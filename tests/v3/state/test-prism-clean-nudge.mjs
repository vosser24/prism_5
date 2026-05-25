#!/usr/bin/env node
// Tests for hooks/prism-clean-nudge.mjs (v4.0 Phase F).
// Subprocess-driven; pipes mock JSON on stdin; asserts stdout JSON / exit code.
//
// Run: node tests/v3/state/test-prism-clean-nudge.mjs

import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-clean-nudge.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function runHook(stdinJson, env = {}) {
  const fullEnv = {...process.env, ...env};
  // Strip any inherited off-switches so tests are deterministic
  if (!('PRISM_DISABLE_CLEAR_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_CLEAR_NUDGE;
  if (!('PRISM_DISABLE_PRECOMPACT_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_PRECOMPACT_NUDGE;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf8',
    env: fullEnv,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function runHookRaw(stdinStr, env = {}) {
  const fullEnv = {...process.env, ...env};
  if (!('PRISM_DISABLE_CLEAR_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_CLEAR_NUDGE;
  if (!('PRISM_DISABLE_PRECOMPACT_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_PRECOMPACT_NUDGE;
  const r = spawnSync(process.execPath, [HOOK], {input: stdinStr, encoding: 'utf8', env: fullEnv});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function parseStdout(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout); }
  catch (e) { throw new Error(`stdout is not JSON: ${stdout}`); }
}

test('SessionEnd reason=clear: emits nudge in hookSpecificOutput.additionalContext', () => {
  const r = runHook({hook_event_name: 'SessionEnd', reason: 'clear', session_id: 'sess-1'});
  assertEq(r.status, 0, r.stderr);
  const out = parseStdout(r.stdout);
  assert(out, 'stdout should be JSON, was empty');
  assertEq(out.hookSpecificOutput.hookEventName, 'SessionEnd');
  assert(/prism-clean/.test(out.hookSpecificOutput.additionalContext), 'nudge text must mention /prism-clean');
  assert(/archive|panel|decision|deviation/i.test(out.hookSpecificOutput.additionalContext), 'nudge text must explain WHY (panel decisions / deviations / archive)');
});

test('SessionEnd reason=clear with PRISM_DISABLE_CLEAR_NUDGE=1: silent exit, no stdout', () => {
  const r = runHook(
    {hook_event_name: 'SessionEnd', reason: 'clear', session_id: 'sess-2'},
    {PRISM_DISABLE_CLEAR_NUDGE: '1'},
  );
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'off-switch must produce no stdout');
});

test('SessionEnd reason=logout (not clear): silent exit (matcher catches this upstream, but defensive)', () => {
  const r = runHook({hook_event_name: 'SessionEnd', reason: 'logout', session_id: 'sess-3'});
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'non-clear SessionEnd reason must produce no stdout');
});

test('PreCompact: emits nudge in hookSpecificOutput.additionalContext', () => {
  const r = runHook({hook_event_name: 'PreCompact', session_id: 'sess-4'});
  assertEq(r.status, 0, r.stderr);
  const out = parseStdout(r.stdout);
  assert(out, 'stdout should be JSON, was empty');
  assertEq(out.hookSpecificOutput.hookEventName, 'PreCompact');
  assert(/prism-clean/.test(out.hookSpecificOutput.additionalContext), 'nudge text must mention /prism-clean');
  assert(/archive|panel|decision|deviation/i.test(out.hookSpecificOutput.additionalContext), 'nudge text must explain WHY (panel decisions / deviations / archive)');
});

test('PreCompact with PRISM_DISABLE_PRECOMPACT_NUDGE=1: silent exit, no stdout', () => {
  const r = runHook(
    {hook_event_name: 'PreCompact', session_id: 'sess-5'},
    {PRISM_DISABLE_PRECOMPACT_NUDGE: '1'},
  );
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'off-switch must produce no stdout');
});

test('Malformed stdin: silent exit 0 (never crash, never block)', () => {
  const r = runHookRaw('this is not json');
  assertEq(r.status, 0, 'must exit 0 even on bad input');
  assertEq(r.stdout.trim(), '', 'no stdout on malformed input');
});

test('Empty stdin: silent exit 0', () => {
  const r = runHookRaw('');
  assertEq(r.status, 0, 'must exit 0 even on empty stdin');
  assertEq(r.stdout.trim(), '', 'no stdout on empty stdin');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
