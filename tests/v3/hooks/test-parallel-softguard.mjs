#!/usr/bin/env node
// tests/v3/hooks/test-parallel-softguard.mjs
//
// WS3.1 Wave-C acceptance test — 3 BINARY pre-reg criteria from
// docs/prism/specs/2026-06-23-PRISM-6.0.0-ACCEPTANCE-AND-PHASE4-PREREG.md §WS3.1:
//
//   (1) nudge line is emitted on the 2nd serial pgroup-tagged dispatch
//   (2) NO 'BLOCKED' / no exit-code 2 on EITHER dispatch (advisory-only)
//   (3) downstream Agent() call completes normally (call is allowed / not denied)
//
// Invocation pattern: drives hooks/prism-parallel-guard.mjs directly via
// subprocess (same as test-parallel-cap-enforce.mjs); uses an isolated HOME
// so trace + sentinel state is deterministic.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', '..', 'hooks', 'prism-parallel-guard.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const SESSION = 'ws31-softguard';

// Build an isolated HOME, write the sentinel and (optionally) a trace file
// seeded with `nEntries` entries all tagged with `pgroup`.
function makeHome({nEntries = 0, pgroup = 'ws31', turnId = 'turn1'} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ws31-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  // Sentinel: parent context (not a subagent), no force_opus.
  writeFileSync(
    join(home, '.claude', `.prism-turn-tier-${SESSION}.json`),
    JSON.stringify({tier: 'haiku', rationale: 't', source: 't', dispatched: false, turn_id: turnId})
  );
  if (nEntries > 0) {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < nEntries; i++) {
      // All entries within the 60s window, all tagged with the same pgroup.
      entries.push({ts: now - i * 200, pgroup, subagent_type: 'general-purpose', turn_id: turnId, dr: false});
    }
    writeFileSync(
      join(home, '.claude', `.prism-parallel-trace-${SESSION}.json`),
      JSON.stringify({entries}, null, 2)
    );
  }
  return home;
}

// Run the guard standalone (as Claude Code does) with a pgroup-tagged Agent
// payload. PRISM_PARALLEL_GUARD=soft forces soft mode regardless of any
// policy file; PRISM_POLICY_OVERRIDE=1 ensures env wins.
function runGuard(home, {pgroup = 'ws31', mode = 'soft'} = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CODE_ENTRYPOINT: 'cli',       // not a subagent context
    PRISM_PARALLEL_GUARD: mode,
    PRISM_POLICY_OVERRIDE: '1',
  };
  const payload = {
    tool_name: 'Agent',
    session_id: SESSION,
    tool_input: {
      subagent_type: 'general-purpose',
      description: `[pgroup:${pgroup}] parallel batch dispatch`,
      prompt: `do work for pgroup ${pgroup}`,
    },
  };
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env,
  });
  return {exit: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

// ── PRE-REG CRITERION (1): nudge line on 2nd serial pgroup-tagged dispatch ──
// Simulate: HOME has 1 prior same-pgroup trace entry (= 1st dispatch already
// recorded). This dispatch is the 2nd → guard MUST emit a nudge string.
test('criterion(1): nudge emitted on 2nd serial pgroup-tagged dispatch', () => {
  const home = makeHome({nEntries: 1, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'soft'});
    // The nudge must contain the guard's identifier text.
    assert(
      /PRISM PARALLEL-GUARD/i.test(r.stdout),
      `nudge text not found in stdout. Got: ${JSON.stringify(r.stdout)}`
    );
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── PRE-REG CRITERION (2a): exit code 0 on the 1st dispatch (NO exit-2) ──
test('criterion(2a): 1st dispatch — exit 0, no BLOCKED, no exit-2', () => {
  // Fresh HOME: no prior trace entries → first dispatch, no flagging.
  const home = makeHome({nEntries: 0, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'soft'});
    assert(r.exit === 0, `exit code must be 0 (got ${r.exit})`);
    assert(!/BLOCKED/i.test(r.stdout + r.stderr), 'no BLOCKED text on first dispatch');
    assert(!/BLOCKED/i.test(r.stdout), `BLOCKED in stdout: ${r.stdout}`);
    // permissionDecision must not be 'deny'
    try {
      const j = JSON.parse(r.stdout);
      const pd = j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision;
      assert(pd !== 'deny', `permissionDecision is 'deny' on first dispatch`);
    } catch { /* stdout not JSON → advisory plain text → fine */ }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── PRE-REG CRITERION (2b): exit code 0 on the 2nd dispatch (nudge, NOT block) ──
test('criterion(2b): 2nd dispatch — soft mode → exit 0, no BLOCKED, no exit-2', () => {
  const home = makeHome({nEntries: 1, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'soft'});
    assert(r.exit === 0, `exit code must be 0 in soft mode (got ${r.exit})`);
    assert(!/BLOCKED/i.test(r.stdout + r.stderr), 'no BLOCKED text in soft mode');
    // Must not carry a deny permissionDecision.
    try {
      const j = JSON.parse(r.stdout);
      const pd = j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision;
      assert(pd !== 'deny', `permissionDecision is 'deny' — that is a regression`);
    } catch { /* plain advisory text → fine */ }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── PRE-REG CRITERION (3): downstream Agent() call completes (not denied) ──
// Hard mode would return exit 2 + deny JSON. Soft mode (the default) returns
// exit 0 → the harness lets the Agent() call proceed. Confirm the call is
// ALLOWED (not denied) in soft/default mode for both dispatches.
test('criterion(3a): 1st dispatch allowed — no deny permissionDecision in result', () => {
  const home = makeHome({nEntries: 0, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'soft'});
    assert(r.exit !== 2, `exit 2 means deny — Agent() would be blocked (got ${r.exit})`);
    try {
      const j = JSON.parse(r.stdout);
      assert(
        !j || !j.hookSpecificOutput || j.hookSpecificOutput.permissionDecision !== 'deny',
        'deny JSON on first dispatch — Agent() blocked'
      );
    } catch { /* advisory plain text → allowed */ }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('criterion(3b): 2nd dispatch allowed in soft mode — Agent() not denied', () => {
  const home = makeHome({nEntries: 1, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'soft'});
    assert(r.exit !== 2, `exit 2 means deny — Agent() would be blocked on 2nd dispatch (got ${r.exit})`);
    try {
      const j = JSON.parse(r.stdout);
      assert(
        !j || !j.hookSpecificOutput || j.hookSpecificOutput.permissionDecision !== 'deny',
        'deny JSON on 2nd dispatch in soft mode — regression'
      );
    } catch { /* advisory plain text → allowed */ }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── SANITY: hard mode does deny on 2nd pgroup-tagged dispatch ──
// (Confirms the detection is real — hard blocks what soft nudges; not a pre-reg
// criterion but required to trust criteria (2) and (3) are meaningful.)
test('sanity: hard mode on 2nd dispatch → exit 2 + deny (confirms detection is real)', () => {
  const home = makeHome({nEntries: 1, pgroup: 'ws31'});
  try {
    const r = runGuard(home, {pgroup: 'ws31', mode: 'hard'});
    assert(r.exit === 2, `hard mode must exit 2 on 2nd dispatch (got ${r.exit})`);
    let j;
    try { j = JSON.parse(r.stdout); } catch { j = null; }
    assert(
      j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny',
      `hard mode must emit deny JSON, got: ${r.stdout}`
    );
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
