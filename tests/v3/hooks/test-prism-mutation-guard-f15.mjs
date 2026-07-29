#!/usr/bin/env node
// tests/v3/hooks/test-prism-mutation-guard-f15.mjs
//
// Regression test for F15 (task #23): hooks/prism-mutation-guard.mjs never
// stripped quotes at all — unlike its sibling hooks/prism-bash-hang-guard.mjs,
// which does via stripQuotesAndHeredocs(). Reported live: a comparison
// operator (`>=`, `<`) sitting INSIDE a quoted argument (e.g. a `node -e`
// script, or the text `echo`/`printf`/`cat` themselves print) was misread as
// a shell redirection, and a read-only integrity check got BLOCKED.
//
// THIS IS A PARSING FIX, NOT A POLICY FIX (explicit constraint, task #23):
// the guard must still deny EXACTLY the same set of genuinely-dangerous
// shapes it denies today. The only change is that `<`/`>` characters INSIDE
// a quoted argument stop being read as shell metacharacters.
//
// Fix: neutralizeQuotedShellMetachars() (hooks/prism-mutation-guard.mjs)
// swaps `<`/`>` for `_` ONLY inside '...'/"..." spans, before write-pattern
// matching. Deliberately NOT a blanket quote-strip (unlike bash-hang-guard's
// approach) — this guard's own patterns need to see extension text INSIDE a
// quoted redirect TARGET (`echo "x" > "out.json"`), so only the metacharacter
// itself is neutralized, never the surrounding text.
//
// Required per task #23's acceptance bar:
//   1. RED test reproducing the false positive.
//   2. The fix.
//   3. MANDATORY paired true-positive: genuine shell redirection to a file
//      still denied, unchanged — INCLUDING the hardest shape, a redirect
//      OUTSIDE a quoted payload on the SAME command line as a quoted
//      payload (exactly where a naive/blanket quote-strip fix would blind
//      the guard).
//   4. Existing mutation-guard suites must not regress (run + reported
//      separately by the dispatching agent, before AND after).
//   5. The D082 teams-asymmetry regression guard (4/4) must stay 4/4 (run +
//      reported separately).
//
// Run: node tests/v3/hooks/test-prism-mutation-guard-f15.mjs

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

// ── RED->GREEN: the reported false-positive shapes ─────────────────────────
check('F15: echo whose OWN quoted text contains a >= comparison -> ALLOW (not a write)',
  isWrite('echo "checking t>=1000" && node -e "process.exit(0)"') === false);
check('F15 variant: printf whose OWN quoted text contains >= -> ALLOW',
  isWrite('printf "value is t>=1000 now"') === false);
check('F15 variant: quoted node -e payload with a bare < comparison -> ALLOW',
  isWrite('node -e "if (t<0) throw new Error(\'bad\')" ; echo done') === false);
check('F15 variant: quoted node -e payload with >= and no surrounding whitespace -> ALLOW',
  isWrite('node -e "const t=Date.now(); if(t>=1000){console.log(1)}"') === false);
check('F15 variant: single-quoted node -e payload (not just double-quoted) -> ALLOW',
  isWrite("node -e 'if (t < 0 || t >= 9999) { throw new Error(1); }'") === false);

// ── MANDATORY PAIRED TRUE-POSITIVE: genuine redirection, unchanged ─────────
check('TP: genuine echo redirect to a real file (unquoted target) -> STILL DENIED',
  isWrite('echo "hello" > docs/notes.md') === true);
check('TP: genuine echo redirect to a QUOTED file target -> STILL DENIED (extension survives)',
  isWrite('echo "hello" > "docs/notes.md"') === true);
check('TP: PowerShell Set-Content -> STILL DENIED regardless of quoted VALUE content',
  isWrite('Set-Content -Path "out.json" -Value "a>b"') === true);
check('TP: node writeFileSync -> STILL DENIED (unrelated to quote handling)',
  isWrite('node -e "require(\'fs\').writeFileSync(\'x.json\', \'{}\')"') === true);
check('TP: sed -i in-place edit -> STILL DENIED',
  isWrite('sed -i "s/foo/bar/" config.yml') === true);

// ── THE HARDEST CASE (explicitly required): a redirect OUTSIDE a quoted ────
// payload, on the SAME command line as a quoted payload containing an
// in-quote comparison operator. This is exactly where a lazy/blanket
// quote-strip fix would silently blind the guard — the neutralization must
// be scoped to WITHIN quotes only, leaving a real, unquoted `>` untouched.
check('TP (hard): quoted node -e payload has an IN-QUOTE >= comparison, AND a REAL redirect sits OUTSIDE the quotes on the same line -> STILL DENIED',
  isWrite('node -e "if (t>=1000) console.log(1)" > results.json') === true);
check('TP (hard) variant: quoted echo text has an IN-QUOTE < comparison, AND a REAL redirect to a quoted target follows -> STILL DENIED',
  isWrite('echo "threshold check: t<0 means invalid" > "audit.log.md"') === true);

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
