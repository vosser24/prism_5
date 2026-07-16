#!/usr/bin/env node
// hooks/prism-acl-rollback-guard.mjs — ACL Phase-3 Auto-Rollback Guard
//
// TRIGGER SEMANTICS (deviation note):
//   The plan labels this hook "PreToolUse/Agent" but a true PreToolUse hook
//   cannot know whether the FUTURE tool invocation will draw a correction.
//   The correct, testable trigger is CORRECTION-DRIVEN: when a correction event
//   is attributed to a recently-upgraded agent (roster entry has
//   last_upgraded_at / last_upgrade_version), this guard reverts the live
//   capability file to its prior version (versions/<n-1>/).
//
//   In the PRISM ACL pipeline this guard is called by the detached worker (or
//   the session-end pipeline) after a correction is attributed, with a payload:
//     { event:'correction', session_id, cap_name, type:'correction', content }
//
//   In production, the existing session-end correction extractor writes lessons
//   with type:'correction'; the worker can pipe each attributed correction through
//   this guard before incrementing counters, enabling immediate auto-rollback.
//
// Rollback logic:
//   1. Read payload from stdin.
//   2. If event/type != 'correction' OR no cap_name → passthrough (exit 0).
//   3. Look up cap_name in roster (agents then skills).
//   4. If not found OR no last_upgraded_at OR version == 1 → safe no-op.
//   5. Locate prior version snapshot: versions/<current-1>/<name>.md
//   6. Atomic restore: copy prior → live path.
//   7. Decrement roster version; append digest rolledback:[{name,from,to}].
//   8. Exit 0.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync,
  appendFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(HOME, '.claude');

// ── Path helpers (mirror prism-acl-store.mjs) ────────────────────────────────

function rosterPath() {
  return join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json');
}

function digestPath() {
  return join(CLAUDE_DIR, '.prism-acl-digest.json');
}

function versionsDir(type, name) {
  if (type === 'agent') {
    return join(CLAUDE_DIR, 'agents', name, 'versions');
  }
  return join(CLAUDE_DIR, 'skills', name, 'versions');
}

// ── Roster helpers ────────────────────────────────────────────────────────────

function readRoster() {
  const rp = rosterPath();
  if (!existsSync(rp)) return { agents: {}, skills: {} };
  try { return JSON.parse(readFileSync(rp, 'utf-8')); } catch { return { agents: {}, skills: {} }; }
}

function writeRoster(roster) {
  const rp = rosterPath();
  mkdirSync(join(CLAUDE_DIR, 'skills', 'prism-plan', 'references'), { recursive: true });
  writeFileSync(rp, JSON.stringify(roster, null, 2), 'utf-8');
}

// ── Digest helpers ────────────────────────────────────────────────────────────

function appendRollbackDigest(entry) {
  const dp = digestPath();
  let digest = { created: [], upgraded: [], rolledback: [] };
  if (existsSync(dp)) {
    try { digest = JSON.parse(readFileSync(dp, 'utf-8')); } catch { /* start fresh */ }
  }
  if (!Array.isArray(digest.created)) digest.created = [];
  if (!Array.isArray(digest.upgraded)) digest.upgraded = [];
  if (!Array.isArray(digest.rolledback)) digest.rolledback = [];

  // Avoid duplicate rollback entries for same name+from+to
  const exists = digest.rolledback.some(r => r && r.name === entry.name && r.from === entry.from && r.to === entry.to);
  if (!exists) {
    digest.rolledback.push(entry);
  }
  writeFileSync(dp, JSON.stringify(digest, null, 2), 'utf-8');
}

// ── Routing-log emission (census visibility) ─────────────────────────────────
// Event-keyed record in ~/.claude/.prism-routing.jsonl so an event-keyed guard
// census can see this guard fire. Additive only — never affects control flow.
function appendLog(obj) {
  try {
    mkdirSync(CLAUDE_DIR, { recursive: true });
    appendFileSync(join(CLAUDE_DIR, '.prism-routing.jsonl'), JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let payload = {};
  try {
    const raw = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', d => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
    if (raw.trim()) payload = JSON.parse(raw.trim());
  } catch { /* malformed input — passthrough */ }

  // Only process correction events
  const isCorrection = payload.event === 'correction' || payload.type === 'correction';
  const capName = payload.cap_name;

  if (!isCorrection || !capName) {
    process.exit(0);
  }

  // Look up cap in roster
  const roster = readRoster();
  let type = null;
  let entry = null;

  if (roster.agents && roster.agents[capName]) {
    type = 'agent';
    entry = roster.agents[capName];
  } else if (roster.skills && roster.skills[capName]) {
    type = 'skill';
    entry = roster.skills[capName];
  }

  if (!entry) {
    // Not in roster — passthrough
    appendLog({ event: 'acl_rollback_guard', ts: new Date().toISOString(), session_id: payload.session_id || 'anon', cap_name: capName, rolledback: false, outcome: 'cap-not-in-roster' });
    process.exit(0);
  }

  const currentVersion = parseInt(entry.version || '1', 10);

  // No rollback if: not recently upgraded, or already at v1
  if (!entry.last_upgraded_at || currentVersion <= 1) {
    // Safe no-op
    appendLog({ event: 'acl_rollback_guard', ts: new Date().toISOString(), session_id: payload.session_id || 'anon', cap_name: capName, rolledback: false, outcome: 'no-op-not-upgraded-or-v1' });
    process.exit(0);
  }

  const priorVersion = currentVersion - 1;
  const vDir = versionsDir(type, capName);
  const priorVersionDir = join(vDir, String(priorVersion));

  // Find the prior version file
  let priorFile = null;
  // Try <name>.md and <name>.mjs
  const candidates = [
    join(priorVersionDir, capName + '.md'),
    join(priorVersionDir, capName + '.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) { priorFile = c; break; }
  }

  if (!priorFile) {
    // No prior version snapshot found — safe no-op
    process.stderr.write(`[acl-rollback-guard] no prior version snapshot found for ${capName} v${priorVersion} at ${priorVersionDir}\n`);
    appendLog({ event: 'acl_rollback_guard', ts: new Date().toISOString(), session_id: payload.session_id || 'anon', cap_name: capName, rolledback: false, outcome: 'no-prior-snapshot' });
    process.exit(0);
  }

  // Determine live path from roster.path or derive
  let livePath = entry.path || null;
  if (!livePath || !existsSync(livePath)) {
    const liveDir = join(CLAUDE_DIR, type === 'agent' ? `agents/${capName}` : `skills/${capName}`);
    const derived = [
      join(liveDir, capName + '.md'),
      join(liveDir, capName + '.mjs'),
    ];
    livePath = derived.find(existsSync) || join(liveDir, capName + '.md');
  }

  // Atomic restore: copy prior → tmp → rename to live
  const tmpPath = livePath + '.rollback.tmp';
  try {
    mkdirSync(join(livePath, '..'), { recursive: true });
  } catch {}
  try {
    copyFileSync(priorFile, tmpPath);
    renameSync(tmpPath, livePath);
  } catch (e) {
    process.stderr.write(`[acl-rollback-guard] atomic restore failed for ${capName}: ${e.message}\n`);
    try { if (existsSync(tmpPath)) renameSync(tmpPath, tmpPath + '.dead'); } catch {}
    appendLog({ event: 'acl_rollback_guard', ts: new Date().toISOString(), session_id: payload.session_id || 'anon', cap_name: capName, rolledback: false, outcome: 'restore-failed' });
    process.exit(0);
  }

  // Update roster: decrement version, clear last_upgraded_at
  const bucket = type === 'agent' ? 'agents' : 'skills';
  const r2 = readRoster(); // re-read to avoid stale
  const e2 = r2[bucket] && r2[bucket][capName];
  if (e2) {
    e2.version = priorVersion;
    e2.path = livePath;
    e2.rolledback_at = new Date().toISOString();
    e2.rolledback_from = currentVersion;
    // Clear upgrade markers so guard doesn't double-rollback
    delete e2.last_upgraded_at;
    delete e2.last_upgrade_version;
    writeRoster(r2);
  }

  // Append to digest
  appendRollbackDigest({ name: capName, from: currentVersion, to: priorVersion });

  appendLog({ event: 'acl_rollback_guard', ts: new Date().toISOString(), session_id: payload.session_id || 'anon', cap_name: capName, rolledback: true, outcome: 'rolledback', from: currentVersion, to: priorVersion });

  process.stderr.write(`[acl-rollback-guard] rolled back ${capName} v${currentVersion}→v${priorVersion}\n`);
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`[acl-rollback-guard] fatal: ${e.message}\n`);
  process.exit(0); // never block the session
});
