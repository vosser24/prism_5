#!/usr/bin/env node
// tools/prism-capability-cli.mjs — ACL Phase-3 Observability CLI
//
// Usage:
//   node tools/prism-capability-cli.mjs log
//     Prints the create/upgrade/rollback history from ~/.claude/.prism-acl-digest.json.
//
//   node tools/prism-capability-cli.mjs rollback <name>
//     Manually rolls back capability <name> to its prior version.
//     Idempotent: if the capability is already at v1 or has no prior version,
//     it is a safe no-op (exits 0).
//
// Both commands use HOME / USERPROFILE to locate the ACL state dir.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from './lib/atomic-fs.mjs';
import { prismHome } from '../hooks/lib/prism-home.mjs';

const HOME = prismHome();
const CLAUDE_DIR = join(HOME, '.claude');

// ── Path helpers ──────────────────────────────────────────────────────────────

function digestPath() {
  return join(CLAUDE_DIR, '.prism-acl-digest.json');
}

function rosterPath() {
  return join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json');
}

function versionsDir(type, name) {
  if (type === 'agent') return join(CLAUDE_DIR, 'agents', name, 'versions');
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

function readDigest() {
  const dp = digestPath();
  if (!existsSync(dp)) return { created: [], upgraded: [], rolledback: [] };
  try {
    const d = JSON.parse(readFileSync(dp, 'utf-8'));
    if (!Array.isArray(d.created)) d.created = [];
    if (!Array.isArray(d.upgraded)) d.upgraded = [];
    if (!Array.isArray(d.rolledback)) d.rolledback = [];
    return d;
  } catch { return { created: [], upgraded: [], rolledback: [] }; }
}

function appendRollbackDigest(entry) {
  const dp = digestPath();
  const digest = readDigest();
  const exists = digest.rolledback.some(r => r && r.name === entry.name && r.from === entry.from && r.to === entry.to);
  if (!exists) {
    digest.rolledback.push(entry);
  }
  writeFileSync(dp, JSON.stringify(digest, null, 2), 'utf-8');
}

// ── Command: log ──────────────────────────────────────────────────────────────

function cmdLog() {
  const digest = readDigest();

  const created = digest.created.filter(Boolean);
  const upgraded = digest.upgraded.filter(Boolean);
  const rolledback = digest.rolledback.filter(Boolean);

  if (created.length === 0 && upgraded.length === 0 && rolledback.length === 0) {
    console.log('ACL capability log: (no entries)');
    return;
  }

  console.log('ACL Capability History');
  console.log('======================');

  if (created.length > 0) {
    console.log('\nCreated:');
    for (const name of created) {
      console.log(`  + ${name}`);
    }
  }

  if (upgraded.length > 0) {
    console.log('\nUpgraded:');
    for (const item of upgraded) {
      if (typeof item === 'string') {
        console.log(`  ^ ${item}`);
      } else if (item && item.name) {
        const range = item.from && item.to ? ` (v${item.from}→v${item.to})` : '';
        console.log(`  ^ ${item.name}${range}`);
      }
    }
  }

  if (rolledback.length > 0) {
    console.log('\nRolled back:');
    for (const item of rolledback) {
      if (typeof item === 'string') {
        console.log(`  < ${item} (rolled back)`);
      } else if (item && item.name) {
        const range = item.from && item.to ? ` (v${item.from}→v${item.to})` : '';
        console.log(`  < ${item.name}${range}`);
      }
    }
  }
}

// ── Command: rollback <name> ──────────────────────────────────────────────────

function cmdRollback(name) {
  if (!name) {
    console.error('Usage: prism-capability-cli.mjs rollback <name>');
    process.exit(1);
  }

  // Look up the capability in the roster
  const roster = readRoster();
  let type = null;
  let entry = null;

  if (roster.agents && roster.agents[name]) {
    type = 'agent';
    entry = roster.agents[name];
  } else if (roster.skills && roster.skills[name]) {
    type = 'skill';
    entry = roster.skills[name];
  }

  if (!entry) {
    console.log(`capability-rollback: '${name}' not found in roster — no-op`);
    process.exit(0);
  }

  const currentVersion = parseInt(entry.version || '1', 10);

  // Idempotency: already at v1 or version<=1 → no-op
  if (currentVersion <= 1) {
    console.log(`capability-rollback: '${name}' is already at v1 — no prior version to restore (no-op)`);
    process.exit(0);
  }

  const priorVersion = currentVersion - 1;
  const vDir = versionsDir(type, name);
  const priorVersionDir = join(vDir, String(priorVersion));

  // Find the prior version file
  let priorFile = null;
  const candidates = [
    join(priorVersionDir, name + '.md'),
    join(priorVersionDir, name + '.mjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) { priorFile = c; break; }
  }

  if (!priorFile) {
    console.log(`capability-rollback: no prior version snapshot found for '${name}' v${priorVersion} at ${priorVersionDir} — no-op`);
    process.exit(0);
  }

  // Determine live path
  let livePath = entry.path || null;
  if (!livePath || !existsSync(livePath)) {
    const liveDir = join(CLAUDE_DIR, type === 'agent' ? `agents/${name}` : `skills/${name}`);
    const derived = [
      join(liveDir, name + '.md'),
      join(liveDir, name + '.mjs'),
    ];
    livePath = derived.find(existsSync) || join(liveDir, name + '.md');
  }

  // Atomic restore: copy prior → tmp → rename
  const tmpPath = livePath + '.cli-rollback.tmp';
  try {
    mkdirSync(join(livePath, '..'), { recursive: true });
    copyFileSync(priorFile, tmpPath);
    // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY before the
    // .dead-marker fallback + exit(1) below.
    renameWithRetry(renameSync, tmpPath, livePath);
  } catch (e) {
    console.error(`capability-rollback: restore failed for '${name}': ${e.message}`);
    try { if (existsSync(tmpPath)) renameSync(tmpPath, tmpPath + '.dead'); } catch {}
    process.exit(1);
  }

  // Update roster: decrement version
  const bucket = type === 'agent' ? 'agents' : 'skills';
  const r2 = readRoster(); // re-read to avoid stale
  const e2 = r2[bucket] && r2[bucket][name];
  if (e2) {
    e2.version = priorVersion;
    e2.path = livePath;
    e2.rolledback_at = new Date().toISOString();
    e2.rolledback_from = currentVersion;
    delete e2.last_upgraded_at;
    delete e2.last_upgrade_version;
    writeRoster(r2);
  }

  // Append rollback to digest log
  appendRollbackDigest({ name, from: currentVersion, to: priorVersion });

  console.log(`capability-rollback: '${name}' reverted v${currentVersion}→v${priorVersion}`);
  process.exit(0);
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`PRISM ACL Capability CLI

Commands:
  log                  Print the create/upgrade/rollback history
  rollback <name>      Restore the prior version of a capability (idempotent)

Options:
  --help               This message`);
  process.exit(0);
}

if (cmd === 'log') {
  cmdLog();
  process.exit(0);
}

if (cmd === 'rollback') {
  cmdRollback(rest[0]);
  // cmdRollback exits internally
}

console.error(`Unknown command: ${cmd}`);
process.exit(1);
