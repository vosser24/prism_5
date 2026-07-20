#!/usr/bin/env node
// tests/v3/hooks/test-subagent-stop-holding.mjs
// D042 pair for Release R2 fix F1-B — holding-string final-output DETECTOR.
//
// hooks/prism-subagent-stop.mjs run() now inspects input.last_assistant_message
// (the worker's FINAL assistant message, per the measured Claude Code 2.1.214
// SubagentStop payload) and, on a conservative match, appends ONE routing-log
// line:
//   {event:'holding_string_final', ts, session_id, agent}
// plus a one-line stderr advisory. This makes worker-stall/orphan results
// (UAT #56 — a dispatched worker whose final message is a "holding string"
// like "I'll hold here and wait for the background notification…") visible.
//
// Fixture style: temp HOME override (prismHome() reads HOME/USERPROFILE), and we
// drive the hook through its stdin shim as a subprocess so exit codes and the
// fail-open path are exercised end-to-end. Matches the pattern in
// test-subagent-stop-telemetry.mjs.
//
//   FIRE     : short holding-string last_assistant_message → exactly ONE
//              holding_string_final line + stderr advisory.
//   QUIET-1  : long, multi-line REAL result (>=500 chars) that happens to
//              contain "verifying" once → NO holding_string_final line
//              (proves the length/newline gate).
//   QUIET-2  : normal short success message → NO holding_string_final line.
//
// Run: node tests/v3/hooks/test-subagent-stop-holding.mjs

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-subagent-stop.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? '\n        ' + detail : ''}\n`); }
}

// Spawn the hook as a real hook process with an isolated temp HOME.
function runHook(home, stdinText, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.PRISM_DEBUG_SUBAGENT_PAYLOAD;
  Object.assign(env, extraEnv);
  const res = spawnSync(process.execPath, [HOOK], { input: stdinText, env, encoding: 'utf-8' });
  return res;
}

function routingLog(home) { return join(home, '.claude', '.prism-routing.jsonl'); }

// Parse all holding_string_final events from a home's routing log.
function holdingEvents(home) {
  const p = routingLog(home);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'holding_string_final');
}

// ── FIRE: short holding-string final message → exactly one line + stderr ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-hold-fire-'));
  try {
    const payload = {
      agent_type: 'stalled-worker',
      session_id: 'sess-hold-fire',
      last_assistant_message: "verifying… I'll hold here and wait for the background notification",
    };
    const res = runHook(home, JSON.stringify(payload));
    check('FIRE: hook exits 0', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    const evs = holdingEvents(home);
    check('FIRE: exactly ONE holding_string_final line appended', evs.length === 1, `got ${evs.length}`);
    const ev = evs[0] || {};
    check('FIRE: event=holding_string_final', ev.event === 'holding_string_final');
    check('FIRE: session_id carried', ev.session_id === 'sess-hold-fire', `got ${ev.session_id}`);
    check('FIRE: agent resolved from payload', ev.agent === 'stalled-worker', `got ${ev.agent}`);
    check('FIRE: ts present (ISO)', typeof ev.ts === 'string' && ev.ts.includes('T'));
    check('FIRE: stderr advisory emitted', /HOLDING-STRING/.test(res.stderr || ''), `stderr=${res.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── QUIET-1: long multi-line REAL result containing "verifying" once → no fire ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-hold-quiet1-'));
  try {
    const realResult = [
      'Summary of changes:',
      '- Added a new detector in hooks/prism-subagent-stop.mjs that reads the',
      '  final assistant message and matches it against a conservative regex.',
      '- Added a D042 test pair verifying (once) both the fire and quiet cases.',
      '- Ran node --check on the hook file: no syntax errors.',
      '- Ran the full test suite: 14 passed, 0 failed.',
      '- Confirmed git status shows only the two expected files changed.',
      '- Confirmed the detector never exits non-zero and is wrapped in try/catch.',
      '- Diff stat: hooks/prism-subagent-stop.mjs | 45 +++++++++++++++++++++++++.',
      '- All acceptance criteria from the spec have been met and verified.',
      'This message is intentionally long and multi-line to exceed the 400-char',
      'and newline-count gates so it is treated as a real result, not a holding',
      'string, even though it contains the word verifying exactly once above.',
    ].join('\n');
    check('QUIET-1 fixture length >= 500 chars', realResult.length >= 500, `len=${realResult.length}`);
    const payload = {
      agent_type: 'real-worker',
      session_id: 'sess-hold-quiet1',
      last_assistant_message: realResult,
    };
    const res = runHook(home, JSON.stringify(payload));
    check('QUIET-1: hook exits 0', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    const evs = holdingEvents(home);
    check('QUIET-1: NO holding_string_final line (length/newline gate)', evs.length === 0, `got ${evs.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── QUIET-2: normal short success message → no fire ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-hold-quiet2-'));
  try {
    const payload = {
      agent_type: 'normal-worker',
      session_id: 'sess-hold-quiet2',
      last_assistant_message: 'Done — all 14 tests pass.',
    };
    const res = runHook(home, JSON.stringify(payload));
    check('QUIET-2: hook exits 0', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    const evs = holdingEvents(home);
    check('QUIET-2: NO holding_string_final line (ordinary success message)', evs.length === 0, `got ${evs.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── QUIET-3..5: F1-B precision-tightening false-fire regressions (no-author validator) ──
// These three previously fired on the old regex (bare `verif(y|ying)`, bare
// `waiting for`, and `stand ?by` matching the plain word "Standby"). The
// tightened HOLDING_RE must stay quiet on all three.
{
  const cases = [
    ['QUIET-3 (Standby ordinary word)', 'Standby generator config updated.'],
    ['QUIET-4 (imperative verify)', 'All done — verify with npm test.'],
    ['QUIET-5 (waiting for review, non-holding object)', 'No tasks were waiting for review.'],
  ];
  for (const [label, msg] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'prism-substop-hold-quiet345-'));
    try {
      const payload = {
        agent_type: 'normal-worker',
        session_id: 'sess-hold-quiet345',
        last_assistant_message: msg,
      };
      const res = runHook(home, JSON.stringify(payload));
      check(`${label}: hook exits 0`, res.status === 0, `status=${res.status} stderr=${res.stderr}`);
      const evs = holdingEvents(home);
      check(`${label}: NO holding_string_final line`, evs.length === 0, `got ${evs.length} for "${msg}"`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

// ── FIRE-2..3: true holding strings must still fire after tightening ──
{
  const cases = [
    ['FIRE-2 (verifying + will report back)', 'verifying… will report back'],
    ['FIRE-3 (waiting for background notification)', 'waiting for the background notification'],
  ];
  for (const [label, msg] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'prism-substop-hold-fire23-'));
    try {
      const payload = {
        agent_type: 'stalled-worker',
        session_id: 'sess-hold-fire23',
        last_assistant_message: msg,
      };
      const res = runHook(home, JSON.stringify(payload));
      check(`${label}: hook exits 0`, res.status === 0, `status=${res.status} stderr=${res.stderr}`);
      const evs = holdingEvents(home);
      check(`${label}: exactly ONE holding_string_final line`, evs.length === 1, `got ${evs.length} for "${msg}"`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
