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
const haikuSentinel = (sessionId) => ({
  tier: 'haiku', summon_panel: false, orchestrator_dispatched: false, dispatched: false,
  source: 'keyword-floor', rationale: 'test haiku turn', ts: new Date().toISOString(),
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

// ── A1-R: override file is READABLE on a denied turn (the real deadlock) ──────
test('dispatch-guard: ALLOWS Read of the .prism-turn-tier override file on a haiku turn', () => {
  const home = makeHome(); const sid = 'sess-a1r';
  try {
    seedSentinel(home, sid, haikuSentinel(sid));
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Read', session_id: sid,
      tool_input: {file_path: sentinelPath(home, sid)},
    });
    assertEq(r.status, 0, 'override-file Read must be allowed — Write requires a prior Read, else the escape deadlocks');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// v5.2.4: read-only tools (Read/Grep/Glob/LS/NotebookRead) pass pre-dispatch —
// reading is how the parent PLANS (which file to inspect, what the orchestrator
// prompt should say). Mutations (Write/Edit/Bash) stay gated. This replaces the
// old "normal Read is denied pre-dispatch" contract, which forced a throwaway
// subagent dispatch just to read one file.
test('dispatch-guard: ALLOWS Read of a normal file pre-dispatch (read-only tools plan the turn)', () => {
  const home = makeHome(); const sid = 'sess-a1rc';
  try {
    seedSentinel(home, sid, haikuSentinel(sid));
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Read', session_id: sid,
      tool_input: {file_path: join(home, 'some-real-file.txt')},
    });
    assertEq(r.status, 0, 'read-only tools must pass pre-dispatch (parent plans by reading)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: ALLOWS Glob/Grep/LS/NotebookRead pre-dispatch', () => {
  const home = makeHome(); const sid = 'sess-a1ro';
  try {
    seedSentinel(home, sid, haikuSentinel(sid));
    for (const tool of ['Glob', 'Grep', 'LS', 'NotebookRead']) {
      const r = runHook(DISPATCH_GUARD, home, {
        tool_name: tool, session_id: sid,
        tool_input: {pattern: '**/*.js'},
      });
      assertEq(r.status, 0, `${tool} must pass pre-dispatch`);
    }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: STILL denies Write AND Bash to a normal file on a haiku turn (mutations gated)', () => {
  const home = makeHome(); const sid = 'sess-a1wc';
  try {
    seedSentinel(home, sid, haikuSentinel(sid));
    const w = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'some-real-file.txt'), content: 'x'},
    });
    assertEq(w.status, 2, 'Write of a normal file must stay gated pre-dispatch');
    const b = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Bash', session_id: sid,
      tool_input: {command: 'echo hi > out.txt'},  // v5.3.2: a MUTATING Bash (redirect) — read-only Bash is now fast-path-exempt
    });
    assertEq(b.status, 2, 'mutating Bash must stay gated pre-dispatch');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: ALLOWS Read of the override file on a panel turn too', () => {
  const home = makeHome(); const sid = 'sess-a1rp';
  try {
    seedSentinel(home, sid, panelSentinel(sid));
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Read', session_id: sid,
      tool_input: {file_path: sentinelPath(home, sid)},
    });
    assertEq(r.status, 0, 'override-file Read must be allowed on panel turns as well');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── A6 (v5.2.5): project-master self-chairs the panel (no nested @master-orchestrator) ──
// When the active agent IS a master-<slug> (loads the orchestrator skill), dispatching a
// nested @master-orchestrator makes it a subagent that can't spawn the panel → role-play.
// The router flags self_chair; the guard then accepts the master's OWN expert dispatch.
test('router: panel turn with an active project-master sets self_chair', () => {
  const home = makeHome(); const sid = 'sess-sc1';
  try {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({agent: 'master-test-x'}));
    const s = runRouter(home, sid, 'design a new event-sourcing architecture from scratch');
    assertEq(s.tier, 'opus', 'still opus');
    assertEq(!!s.summon_panel, true, 'still a panel turn');
    assertEq(!!s.self_chair, true, 'active project-master ⇒ self_chair=true');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('router: panel turn with NO project-master keeps the generic @master-orchestrator path', () => {
  const home = makeHome(); const sid = 'sess-sc2';
  try {
    const s = runRouter(home, sid, 'design a new event-sourcing architecture from scratch');
    assertEq(!!s.summon_panel, true, 'still a panel turn');
    assertEq(!!s.self_chair, false, 'no project-master ⇒ no self_chair');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: self_chair panel turn DENIES synthesis before any panel member is dispatched', () => {
  const home = makeHome(); const sid = 'sess-sc3';
  try {
    seedSentinel(home, sid, {tier: 'opus', summon_panel: true, self_chair: true, active_master: 'master-test-x', dispatched: false, orchestrator_dispatched: false, source: 'keyword-floor', rationale: 'panel', ts: new Date().toISOString()});
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'x.txt'), content: 'x'},
    });
    assertEq(r.status, 2, 'must dispatch ≥1 panel member before synthesizing (prevents role-play)');
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assertEq(/chair (the |this )?panel yourself|dispatch (your |the )?(expert )?panel member/i.test(reason), true, 'self-chair notice must guide self-chairing, got: ' + reason);
    assertEq(/spawn @master-orchestrator as your next action/i.test(reason), false, 'self-chair notice must NOT tell the master to nest a @master-orchestrator');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: self_chair panel turn ALLOWS synthesis after the master dispatched a panel member', () => {
  const home = makeHome(); const sid = 'sess-sc4';
  try {
    seedSentinel(home, sid, {tier: 'opus', summon_panel: true, self_chair: true, active_master: 'master-test-x', dispatched: true, orchestrator_dispatched: false, source: 'keyword-floor', rationale: 'panel', ts: new Date().toISOString()});
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'x.txt'), content: 'x'},
    });
    assertEq(r.status, 0, 'self-chair master may synthesize after dispatching ≥1 member');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: non-self_chair panel turn still requires @master-orchestrator (generic path intact)', () => {
  const home = makeHome(); const sid = 'sess-sc5';
  try {
    seedSentinel(home, sid, {tier: 'opus', summon_panel: true, dispatched: true, orchestrator_dispatched: false, source: 'keyword-floor', rationale: 'panel', ts: new Date().toISOString()});
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'x.txt'), content: 'x'},
    });
    assertEq(r.status, 2, 'without self_chair, a mere expert dispatch must NOT open the gate — orchestrator still required');
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
