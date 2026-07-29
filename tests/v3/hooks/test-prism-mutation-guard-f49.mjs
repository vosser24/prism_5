#!/usr/bin/env node
// tests/v3/hooks/test-prism-mutation-guard-f49.mjs
//
// Regression test for F49 (task #67): hooks/prism-mutation-guard.mjs's
// cp/mv/move/copy write-pattern had NO positional anchor — it matched the
// verb ANYWHERE in the scanned Bash command string, including prose inside
// a `git commit -F -` heredoc body. Because the `[^|&;]*?` gap between verb
// and path token is a character class (which matches newlines), a commit
// message that merely DESCRIBES copying/moving files (e.g. "...exercises a
// copy of the residue scenario... references lib/prism-home.mjs...") could
// pull the verb from one sentence and the src/app/lib path token from
// another, and get hard-blocked as if it were a real `cp`/`mv` invocation.
// Reproduced live during session 5's own commit step — a legitimate
// `git add && git commit -F -` was denied outright.
//
// Same structural class as F48 / D098: "a document describing an operation
// must not be treated as performing it."
//
// Fix: option (c) from the F49 write-up — require the verb to sit in
// COMMAND POSITION (string start, or immediately after `;`, `&`, `|`, `(`,
// or a NEWLINE, modulo horizontal whitespace) rather than matching anywhere
// in the string.
//
// v2 (coordinator challenge, same task #67): the first cut of this fix
// excluded bare newline from the separator class, reasoning there was "no
// lexical way" to distinguish a heredoc body line from a genuine new
// command. That premise was tested and did NOT hold — heredoc extents are
// lexically bounded (`<<`/`<<-` + optionally-quoted delimiter word, body
// running to a line that IS the delimiter) — see stripHeredocBodies() in
// hooks/prism-mutation-guard.mjs. Newline was too big a concession to give
// up: multi-line Bash blocks are this project's normal shape, and a
// `cp`/`mv` starting its own line with no leading `;`/`&&` is a REAL
// parent-context mutation. Newline is now IN the separator class; heredoc
// bodies and `-m`/`--message` quoted values are stripped from a dedicated
// probe string BEFORE this one pattern is matched (every other write
// pattern still scans the original, unstripped string).
//
// Run: node tests/v3/hooks/test-prism-mutation-guard-f49.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const { classifyBashCommand } = await import(pathToFileURL(join(HOOKS, 'prism-mutation-guard.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}
const isWrite = (cmd) => classifyBashCommand(cmd).isWrite;

// ── RED->GREEN: the reported false-positive shape, real command shape ──────
// A `git add && git commit -F -` heredoc whose message body describes
// copying work and references a lib/ path across separate sentences/lines —
// exactly the shape that was live-reproduced and blocked a real commit.
const heredocBody = [
  "fix(residue): tighten unpaired-tag detector",
  "",
  "Regression test for the fixture that exercises a copy of the residue",
  "scenario end to end, spanning several lines of explanation before it",
  "finally references lib/prism-home.mjs as the file under test.",
].join('\n');
const heredocCommit = `git add -A && git commit -F - <<'EOF'\n${heredocBody}\nEOF`;

check('F49: git commit -F - heredoc whose MESSAGE prose mentions "copy" and "lib/" -> ALLOW (not a write)',
  isWrite(heredocCommit) === false, heredocCommit);

check('F49 variant: git commit -m prose mentioning copy + lib/ on one line, no heredoc -> ALLOW',
  isWrite('git commit -m "we copy the file into lib/x.mjs as part of this change"') === false);

check('F49 variant: git commit -F - heredoc body says "moved" prose near a hooks/ path -> ALLOW',
  isWrite("git commit -F - <<'EOF'\nDocs moved to describe the new hooks/prism-x.mjs behavior in detail.\nEOF") === false);

// ── MANDATORY PAIRED TRUE-POSITIVE: genuine cp/mv, unchanged ───────────────
check('TP: genuine cp at command start into src/ -> STILL DENIED',
  isWrite('cp notes.txt src/notes.txt') === true);
check('TP: genuine mv after && into lib/ -> STILL DENIED',
  isWrite('cd foo && mv draft.md lib/draft.md') === true);
check('TP: genuine move after ; into hooks/ -> STILL DENIED',
  isWrite('echo done; move x.txt hooks/x.txt') === true);
check('TP: genuine copy inside a subshell paren into agents/ -> STILL DENIED',
  isWrite('(copy config.json agents/config.json)') === true);
check('TP: genuine cp piped from a prior command via && into docs/ -> STILL DENIED',
  isWrite('node build.mjs && cp out/README.md docs/README.md') === true);

// ── PINNED (coordinator challenge, v2 fix): multi-line Bash block where the
// cp/mv starts its own line with NO leading `;`/`&&` — the v1 fix's known-
// missed case. Now caught, because newline is a command-position separator
// AND heredoc bodies are excluded from the probe that separator applies to.
check('TP (multi-line, v2): cp on its own line after a prior unrelated command line -> DENIED',
  isWrite('node build.mjs\ncp out/README.md src/README.md') === true, 'newline must now anchor as command position');
check('TP (multi-line, v2) variant: mv on its own line into lib/ -> DENIED',
  isWrite('echo "building"\nmv dist/bundle.js lib/bundle.js') === true);
check('TP (multi-line, v2) variant: cp indented (leading spaces) on its own line into hooks/ -> DENIED',
  isWrite('cd repo\n  cp patch.mjs hooks/patch.mjs') === true);

// ── PINNED: the multi-line case must NOT reopen the F49 hole. A newline
// directly before a verb-looking word INSIDE a heredoc body must still be
// allowed, even though newline is now a command-position separator —
// because the heredoc body itself is stripped from the probe first.
check('F49 (multi-line-safe): heredoc body has "copy" as the FIRST word of its own line, followed eventually by lib/ -> STILL ALLOW',
  isWrite("git commit -F - <<'EOF'\nsummary line\n\ncopy of the fixture eventually touches lib/prism-home.mjs\nEOF") === false,
  'newline-anchored command-position must not defeat heredoc-body stripping');

// ── PINNED: the pre-existing nested case (heredoc INSIDE a -m "..." quoted
// value, via command substitution) must still be allowed — this exercises
// both strippers interacting (heredoc-body-strip runs before message-arg-
// strip in classifyBashCommand, and must not desync on this shape).
check('F49 (nested): git commit -m "$(cat <<\'EOF\' ... EOF)" with -> arrows in the heredoc body -> STILL ALLOW',
  isWrite('git commit -m "$(cat <<\'EOF\'\nfeat: detect->promote->notify\nEOF\n)"') === false);

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
