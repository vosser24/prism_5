// tools/prism-capability-promote.mjs — ACL Promoter + Validator/Versioner
//
// promote(candidate, {home, factory}) workflow:
//   1. Derive a name from the candidate label.
//   2. Ensure staging dir exists; call factory(spec, stagingDir) → stagingFile.
//   3. validate() — parse frontmatter; for agents run `node --check`; smoke load.
//   4. version() — copy staging file to skills/<name>/versions/1/<file> (or agents/).
//   5. Atomic rename staging file → live path (under ~/.claude/skills/ or agents/).
//   6. Register in GLOBAL roster via withRosterLock.
//   7. Append to digest (.prism-acl-digest.json).
//
// Factory injection:
//   In production, the factory dispatches the real agent-factory subprocess.
//   In tests, an in-process stub function is passed directly:
//     factory(spec, stagingDir) → writes a file into stagingDir, returns its path.
//   The detached worker also supports PRISM_ACL_FACTORY env var: when set to a
//   .mjs path, that module's default export is used as the factory, allowing the
//   E2E test to inject a stub factory without modifying production code.

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, copyFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  stagingPath, versionsPath, digestPath, withRosterLock,
} from './lib/prism-acl-store.mjs';

// ── Name derivation ──────────────────────────────────────────────────────────

function deriveName(label) {
  // label is already a kebab-case slug like "watchdog-monitor-health"
  // Ensure it ends with "-builder" only if it doesn't already describe a tool
  const clean = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Append -builder to make it a descriptive skill name
  if (clean.endsWith('-builder') || clean.endsWith('-agent') || clean.endsWith('-skill')) {
    return clean;
  }
  return clean + '-builder';
}

// ── Frontmatter parser ──────────────────────────────────────────────────────

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
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fm[key] = val;
  }
  return fm;
}

// ── validate: frontmatter + syntax check for agents ─────────────────────────

function validate(filePath, type) {
  const content = readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) throw new Error(`validate: missing or malformed frontmatter in ${filePath}`);
  if (!fm.name) throw new Error(`validate: frontmatter missing 'name' in ${filePath}`);
  if (!fm.description) throw new Error(`validate: frontmatter missing 'description' in ${filePath}`);

  // For agent .mjs files: node --check syntax validation
  if (type === 'agent' && filePath.endsWith('.mjs')) {
    try {
      execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    } catch (e) {
      throw new Error(`validate: node --check failed for ${filePath}: ${e.message}`);
    }
  }

  return fm;
}

// ── version: copy to versions/<n>/ snapshot dir ──────────────────────────────

function version(home, type, name, stagingFile, vNum = 1) {
  const verDir = join(versionsPath(home, type, name), String(vNum));
  mkdirSync(verDir, { recursive: true });
  const dest = join(verDir, basename(stagingFile));
  copyFileSync(stagingFile, dest);
  return dest;
}

// ── digest: append to .prism-acl-digest.json ─────────────────────────────────

function appendDigest(home, entry) {
  const dp = digestPath(home);
  let digest = { created: [], upgraded: [] };
  if (existsSync(dp)) {
    try { digest = JSON.parse(readFileSync(dp, 'utf-8')); } catch { /* start fresh */ }
  }
  if (!Array.isArray(digest.created)) digest.created = [];
  if (!Array.isArray(digest.upgraded)) digest.upgraded = [];
  if (entry.kind === 'created' && !digest.created.includes(entry.name)) {
    digest.created.push(entry.name);
  }
  writeFileSync(dp, JSON.stringify(digest, null, 2), 'utf-8');
}

// ── promote: main export ──────────────────────────────────────────────────────

export async function promote(candidate, { home, factory }) {
  const type = candidate.suggestedType || 'skill'; // 'skill' | 'agent'
  const name = deriveName(candidate.label);

  const spec = {
    name,
    description: `Auto-detected capability: ${candidate.label.replace(/-/g, ' ')}`,
    type,
    members: candidate.members,
    sessions: candidate.sessions,
    label: candidate.label,
  };

  // 1. Ensure staging dir
  const stageDir = stagingPath(home);
  mkdirSync(stageDir, { recursive: true });

  // 2. Call factory to produce the file in staging
  const stagingFile = await Promise.resolve(factory(spec, stageDir));
  if (!stagingFile || !existsSync(stagingFile)) {
    throw new Error(`promote: factory did not produce a file at ${stagingFile}`);
  }

  // 3. Validate
  const fm = validate(stagingFile, type);

  // 4. Version snapshot (v1)
  const versionedPath = version(home, type, name, stagingFile, 1);

  // 5. Determine live path; atomic rename staging → live
  const liveDir = join(
    home, '.claude',
    type === 'agent' ? `agents/${name}` : `skills/${name}`,
  );
  mkdirSync(liveDir, { recursive: true });
  const livePath = join(liveDir, basename(stagingFile));

  // Atomic: write to a .tmp first, then rename over live
  const tmpLive = livePath + '.tmp';
  copyFileSync(stagingFile, tmpLive);
  renameSync(tmpLive, livePath);

  // 6. Register in GLOBAL roster (the path the orchestrator reads)
  const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  mkdirSync(join(home, '.claude', 'skills', 'prism-plan', 'references'), { recursive: true });

  await withRosterLock(rosterPath, () => {
    let roster = { agents: {}, skills: {} };
    if (existsSync(rosterPath)) {
      try { roster = JSON.parse(readFileSync(rosterPath, 'utf-8')); } catch { /* start fresh */ }
    }
    if (!roster.agents) roster.agents = {};
    if (!roster.skills) roster.skills = {};

    const entry = {
      description: fm.description || spec.description,
      version: parseInt(fm.version || '1', 10),
      path: livePath,
      created_at: new Date().toISOString(),
      acl_promoted: true,
      keywords: candidate.label.split('-').filter(t => t.length > 2),
    };

    if (type === 'agent') {
      roster.agents[name] = entry;
    } else {
      roster.skills[name] = entry;
    }

    writeFileSync(rosterPath, JSON.stringify(roster, null, 2), 'utf-8');
  });

  // 7. Append to digest
  appendDigest(home, { kind: 'created', name });

  return {
    name,
    livePath,
    versionPath: versionedPath,
    type,
  };
}
