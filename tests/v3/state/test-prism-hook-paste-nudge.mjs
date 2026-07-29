#!/usr/bin/env node
// prism-hook skill-suggestion nudges must NOT over-fire on pasted content (v5.2.1).
// Run: node tests/v3/state/test-prism-hook-paste-nudge.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// UAT (2026-06-03): pasting a /prism-* transcript into a PRISM session fired the
// TDD / debugging / git-worktree / parallelizable skill nudges off the PASTED
// vocabulary (prism-hook.mjs matched the raw prompt). This is the unfinished half
// of the v5.1.7 panel-summon dampening. Fix: prism-hook matches the user's OWN
// words (stripPastedContent when pastedRatio ≥ 0.6). Drives the hook as a real
// subprocess over stdin — the way Claude Code runs it.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-hook.mjs');

function run(prompt) {
  const home = mkdtempSync(join(tmpdir(), 'prism-hook-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'prism-hook-cwd-'));
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({prompt, session_id: 'paste-nudge-test'}),
    encoding: 'utf8',
    cwd,
    env: {...process.env, HOME: home, USERPROFILE: home},
  });
  rmSync(home, {recursive: true, force: true});
  rmSync(cwd, {recursive: true, force: true});
  return r.stdout || '';
}

// T8 (2026-07-22): commit 012cb1548 (v6.6.0 FIX-6) deleted the "Test-driven
// work"/"Debugging work"/"Git worktree work" nudge TEXT from prism-hook.mjs
// but deliberately PRESERVED the underlying recognizer signal — a matching
// prompt sets matchedInvocation=true, which resets gs.trivial_streak to 0
// (persisted per-session in .prism-global-state.json); a non-matching prompt
// increments it. runFull() reads that value back before the ephemeral HOME is
// torn down, so paste-dampening (stripPastedContent) can be asserted on the
// signal that actually still exists, instead of on the deleted text.
function runFull(prompt, sessionId) {
  const home = mkdtempSync(join(tmpdir(), 'prism-hook-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'prism-hook-cwd-'));
  const sid = sessionId || 'paste-nudge-test-full';
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({prompt, session_id: sid}),
    encoding: 'utf8',
    cwd,
    env: {...process.env, HOME: home, USERPROFILE: home},
  });
  let trivialStreak = null;
  try {
    const gsf = join(home, '.claude', '.prism-global-state.json');
    if (existsSync(gsf)) trivialStreak = JSON.parse(readFileSync(gsf, 'utf8')).sessions[sid].trivial_streak;
  } catch {}
  rmSync(home, {recursive: true, force: true});
  rmSync(cwd, {recursive: true, force: true});
  return {stdout: r.stdout || '', trivialStreak};
}

let pass = 0, total = 0;
const check = (l, c) => { total++; c ? pass++ : console.log('FAIL: ' + l); };

// A paste-dominated transcript: the trigger vocabulary lives inside CC transcript
// / table marker lines (●, ⎿, │, └) — exactly where it lives in a real paste —
// so stripPastedContent removes it. Message-prefix greps ("Test-driven work",
// etc.) never appear in the input, only in the emitted nudge.
const PASTE = [
  '● /prism-recommend — scoring tools',
  '  ⎿  superpowers 4/5 — test-driven-development, systematic-debugging workflows',
  '│ tool │ git worktree │ parallelizable work │',
  '● Agent(Run scan) Haiku 4.5',
  '└────┘ root cause / debug / TDD / worktree mentioned in the report body',
].join('\n');

const pasted = run(PASTE);
// T8 fix: these three used to assert on the deleted nudge TEXT (see runFull()
// comment above) and so passed vacuously — the assertion could not fail for
// any input once 012cb1548 removed the strings from prism-hook.mjs. Assert on
// the surviving signal instead: on a fresh session, trivial_streak lands at 1
// (incremented, not reset) only if matchedInvocation stayed false for all of
// TDD/debug/worktree — i.e. paste-dampening actually suppressed the
// recognizer. A positive control (same vocabulary as the user's OWN words,
// not pasted) proves this has real discriminating power: it must reset
// trivial_streak to 0, showing the recognizer still fires when it should.
check('pasted transcript does NOT fire the TDD/debug/worktree recognizer (trivial_streak increments, not reset)',
  runFull(PASTE, 'paste-nudge-tdw-pasted').trivialStreak === 1);
check('same TDD/debug/worktree vocabulary as the user\'s OWN words DOES fire the recognizer (trivial_streak resets to 0)',
  runFull('debug this and find the root cause with a git worktree, write tests first', 'paste-nudge-tdw-own').trivialStreak === 0);

// ── v5.3.1: broadened parallel-opportunity detector ──────────────────────────
// Everyday multi-target work should now trip the "Parallelizable work detected"
// nudge so the main loop batches independent subtasks into ONE message.
const PAR = /Parallelizable work detected/;
check('multi-file edit fires the parallel nudge',
  PAR.test(run('update config.js and utils.js and api.js to use the new logger')));
check('verb + "across" fires the parallel nudge (broadened verb set)',
  PAR.test(run('refactor the auth module across all services')));
check('two source files fire the parallel nudge (parallel_files)',
  PAR.test(run('implement the parser in lexer.py and emitter.py')));
check('explicit "in parallel" fires the parallel nudge',
  PAR.test(run('research Redis and Memcached in parallel')));
check('single-file edit does NOT fire the parallel nudge (no over-fire)',
  !PAR.test(run('fix the off-by-one bug in app.js')));
check('pasted transcript does NOT fire the parallel nudge (paste dampening holds)',
  !PAR.test(pasted));

// ── v5.3.1: plan-first / task-list detector ──────────────────────────────────
// Clear multi-step intent should nudge a task list (TaskCreate/TaskUpdate; or
// TodoWrite on builds that expose the legacy name) before execution. The assertion
// matches the stable trigger phrase "Multi-step work detected", not the tool name,
// so the v5.7.1 tool-name change does not touch it.
const PLAN = /Multi-step work detected/;
check('first/then sequence fires the plan-first nudge',
  PLAN.test(run('first scaffold the data model, then build the API, then write the tests')));
check('numbered list fires the plan-first nudge',
  PLAN.test(run('do this:\n1. add the migration\n2. update the serializer\n3. add a test')));
check('"then also add" phrasing fires the plan-first nudge',
  PLAN.test(run('implement the export endpoint then also add rate limiting')));
check('single-action request does NOT fire the plan-first nudge (no over-fire)',
  !PLAN.test(run('rename the variable in app.js')));
check('pasted transcript does NOT fire the plan-first nudge (paste dampening holds)',
  !PLAN.test(pasted));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
