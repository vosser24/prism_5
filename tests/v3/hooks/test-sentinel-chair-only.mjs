#!/usr/bin/env node
// tests/v3/hooks/test-sentinel-chair-only.mjs — D087 (#44): CHAIR-WRITABLE-ONLY
// tier sentinel.
//
// Defect (#44, reproduced 2026-07-28): `.prism-turn-tier-<session>.json` is a
// SINGLE file keyed by session_id alone. Under agent-teams every teammate shares
// that session_id, and `hooks/prism-parent-dispatch-guard.mjs` carried an
// UNCONDITIONAL exemption (FIX-A / FIX-A2) that let ANY caller Write/Edit it —
// so a subordinate teammate could clobber the chair's tier/summon_panel. The
// exemption is load-bearing (without it the documented override escape is
// unreachable and the turn deadlocks), so D087 NARROWS it rather than removing
// it: the write is gated on CLAUDE_CODE_CHILD_SESSION !== '1' (the only
// chair-vs-teammate discriminator that exists — there is NO per-actor identity).
//
// Second site: `hooks/prism-prompt-tier-router.mjs` buildOverrideDirective()
// INSTRUCTS the model to Read-then-Write that sentinel. Emitting an instruction
// we then deny is worse than either alone, so the directive is suppressed for
// teammates on the same predicate.
//
// FAIL-OPEN is non-negotiable: env absent / unreadable / throwing → ALLOW, and
// the fault path must be OBSERVABLE, matching what the D086 proposal (Status:
// Proposed, not ratified) recommends — a `sentinel_write_gate_faultopen`
// event in .prism-routing.jsonl, never a silent allow.
//
// HOME is isolated to a temp dir (finding #33: fixture writes polluted the real
// ~/.claude). Every case sets CLAUDE_CODE_CHILD_SESSION explicitly — this suite
// is itself often run from a dispatched subagent process, where that var is
// already '1'.
//
// Run: node tests/v3/hooks/test-sentinel-chair-only.mjs

import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'prism-sentinel-chair-'));
const REAL_ENV = process.env;
const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CHILD: process.env.CLAUDE_CODE_CHILD_SESSION,
  ENTRY: process.env.CLAUDE_CODE_ENTRYPOINT,
  TEAMS: process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
  GUARD: process.env.PRISM_DISPATCH_GUARD,
  CHAIRONLY: process.env.PRISM_SENTINEL_CHAIR_ONLY,
};

// Module-scope constants (H, LOG_PATH, MODE) are read at IMPORT time — set env
// before the dynamic imports below.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.PRISM_DISPATCH_GUARD = 'hard';
delete process.env.PRISM_SENTINEL_CHAIR_ONLY;
delete process.env.CLAUDE_CODE_ENTRYPOINT; // a teammate reports entrypoint=cli, NOT subagent
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

const HOOKS = join(process.cwd(), 'hooks');
const {run: guardRun} = await import(
  pathToFileURL(join(HOOKS, 'prism-parent-dispatch-guard.mjs')).href + '?t=' + Date.now()
);
const {formatAdvice} = await import(
  pathToFileURL(join(HOOKS, 'prism-prompt-tier-router.mjs')).href + '?t=' + Date.now()
);

const SENTINEL = join(HOME, '.claude', '.prism-turn-tier-shared123.json');
const LOG = join(HOME, '.claude', '.prism-routing.jsonl');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function asTeammate() { process.env.CLAUDE_CODE_CHILD_SESSION = '1'; }
function asChair() { delete process.env.CLAUDE_CODE_CHILD_SESSION; }

function sentinelWrite(tool = 'Write') {
  return {
    tool_name: tool,
    tool_input: {file_path: SENTINEL, content: '{"tier":"haiku","summon_panel":false}'},
    session_id: 'shared123',
  };
}
function logText() { return existsSync(LOG) ? readFileSync(LOG, 'utf-8') : ''; }
function isDeny(r) { return r.exit === 2 && /"permissionDecision"\s*:\s*"deny"/.test(r.stdout); }

// ── 1. the defect: a teammate must NOT be able to write the shared sentinel ──
test('teammate Write to the shared sentinel is DENIED', () => {
  asTeammate();
  const r = guardRun(sentinelWrite('Write'));
  assert(isDeny(r), `expected deny (exit 2 + permissionDecision:deny), got exit=${r.exit} stdout=${JSON.stringify(r.stdout)}`);
  assert(/D087|chair/i.test(r.stdout), 'deny reason must name the chair-only rule, got: ' + r.stdout);
});

test('teammate Edit to the shared sentinel is DENIED', () => {
  asTeammate();
  const r = guardRun(sentinelWrite('Edit'));
  assert(isDeny(r), `expected deny, got exit=${r.exit} stdout=${JSON.stringify(r.stdout)}`);
});

test('teammate MultiEdit to the shared sentinel is DENIED', () => {
  asTeammate();
  const r = guardRun(sentinelWrite('MultiEdit'));
  assert(isDeny(r), `expected deny, got exit=${r.exit} stdout=${JSON.stringify(r.stdout)}`);
});

test('the teammate deny is LOGGED (observable, not silent)', () => {
  asTeammate();
  guardRun(sentinelWrite('Write'));
  assert(/sentinel_write_denied/.test(logText()), 'expected a sentinel_write_denied event in .prism-routing.jsonl');
});

// ── 2. the chair keeps the FIX-A escape ──
test('chair Write to the sentinel is ALLOWED (FIX-A escape preserved)', () => {
  asChair();
  const r = guardRun(sentinelWrite('Write'));
  assert(r.exit === 0, `expected exit 0, got ${r.exit} stdout=${r.stdout}`);
  assert(!isDeny(r), 'chair must not be denied');
});

test('chair Edit to the sentinel is ALLOWED', () => {
  asChair();
  const r = guardRun(sentinelWrite('Edit'));
  assert(r.exit === 0, `expected exit 0, got ${r.exit}`);
});

// ── 3. FAIL-OPEN ──
test('CLAUDE_CODE_CHILD_SESSION ABSENT → ALLOWED (fail-open)', () => {
  delete process.env.CLAUDE_CODE_CHILD_SESSION;
  const r = guardRun(sentinelWrite('Write'));
  assert(r.exit === 0, `absent var must allow, got exit=${r.exit} stdout=${r.stdout}`);
});

test('CLAUDE_CODE_CHILD_SESSION set to a non-1 value → ALLOWED (fail-open)', () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '0';
  const r = guardRun(sentinelWrite('Write'));
  assert(r.exit === 0, `non-'1' value must allow, got exit=${r.exit} stdout=${r.stdout}`);
});

test('env read THROWS → ALLOWED (fail-open) and the fault is OBSERVABLE (per the D086 proposal, Status: Proposed)', () => {
  const before = logText();
  const throwing = new Proxy({}, {
    get(_t, k) { if (k === 'CLAUDE_CODE_CHILD_SESSION') throw new Error('simulated env fault'); return REAL_ENV[k]; },
    has(_t, k) { return k in REAL_ENV; },
    set(_t, k, v) { REAL_ENV[k] = v; return true; },
  });
  let r;
  try { process.env = throwing; r = guardRun(sentinelWrite('Write')); }
  finally { process.env = REAL_ENV; }
  assert(r.exit === 0, `a throwing env read must ALLOW, got exit=${r.exit} stdout=${r.stdout}`);
  const added = logText().slice(before.length);
  assert(/sentinel_write_gate_faultopen/.test(added),
    'the fail-open path must be structurally distinguishable from a healthy allow (per the D086 proposal, Status: Proposed) — expected a sentinel_write_gate_faultopen event, got: ' + JSON.stringify(added));
});

// ── 4. blast radius: nothing else changes ──
test('teammate Write to a NON-sentinel path does not hit the sentinel gate', () => {
  asTeammate();
  const r = guardRun({
    tool_name: 'Write',
    tool_input: {file_path: join(HOME, 'some-other-file.txt'), content: 'x'},
    session_id: 'shared123',
  });
  assert(!/sentinel_write_denied|D087/.test(r.stdout), 'non-sentinel writes must not be touched by the D087 gate, got: ' + r.stdout);
});

test('master switch PRISM_SENTINEL_CHAIR_ONLY=off restores the prior unconditional exemption', () => {
  asTeammate();
  process.env.PRISM_SENTINEL_CHAIR_ONLY = 'off';
  try {
    const r = guardRun(sentinelWrite('Write'));
    assert(r.exit === 0, `off must allow, got exit=${r.exit} stdout=${r.stdout}`);
  } finally { delete process.env.PRISM_SENTINEL_CHAIR_ONLY; }
});

// ── 5. router: stop INSTRUCTING what we now block ──
test('teammate turn → override directive SUPPRESSED', () => {
  asTeammate();
  const advice = formatAdvice('sonnet', 'kw floor', 'soft', false, 'keyword-floor', 'shared123', null);
  assert(!/PRISM TIER OVERRIDE PROTOCOL/.test(advice),
    'a teammate must not be told to write a sentinel it is now denied, got: ' + advice);
});

test('chair turn → override directive PRESENT (existing behaviour unchanged)', () => {
  asChair();
  const advice = formatAdvice('sonnet', 'kw floor', 'soft', false, 'keyword-floor', 'shared123', null);
  assert(/PRISM TIER OVERRIDE PROTOCOL/.test(advice),
    'the chair must still receive the override directive, got: ' + advice);
});

test('router master switch off → directive present even for a teammate', () => {
  asTeammate();
  process.env.PRISM_SENTINEL_CHAIR_ONLY = 'off';
  try {
    const advice = formatAdvice('sonnet', 'kw floor', 'soft', false, 'keyword-floor', 'shared123', null);
    assert(/PRISM TIER OVERRIDE PROTOCOL/.test(advice), 'off must restore the directive, got: ' + advice);
  } finally { delete process.env.PRISM_SENTINEL_CHAIR_ONLY; }
});

// ── teardown ──
for (const [k, v] of Object.entries({
  HOME: SAVED.HOME, USERPROFILE: SAVED.USERPROFILE,
  CLAUDE_CODE_CHILD_SESSION: SAVED.CHILD, CLAUDE_CODE_ENTRYPOINT: SAVED.ENTRY,
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: SAVED.TEAMS, PRISM_DISPATCH_GUARD: SAVED.GUARD,
  PRISM_SENTINEL_CHAIR_ONLY: SAVED.CHAIRONLY,
})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
try { rmSync(HOME, {recursive: true, force: true}); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
