#!/usr/bin/env node
// Task #38 (F26) — REGRESSION GUARD for the mutation-guard / dispatch-guard
// agent-teams DIVERGENCE. This file started life as a RED test proposing that
// mutation-guard should mirror dispatch-guard's D043 advisory-downgrade; that
// proposal was surveyed and REJECTED (see the adjudication cited below). The
// divergence asserted below is now the INTENDED, DELIBERATE behavior — this
// suite is GREEN and stays green. If it ever goes red, someone changed
// mutation-guard's or dispatch-guard's agent-teams behavior — READ
// docs/prism/adjudications/D082-mutation-guard-teams-asymmetry-deliberate.md
// BEFORE touching either hook again.
//
// BACKGROUND (D043, v6.4.0, commit 0721cd38c "agent-teams dispatch honesty"):
// under agent-teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) every teammate is
// a top-level CLI session sharing ONE session_id, so `sentinel.dispatched` —
// a session-global boolean with NO caller dimension — cannot gate per-caller:
// any teammate's Agent/TaskCreate unlocks EVERYONE sharing the session, and
// any teammate's next incoming message re-locks everyone. D043 fixed this in
// hooks/prism-parent-dispatch-guard.mjs ONLY: when IN_AGENT_TEAMS &&
// TEAMS_MODE==='advisory' (both defaults), the dispatched-gated hard-deny
// DOWNGRADES to an advisory (exit 0 + additionalContext) instead of a hard
// block (hooks/prism-parent-dispatch-guard.mjs:631, teamsAdvisoryDowngrade).
//
// THE DIVERGENCE (kept ON PURPOSE): hooks/prism-mutation-guard.mjs has ZERO
// agent-teams handling (confirmed: `grep -n "AGENT_TEAMS\|TEAMS_MODE\|
// IN_AGENT_TEAMS" hooks/prism-mutation-guard.mjs` returns nothing) despite
// using the IDENTICAL `sentinel.dispatched === true` signal as its OWN third
// subagent-detection path (isSubagentByDispatched,
// hooks/prism-mutation-guard.mjs:292-296 — "This matches the v2.2.1
// 'dispatch-guard path 3' reasoning"). A survey (task #38) found this is the
// ONLY guard of six sharing that signal that is BOTH blocking-by-default AND
// gated directly on `dispatched:false` under agent-teams. The decision, per
// the adjudication, is INTENTIONAL-BY-DEFAULT-INACTION: a false-allow here
// risks silent, irreversible Windows BOM/bypass corruption, while a
// false-deny costs only friction — and mutation-guard's own deny message
// already prints 3 escape hatches, the first of which (Edit/Write/MultiEdit)
// has not been gated by mutation-guard at all since v5.4.0. Weakening the
// guard to match dispatch-guard was REJECTED as the less-safe, harder-to-undo
// direction. See the adjudication for full reasoning, the dormant look-alike
// guards, and the recommended eventual direction.
//
// CONSEQUENCE (asserted below, on purpose): under agent-teams, on the SAME
// Bash file-write call with the SAME "re-locked" sentinel (dispatched:false —
// the exact D043 scenario of an unrelated teammate's message just having
// reset the shared flag), hooks/prism-parent-dispatch-guard.mjs
// ADVISORY-ALLOWS (exit 0) while hooks/prism-mutation-guard.mjs STILL
// HARD-DENIES (exit 2). Both guards run on every Bash call (ROUTES.Bash in
// hooks/prism-pretooluse-dispatcher.mjs:44 = [..., 'prism-mutation-guard.mjs',
// PARENT] where PARENT = 'prism-parent-dispatch-guard.mjs'), and
// consolidate() treats ANY deny as authoritative regardless of what other
// guards in the chain say (denies.length checked first) — so for a
// Bash-write call specifically, the stricter guard (mutation-guard) wins.
// That is the deliberately-chosen, fail-safe outcome, not a bug.
//
// MANDATORY METHOD CONSTRAINT: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is
// EXPLICITLY controlled in BOTH directions in every runHook() call (idiom
// copied from tests/v3/state/test-prism-panel-deadlock.mjs:58-61) so this
// probe cannot produce a false result from an ambient marker leaking out of
// whatever session runs this file.
//
// Run: node tests/v3/state/test-prism-mutation-guard-teams-asymmetry.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const DISPATCH_GUARD = join(REPO, 'hooks', 'prism-parent-dispatch-guard.mjs');
const MUTATION_GUARD = join(REPO, 'hooks', 'prism-mutation-guard.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-mg-teams-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}
function seedSentinel(home, sessionId, obj) {
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${sessionId}.json`), JSON.stringify(obj));
}

// "Re-locked" sentinel — D043's own scenario: no dispatch recorded for THIS
// turn (an unrelated teammate's message just reset the shared `dispatched`
// flag back to false for everyone sharing the session_id).
const relockedSentinel = () => ({
  tier: 'sonnet', dispatched: false, summon_panel: false, orchestrator_dispatched: false,
  force_opus: false, source: 'keyword-floor', rationale: 'test: routine work',
  ts: new Date().toISOString(),
});

function runHook(hook, home, payload, {teams} = {}) {
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    PRISM_DISPATCH_GUARD: 'hard',
    PRISM_MUTATION_GUARD: 'hard',
    PRISM_DISPATCH_GUARD_TEAMS: 'advisory', // default, explicit for clarity
    // EXPLICITLY controlled in both directions — never left to ambient leak.
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: teams ? '1' : '',
  };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const r = spawnSync(process.execPath, [hook], {encoding: 'utf-8', input: JSON.stringify(payload), env, timeout: 15000});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

const BASH_WRITE_PAYLOAD = (sid) => ({
  tool_name: 'Bash', session_id: sid,
  tool_input: {command: 'echo "hello" > docs/prism/notes.md'},
});

// ── ARM A: marker UNSET — fail-safe baseline, BOTH guards agree (hard-deny) ──
test('ARM A (no agent-teams marker): dispatch-guard hard-denies the re-locked Bash write (fail-safe baseline)', () => {
  const home = makeHome(); const sid = 'mg-teams-a-dg';
  try {
    seedSentinel(home, sid, relockedSentinel());
    const r = runHook(DISPATCH_GUARD, home, BASH_WRITE_PAYLOAD(sid), {teams: false});
    assertEq(r.status, 2, 'dispatch-guard must hard-deny when the teams marker is absent (D039 fail-safe)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('ARM A (no agent-teams marker): mutation-guard hard-denies the re-locked Bash write (fail-safe baseline)', () => {
  const home = makeHome(); const sid = 'mg-teams-a-mg';
  try {
    seedSentinel(home, sid, relockedSentinel());
    const r = runHook(MUTATION_GUARD, home, BASH_WRITE_PAYLOAD(sid), {teams: false});
    assertEq(r.status, 2, 'mutation-guard must hard-deny when the teams marker is absent (unaffected baseline)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── ARM B: marker SET — THE GAP. dispatch-guard downgrades (D043); mutation-
// guard does not, producing a CONTRADICTORY verdict on the identical call. ──
test('ARM B (agent-teams active): dispatch-guard ADVISORY-ALLOWS the re-locked Bash write (D043, exit 0)', () => {
  const home = makeHome(); const sid = 'mg-teams-b-dg';
  try {
    seedSentinel(home, sid, relockedSentinel());
    const r = runHook(DISPATCH_GUARD, home, BASH_WRITE_PAYLOAD(sid), {teams: true});
    assertEq(r.status, 0, 'dispatch-guard must downgrade to advisory under agent-teams (D043)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('DELIBERATE (F26/D082) — ARM B (agent-teams active): mutation-guard STILL hard-denies the SAME re-locked Bash write dispatch-guard just advisory-allowed — this divergence is INTENTIONAL, not a bug', () => {
  const home = makeHome(); const sid = 'mg-teams-b-mg';
  try {
    seedSentinel(home, sid, relockedSentinel());
    const r = runHook(MUTATION_GUARD, home, BASH_WRITE_PAYLOAD(sid), {teams: true});
    // THIS IS A REGRESSION GUARD, not an open gap: task #38's survey + the
    // team lead's asymmetric-cost reasoning REJECTED making mutation-guard
    // downgrade like dispatch-guard does. A false-allow here (silently
    // permitting a Bash file-write that bypasses BOM protection / the
    // orchestrator pattern) is worse and less reversible than a false-deny
    // (friction only — 3 documented escape hatches exist, including
    // Edit/Write/MultiEdit, which mutation-guard has not gated since v5.4.0).
    // If this assertion ever needs to change to 0, that means someone is
    // ABOUT TO WEAKEN A SAFETY GUARD — read
    // docs/prism/adjudications/D082-mutation-guard-teams-asymmetry-deliberate.md
    // first; do not "fix" this test without reading it.
    assertEq(r.status, 2, 'mutation-guard must keep hard-denying under agent-teams — this divergence from dispatch-guard is DELIBERATE (D082), do not weaken');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
