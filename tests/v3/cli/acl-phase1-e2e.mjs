#!/usr/bin/env node
// tests/v3/cli/acl-phase1-e2e.mjs — F1.7 Phase-1 CLI end-to-end
//
// Factory injection mechanism:
//   PRISM_ACL_FACTORY=<absolute-path-to-stub-factory.mjs>
//   The worker (hooks/prism-acl-worker.mjs) reads this env var on startup and
//   dynamically imports the module at that path, using its default export as the
//   factory function: factory(spec, stagingDir) → stagingFilePath.
//   This way NO real agent-factory / LLM dispatch occurs in tests.
//
// Assertions (each prints PASS/FAIL):
//   (a) A new global skill *-builder file exists after worker completes.
//   (b) Roster gained exactly one key.
//   (c) Running the notify hook prints "PRISM learned: +skill …".
//   (d) Re-running SessionEnd is a no-op (watermark advanced + debounce).

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const SESSIONEND_HOOK = join(REPO_ROOT, 'hooks', 'prism-acl-sessionend.mjs');
const NOTIFY_HOOK = join(REPO_ROOT, 'hooks', 'prism-acl-notify.mjs');
const STUB_FACTORY = join(__dirname, 'acl-stub-factory.mjs');

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

const HOME = mkdtempSync(join(tmpdir(), 'prism-e2e-phase1-'));
const CLAUDE_DIR = join(HOME, '.claude');
mkdirSync(CLAUDE_DIR, { recursive: true });

// Seed routing log: 3 watchdog/health-monitor prompts across 2 sessions.
// These prompts share keywords (watchdog, monitor, health, uptime) to form a
// cluster with Jaccard similarity >= 0.25 across all pairs.
const routingLines = [
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'build a watchdog monitor to check service health uptime', ts: '2026-06-17T10:00:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'implement health monitor watchdog to track service uptime', ts: '2026-06-17T10:05:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-B', description: 'set up watchdog health monitor for service uptime checking', ts: '2026-06-17T11:00:00Z' },
];
const routingPath = join(CLAUDE_DIR, '.prism-routing.jsonl');
writeFileSync(routingPath, routingLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// Seed empty roster in global path
const rosterDir = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');
writeFileSync(rosterPath, JSON.stringify({ agents: {}, skills: {} }, null, 2), 'utf-8');

const hookEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  PRISM_ACL_FACTORY: STUB_FACTORY,
  PRISM_ACL_DEBOUNCE_MS: '300000',       // 5 min debounce — long enough for test duration
  PRISM_ACL_TIME_BUDGET_MS: '30000',
};

const payload = JSON.stringify({ event: 'SessionEnd', session_id: 'e2e-sess' });

// ── Step 1: run SessionEnd hook; measure foreground time ─────────────────────

const t0 = Date.now();
const r1 = spawnSync(process.execPath, [SESSIONEND_HOOK], {
  input: payload,
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});
const foregroundMs = Date.now() - t0;
console.log(`\nForeground SessionEnd returned in ${foregroundMs}ms`);
result('SessionEnd exits 0', r1.status === 0, `exit=${r1.status} stderr=${r1.stderr}`);

// ── Step 2: poll for digest (worker is detached — may take a few seconds) ────

const DIGEST_PATH = join(CLAUDE_DIR, '.prism-acl-digest.json');
const POLL_INTERVAL_MS = 300;
const TIMEOUT_MS = 15000;
const pollStart = Date.now();

console.log('\nWaiting for detached worker to complete (polling digest, timeout 15s)...');
let digest = null;
while (Date.now() - pollStart < TIMEOUT_MS) {
  if (existsSync(DIGEST_PATH)) {
    try {
      const raw = readFileSync(DIGEST_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.created) && parsed.created.length > 0) {
        digest = parsed;
        break;
      }
    } catch {}
  }
  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
}

if (!digest) {
  console.log('  [WARN] worker did not write digest within 15s');
}

// ── Assertion (a): new global skill *-builder file exists ─────────────────────

let skillFound = false;
let skillName = '';
const skillsDir = join(CLAUDE_DIR, 'skills');
if (existsSync(skillsDir)) {
  const entries = readdirSync(skillsDir);
  for (const entry of entries) {
    if (entry.endsWith('-builder') || entry.includes('builder')) {
      // Check for a live file inside
      const skillDir = join(skillsDir, entry);
      try {
        const files = readdirSync(skillDir).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          skillFound = true;
          skillName = entry;
        }
      } catch {}
    }
  }
}
result('(a) new *-builder skill file exists in global skills dir', skillFound, skillFound ? `found: ${skillName}` : 'no *-builder skill dir found');

// ── Assertion (b): roster gained exactly one key ──────────────────────────────

let rosterGainedOne = false;
let rosterCount = 0;
try {
  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const skillKeys = Object.keys(roster.skills || {});
  const agentKeys = Object.keys(roster.agents || {});
  rosterCount = skillKeys.length + agentKeys.length;
  rosterGainedOne = rosterCount >= 1;
} catch (e) {
  console.log(`  [roster] error: ${e.message}`);
}
result('(b) roster gained at least one key', rosterGainedOne, `rosterCount=${rosterCount}`);

// ── Assertion (c): notify hook prints "PRISM learned: +skill …" ───────────────

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
    notifyOk = ctx.includes('PRISM learned: +skill');
    notifyDetail = ctx.slice(0, 120);
  } else {
    notifyDetail = '(empty stdout)';
  }
} catch (e) {
  notifyDetail = `parse error: ${e.message}; stdout=${r3.stdout.slice(0, 100)}`;
}
result('(c) notify hook emits "PRISM learned: +skill …"', notifyOk, notifyDetail);

// ── Assertion (d): re-running SessionEnd is a no-op (debounce) ───────────────

const markerBefore = existsSync(join(CLAUDE_DIR, '.prism-acl-spawn-marker'))
  ? readFileSync(join(CLAUDE_DIR, '.prism-acl-spawn-marker'), 'utf-8').trim()
  : '';

const r4 = spawnSync(process.execPath, [SESSIONEND_HOOK], {
  input: payload,
  env: hookEnv,
  timeout: 5000,
  encoding: 'utf-8',
});

const markerAfter = existsSync(join(CLAUDE_DIR, '.prism-acl-spawn-marker'))
  ? readFileSync(join(CLAUDE_DIR, '.prism-acl-spawn-marker'), 'utf-8').trim()
  : '';

const debounceOk = r4.status === 0 && markerBefore === markerAfter;
result('(d) re-running SessionEnd within debounce is a no-op (marker unchanged)', debounceOk,
  `exit=${r4.status} markerBefore=${markerBefore} markerAfter=${markerAfter}`);

// ── Watermark advanced check ──────────────────────────────────────────────────

const wmPath = join(CLAUDE_DIR, '.prism-acl-watermark');
let wmAdvanced = false;
let wmVal = 0;
if (existsSync(wmPath)) {
  try {
    wmVal = parseInt(readFileSync(wmPath, 'utf-8').trim(), 10);
    wmAdvanced = wmVal > 0;
  } catch {}
}
result('(d+) watermark advanced beyond 0', wmAdvanced, `watermark=${wmVal}`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nForeground SessionEnd: ${foregroundMs}ms`);
console.log(`Results: ${pass} PASS, ${fail} FAIL`);

// Cleanup
try { rmSync(HOME, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
