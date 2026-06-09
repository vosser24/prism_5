#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-ptu-${label}-`)); }

// ─── Task 2.1: prism-kb-autosync ────────────────────────────────────────────

await test('kb-autosync run() marks a .claude/skills write dirty, returns stdout exit 0', async () => {
  const home = fakeHome('kb-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-kb-autosync.mjs')).href);
    assert(typeof mod.run === 'function', 'kb-autosync must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const fp = join(home, '.claude', 'skills', 'foo', 'SKILL.md');
      const res = await mod.run({tool_name: 'Write', tool_input: {file_path: fp}});
      assert(res.exit === 0, 'exit 0');
      assert(existsSync(join(home, '.claude', '.prism-kb-dirty')), 'dirty flag written');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 2.2: prism-agent-write-register ───────────────────────────────────

await test('agent-write-register run() registers a global agent, returns stdout exit 0', async () => {
  const home = fakeHome('awr-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-agent-write-register.mjs')).href);
    assert(typeof mod.run === 'function', 'agent-write-register must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const ap = join(home, '.claude', 'agents', 'foo.md');
      mkdirSync(dirname(ap), {recursive: true});
      writeFileSync(ap, '---\nname: foo\ndescription: does foo\n---\n# foo\n');
      const res = await mod.run({tool_name: 'Write', tool_input: {file_path: ap}});
      assert(res.exit === 0, 'exit 0');
      assert(/registered foo/i.test(res.stdout), 'stdout: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 2.3: prism-phase-0d-challenges ────────────────────────────────────

await test('phase-0d-challenges run() no-ops on non-panel Write, exit 0', async () => {
  const home = fakeHome('0dc-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-phase-0d-challenges.mjs')).href);
    assert(typeof mod.run === 'function', 'phase-0d-challenges must export run()');
    const res = await mod.run({tool_name: 'Write', tool_input: {file_path: join(home, 'notes.md')}});
    assert(res.exit === 0 && res.stdout === '', 'silent on non-panel path');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 2.6: prism-dispatch-cap ───────────────────────────────────────────

await test('dispatch-cap run() no-ops on non-Agent tool, exit 0', async () => {
  const mod = await import(pathToFileURL(join(HOOKS, 'prism-dispatch-cap.mjs')).href);
  assert(typeof mod.run === 'function', 'dispatch-cap must export run()');
  const res = await mod.run({tool_name: 'Write', tool_input: {}});
  assert(res.exit === 0 && res.stdout === '', 'silent on non-Agent tool');
});

// ─── Task 2.4: prism-panel-guard ────────────────────────────────────────────

await test('panel-guard runPostToolUse() exists; no-ops on non-panel Write, exit 0', async () => {
  const home = fakeHome('pg-b');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-panel-guard.mjs')).href);
    assert(typeof mod.runPostToolUse === 'function', 'panel-guard must export runPostToolUse()');
    const res = await mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: join(home, 'x.md')}});
    assert(res.exit === 0 && res.stdout === '', 'silent on non-panel path');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 2.5: prism-phase-0d-oob ───────────────────────────────────────────

await test('phase-0d-oob run() returns immediately on non-panel Write (R2 early-exit)', async () => {
  const home = fakeHome('0doob-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-phase-0d-oob.mjs')).href);
    assert(typeof mod.run === 'function', 'phase-0d-oob must export run()');
    const t0 = Date.now();
    const res = await mod.run({tool_name: 'Write', tool_input: {file_path: join(home, 'notes.md')}});
    assert(res.exit === 0, 'exit 0');
    assert(Date.now() - t0 < 2000, 'must return fast on non-panel path (no reviewer spawn)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('PostToolUse dispatcher: Write fans to 5 (kb-autosync dirty flag written), exit 0', async () => {
  const home = fakeHome('ptu-write');
  try {
    const DISP = join(HOOKS, 'prism-posttooluse-dispatcher.mjs');
    const fp = join(home, '.claude', 'skills', 'foo', 'SKILL.md');
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({tool_name: 'Write', tool_input: {file_path: fp}}),
      encoding: 'utf8',
      env: {...process.env, HOME: home, USERPROFILE: home, PRISM_DISABLE_OOB_REVIEW: '1'},
    });
    assert(r.status === 0, 'exit 0, stderr=' + r.stderr);
    assert(existsSync(join(home, '.claude', '.prism-kb-dirty')), 'kb-autosync ran inside dispatcher');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('PostToolUse dispatcher: Agent routes ONLY to dispatch-cap, exit 0', async () => {
  const home = fakeHome('ptu-agent');
  try {
    const DISP = join(HOOKS, 'prism-posttooluse-dispatcher.mjs');
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({tool_name: 'Agent', tool_input: {subagent_type: 'general-purpose', description: 'x'}}),
      encoding: 'utf8', env: {...process.env, HOME: home, USERPROFILE: home},
    });
    assert(r.status === 0, 'exit 0');
    assert(!existsSync(join(home, '.claude', '.prism-kb-dirty')), 'kb-autosync NOT run for Agent');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
