#!/usr/bin/env node
// v6.6.0 FIX-3 — agent-model-guard: dispatched-only context downgrades to
// advisory instead of full bypass.
//
// Of the three subagent-context signals, parent_tool_use_id and
// CLAUDE_CODE_ENTRYPOINT=subagent are strong per-call evidence; sentinel.
// dispatched is a session-global boolean set by the parent's own FIRST
// dispatch (hooks/prism-parent-dispatch-guard.mjs) — so parent dispatches
// 2..N of every turn previously skipped model checking entirely (full
// bypass). This test proves: (1) a dispatched-only signal now falls through
// to classification and may nudge (never denies, even under hard/strict);
// (2) the two strong signals (parent_tool_use_id, explicit model) still
// bypass silently, byte-identical to before.
//
// Run: node tests/v3/hooks/test-agent-model-guard-advisory-downgrade.mjs

import {writeFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = join(__dirname, '..', '..', '..', 'hooks', 'prism-agent-model-guard.mjs');
const GUARD_FILE_URL = pathToFileURL(GUARD_PATH).href;

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-fix3-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function plantSentinel(home, sessionId, sentinel) {
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${sessionId}.json`), JSON.stringify(sentinel));
}

async function runGuard(home, envOverrides, payload) {
  const origHome = process.env.HOME;
  const origUP = process.env.USERPROFILE;
  const origMode = process.env.PRISM_MODEL_GUARD;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (envOverrides.PRISM_MODEL_GUARD !== undefined) process.env.PRISM_MODEL_GUARD = envOverrides.PRISM_MODEL_GUARD;
  else delete process.env.PRISM_MODEL_GUARD;
  try {
    const {run} = await import(GUARD_FILE_URL + '?fix3=' + Date.now() + Math.random());
    return await run(payload);
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUP !== undefined) process.env.USERPROFILE = origUP; else delete process.env.USERPROFILE;
    if (origMode !== undefined) process.env.PRISM_MODEL_GUARD = origMode; else delete process.env.PRISM_MODEL_GUARD;
  }
}

function stdoutHasDeny(stdout) {
  if (!stdout) return false;
  try {
    const parsed = JSON.parse(stdout);
    return !!(parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny');
  } catch { return false; }
}

// ─── Case 1: dispatched-only, no model, no parent_tool_use_id → nudge, no deny ───
await test('Case 1: dispatched-only sentinel (sonnet), no model, no parent_tool_use_id -> exit 0, MODEL GUARD nudge, no deny', async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fix3-case1', {tier: 'sonnet', dispatched: true});
    const res = await runGuard(home, {}, {
      tool_name: 'Agent',
      session_id: 'fix3-case1',
      tool_input: {subagent_type: 'general-purpose', prompt: 'Do a substantial implementation task.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert(/MODEL GUARD/.test(res.stdout || ''), `expected a MODEL GUARD nudge in stdout, got: ${JSON.stringify(res.stdout)}`);
    assert(!stdoutHasDeny(res.stdout), `expected NO deny, got: ${res.stdout}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── Case 2: same, but PRISM_MODEL_GUARD=strict → still no deny ───
await test('Case 2: dispatched-only sentinel + PRISM_MODEL_GUARD=strict -> still no deny (advisory-only honored)', async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fix3-case2', {tier: 'sonnet', dispatched: true});
    const res = await runGuard(home, {PRISM_MODEL_GUARD: 'strict'}, {
      tool_name: 'Agent',
      session_id: 'fix3-case2',
      tool_input: {subagent_type: 'general-purpose', prompt: 'Do a substantial implementation task.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert(!stdoutHasDeny(res.stdout), `expected NO deny even under strict mode, got: ${res.stdout}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── Case 3: same input WITH parent_tool_use_id → empty stdout (strong-signal passthrough unchanged) ───
await test('Case 3: dispatched-only sentinel + parent_tool_use_id set -> empty stdout (strong-signal passthrough unchanged)', async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fix3-case3', {tier: 'sonnet', dispatched: true});
    const res = await runGuard(home, {}, {
      tool_name: 'Agent',
      session_id: 'fix3-case3',
      parent_tool_use_id: 'toolu_fake_fix3',
      tool_input: {subagent_type: 'general-purpose', prompt: 'Do a substantial implementation task.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert((res.stdout || '') === '', `expected empty stdout (silent strong-signal bypass), got: ${JSON.stringify(res.stdout)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── Case 4: explicit model:'sonnet' + dispatched sentinel → empty stdout (explicit-model passthrough unchanged) ───
await test("Case 4: explicit model:'sonnet' + dispatched sentinel -> empty stdout (explicit-model passthrough unchanged)", async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fix3-case4', {tier: 'sonnet', dispatched: true});
    const res = await runGuard(home, {}, {
      tool_name: 'Agent',
      session_id: 'fix3-case4',
      tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'Do a substantial implementation task.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert((res.stdout || '') === '', `expected empty stdout (explicit model passthrough), got: ${JSON.stringify(res.stdout)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
