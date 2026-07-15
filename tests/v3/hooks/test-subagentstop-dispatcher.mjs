#!/usr/bin/env node
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
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-sas-${label}-`)); }

// ─── Task 3.1: prism-subagent-stop ──────────────────────────────────────────

await test('subagent-stop run() exits 0 with empty roster + no agent_name', async () => {
  const home = fakeHome('sas-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-subagent-stop.mjs')).href);
    assert(typeof mod.run === 'function', 'subagent-stop must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({session_id: 's', model: ''});
      assert(res.exit === 0, 'exit 0');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 3.2: prism-panel-guard (Path A → runSubagentStop) ─────────────────

await test('panel-guard runSubagentStop() no-ops on non-panel subagent_type, exit 0', async () => {
  const home = fakeHome('pg-a');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-panel-guard.mjs')).href);
    assert(typeof mod.runSubagentStop === 'function', 'panel-guard must export runSubagentStop()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.runSubagentStop({subagent_type: 'general-purpose', output: 'hello', session_id: 's'});
      assert(res.exit === 0 && res.stdout === '', 'silent on non-panel subagent');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 3.3: prism-phase-1-5-oob ──────────────────────────────────────────

await test('phase-1-5-oob run() exits 0 fast under recursion guard', async () => {
  const mod = await import(pathToFileURL(join(HOOKS, 'prism-phase-1-5-oob.mjs')).href);
  assert(typeof mod.run === 'function', 'phase-1-5-oob must export run()');
  const t0 = Date.now();
  const prev = process.env.PRISM_OOB_REVIEWER_PROCESS; process.env.PRISM_OOB_REVIEWER_PROCESS = '1';
  try {
    const res = await mod.run({agent_name: 'x', session_id: 's'});
    assert(res.exit === 0, 'exit 0');
    assert(Date.now() - t0 < 3000, 'returns fast (does not await reviewer)');
  } finally { if (prev === undefined) delete process.env.PRISM_OOB_REVIEWER_PROCESS; else process.env.PRISM_OOB_REVIEWER_PROCESS = prev; }
});

await test('SubagentStop dispatcher: fans to 3, panel-guard hard mode propagates exit 2', async () => {
  const home = fakeHome('sas-disp');
  try {
    const DISP = join(HOOKS, 'prism-subagentstop-dispatcher.mjs');
    const output = '**Quantum Astrologer**: my unindexed take';
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({subagent_type: 'panel', output, session_id: 's-sas'}),
      encoding: 'utf8',
      env: {...process.env, HOME: home, USERPROFILE: home, PRISM_PANEL_GUARD: 'hard', PRISM_OOB_REVIEWER_PROCESS: '1'},
    });
    assert(r.status === 2, 'hard-mode panel-guard exit 2 propagates, got ' + r.status + ' stderr=' + r.stderr);
    assert(/unindexed persona/i.test(r.stderr), 'deny notice on stderr, got: ' + r.stderr);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('SubagentStop dispatcher: soft mode advisory -> exit 0', async () => {
  const home = fakeHome('sas-soft');
  try {
    const DISP = join(HOOKS, 'prism-subagentstop-dispatcher.mjs');
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({subagent_type: 'panel', output: '**Quantum Astrologer**: x', session_id: 's2'}),
      encoding: 'utf8', env: {...process.env, HOME: home, USERPROFILE: home, PRISM_OOB_REVIEWER_PROCESS: '1'},
    });
    assert(r.status === 0, 'soft mode exit 0, got ' + r.status);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
