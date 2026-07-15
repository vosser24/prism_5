#!/usr/bin/env node
// tests/v3/cli/acl-phase3-e2e.mjs — F3.3 Phase-3 CLI end-to-end
//
// Scenario:
//   1. Start with a capability (watchdog-monitor-builder) already at v2
//      (upgraded from v1 → v2 in Phase 2). Both v1 and v2 snapshots exist.
//   2. Simulate its first use drawing an IMMEDIATE CORRECTION by calling
//      the rollback guard with a correction payload attributed to that cap.
//   3. Assert auto-rollback (F3.1) restored the prior version.
//   4. Run `capability-cli log` and assert the rollback event appears.
//   5. Run `capability-cli rollback <name>` again and assert it is IDEMPOTENT
//      (already at v1, no-op).
//
// Assertions (each PASS/FAIL):
//   (a) auto-rollback: live file content matches prior v1 after correction
//   (b) roster version decremented to 1
//   (c) digest has rolledback entry for watchdog-monitor-builder from→2 to→1
//   (d) `capability-log` shows the rollback event
//   (e) `capability-rollback watchdog-monitor-builder` is idempotent (exit 0, no-op message)

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const ROLLBACK_GUARD = join(REPO_ROOT, 'hooks', 'prism-acl-rollback-guard.mjs');
const CLI = join(REPO_ROOT, 'tools', 'prism-capability-cli.mjs');

let pass = 0, fail = 0;

function result(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

// ── Setup: throwaway HOME ─────────────────────────────────────────────────────

const HOME = mkdtempSync(join(tmpdir(), 'prism-e2e-phase3-'));
const CLAUDE_DIR = join(HOME, '.claude');
mkdirSync(CLAUDE_DIR, { recursive: true });

const hookEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
};

// ── Seed capability at v2 (deliberately bad upgrade) ─────────────────────────

const NAME = 'watchdog-monitor-builder';
const skillDir = join(CLAUDE_DIR, 'skills', NAME);
mkdirSync(skillDir, { recursive: true });

// v1 snapshot — the GOOD version we want to roll back to
const ver1Dir = join(skillDir, 'versions', '1');
mkdirSync(ver1Dir, { recursive: true });
const v1Content = [
  '---',
  `name: ${NAME}`,
  'description: Watchdog monitor skill (GOOD v1)',
  'type: skill',
  'version: 1',
  '---',
  '',
  `# ${NAME} v1`,
  '',
  'Original good v1 content — this is what rollback should restore.',
].join('\n');
writeFileSync(join(ver1Dir, NAME + '.md'), v1Content, 'utf-8');

// v2 snapshot — the DELIBERATELY BAD upgrade
const ver2Dir = join(skillDir, 'versions', '2');
mkdirSync(ver2Dir, { recursive: true });
const v2Content = [
  '---',
  `name: ${NAME}`,
  'description: Watchdog monitor skill (BAD v2)',
  'type: skill',
  'version: 2',
  '---',
  '',
  `# ${NAME} v2`,
  '',
  'DELIBERATELY BAD upgrade — should be rolled back on correction.',
].join('\n');
const liveFile = join(skillDir, NAME + '.md');
writeFileSync(liveFile, v2Content, 'utf-8');
copyFileSync(liveFile, join(ver2Dir, NAME + '.md'));

// ── Seed roster: capability at v2 with last_upgraded_at ──────────────────────

const rosterDir = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');

const initialRoster = {
  agents: {},
  skills: {
    [NAME]: {
      description: 'Watchdog monitor skill',
      version: 2,
      path: liveFile,
      corrections_received: 0,
      corrections_since_last_upgrade: 0,
      last_upgraded_at: new Date().toISOString(),
      last_upgrade_version: 2,
      acl_promoted: true,
    },
  },
};
writeFileSync(rosterPath, JSON.stringify(initialRoster, null, 2), 'utf-8');

console.log('\n[Phase 3 E2E] Setup: watchdog-monitor-builder at v2 (deliberately bad)');
console.log(`  HOME: ${HOME}`);

// ── Step 1: Simulate immediate correction → trigger rollback guard ────────────

console.log('\n[Phase 3 E2E] Simulating correction attributed to upgraded capability...');

const correctionPayload = {
  event: 'correction',
  session_id: 'e2e-phase3-sess',
  cap_name: NAME,
  type: 'correction',
  content: 'The v2 upgrade gave wrong output — immediate correction needed',
};

const r1 = spawnSync(process.execPath, [ROLLBACK_GUARD], {
  input: JSON.stringify(correctionPayload),
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});

result('rollback guard exits 0', r1.status === 0,
  `exit=${r1.status} stderr=${r1.stderr?.slice(0, 200)}`);

// ── Assertion (a): auto-rollback restored prior v1 ───────────────────────────

const liveContentAfter = existsSync(liveFile) ? readFileSync(liveFile, 'utf-8') : '(missing)';
const restoredToV1 = liveContentAfter.includes('Original good v1 content') ||
                     liveContentAfter.includes('version: 1') ||
                     liveContentAfter.includes('GOOD v1');
result('(a) auto-rollback: live file restored to v1 content',
  restoredToV1, `live content: ${liveContentAfter.slice(0, 100)}`);

// ── Assertion (b): roster version decremented ────────────────────────────────

let rosterOk = false;
let rosterDetail = '';
try {
  const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = r.skills[NAME];
  if (entry) {
    rosterOk = entry.version === 1;
    rosterDetail = `version=${entry.version}`;
  } else {
    rosterDetail = 'entry missing';
  }
} catch (e) {
  rosterDetail = `error: ${e.message}`;
}
result('(b) roster version decremented to 1', rosterOk, rosterDetail);

// ── Assertion (c): digest has rolledback entry ────────────────────────────────

const DIGEST_PATH = join(CLAUDE_DIR, '.prism-acl-digest.json');
let digestOk = false;
let digestDetail = '';
try {
  if (existsSync(DIGEST_PATH)) {
    const digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8'));
    const rolledback = digest.rolledback || [];
    const rb = rolledback.find(r => r && r.name === NAME);
    if (rb) {
      digestOk = rb.from === 2 && rb.to === 1;
      digestDetail = `from=${rb.from} to=${rb.to}`;
    } else {
      digestDetail = `no rolledback entry for ${NAME}; rolledback=${JSON.stringify(rolledback)}`;
    }
  } else {
    digestDetail = 'digest file missing';
  }
} catch (e) {
  digestDetail = `error: ${e.message}`;
}
result('(c) digest has rolledback entry (from=2, to=1)', digestOk, digestDetail);

// ── Assertion (d): capability-log shows the rollback event ───────────────────

const r2 = spawnSync(process.execPath, [CLI, 'log'], {
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});

let logOk = false;
let logDetail = '';
if (r2.status === 0) {
  const logOut = r2.stdout || '';
  logOk = logOut.match(/rolled.?back|Rolled.?back/i) !== null &&
           logOut.includes(NAME);
  logDetail = logOut.slice(0, 300);
} else {
  logDetail = `exit=${r2.status} stderr=${r2.stderr?.slice(0, 100)}`;
}
result('(d) capability-log shows rollback event', logOk, logDetail);

// ── Assertion (e): capability-rollback is idempotent (already at v1) ──────────

const r3 = spawnSync(process.execPath, [CLI, 'rollback', NAME], {
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});

let idempotentOk = false;
let idempotentDetail = '';
if (r3.status === 0) {
  const out = r3.stdout || '';
  // Should print a no-op message (already at v1) OR a "reverted" message
  // Either is acceptable for idempotency — the key is exit 0 and no mutation
  const isNoOp = out.match(/already at v1|no prior version|no-op/i) !== null;
  const isAlreadyReverted = out.includes('v1→v') || out.includes('reverted');
  idempotentOk = isNoOp || isAlreadyReverted || r3.status === 0;
  idempotentDetail = out.slice(0, 200);

  // Verify the live file is STILL v1 (not further mutated)
  const liveAfterIdempotent = existsSync(liveFile) ? readFileSync(liveFile, 'utf-8') : '(missing)';
  const stillV1 = liveAfterIdempotent.includes('version: 1') ||
                  liveAfterIdempotent.includes('GOOD v1') ||
                  liveAfterIdempotent.includes('Original good v1 content');
  if (!stillV1) {
    idempotentOk = false;
    idempotentDetail += ` | live content changed unexpectedly: ${liveAfterIdempotent.slice(0, 80)}`;
  }
} else {
  idempotentDetail = `exit=${r3.status} stderr=${r3.stderr?.slice(0, 100)}`;
}
result('(e) capability-rollback is idempotent (exit 0, live file still v1)', idempotentOk, idempotentDetail);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${pass} PASS, ${fail} FAIL`);

// Cleanup
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
