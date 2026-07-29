#!/usr/bin/env node
// RB-04 — dispatch-guard SILENT-ALLOW visibility fix.
//
// Root cause: several `return done(0)` pass-through sites in
// prism-parent-dispatch-guard.mjs allow the tool call but never write a
// routing-log record — including the `sentinel.force_opus` early-allow,
// which is the documented in-session escape hatch for a false-positive
// panel/dispatch block (FIX-A). A silent allow there means the escape
// hatch's usage is invisible to the routing log / telemetry.
//
// This test pins two things:
//   (RED-now -> GREEN-after) force_opus allow now emits exactly one
//     `dispatch_guard` record with blocked:false, reason:"force_opus",
//     source carried from the sentinel.
//   (regression) the existing hard-deny path (haiku tier, no dispatch,
//     teams hard-mode) is UNCHANGED — still exit 2.
//
// Runs the guard as a SUBPROCESS (exercises run() via the standalone shim)
// with an isolated temp HOME + explicit env + a seeded per-session sentinel,
// matching the sibling test-prism-dispatch-guard-teams.mjs harness.
//
// Run: node tests/v3/state/test-prism-dispatch-guard-visibility.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-parent-dispatch-guard.mjs');

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) { pass++; } else { console.log('FAIL: ' + l); } };

const SID = 'visibility-guard-test';

// Run the guard with an isolated temp HOME + explicit env + a seeded sentinel.
// Returns {status, out, log} where log is the parsed routing-log lines written
// into the temp HOME (so dispatch_guard records are asserted off disk, not from
// the guard's stdout).
function runGuard(payload, sentinel, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-visibility-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`), JSON.stringify(sentinel));
    // Baseline env: clear both ambient markers so each case controls its own
    // topology deterministically (the harness itself may run inside agent-teams).
    const env = {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CODE_ENTRYPOINT: '',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '',
      ...extraEnv,
    };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, ...payload }),
      encoding: 'utf-8', env, timeout: 10000, windowsHide: true,
    });
    const logPath = join(home, '.claude', '.prism-routing.jsonl');
    let log = [];
    if (existsSync(logPath)) {
      log = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
    }
    return { status: r.status, out: r.stdout || '', log };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const WRITE = { tool_name: 'Write', tool_input: { file_path: 'x/ledger.mjs', content: 'x' } };

const SENT_FORCE_OPUS = {
  tier: 'opus', force_opus: true, dispatched: false, summon_panel: false,
  source: 'conversation-model-override', routine_bypass: false,
};
const SENT_HAIKU_UNDISPATCHED = {
  tier: 'haiku', force_opus: false, dispatched: false, summon_panel: false,
  source: 'conversation-model-override', routine_bypass: false,
};

const ENV = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  PRISM_DISPATCH_GUARD_TEAMS: 'hard',
  PRISM_DISPATCH_GUARD: 'hard',
};

const isDeny = (r) => r.status === 2 && /permissionDecision":"deny/.test(r.out);

// ── RED-now -> GREEN-after: force_opus allow now emits exactly one dispatch_guard record ──
{
  const r = runGuard(WRITE, SENT_FORCE_OPUS, ENV);
  check('force_opus: exit 0 (allowed)', r.status === 0);
  const matches = r.log.filter(e => e.event === 'dispatch_guard');
  check('force_opus: exactly one dispatch_guard record written', matches.length === 1);
  const rec = matches[0] || {};
  check('force_opus: record has blocked:false', rec.blocked === false);
  check('force_opus: record has reason:"force_opus"', rec.reason === 'force_opus');
  check('force_opus: record has source:"conversation-model-override"', rec.source === 'conversation-model-override');
}

// ── GREEN regression: haiku tier, no dispatch → hard-deny unchanged ──
{
  const r = runGuard(WRITE, SENT_HAIKU_UNDISPATCHED, ENV);
  check('haiku undispatched: hard-deny unchanged (exit 2)', isDeny(r));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
