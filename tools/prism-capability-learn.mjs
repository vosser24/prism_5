// tools/prism-capability-learn.mjs — ACL Learner/Upgrader (Phase 2)
//
// Exports:
//   attribute({home, lessonsPath, routingPath, rosterPath})
//     — Pure-ish (all paths injected). Reads .prism-lessons.jsonl correction rows,
//       maps each correction's session_id to the agent dispatched in that session
//       via the routing log, and increments corrections_received +
//       corrections_since_last_upgrade in the roster under withRosterLock.
//
//   learn({home, factory, rosterPath})
//     — Finds agents with corrections_since_last_upgrade >= 3 OR pending_upgrade,
//       invokes factory-upgrade (injected; same seam as Phase 1), validates,
//       versions (v<n+1> snapshot, prior version retained), atomically promotes,
//       resets counters, appends digest upgraded:[{name,from,to}].
//
// Factory injection (same pattern as promoter):
//   In tests: pass `factory` as a direct function arg.
//   In the detached worker (E2E): PRISM_ACL_FACTORY env var points to a .mjs
//   whose default export is the factory function.

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';

import {
  stagingPath, versionsPath, digestPath, withRosterLock,
} from './lib/prism-acl-store.mjs';
import { renameWithRetry } from './lib/atomic-fs.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const UPGRADE_THRESHOLD = 3; // corrections_since_last_upgrade >= this → trigger

// ── Frontmatter parser (shared with promoter logic) ──────────────────────────

function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const fmLines = lines.slice(1, end);
  const fm = {};
  for (const line of fmLines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

// ── validate: frontmatter check before staging→live ──────────────────────────

function validate(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) throw new Error(`learn/validate: missing frontmatter in ${filePath}`);
  if (!fm.name) throw new Error(`learn/validate: frontmatter missing 'name' in ${filePath}`);
  if (!fm.description) throw new Error(`learn/validate: frontmatter missing 'description' in ${filePath}`);
  return fm;
}

// ── version: copy staging file to versions/<n>/ snapshot dir ─────────────────
// Reuses the same versioning pattern as promote() in prism-capability-promote.mjs.

function snapshotVersion(home, type, name, srcFile, vNum) {
  const verDir = join(versionsPath(home, type, name), String(vNum));
  mkdirSync(verDir, { recursive: true });
  const dest = join(verDir, basename(srcFile));
  copyFileSync(srcFile, dest);
  return dest;
}

// ── appendUpgradeDigest ───────────────────────────────────────────────────────

function appendUpgradeDigest(home, entry) {
  const dp = digestPath(home);
  let digest = { created: [], upgraded: [] };
  if (existsSync(dp)) {
    try { digest = JSON.parse(readFileSync(dp, 'utf-8')); } catch { /* start fresh */ }
  }
  if (!Array.isArray(digest.created)) digest.created = [];
  if (!Array.isArray(digest.upgraded)) digest.upgraded = [];
  // Avoid duplicates
  const exists = digest.upgraded.some(u => u && u.name === entry.name && u.to === entry.to);
  if (!exists) {
    digest.upgraded.push(entry);
  }
  writeFileSync(dp, JSON.stringify(digest, null, 2), 'utf-8');
}

// ── readRoster / writeRoster helpers ─────────────────────────────────────────

function readRoster(rosterPath) {
  if (!existsSync(rosterPath)) return { agents: {}, skills: {} };
  try { return JSON.parse(readFileSync(rosterPath, 'utf-8')); } catch { return { agents: {}, skills: {} }; }
}

// ── attribute({home, lessonsPath, routingPath, rosterPath}) ─────────────────
//
// Strategy:
//   1. Read all routing log entries with a cap_name (dispatch records).
//      Build a map: session_id → Set<cap_name> (there may be multiple agents
//      dispatched in a session; attribute to ALL agents active in that session).
//   2. Read all .prism-lessons.jsonl rows with type === 'correction'.
//   3. For each correction, look up its session_id → find all cap_names dispatched
//      in that session → increment each agent's counters in the roster.
//   4. All roster writes under withRosterLock.

export async function attribute({ home, lessonsPath, routingPath, rosterPath }) {
  // Build session → cap_names map from routing log
  const sessionAgents = new Map(); // session_id → Set<cap_name>

  if (existsSync(routingPath)) {
    const routingRaw = readFileSync(routingPath, 'utf-8');
    for (const line of routingRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row.cap_name && row.session_id) {
          if (!sessionAgents.has(row.session_id)) {
            sessionAgents.set(row.session_id, new Set());
          }
          sessionAgents.get(row.session_id).add(row.cap_name);
        }
      } catch { /* skip malformed */ }
    }
  }

  // Read correction rows from lessons
  const corrections = []; // [{session_id}]
  if (existsSync(lessonsPath)) {
    const lessonsRaw = readFileSync(lessonsPath, 'utf-8');
    for (const line of lessonsRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row.type === 'correction' && row.session_id) {
          corrections.push(row);
        }
      } catch { /* skip malformed */ }
    }
  }

  if (corrections.length === 0) return; // nothing to attribute

  // Build attribution map: cap_name → correction count
  const attributionMap = new Map(); // cap_name → count

  for (const corr of corrections) {
    const capNames = sessionAgents.get(corr.session_id);
    if (!capNames || capNames.size === 0) continue;
    for (const capName of capNames) {
      attributionMap.set(capName, (attributionMap.get(capName) || 0) + 1);
    }
  }

  if (attributionMap.size === 0) return; // no attributable corrections

  // Update roster under lock
  await withRosterLock(rosterPath, () => {
    const roster = readRoster(rosterPath);
    if (!roster.agents) roster.agents = {};
    if (!roster.skills) roster.skills = {};

    for (const [capName, count] of attributionMap.entries()) {
      // Check agents first, then skills
      const bucket = roster.agents[capName] ? 'agents' : 'skills';
      const entry = roster[bucket][capName];
      if (!entry) continue; // not in roster — skip

      entry.corrections_received = (entry.corrections_received || 0) + count;
      entry.corrections_since_last_upgrade = (entry.corrections_since_last_upgrade || 0) + count;
    }

    writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf-8');
  });
}

// ── learn({home, factory, rosterPath}) ───────────────────────────────────────
//
// Upgrade loop:
//   1. Read roster; find all agents/skills with corrections_since_last_upgrade
//      >= UPGRADE_THRESHOLD OR pending_upgrade === true.
//   2. For each such entry:
//      a. Determine type ('agent'/'skill'), current version.
//      b. Locate the live file (from roster.path, or derive from conventions).
//      c. Call factory(upgradeSpec, stagingDir) → stagingFile.
//      d. validate(stagingFile).
//      e. snapshotVersion(home, type, name, stagingFile, nextVersion) — NEW snapshot.
//         The PRIOR version (at versions/<n-1>/) must already exist and is untouched.
//      f. Atomic promote: copy stagingFile → <liveDir>/<name>.md.tmp → rename.
//      g. Reset corrections_since_last_upgrade = 0, bump version in roster.
//      h. appendUpgradeDigest(home, {name, from, to}).
//      All roster writes under withRosterLock.

export async function learn({ home, factory, rosterPath: rosterPathArg }) {
  // Derive rosterPath default
  const rosterPath = rosterPathArg ||
    join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');

  if (!existsSync(rosterPath)) return; // no roster — nothing to do

  const roster = readRoster(rosterPath);

  // Collect upgrade candidates
  const upgradeCandidates = []; // [{name, type, entry}]

  for (const [name, entry] of Object.entries(roster.agents || {})) {
    if ((entry.corrections_since_last_upgrade || 0) >= UPGRADE_THRESHOLD || entry.pending_upgrade) {
      upgradeCandidates.push({ name, type: 'agent', entry });
    }
  }
  for (const [name, entry] of Object.entries(roster.skills || {})) {
    if ((entry.corrections_since_last_upgrade || 0) >= UPGRADE_THRESHOLD || entry.pending_upgrade) {
      upgradeCandidates.push({ name, type: 'skill', entry });
    }
  }

  if (upgradeCandidates.length === 0) return; // nothing to upgrade

  const stageDir = stagingPath(home);
  mkdirSync(stageDir, { recursive: true });

  for (const { name, type, entry } of upgradeCandidates) {
    // Manifest/flat-owned guard: the ACL learner ONLY ever writes to the nested
    // agents/<name>/ layout. A FLAT agents/<name>.md existing is definitional
    // proof this agent is owned outside ACL (the install manifest or a
    // hand-authored agent). Re-authoring it would fork a divergent nested copy
    // that collides (duplicate frontmatter `name:`) with the flat file in the
    // same user scope — nested dirs ARE dispatch-loaded, so the winner is
    // ambiguous. Refuse, and clear the stuck flag so the evidence-discipline
    // ratchet does not keep re-triggering this no-op upgrade.
    if (type === 'agent' && existsSync(join(home, '.claude', 'agents', `${name}.md`))) {
      process.stderr.write(`[acl-learn] skip '${name}': flat-owned agent (agents/${name}.md exists) — ACL will not upgrade\n`);
      try {
        await withRosterLock(rosterPath, () => {
          const r = readRoster(rosterPath);
          const e = r.agents && r.agents[name];
          if (e && (e.pending_upgrade || e.status === 'upgrade_needed')) {
            e.pending_upgrade = false;
            if (e.status === 'upgrade_needed') e.status = 'active';
            writeFileSync(rosterPath, JSON.stringify(r, null, 2), 'utf-8');
          }
        });
      } catch { /* best-effort flag clear */ }
      continue;
    }

    const currentVersion = parseInt(entry.version || '1', 10);
    const nextVersion = currentVersion + 1;

    // Locate live file: prefer roster.path, else derive from conventions
    let livePath = entry.path || null;
    if (!livePath || !existsSync(livePath)) {
      // Derive: ~/.claude/skills/<name>/<name>.md (or agents/)
      const liveDir = join(
        home, '.claude',
        type === 'agent' ? `agents/${name}` : `skills/${name}`,
      );
      const candidates = [
        join(liveDir, name + '.md'),
        join(liveDir, name + '.mjs'),
      ];
      livePath = candidates.find(existsSync) || null;
    }

    // Build upgrade spec
    const upgradeSpec = {
      name,
      description: entry.description || `Auto-upgrade of ${name}`,
      type,
      upgrade: true,
      fromVersion: currentVersion,
      toVersion: nextVersion,
      livePath,
    };

    let stagingFile;
    try {
      stagingFile = await Promise.resolve(factory(upgradeSpec, stageDir));
    } catch (e) {
      process.stderr.write(`[acl-learn] factory failed for ${name}: ${e.message}\n`);
      continue;
    }

    if (!stagingFile || !existsSync(stagingFile)) {
      process.stderr.write(`[acl-learn] factory produced no file for ${name}\n`);
      continue;
    }

    // Validate
    let fm;
    try {
      fm = validate(stagingFile);
    } catch (e) {
      process.stderr.write(`[acl-learn] validate failed for ${name}: ${e.message}\n`);
      continue;
    }

    // Snapshot the NEW version (the prior version stays untouched)
    try {
      snapshotVersion(home, type, name, stagingFile, nextVersion);
    } catch (e) {
      process.stderr.write(`[acl-learn] snapshot failed for ${name} v${nextVersion}: ${e.message}\n`);
      continue;
    }

    // Atomic promote: staging → live
    const liveDir = join(
      home, '.claude',
      type === 'agent' ? `agents/${name}` : `skills/${name}`,
    );
    mkdirSync(liveDir, { recursive: true });
    const liveFilePath = join(liveDir, basename(stagingFile));
    const tmpLive = liveFilePath + '.tmp';
    try {
      copyFileSync(stagingFile, tmpLive);
      // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY before
      // the cleanup-attempt + continue below.
      renameWithRetry(renameSync, tmpLive, liveFilePath);
    } catch (e) {
      process.stderr.write(`[acl-learn] atomic promote failed for ${name}: ${e.message}\n`);
      // F34: this was a no-op self-rename (rename(tmpLive, tmpLive)) that left
      // a stale .tmp file on every failed promote. unlinkSync matches the
      // established cleanup-after-failed-renameWithRetry idiom used elsewhere
      // in this repo (tools/lib/prism-state.mjs, tools/prism-installer.mjs,
      // hooks/prism-handoff-pointer.mjs).
      try { unlinkSync(tmpLive); } catch { /* ignore */ } // cleanup attempt
      continue;
    }

    // Update roster under lock: reset counter, bump version
    try {
      await withRosterLock(rosterPath, () => {
        const r = readRoster(rosterPath);
        const bucket = type === 'agent' ? 'agents' : 'skills';
        const e = r[bucket][name];
        if (e) {
          e.corrections_since_last_upgrade = 0;
          e.version = nextVersion;
          e.path = liveFilePath;
          e.pending_upgrade = false;
          e.last_upgraded_at = new Date().toISOString();
        }
        writeFileSync(rosterPath, JSON.stringify(r, null, 2), 'utf-8');
      });
    } catch (e) {
      process.stderr.write(`[acl-learn] roster update failed for ${name}: ${e.message}\n`);
    }

    // Append to digest
    appendUpgradeDigest(home, { name, from: currentVersion, to: nextVersion });
  }
}
