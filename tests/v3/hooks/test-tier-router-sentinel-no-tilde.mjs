#!/usr/bin/env node
// F22 — buildOverrideDirective() in prism-prompt-tier-router.mjs used to build
// the sentinel path the model is told to Read as a LITERAL TILDE STRING
// (`~/.claude/.prism-turn-tier-${sid}.json`), even though the same file
// already computes the correct absolute path via sentinelPath(sessionId) for
// its own I/O (readSentinel/write). Handing the model an ambiguous `~` path
// let a shell/tool with a different HOME resolution (observed live: `~`
// expanded to a non-existent `C:\Users\userA\...` instead of the real
// `C:\Users\userB\...`) fail the Read and fall back to a directory dump.
//
// This test asserts the override directive text emitted to the model
// contains NO `~` character and instead carries the fully-resolved sentinel
// path (matching what sentinelPath()/readSentinel() use internally).
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

// D087 (#44): the override directive is now suppressed for a dispatched
// teammate (CLAUDE_CODE_CHILD_SESSION=1). Both assertions below describe the
// CHAIR path — pin the discriminator so the result does not depend on whether
// the chair or a subagent runs the suite.
delete process.env.CLAUDE_CODE_CHILD_SESSION;
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-tier-notilde-${label}-`)); }

await test('buildOverrideDirective() emits NO literal ~ and uses the resolved sentinelPath()', async () => {
  const home = fakeHome('unit');
  const prevCwd = process.cwd();
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-prompt-tier-router.mjs')).href + '?t=' + Date.now());
    assert(typeof mod.buildOverrideDirective === 'function', 'module must export buildOverrideDirective');
    const directive = mod.buildOverrideDirective('opus', true, 'sess-abc');
    assert(!directive.includes('~'), 'directive text must contain NO ~ character, got: ' + directive);
    const expectedPath = join(home, '.claude', '.prism-turn-tier-sess-abc.json');
    assert(directive.includes(expectedPath), `directive must contain the resolved absolute sentinel path (${expectedPath}), got: ${directive}`);
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd);
    rmSync(home, {recursive: true, force: true});
  }
});

await test('run() additionalContext on a keyword-floor turn contains NO ~ character', async () => {
  const home = fakeHome('run');
  const prevCwd = process.cwd();
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-prompt-tier-router.mjs')).href + '?t=' + Date.now());
    assert(typeof mod.run === 'function', 'tier-router must export run()');
    // Fresh home => no 24h cache, no slash-command allowlist match => keyword-floor.
    const res = await mod.run({prompt: 'fix a small bug in the login form', session_id: 's-notilde', cwd: home});
    assert(res.exit === 0, 'exit 0');
    const parsed = JSON.parse(res.stdout);
    const advice = parsed.hookSpecificOutput.additionalContext;
    assert(/PRISM TIER OVERRIDE PROTOCOL/.test(advice), 'expected the keyword-floor override protocol to fire, got: ' + advice);
    assert(!advice.includes('~'), 'additionalContext must contain NO ~ character, got: ' + advice);
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd);
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
