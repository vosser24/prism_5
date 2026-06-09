#!/usr/bin/env node
// Tests for the UserPromptSubmit dispatcher + the run() exports it composes.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-ups-${label}-`)); }

await test('prism-hook run() returns advisory stdout for a TDD prompt, exit 0', async () => {
  const home = fakeHome('hook-run');
  const prevCwd = process.cwd();
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-hook.mjs')).href);
    assert(typeof mod.run === 'function', 'prism-hook.mjs must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.chdir(home);              // isolate PROJECT-LOCAL .claude state too
    try {
      const res = await mod.run({prompt: 'write this with proper tests, TDD', session_id: 's1'});
      assert(res.exit === 0, 'exit 0');
      assert(/test-driven-development/i.test(res.stdout), 'emits TDD nudge, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
