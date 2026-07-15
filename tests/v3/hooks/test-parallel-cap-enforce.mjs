#!/usr/bin/env node
// WS3 (v5.7.3) — parallel-guard concurrency-CAP enforcement.
//
// The parallel-guard already traces every Agent() call within a turn. v5.7.3
// adds a count-ceiling that reuses that SAME trace: when `cap` same-turn
// in-window dispatches have already fired, the (cap+1)th Agent call is
// over-cap → soft-nudged (default) or hard-denied (hard mode). A correct
// single-message batch of ≤cap calls must still pass, and the subagent /
// opus-force bypasses must hold (they short-circuit BEFORE the count).
//
// Runs the guard as a SUBPROCESS (as Claude Code does) with an isolated HOME
// so the trace + sentinel state is deterministic — mirrors golden-pretooluse.mjs.

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

const SESSION = 'capgm';

// Build an isolated HOME with `nEntries` same-turn, in-window trace entries
// and a sentinel carrying the matching turn_id.
function makeHome(nEntries, {turnId = 't1'} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-cap-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < nEntries; i++) {
    entries.push({ts: now - i * 100, pgroup: null, subagent_type: 'general-purpose', turn_id: turnId});
  }
  writeFileSync(join(home, '.claude', `.prism-parallel-trace-${SESSION}.json`),
    JSON.stringify({entries}, null, 2));
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${SESSION}.json`),
    JSON.stringify({turn_id: turnId}, null, 2));
  return home;
}

// Run the guard with a fresh Agent dispatch against the given HOME.
function runGuard(home, {mode = 'soft', cap, parentToolUseId, sentinelExtra} = {}) {
  if (sentinelExtra) {
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SESSION}.json`),
      JSON.stringify({turn_id: 't1', ...sentinelExtra}, null, 2));
  }
  const env = {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli',
    PRISM_PARALLEL_GUARD: mode, PRISM_POLICY_OVERRIDE: '1'};
  delete env.PRISM_PARALLEL_CAP;
  if (cap != null) env.PRISM_PARALLEL_CAP = String(cap);
  const payload = {tool_name: 'Agent', session_id: SESSION,
    tool_input: {subagent_type: 'general-purpose', prompt: 'x'}};
  if (parentToolUseId) payload.parent_tool_use_id = parentToolUseId;
  const r = spawnSync(process.execPath, [GUARD], {input: JSON.stringify(payload), encoding: 'utf8', env});
  return {exit: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

// ── cap=4 (default): 4 same-turn in-window entries → 5th call is over-cap ──
test('default cap=4: 5th same-turn call is over-cap, soft → exit 0 + cap notice', () => {
  const home = makeHome(4);
  try {
    const r = runGuard(home, {mode: 'soft'});
    assert(r.exit === 0, 'soft exit 0, got ' + r.exit);
    assert(/cap/i.test(r.stdout), 'notice mentions cap, got: ' + JSON.stringify(r.stdout));
    assert(/PRISM_PARALLEL_CAP/.test(r.stdout), 'notice explains how to raise the cap');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('default cap=4: 5th same-turn call is over-cap, hard → exit 2 + deny JSON', () => {
  const home = makeHome(4);
  try {
    const r = runGuard(home, {mode: 'hard'});
    assert(r.exit === 2, 'hard exit 2, got ' + r.exit);
    const j = JSON.parse(r.stdout);
    assert(j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny',
      'deny JSON, got: ' + r.stdout);
    assert(/cap/i.test(j.hookSpecificOutput.permissionDecisionReason), 'reason mentions cap');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── good batch ≤cap must pass ──
test('default cap=4: 4th call (3 prior entries) passes, no over-cap notice', () => {
  const home = makeHome(3);
  try {
    const r = runGuard(home, {mode: 'soft'});
    assert(r.exit === 0, 'exit 0, got ' + r.exit);
    assert(!/cap/i.test(r.stdout), 'no over-cap notice for ≤cap batch, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── subagent-context bypass holds (short-circuits BEFORE the count) ──
test('subagent context (parent_tool_use_id) with 5 entries → passthrough exit 0, no notice', () => {
  const home = makeHome(5);
  try {
    const r = runGuard(home, {mode: 'hard', parentToolUseId: 'p1'});
    assert(r.exit === 0, 'bypass exit 0 even in hard mode, got ' + r.exit);
    assert(!/cap/i.test(r.stdout), 'no notice under subagent bypass');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── opus-force bypass holds ──
test('!opus-force (force_opus sentinel) with 5 entries → passthrough exit 0', () => {
  const home = makeHome(5);
  try {
    const r = runGuard(home, {mode: 'hard', sentinelExtra: {force_opus: true}});
    assert(r.exit === 0, 'opus-force bypass exit 0, got ' + r.exit);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── raised cap honored ──
test('PRISM_PARALLEL_CAP=8: 5 prior entries → 6th call passes', () => {
  const home = makeHome(5);
  try {
    const r = runGuard(home, {mode: 'soft', cap: 8});
    assert(r.exit === 0, 'exit 0, got ' + r.exit);
    assert(!/over-cap|cap of/i.test(r.stdout), 'no over-cap notice below raised cap');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('PRISM_PARALLEL_CAP=8: 8 prior entries → 9th call is over-cap (soft notice)', () => {
  const home = makeHome(8);
  try {
    const r = runGuard(home, {mode: 'soft', cap: 8});
    assert(r.exit === 0, 'soft exit 0, got ' + r.exit);
    assert(/cap/i.test(r.stdout), 'over-cap notice at raised ceiling, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
