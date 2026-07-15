#!/usr/bin/env node
// TDD for prism-mutation-guard.mjs classifyBashCommand().
//
// BUG (flagged this session): the `echo|printf|cat ... > file` write pattern
// has no fd-redirect / /dev/null guard (unlike the line-95 extension pattern),
// so a pure READ like `cat <statefile> 2>/dev/null` matches `cat ... > /dev/null`
// via the STDERR redirect and gets hard-blocked. Symptom: "the guard caught the
// 2> redirect; reading the state file directly instead."
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-mutation-guard.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const mod = await import(pathToFileURL(HOOK).href);
const classify = mod.classifyBashCommand;

await test('exports classifyBashCommand', async () => {
  assert(typeof classify === 'function', 'classifyBashCommand must be exported for testing');
});

// ── The bug: stderr / fd redirects must NOT be treated as file writes ──
const notWrites = [
  ['cat ~/.claude/.prism-turn-tier-abc.json 2>/dev/null', 'cat statefile with 2>/dev/null (THE bug)'],
  ['cat foo.json 2>/dev/null | tail -1', 'cat .json piped, stderr to null'],
  ['node tests/v3/hooks/test-x.mjs 2>&1', 'stderr dup 2>&1'],
  ['printf hi 2>>err.log', 'stderr append 2>>'],
  ['echo checking 2>/dev/null', 'echo with only a stderr redirect'],
  ['cat report.md > /dev/null', 'explicit cat to /dev/null is not a real write'],
  ['grep -n HOME hooks/*.mjs 2>/dev/null', 'grep, stderr suppressed'],
];
for (const [cmd, desc] of notWrites) {
  await test(`NOT a write: ${desc}`, async () => {
    assert(classify(cmd).isWrite === false, `should be isWrite=false → ${cmd}`);
  });
}

// ── Regression guard: genuine writes must STILL be detected ──
const writes = [
  ['echo hello > out.txt', 'echo redirect to a real file'],
  ['cat a.json > b.json', 'cat to a real .json file'],
  ['printf "x" > notes.md', 'printf to a real .md file'],
  ['cat header.txt >> combined.log', 'append to a real file'],
  ["Set-Content -Path foo.json -Value '{}'", 'PowerShell Set-Content'],
];
for (const [cmd, desc] of writes) {
  await test(`IS a write: ${desc}`, async () => {
    assert(classify(cmd).isWrite === true, `should be isWrite=true → ${cmd}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
