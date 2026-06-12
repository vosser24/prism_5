#!/usr/bin/env node
// v5.7.2 — unit test for isPrismHookCommand (the strip recognizer). Pure/fast: no
// install spawn, imports the function directly.
//
// Regression it guards: the recognizer used to require the prism-exec.sh/.cmd
// WRAPPER substring, so a pre-wrapper (legacy) PRISM registration like
//   "bash ~/.claude/hooks/prism-session-end.mjs"
// was NOT recognized as PRISM → stripPrismHooks left it in place → on the next
// upgrade the canonical wrapped hook was added next to the legacy one = duplicate
// Stop hooks. The recognizer must match ANY prism-*.{mjs,sh,cmd} under a hooks/
// dir (wrapped or legacy) while NOT matching unrelated user hooks.

import {isPrismHookCommand} from '../../../tools/prism-installer.mjs';

let pass = 0, total = 0;
function ok(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// --- PRISM hooks (must be recognized so strip removes them) ---
ok('wrapper .sh form', isPrismHookCommand('bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-hook.mjs'));
ok('wrapper .cmd form', isPrismHookCommand('cmd /c ~/.claude/hooks/lib/prism-exec.cmd ~/.claude/hooks/prism-hook.mjs'));
ok('legacy direct bash (no wrapper)', isPrismHookCommand('bash ~/.claude/hooks/prism-session-end.mjs'));
ok('legacy direct node (no wrapper)', isPrismHookCommand('node ~/.claude/hooks/prism-stop.mjs'));
ok('legacy hooks/lib direct (no exec)', isPrismHookCommand('bash ~/.claude/hooks/lib/prism-something.sh'));
ok('rewritten --target absolute (wrapper)', isPrismHookCommand('bash C:/Users/x/.claude/hooks/lib/prism-exec.sh C:/Users/x/.claude/hooks/prism-hook.mjs'));
ok('rewritten --target absolute (legacy)', isPrismHookCommand('bash C:/Users/x/.claude/hooks/prism-session-end.mjs'));
ok('backslash path (legacy)', isPrismHookCommand('bash C:\\Users\\x\\.claude\\hooks\\prism-session-end.mjs'));

// --- non-PRISM hooks (must NOT be recognized so strip preserves them) ---
ok('user hook unrelated', !isPrismHookCommand('bash some-other-tool.sh'));
ok('user hook in hooks/ but not prism-', !isPrismHookCommand('node ~/.claude/hooks/my-helper.mjs'));
ok('user hook with prism in the middle (not after hooks/)', !isPrismHookCommand('node ~/.claude/hooks/my-prism-helper.mjs'));
ok('empty string', !isPrismHookCommand(''));
ok('non-string (null)', !isPrismHookCommand(null));
ok('mentions the word prism but runs no script', !isPrismHookCommand('echo "running prism stuff"'));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
