#!/usr/bin/env node
// tests/v3/state/test-prism-routine-single-pass-gate.mjs
//
// TDD — routine single-pass gate (v6.1.0).
// Verifies all 8 invariants of the gate added to hooks/prism-parent-dispatch-guard.mjs.
//
// Invariants:
//  1. FIRST dispatch on a routine turn ALWAYS passes (dispatched=false → isRedispatch false).
//  2. Same-message parallel siblings pass: dispatched_ts=now-100ms → inBatchWindow → pass.
//  3a. Later sequential re-dispatch (routine, dispatched=true, ts=now-30s): SOFT → advisory + PASS.
//  3b. Later sequential re-dispatch (routine, dispatched=true, ts=now-30s): ENFORCE → DENY.
//  4. After single_pass_nudged=true, a third dispatch passes silently (nudge at most ONCE).
//  5. force_opus / opus tier / routine_bypass=false → gate never fires.
//  6. PRISM_ROUTINE_SINGLE_PASS=off → gate never fires.
//  7. TaskCreate is NOT gated (only Agent).
//  8. dispatch_count is NOT read for any decision (telemetry only).
//
// Run: node tests/v3/state/test-prism-routine-single-pass-gate.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const DISPATCH_GUARD = join(REPO, 'hooks', 'prism-parent-dispatch-guard.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-rsp-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}
function sentinelPath(home, sessionId) {
  return join(home, '.claude', `.prism-turn-tier-${sessionId}.json`);
}
function seedSentinel(home, sessionId, obj) {
  writeFileSync(sentinelPath(home, sessionId), JSON.stringify(obj));
}
function readSentinel(home, sessionId) {
  try { return JSON.parse(readFileSync(sentinelPath(home, sessionId), 'utf-8')); } catch { return null; }
}

// Run the dispatch guard hook with given env overrides and payload.
// Returns {status, stdout, stderr}.
function runGuard(home, payload, envOverrides = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PRISM_DISPATCH_GUARD: 'hard',  // default hard for existing behaviour
    // default: PRISM_ROUTINE_SINGLE_PASS not set → defaults to 'soft'
    ...envOverrides,
  };
  const r = spawnSync(process.execPath, [DISPATCH_GUARD], {
    encoding: 'utf-8',
    input: JSON.stringify(payload),
    env,
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Helper: an Agent dispatch payload in parent context (no parent_tool_use_id).
function agentPayload(sessionId, opts = {}) {
  return {
    tool_name: opts.toolName ?? 'Agent',
    session_id: sessionId,
    tool_input: {
      subagent_type: opts.subagentType ?? 'general-purpose',
      model: opts.model ?? 'sonnet',
      prompt: opts.prompt ?? 'do the work',
      ...opts.toolInputExtra,
    },
  };
}

// A routine sentinel where dispatched=false (first dispatch).
function routineFirstSentinel() {
  return {
    tier: 'sonnet',
    routine_bypass: true,
    dispatched: false,
    dispatched_ts: null,
    force_opus: false,
    summon_panel: false,
    orchestrator_dispatched: false,
    dispatch_count: 0,
    single_pass_nudged: false,
    source: 'keyword-floor',
    rationale: 'test routine first',
    ts: new Date().toISOString(),
  };
}

// A routine sentinel where dispatched=true, dispatched_ts is far in the past
// (simulates a genuinely-later sequential re-dispatch, outside batch window).
function routineRedispatchSentinel(overrides = {}) {
  return {
    tier: 'sonnet',
    routine_bypass: true,
    dispatched: true,
    dispatched_ts: new Date(Date.now() - 30_000).toISOString(),  // 30s ago — well outside 8s window
    force_opus: false,
    summon_panel: false,
    orchestrator_dispatched: false,
    dispatch_count: 1,
    single_pass_nudged: false,
    source: 'keyword-floor',
    rationale: 'test routine redispatch',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

// ── INVARIANT 1: First dispatch on a routine turn ALWAYS passes ───────────────
// dispatched=false → isRedispatch is false → gate never fires → Agent passes.
test('INV-1: first dispatch on a routine turn passes (dispatched=false)', () => {
  const home = makeHome(); const sid = 'rsp-inv1';
  try {
    seedSentinel(home, sid, routineFirstSentinel());
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });
    assertEq(r.status, 0, 'first dispatch must PASS (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'first dispatch must NOT emit single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 2: Same-message parallel siblings pass (in batch window) ────────
// dispatched=true, dispatched_ts=now-100ms → inBatchWindow=true → pass silently.
test('INV-2: parallel sibling within batch window passes silently (in-batch)', () => {
  const home = makeHome(); const sid = 'rsp-inv2';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({
      dispatched_ts: new Date(Date.now() - 100).toISOString(),  // 100ms ago → inside 8s window
    }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
      PRISM_ROUTINE_BATCH_WINDOW_MS: '8000',
    });
    assertEq(r.status, 0, 'parallel sibling must PASS (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'parallel sibling must NOT emit single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 3a: Later sequential re-dispatch — SOFT mode → advisory + PASS ──
// dispatched=true, dispatched_ts=now-30s, routine_bypass=true, SOFT mode.
test('INV-3a: later sequential re-dispatch in SOFT mode → advisory emitted, exit 0', () => {
  const home = makeHome(); const sid = 'rsp-inv3a';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });
    assertEq(r.status, 0, 'SOFT mode must NOT deny (exit 0)');
    assert(
      r.stdout.includes('ROUTINE SINGLE-PASS'),
      'SOFT mode must emit advisory text, got: ' + r.stdout,
    );
    // Must be advisory context, not a deny JSON
    assert(
      !r.stdout.includes('"permissionDecision"'),
      'SOFT mode must NOT emit deny JSON permissionDecision, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 3b: Later sequential re-dispatch — ENFORCE mode → DENY (exit 2) ─
test('INV-3b: later sequential re-dispatch in ENFORCE mode → deny JSON, exit 2', () => {
  const home = makeHome(); const sid = 'rsp-inv3b';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    assertEq(r.status, 2, 'ENFORCE mode must deny (exit 2)');
    assert(
      r.stdout.includes('ROUTINE SINGLE-PASS'),
      'ENFORCE mode deny must include ROUTINE SINGLE-PASS text, got: ' + r.stdout,
    );
    // Must be a deny JSON
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      throw new Error('ENFORCE mode must emit valid JSON deny, parse error: ' + e.message + ', got: ' + r.stdout);
    }
    assertEq(
      parsed?.hookSpecificOutput?.permissionDecision, 'deny',
      'ENFORCE deny JSON must have permissionDecision=deny',
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 4: Nudge fires AT MOST ONCE — after single_pass_nudged=true, silent pass ──
test('INV-4: after single_pass_nudged=true, subsequent dispatch passes silently (once-per-turn)', () => {
  const home = makeHome(); const sid = 'rsp-inv4';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({
      single_pass_nudged: true,  // already nudged this turn
    }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });
    assertEq(r.status, 0, 'already-nudged dispatch must PASS silently (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'already-nudged dispatch must NOT re-emit advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Same for ENFORCE — after nudged=true, even enforce does not re-deny.
test('INV-4b: after single_pass_nudged=true, ENFORCE mode also passes silently', () => {
  const home = makeHome(); const sid = 'rsp-inv4b';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({
      single_pass_nudged: true,
    }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    assertEq(r.status, 0, 'already-nudged dispatch must PASS even in ENFORCE (exit 0)');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 5a: force_opus → gate never fires ──────────────────────────────
// When force_opus=true the router sets routine_bypass=false (confirmed by
// test-prism-dispatch-count-schema.mjs INV-2). The gate reads routine_bypass;
// with routine_bypass=false the isRedispatch condition is false → gate never fires.
test('INV-5a: force_opus=true on sentinel → routine_bypass=false → gate never fires, passes', () => {
  const home = makeHome(); const sid = 'rsp-inv5a';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({
      force_opus: true,
      routine_bypass: false,  // router always sets routine_bypass=false when force_opus=true
    }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    // routine_bypass=false → isRedispatch=false → gate never fires → exit 0
    assertEq(r.status, 0, 'force_opus must bypass gate (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'force_opus must produce no single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 5b: opus tier (routine_bypass=false) → gate never fires ─────────
test('INV-5b: opus tier (routine_bypass=false) → gate never fires', () => {
  const home = makeHome(); const sid = 'rsp-inv5b';
  try {
    seedSentinel(home, sid, {
      tier: 'opus',
      routine_bypass: false,   // opus is never routine_bypass
      dispatched: true,
      dispatched_ts: new Date(Date.now() - 30_000).toISOString(),
      force_opus: false,
      summon_panel: false,
      orchestrator_dispatched: false,
      dispatch_count: 1,
      single_pass_nudged: false,
      source: 'keyword-floor',
      rationale: 'test opus turn',
      ts: new Date().toISOString(),
    });
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    // opus tier falls through: `if (sentinel.tier === 'opus') return done(0)` at line 385
    assertEq(r.status, 0, 'opus tier must bypass gate (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'opus tier must produce no single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 5c: routine_bypass=false (haiku/sonnet with no routine_bypass) ──
// This can't normally happen (router always sets routine_bypass for haiku/sonnet),
// but gate must not fire if routine_bypass is explicitly false.
test('INV-5c: routine_bypass=false on a sonnet sentinel → gate never fires', () => {
  const home = makeHome(); const sid = 'rsp-inv5c';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({
      routine_bypass: false,   // explicitly not a routine turn
    }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    // Without routine_bypass, isRedispatch is false; Agent falls through ALWAYS_ALLOW → pass.
    assertEq(r.status, 0, 'routine_bypass=false must bypass gate (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'routine_bypass=false must produce no single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 6: PRISM_ROUTINE_SINGLE_PASS=off → gate never fires ─────────────
test('INV-6: PRISM_ROUTINE_SINGLE_PASS=off → gate never fires regardless of sentinel', () => {
  const home = makeHome(); const sid = 'rsp-inv6';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'off',
    });
    assertEq(r.status, 0, 'off mode must PASS (exit 0)');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'off mode must NOT emit single-pass advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 7: TaskCreate is NOT gated (only Agent) ─────────────────────────
test('INV-7: TaskCreate is not gated by the routine single-pass gate', () => {
  const home = makeHome(); const sid = 'rsp-inv7';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    const r = runGuard(home, {
      tool_name: 'TaskCreate',
      session_id: sid,
      tool_input: { description: 'some task', prompt: 'do it' },
    }, {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });
    assertEq(r.status, 0, 'TaskCreate must PASS (exit 0) — gate is Agent-only');
    assert(
      !r.stdout.includes('ROUTINE SINGLE-PASS'),
      'TaskCreate must NOT trigger single-pass gate, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── INVARIANT 8: dispatch_count is NOT read for any decision (telemetry only) ──
// Vary dispatch_count to very large/zero values; gate must still fire on
// isRedispatch condition (not on dispatch_count value).
test('INV-8a: gate fires regardless of dispatch_count=0 (telemetry not read)', () => {
  const home = makeHome(); const sid = 'rsp-inv8a';
  try {
    // dispatch_count=0 but dispatched=true (contradictory but valid for testing)
    seedSentinel(home, sid, routineRedispatchSentinel({ dispatch_count: 0 }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });
    assertEq(r.status, 0, 'SOFT advisory must still exit 0 regardless of dispatch_count');
    assert(
      r.stdout.includes('ROUTINE SINGLE-PASS'),
      'gate must still fire even when dispatch_count=0, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('INV-8b: gate fires regardless of dispatch_count=999 (telemetry not read)', () => {
  const home = makeHome(); const sid = 'rsp-inv8b';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel({ dispatch_count: 999 }));
    const r = runGuard(home, agentPayload(sid), {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });
    assertEq(r.status, 0, 'gate fires regardless of dispatch_count=999');
    assert(
      r.stdout.includes('ROUTINE SINGLE-PASS'),
      'gate must fire with dispatch_count=999, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── Bonus: sentinel is updated with single_pass_nudged=true after gate fires ──
test('BONUS: sentinel gets single_pass_nudged=true after gate fires in SOFT mode', () => {
  const home = makeHome(); const sid = 'rsp-bonus1';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    runGuard(home, agentPayload(sid), { PRISM_ROUTINE_SINGLE_PASS: 'soft' });
    const updated = readSentinel(home, sid);
    assertEq(updated?.single_pass_nudged, true, 'sentinel.single_pass_nudged must be true after gate fires');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('BONUS: sentinel gets single_pass_nudged=true after gate fires in ENFORCE mode', () => {
  const home = makeHome(); const sid = 'rsp-bonus2';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    runGuard(home, agentPayload(sid), { PRISM_ROUTINE_SINGLE_PASS: 'enforce' });
    const updated = readSentinel(home, sid);
    assertEq(updated?.single_pass_nudged, true, 'sentinel.single_pass_nudged must be true after ENFORCE deny');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── Default mode is SOFT (no env var) — advisory, not deny ───────────────────
test('DEFAULT: without PRISM_ROUTINE_SINGLE_PASS env, defaults to soft (advisory + exit 0)', () => {
  const home = makeHome(); const sid = 'rsp-default';
  try {
    seedSentinel(home, sid, routineRedispatchSentinel());
    // Do NOT set PRISM_ROUTINE_SINGLE_PASS — should default to soft
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PRISM_DISPATCH_GUARD: 'hard',
    };
    delete env.PRISM_ROUTINE_SINGLE_PASS;
    const r = spawnSync(process.execPath, [DISPATCH_GUARD], {
      encoding: 'utf-8',
      input: JSON.stringify(agentPayload(sid)),
      env,
      timeout: 15000,
    });
    assertEq(r.status, 0, 'default (soft) must not deny (exit 0)');
    assert(
      r.stdout.includes('ROUTINE SINGLE-PASS'),
      'default (soft) must emit advisory, got: ' + r.stdout,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      process.stdout.write(`  ok  ${name}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
    }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
