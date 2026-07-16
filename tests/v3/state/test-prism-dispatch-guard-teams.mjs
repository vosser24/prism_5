#!/usr/bin/env node
// v2.7.0 (D043) — AGENT-TEAMS TOPOLOGY handling in prism-parent-dispatch-guard.mjs.
//
// Root cause (D043, docs/prism/deviations/2026-07-14-guard-forensics-shared-
// sentinel-latch.md): under agent-teams every teammate is a top-level CLI session
// sharing ONE session_id, so `sentinel.dispatched` (session-global, no caller
// dimension) cannot gate per-caller. One root cause, two failure modes: a loud
// false-DENY (legit worker blocked because the shared flag was just reset) and a
// SILENT false-ALLOW (teammate mutates freely on an unrelated teammate's dispatch).
//
// This test pins the fix (all gated behind PRISM_DISPATCH_GUARD_TEAMS + the
// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS marker, fail-safe to prior behavior):
//   (a) HARD PRESERVED  — no teams marker, dispatched=false, Write → deny exit 2.
//   (b) FALSE-DENY CLOSED — teams marker, dispatched=false, Write → advisory exit 0
//                           (additionalContext, NOT a deny).
//   (c) FALSE-ALLOW VISIBLE — teams marker, dispatched=true, Write → allow exit 0
//                           + a `borrowed_unlock` log record + in-band advisory.
//   (d) KILL-SWITCH — teams + PRISM_DISPATCH_GUARD_TEAMS=hard restores exit 2 deny
//                     on (b); PRISM_DISPATCH_GUARD=off disables the whole guard.
//   (+) FAIL-SAFE — no teams marker, dispatched=true → SILENT pass (byte-identical
//                   to prior behavior: exit 0, no output, no borrowed_unlock log).
//
// Runs the guard as a SUBPROCESS (exercises run() via the standalone shim, the
// exact wire path Claude Code uses) so per-case env is controlled at module-load —
// env consts (MODE/TEAMS_MODE/IN_AGENT_TEAMS) are read once at import, so a
// subprocess per case is the only way to vary them, matching every sibling test.
//
// Run: node tests/v3/state/test-prism-dispatch-guard-teams.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-parent-dispatch-guard.mjs');

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) { pass++; } else { console.log('FAIL: ' + l); } };

const SID = 'teams-guard-test';

// Run the guard with an isolated temp HOME + explicit env + a seeded sentinel.
// Returns {status, out, log} where log is the parsed routing-log lines written
// into the temp HOME (so borrowed_unlock records are asserted off disk, not from
// the guard's stdout).
function runGuard(payload, sentinel, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-teams-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`), JSON.stringify(sentinel));
    // Baseline env: clear BOTH ambient markers so each case controls its own
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

const WRITE = { tool_name: 'Write', tool_input: { file_path: 'a.ts', content: 'x' } };
const SENT_UNDISPATCHED = { tier: 'haiku', dispatched: false, force_opus: false, summon_panel: false, rationale: 'test', source: 'test' };
const SENT_DISPATCHED   = { tier: 'haiku', dispatched: true,  force_opus: false, summon_panel: false, rationale: 'test', source: 'test' };

const isDeny = (r) => r.status === 2 && /permissionDecision":"deny/.test(r.out);
const hasAdditionalContext = (r) => /additionalContext/.test(r.out) && !/permissionDecision":"deny/.test(r.out);
const hasBorrowedLog = (r) => r.log.some(e => e.event === 'borrowed_unlock');

// ── (a) HARD PRESERVED: no teams marker → prior hard-deny, unchanged ──
{
  const r = runGuard(WRITE, SENT_UNDISPATCHED); // teams marker cleared by default
  check('(a) HARD PRESERVED: no-teams + dispatched=false + Write → deny exit 2', isDeny(r));
  check('(a) deny carries the honest single-actor CAVEAT text (D043)', /CAVEAT \(D043\)/.test(r.out));
}

// ── (b) FALSE-DENY CLOSED: teams marker → advisory exit 0, not a deny ──
{
  const r = runGuard(WRITE, SENT_UNDISPATCHED, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
  check('(b) FALSE-DENY CLOSED: teams + dispatched=false + Write → exit 0 (NOT denied)', r.status === 0 && !/permissionDecision":"deny/.test(r.out));
  check('(b) advisory additionalContext present + labeled ADVISORY', hasAdditionalContext(r) && /ADVISORY/.test(r.out));
}

// ── (c) FALSE-ALLOW VISIBLE: teams + dispatched=true → allow + borrowed_unlock ──
{
  const r = runGuard(WRITE, SENT_DISPATCHED, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
  check('(c) FALSE-ALLOW VISIBLE: teams + dispatched=true + Write → allow exit 0', r.status === 0);
  check('(c) a borrowed_unlock record is written to the routing log', hasBorrowedLog(r));
  check('(c) the borrowed-unlock advisory is emitted in-band (additionalContext)', hasAdditionalContext(r) && /BORROWED/.test(r.out));
}

// ── (d) KILL-SWITCH ──
{
  // teams + PRISM_DISPATCH_GUARD_TEAMS=hard → restores the exit-2 deny on case (b).
  const r1 = runGuard(WRITE, SENT_UNDISPATCHED, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PRISM_DISPATCH_GUARD_TEAMS: 'hard' });
  check('(d) kill-switch TEAMS=hard restores exit 2 deny on case (b)', isDeny(r1));

  // teams + hard-mode borrowed unlock → NO borrowed_unlock log (prior behavior restored, silent pass).
  const r2 = runGuard(WRITE, SENT_DISPATCHED, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PRISM_DISPATCH_GUARD_TEAMS: 'hard' });
  check('(d) kill-switch TEAMS=hard: dispatched=true → silent pass, no borrowed_unlock log', r2.status === 0 && r2.out === '' && !hasBorrowedLog(r2));

  // master switch PRISM_DISPATCH_GUARD=off → whole guard disabled (exit 0, no output).
  const r3 = runGuard(WRITE, SENT_UNDISPATCHED, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', PRISM_DISPATCH_GUARD: 'off' });
  check('(d) master switch PRISM_DISPATCH_GUARD=off disables the guard (exit 0, no output)', r3.status === 0 && r3.out === '');
}

// ── (+) FAIL-SAFE: no teams marker + dispatched=true → SILENT pass, byte-identical ──
{
  const r = runGuard(WRITE, SENT_DISPATCHED); // no teams marker
  check('(+) FAIL-SAFE: no-teams + dispatched=true → silent pass (exit 0, no output, no borrowed_unlock)',
    r.status === 0 && r.out === '' && !hasBorrowedLog(r));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
