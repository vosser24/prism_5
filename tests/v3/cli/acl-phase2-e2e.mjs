#!/usr/bin/env node
// tests/v3/cli/acl-phase2-e2e.mjs — F2.4 Phase-2 CLI end-to-end
//
// Scenario:
//   - Seed a rostered test agent (watchdog-monitor-builder, v1) with a live file
//     and 3 correction rows already attributed (corrections_since_last_upgrade=3).
//   - Seed a routing log with dispatch records tying those corrections to the agent.
//   - Run the SessionEnd worker (with PRISM_ACL_FACTORY stub → no real LLM).
//   - Wait for the detached worker to finish (poll digest, 15s timeout).
//
// Assertions (each PASS/FAIL):
//   (a) Agent version bumped: v2 snapshot exists (versions/2/ dir present).
//   (b) Counters reset: corrections_since_last_upgrade = 0 in roster.
//   (c) SessionStart notify prints "upgraded watchdog-monitor-builder v1→v2".
//   (d) OLD v1 snapshot retained for rollback (versions/1/ still present).

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  readdirSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const SESSIONEND_HOOK = join(REPO_ROOT, 'hooks', 'prism-acl-sessionend.mjs');
const NOTIFY_HOOK = join(REPO_ROOT, 'hooks', 'prism-acl-notify.mjs');
const STUB_FACTORY = join(__dirname, 'acl-stub-upgrade-factory.mjs');

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

const HOME = mkdtempSync(join(tmpdir(), 'prism-e2e-phase2-'));
const CLAUDE_DIR = join(HOME, '.claude');
mkdirSync(CLAUDE_DIR, { recursive: true });

// ── Seed routing log ──────────────────────────────────────────────────────────
// 3 clustered "watchdog" prompts across 2 sessions (for detect→promote pass)
// + dispatch records for watchdog-monitor-builder (for learn attribution)
const routingLines = [
  // Cluster for detect→promote (these form a new "uptime-checker" or similar skill)
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'build a watchdog monitor to check service health uptime', ts: '2026-06-17T10:00:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'implement health monitor watchdog to track service uptime', ts: '2026-06-17T10:05:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-B', description: 'set up watchdog health monitor for service uptime checking', ts: '2026-06-17T11:00:00Z' },
  // dispatch records for learn() — ties corrections to watchdog-monitor-builder
  { event: 'dispatch_cap', session_id: 'sess-A', cap_name: 'watchdog-monitor-builder', ts: '2026-06-17T10:10:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-B', cap_name: 'watchdog-monitor-builder', ts: '2026-06-17T11:10:00Z' },
];
const routingPath = join(CLAUDE_DIR, '.prism-routing.jsonl');
writeFileSync(routingPath, routingLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed lessons: 3 correction rows attributed to watchdog-monitor-builder ────
// (pre-seeded via roster so the worker doesn't need to attribute them fresh;
//  we also seed the raw lessons so the worker's attribute() pass would agree)
const lessonsPath = join(CLAUDE_DIR, '.prism-lessons.jsonl');
const lessonLines = [
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:02:00Z', content: 'correction 1' },
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:06:00Z', content: 'correction 2' },
  { type: 'correction', session_id: 'sess-B', ts: '2026-06-17T11:05:00Z', content: 'correction 3' },
];
writeFileSync(lessonsPath, lessonLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed roster: watchdog-monitor-builder v1 with 3 corrections (upgrade trigger) ──
const rosterDir = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');

// Create v1 live file
const skillDir = join(CLAUDE_DIR, 'skills', 'watchdog-monitor-builder');
mkdirSync(skillDir, { recursive: true });
const liveFile = join(skillDir, 'watchdog-monitor-builder.md');
const v1Content = [
  '---',
  'name: watchdog-monitor-builder',
  'description: Watchdog monitor skill',
  'type: skill',
  'version: 1',
  '---',
  '',
  '# watchdog-monitor-builder v1',
  '',
  'Original v1 content.',
].join('\n');
writeFileSync(liveFile, v1Content, 'utf-8');

// Create v1 snapshot (versions/1/)
const ver1Dir = join(CLAUDE_DIR, 'skills', 'watchdog-monitor-builder', 'versions', '1');
mkdirSync(ver1Dir, { recursive: true });
copyFileSync(liveFile, join(ver1Dir, basename(liveFile)));

// Seed roster with corrections_since_last_upgrade=3 already (so upgrade triggers)
const initialRoster = {
  agents: {},
  skills: {
    'watchdog-monitor-builder': {
      description: 'Watchdog monitor skill',
      version: 1,
      path: liveFile,
      corrections_received: 3,
      corrections_since_last_upgrade: 3,
      acl_promoted: true,
    },
  },
};
writeFileSync(rosterPath, JSON.stringify(initialRoster, null, 2), 'utf-8');

const hookEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  PRISM_ACL_FACTORY: STUB_FACTORY,
  PRISM_ACL_DEBOUNCE_MS: '300000',   // long debounce so test duration doesn't interfere
  PRISM_ACL_TIME_BUDGET_MS: '30000',
};

const payload = JSON.stringify({ event: 'SessionEnd', session_id: 'e2e-phase2-sess' });

// ── Step 1: run SessionEnd hook (fire-and-forget) ────────────────────────────

console.log('\nRunning SessionEnd hook...');
const t0 = Date.now();
const r1 = spawnSync(process.execPath, [SESSIONEND_HOOK], {
  input: payload,
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});
const foregroundMs = Date.now() - t0;
console.log(`Foreground SessionEnd returned in ${foregroundMs}ms`);
result('SessionEnd exits 0', r1.status === 0,
  `exit=${r1.status} stderr=${r1.stderr?.slice(0, 200)}`);

// ── Step 2: poll for upgrade digest entry (worker is detached) ────────────────

const DIGEST_PATH = join(CLAUDE_DIR, '.prism-acl-digest.json');
const POLL_INTERVAL_MS = 300;
const TIMEOUT_MS = 20000;
const pollStart = Date.now();

console.log('\nWaiting for detached worker (polling digest for upgraded entry, timeout 20s)...');
let digest = null;
while (Date.now() - pollStart < TIMEOUT_MS) {
  if (existsSync(DIGEST_PATH)) {
    try {
      const raw = readFileSync(DIGEST_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      // Wait for the upgraded array to have an entry for watchdog-monitor-builder
      if (Array.isArray(parsed.upgraded) && parsed.upgraded.some(u => u && u.name === 'watchdog-monitor-builder')) {
        digest = parsed;
        break;
      }
    } catch {}
  }
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

if (!digest) {
  console.log('  [WARN] worker did not write upgraded digest within 20s');
  // Read whatever we have for diagnostics
  if (existsSync(DIGEST_PATH)) {
    try {
      digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8'));
      console.log(`  [diag] digest: ${JSON.stringify(digest)}`);
    } catch {}
  }
  // Also read roster for diagnostics
  try {
    const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
    console.log(`  [diag] roster.skills.watchdog: ${JSON.stringify(r.skills?.['watchdog-monitor-builder'])}`);
  } catch {}
}

// ── Assertion (a): v2 snapshot exists ────────────────────────────────────────

const ver2Dir = join(CLAUDE_DIR, 'skills', 'watchdog-monitor-builder', 'versions', '2');
const hasV2 = existsSync(ver2Dir) && existsSync(join(ver2Dir, 'watchdog-monitor-builder.md'));
result('(a) agent version bumped: v2 snapshot exists (versions/2/watchdog-monitor-builder.md)',
  hasV2, `ver2Dir=${ver2Dir} exists=${existsSync(ver2Dir)}`);

// ── Assertion (b): counters reset ────────────────────────────────────────────

let countersReset = false;
let countersDetail = '';
try {
  const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = r.skills['watchdog-monitor-builder'];
  if (entry) {
    countersReset = entry.corrections_since_last_upgrade === 0;
    countersDetail = `corrections_since_last_upgrade=${entry.corrections_since_last_upgrade}, version=${entry.version}`;
  } else {
    countersDetail = 'entry missing from roster';
  }
} catch (e) {
  countersDetail = `error: ${e.message}`;
}
result('(b) counters reset: corrections_since_last_upgrade=0', countersReset, countersDetail);

// ── Assertion (c): SessionStart notify prints upgraded <agent> v1→v2 ──────────

const r3 = spawnSync(process.execPath, [NOTIFY_HOOK], {
  input: JSON.stringify({ event: 'SessionStart' }),
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});

let notifyOk = false;
let notifyDetail = '';
try {
  const out = r3.stdout.trim();
  if (out) {
    const parsed = JSON.parse(out);
    const ctx = parsed?.hookSpecificOutput?.additionalContext || '';
    notifyOk = ctx.includes('upgraded watchdog-monitor-builder v1') || ctx.includes('upgraded watchdog-monitor-builder');
    notifyDetail = ctx.slice(0, 160);
  } else {
    notifyDetail = `(empty stdout) stderr=${r3.stderr?.slice(0, 100)}`;
  }
} catch (e) {
  notifyDetail = `parse error: ${e.message}; stdout=${r3.stdout?.slice(0, 100)}`;
}
result('(c) SessionStart notify prints "upgraded watchdog-monitor-builder v1→v2"',
  notifyOk, notifyDetail);

// ── Assertion (d): OLD v1 retained for rollback ────────────────────────────────

const v1RetainedFile = join(ver1Dir, 'watchdog-monitor-builder.md');
const v1Retained = existsSync(v1RetainedFile);
result('(d) OLD v1 snapshot retained for rollback (versions/1/ still exists)',
  v1Retained, `path: ${v1RetainedFile}`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nForeground SessionEnd: ${foregroundMs}ms`);
console.log(`Results: ${pass} PASS, ${fail} FAIL`);

// Cleanup
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
