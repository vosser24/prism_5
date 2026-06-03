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
import {mkdtempSync, rmSync} from 'node:fs';
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
check('pasted transcript does NOT fire the TDD nudge', !/Test-driven work/.test(pasted));
check('pasted transcript does NOT fire the debugging nudge', !/Debugging work/.test(pasted));
check('pasted transcript does NOT fire the git-worktree nudge', !/Git worktree work/.test(pasted));

// A genuine request (no paste, ratio 0) must STILL fire the nudge.
const genuine = run('please implement the settlement function with proper tests, TDD red-green first');
check('genuine TDD request still fires the TDD nudge', /Test-driven work/.test(genuine));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
