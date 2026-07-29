#!/usr/bin/env node
// tests/v3/hooks/test-prism-bash-hang-guard-f14.mjs
//
// Regression test for F14 (task #23): the `state-file-poll` rule in
// hooks/prism-bash-hang-guard.mjs blocked a BOUNDED `for VAR in <fixed
// list>; do …; done` loop purely because ONE enumerated filename happened
// to be state/lock-shaped — even though the loop body only ever reads the
// loop VARIABLE (`"$f"`), never that literal path. Observed live during
// /prism-audit's secret scan: `for f in <6 fixed files>; do grep … "$f";
// done`, where one of the six files was `.claude/.prism-state.json`.
//
// Root cause: the old regex matched the state/lock token ANYWHERE after the
// loop keyword (while/until/for alike), including inside a `for`'s
// iteration-list clause (before `do`) — conflating "this filename is one of
// N distinct enumerated items" with "this exact file is read/re-read".
//
// Fix: `for` loops now only match when the token appears AFTER `do` (i.e.
// the BODY itself names that literal path — a genuine same-file re-read).
// `while`/`until` are UNCHANGED (token may match in condition or body,
// since those loops have no fixed bound the way `for VAR in <list>` does).
//
// Required per task #23's acceptance bar: RED (reproduces the reported FP),
// the fix, and a PAIRED TRUE-POSITIVE (the rule must still catch a genuine
// tight state-file poll — including one dressed as a bounded `for`, per the
// tracker's own fix-candidate: "require same-file re-read ... for the poll
// signal").
//
// Run: node tests/v3/hooks/test-prism-bash-hang-guard-f14.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const { run } = await import(pathToFileURL(join(HOOKS, 'prism-bash-hang-guard.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}
const exitOf = (cmd) => run({ tool_name: 'Bash', tool_input: { command: cmd } }).exit;

// ── RED->GREEN: the exact reported shape ────────────────────────────────────
// A fixed 6-item file list (the real /prism-audit secret-scan shape), one
// item happens to be state.json-named, body reads only the loop variable.
const F14_REPORTED_SHAPE =
  'for f in .claude/CLAUDE.md settings.json .claude/.prism-state.json .mcp.json hooks/prism-a.mjs skills/b/SKILL.md; do grep -n "sk-" "$f" 2>/dev/null; done';
check('F14: bounded for-list containing a state.json-named entry -> ALLOW (not a poll)',
  exitOf(F14_REPORTED_SHAPE) === 0);

// Same shape with a .lock-named entry instead of state.json — same bug class.
const F14_LOCK_VARIANT =
  'for f in a.mjs b.mjs .reclassify_lock c.mjs; do wc -l "$f"; done';
check('F14 variant: bounded for-list containing a .lock-named entry -> ALLOW',
  exitOf(F14_LOCK_VARIANT) === 0);

// ── PAIRED TRUE-POSITIVE (required): genuine while/until polls still block ──
check('TP: while true reading init_state.json in body -> BLOCK (unchanged)',
  exitOf('while true; do cat init_state.json; sleep 1; done') === 2);
check('TP: until condition polls init_state.json -> BLOCK (unchanged)',
  exitOf('until grep -q ready init_state.json; do sleep 1; done') === 2);

// ── PAIRED TRUE-POSITIVE (the harder case): a bounded `for` that STILL ──────
// re-reads the SAME hardcoded state file in its body (not via a loop
// variable) must still be caught — this is the "same-file re-read" signal
// the tracker's own fix-candidate names as the alternative to unbounded
// while, and it's exactly what distinguishes this from the F14 FP above.
check('TP: bounded for-loop that hardcodes init_state.json IN THE BODY -> BLOCK',
  exitOf('for i in 1 2 3; do cat init_state.json; done') === 2);

// ── Sanity: no state/lock token anywhere -> stays quiet (pre-existing) ──────
check('control: bounded for-loop, no state/lock token at all -> ALLOW',
  exitOf('for f in *.mjs; do node --check "$f"; done') === 0);

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
