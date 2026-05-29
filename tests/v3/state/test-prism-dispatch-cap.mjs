#!/usr/bin/env node
// Tests for v4.7 K1 — PRISM_PARALLEL_CAP becomes a real configurable knob.
//
// Covers three surfaces:
//   1. hooks/lib/prism-cap.mjs        — resolveParallelCap() resolver + guards
//   2. hooks/prism-dispatch-cap.mjs   — logs the RESOLVED cap (not a constant)
//   3. hooks/prism-session-start.mjs  — injects the active cap into
//      additionalContext ONLY when overridden (default 4 needs no injection,
//      since the orchestrator prose already says 4 — this closes the
//      "half-knob" trap where telemetry diverges from doctrine).
//
// Run: node tests/v3/state/test-prism-dispatch-cap.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CAP_LIB_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-cap.mjs');
const DISPATCH_HOOK = join(REPO_ROOT, 'hooks', 'prism-dispatch-cap.mjs');
const SESSION_START = join(REPO_ROOT, 'hooks', 'prism-session-start.mjs');
const SWEEP_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const FLAG_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-flag-file.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assertContains(haystack, needle, msg) {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(`expected to contain "${needle}", got ${JSON.stringify(haystack)}${msg ? ' — ' + msg : ''}`);
  }
}

// Ephemeral ~/.claude tree with the libs session-start imports at runtime.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-cap-home-'));
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'skills', 'prism-plan', 'references'), {recursive: true});
  mkdirSync(join(home, '.claude', 'plugins'), {recursive: true});
  writeFileSync(join(home, '.claude', 'hooks', 'lib', 'prism-cap.mjs'), readFileSync(CAP_LIB_REPO, 'utf-8'));
  writeFileSync(join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs'), readFileSync(SWEEP_REPO, 'utf-8'));
  writeFileSync(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs'), readFileSync(FLAG_HELPER_REPO, 'utf-8'));
  return home;
}

function runDispatchHook(home, capEnvValue) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  if (capEnvValue === undefined) delete env.PRISM_PARALLEL_CAP;
  else env.PRISM_PARALLEL_CAP = capEnvValue;
  const r = spawnSync(process.execPath, [DISPATCH_HOOK], {
    encoding: 'utf-8',
    input: JSON.stringify({tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose', description: 'demo'}}),
    env,
    timeout: 10000,
  });
  const log = readFileSync(join(home, '.claude', '.prism-routing.jsonl'), 'utf-8').trim().split('\n');
  return JSON.parse(log[log.length - 1]);
}

function runSessionStart(home, capEnvValue) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  if (capEnvValue === undefined) delete env.PRISM_PARALLEL_CAP;
  else env.PRISM_PARALLEL_CAP = capEnvValue;
  const r = spawnSync(process.execPath, [SESSION_START], {
    cwd: home,
    encoding: 'utf-8',
    input: JSON.stringify({cwd: home}),
    env,
    timeout: 10000,
  });
  let ctx = '';
  try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
  return ctx || '';
}

// ─────────────────────────────── tests ──────────────────────────────────

test('resolver: default is 4 and guards reject bad values', async () => {
  const {resolveParallelCap, DEFAULT_PARALLEL_CAP} = await import(pathToFileURL(CAP_LIB_REPO).href);
  assertEq(DEFAULT_PARALLEL_CAP, 4, 'documented default');
  assertEq(resolveParallelCap({}), 4, 'unset → default');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: ''}), 4, 'empty → default');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '   '}), 4, 'whitespace → default');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '6'}), 6, 'valid override');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: ' 3 '}), 3, 'trimmed override');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '1'}), 1, 'minimum valid');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '0'}), 4, 'zero rejected');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '-2'}), 4, 'negative rejected');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: 'abc'}), 4, 'non-numeric rejected');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '8x'}), 4, 'partial-numeric rejected (strict)');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '16'}), 16, 'ceiling value honored');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '17'}), 4, 'above ceiling rejected');
  assertEq(resolveParallelCap({PRISM_PARALLEL_CAP: '40'}), 4, 'fat-finger typo (40 for 4) rejected, not widened');
});

test('dispatch-cap hook: logs default cap 4 when unset', () => {
  const home = makeHome();
  try {
    const entry = runDispatchHook(home, undefined);
    assertEq(entry.event, 'dispatch_cap');
    assertEq(entry.cap, 4, 'default cap logged');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-cap hook: logs overridden cap from PRISM_PARALLEL_CAP', () => {
  const home = makeHome();
  try {
    const entry = runDispatchHook(home, '7');
    assertEq(entry.cap, 7, 'override flows into log');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-cap hook: bad override falls back to 4', () => {
  const home = makeHome();
  try {
    const entry = runDispatchHook(home, 'garbage');
    assertEq(entry.cap, 4, 'bad value → safe default');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: injects active cap notice when overridden', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, '8');
    assertContains(ctx, 'parallel-dispatch cap is 8');
    assertContains(ctx, 'PRISM_PARALLEL_CAP');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: NO cap injection at default (no token noise)', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, undefined);
    assert(!/parallel-dispatch cap is/i.test(ctx), 'must not inject at default; got: ' + JSON.stringify(ctx));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: bad override is treated as default (no injection)', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, 'nope');
    assert(!/parallel-dispatch cap is/i.test(ctx), 'bad override must not inject; got: ' + JSON.stringify(ctx));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─────────────────────────────── runner ─────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
