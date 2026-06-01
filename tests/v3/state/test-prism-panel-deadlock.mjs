#!/usr/bin/env node
// Tests for v5.x FIX-A — panel-summon deadlock escape + false-positive prevention.
// Surfaced by the v5.0 real-usage stress test (docs/prism/2026-06-01-v5.0-stress-test-report.md).
//
// Two properties:
//   A1 (escapability): on a panel-summoning turn, a Write/Edit to the
//      conversation-model override file (.prism-turn-tier-<session>.json) is
//      ALLOWED by the dispatch-guard and mutation-guard — otherwise the
//      documented override is unreachable and the session deadlocks.
//   A2 (no false positive): the tier-router never carries summon_panel forward
//      on a continuation-inherit, and does NOT inherit at all on an empty
//      prompt (a notification / non-user turn).
//
// Run: node tests/v3/state/test-prism-panel-deadlock.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const DISPATCH_GUARD = join(REPO, 'hooks', 'prism-parent-dispatch-guard.mjs');
const MUTATION_GUARD = join(REPO, 'hooks', 'prism-mutation-guard.mjs');
const ROUTER = join(REPO, 'hooks', 'prism-prompt-tier-router.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-deadlock-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}
function sentinelPath(home, sessionId) {
  return join(home, '.claude', `.prism-turn-tier-${sessionId}.json`);
}
function seedSentinel(home, sessionId, obj) {
  writeFileSync(sentinelPath(home, sessionId), JSON.stringify(obj));
}
function runHook(hook, home, payload) {
  const env = {...process.env, HOME: home, USERPROFILE: home, PRISM_DISPATCH_GUARD: 'hard', PRISM_MUTATION_GUARD: 'hard'};
  const r = spawnSync(process.execPath, [hook], {encoding: 'utf-8', input: JSON.stringify(payload), env, timeout: 15000});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}
function runRouter(home, sessionId, prompt) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  spawnSync(process.execPath, [ROUTER], {encoding: 'utf-8', input: JSON.stringify({prompt, session_id: sessionId, cwd: home}), env, timeout: 15000});
  return JSON.parse(readFileSync(sentinelPath(home, sessionId), 'utf-8'));
}

const panelSentinel = (sessionId) => ({
  tier: 'opus', summon_panel: true, orchestrator_dispatched: false, dispatched: false,
  source: 'keyword-floor', rationale: 'test panel turn', ts: new Date().toISOString(),
});

// ── A1: override file is writable on a panel turn (escapability) ──────────────
test('dispatch-guard: ALLOWS Write to the .prism-turn-tier override file on a panel turn', () => {
  const home = makeHome(); const sid = 'sess-a1';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: sentinelPath(home, sid), content: '{}'},
    });
    assertEq(r.status, 0, 'override-file Write must be allowed (escape hatch)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: STILL denies Write to a normal file on a panel turn (control)', () => {
  const home = makeHome(); const sid = 'sess-a1c';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'some-real-file.txt'), content: 'x'},
    });
    assertEq(r.status, 2, 'normal Write must still be blocked on a panel turn');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: ALLOWS Edit to the .prism-turn-tier override file on a panel turn', () => {
  const home = makeHome(); const sid = 'sess-a1m';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Edit', session_id: sid,
      tool_input: {file_path: sentinelPath(home, sid), old_string: 'a', new_string: 'b'},
    });
    assertEq(r.status, 0, 'override-file Edit must be allowed by mutation-guard');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── A2: router never re-panels on continuation / empty turns ──────────────────
test('router: short approval inherits opus tier but NOT summon_panel', () => {
  const home = makeHome(); const sid = 'sess-a2a';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const s = runRouter(home, sid, 'yes go ahead');
    assertEq(s.tier, 'opus', 'tier still inherited (keep expensive work going)');
    assertEq(!!s.summon_panel, false, 'summon_panel must NOT carry forward on inherit');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('router: empty prompt (notification turn) does NOT inherit a panel sentinel', () => {
  const home = makeHome(); const sid = 'sess-a2b';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const s = runRouter(home, sid, '');
    assertEq(!!s.summon_panel, false, 'empty/notification turn must never be a panel turn');
    if (s.source === 'continuation-inherit') throw new Error('empty prompt must not inherit; got continuation-inherit');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
