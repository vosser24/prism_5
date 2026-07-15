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

await test('tier-router run() classifies + returns additionalContext JSON, exit 0', async () => {
  const home = fakeHome('tier-run');
  const prevCwd = process.cwd();
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-prompt-tier-router.mjs')).href);
    assert(typeof mod.run === 'function', 'tier-router must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    try {
      const res = await mod.run({prompt: 'implement a new feature with full tests', session_id: 's-tier', cwd: home});
      assert(res.exit === 0, 'exit 0');
      const parsed = JSON.parse(res.stdout);
      assert(parsed.hookSpecificOutput.hookEventName === 'UserPromptSubmit', 'emits UserPromptSubmit additionalContext');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('memory-save-nudge run() stands down when claude-mem installed / silent before first nudge, exit 0', async () => {
  const home = fakeHome('mem-run');
  const prevCwd = process.cwd();
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-memory-save-nudge.mjs')).href);
    assert(typeof mod.run === 'function', 'memory-save-nudge must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    try {
      const res = await mod.run({session_id: 's-mem'});
      assert(res.exit === 0 && res.stdout === '', 'silent before first nudge turn, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('skill-trigger-guard run() exports + exits 0 with no triggers file', async () => {
  const home = fakeHome('skill-run');
  const prevCwd = process.cwd();
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-skill-trigger-guard.mjs')).href);
    assert(typeof mod.run === 'function', 'skill-trigger-guard must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    try {
      const res = await mod.run({prompt: 'hello there', session_id: 's-skill'});
      assert(res.exit === 0 && res.stdout === '', 'silent with no triggers map, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('dispatcher reads stdin ONCE, fans to all 4 sub-hooks, concatenates stdout, exit 0', async () => {
  const home = fakeHome('ups-disp');
  try {
    const DISP = join(HOOKS, 'prism-userpromptsubmit-dispatcher.mjs');
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({prompt: 'debug this, been stuck for hours, write tests first', session_id: 's-disp', cwd: home}),
      encoding: 'utf8',
      env: {...process.env, HOME: home, USERPROFILE: home},
      cwd: home,
    });
    assert(r.status === 0, 'exit 0, stderr=' + r.stderr);
    assert(/systematic-debugging/i.test(r.stdout), 'prism-hook debug nudge present, got: ' + r.stdout);
    assert(/TIER ROUTER/i.test(r.stdout), 'tier-router additionalContext present, got: ' + r.stdout);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
