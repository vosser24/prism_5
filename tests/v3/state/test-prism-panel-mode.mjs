#!/usr/bin/env node
// Tests for v5.x item 6 — PRISM_PANEL_MODE becomes a real surfaced knob.
//
// Covers two surfaces (mirrors the PRISM_PARALLEL_CAP pattern):
//   1. hooks/lib/prism-panel-mode.mjs   — resolvePanelMode() resolver + guards
//   2. hooks/prism-session-start.mjs    — injects the active panel mode into
//      additionalContext ONLY when overridden to roleplay (default "dispatch"
//      needs no injection — doctrine already says dispatch is the default).
//
// A typo must fall back to "dispatch" (fail toward the rigorous mode — never
// silently degrade a real panel into role-play).
//
// Run: node tests/v3/state/test-prism-panel-mode.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PANEL_MODE_LIB_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-panel-mode.mjs');
const CAP_LIB_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-cap.mjs');
const SWEEP_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const FLAG_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-flag-file.mjs');
const SESSION_START = join(REPO_ROOT, 'hooks', 'prism-session-start.mjs');

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
  const home = mkdtempSync(join(tmpdir(), 'prism-panelmode-home-'));
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'skills', 'prism-plan', 'references'), {recursive: true});
  mkdirSync(join(home, '.claude', 'plugins'), {recursive: true});
  writeFileSync(join(home, '.claude', 'hooks', 'lib', 'prism-panel-mode.mjs'), readFileSync(PANEL_MODE_LIB_REPO, 'utf-8'));
  writeFileSync(join(home, '.claude', 'hooks', 'lib', 'prism-cap.mjs'), readFileSync(CAP_LIB_REPO, 'utf-8'));
  writeFileSync(join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs'), readFileSync(SWEEP_REPO, 'utf-8'));
  writeFileSync(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs'), readFileSync(FLAG_HELPER_REPO, 'utf-8'));
  return home;
}

function runSessionStart(home, panelModeEnvValue) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  if (panelModeEnvValue === undefined) delete env.PRISM_PANEL_MODE;
  else env.PRISM_PANEL_MODE = panelModeEnvValue;
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

test('resolver: default is dispatch and guards reject bad values', async () => {
  const {resolvePanelMode, DEFAULT_PANEL_MODE} = await import(pathToFileURL(PANEL_MODE_LIB_REPO).href);
  assertEq(DEFAULT_PANEL_MODE, 'dispatch', 'documented default');
  assertEq(resolvePanelMode({}), 'dispatch', 'unset → default');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: ''}), 'dispatch', 'empty → default');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: '   '}), 'dispatch', 'whitespace → default');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: 'roleplay'}), 'roleplay', 'valid roleplay override');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: 'dispatch'}), 'dispatch', 'valid dispatch (explicit default)');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: 'RolePlay'}), 'roleplay', 'case-insensitive');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: ' roleplay '}), 'roleplay', 'trimmed');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: 'rolplay'}), 'dispatch', 'typo → safe default (never silently degrade a real panel)');
  assertEq(resolvePanelMode({PRISM_PANEL_MODE: 'fast'}), 'dispatch', 'unknown token → default');
});

test('session-start: injects panel-mode notice when overridden to roleplay', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, 'roleplay');
    assertContains(ctx, 'panel mode is roleplay');
    assertContains(ctx, 'PRISM_PANEL_MODE');
    assertContains(ctx, 'dispatch_mode');  // env→panel.json field link is explicit (review fix)
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: NO panel-mode injection at default (no token noise)', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, undefined);
    assert(!/panel mode is/i.test(ctx), 'must not inject at default; got: ' + JSON.stringify(ctx));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: explicit dispatch (the default) injects nothing', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, 'dispatch');
    assert(!/panel mode is/i.test(ctx), 'explicit default dispatch must not inject; got: ' + JSON.stringify(ctx));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: bad override treated as default (no injection)', () => {
  const home = makeHome();
  try {
    const ctx = runSessionStart(home, 'nonsense');
    assert(!/panel mode is/i.test(ctx), 'bad override must not inject; got: ' + JSON.stringify(ctx));
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
