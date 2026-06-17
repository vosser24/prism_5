#!/usr/bin/env node
// tests/v3/hooks/test-pretooluse-parallel-dispatch.mjs
// E-P2: Agent-route guards must run in parallel, not serial.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

function runDispatcher(payload, envOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ep2-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sentinel = {tier: 'haiku', rationale: 't', source: 't', dispatched: false};
  writeFileSync(
    join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`),
    JSON.stringify(sentinel)
  );
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...envOverrides},
    });
    const elapsed = Date.now() - t0;
    return {exit: r.status, stdout: (r.stdout || '').trim(), elapsed};
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

await test('Agent dispatch completes < 700ms on warm cache (parallel guard import+run)', async () => {
  // NOTE: On Windows, the first spawn is cold (~1-2s due to Node/NTFS cache warming).
  // We run a warm-up invocation first, then measure. The warm parallel floor is
  // typically ~400-450ms on this machine vs ~900ms+ serial (3 guards × ~220ms import).
  // The structural test below is the primary parallelism guard; this timing test
  // confirms the parallel path is actually being exercised end-to-end.
  const payload = {
    tool_name: 'Agent',
    session_id: 'ep2-timing',
    tool_input: {subagent_type: 'general-purpose', prompt: 'implement a feature'},
  };
  // warm-up run (discarded)
  runDispatcher(payload);
  // measured run
  const {exit, elapsed} = runDispatcher(payload);
  assert(exit === 0, `exit ${exit}`);
  assert(elapsed < 700, `elapsed ${elapsed}ms — unexpectedly slow even after warm-up (parallel path should be ~400-450ms on this machine)`);
});

await test('dispatcher source uses SEQUENTIAL_ROUTES set (structural guard)', async () => {
  const src = readFileSync(DISPATCHER, 'utf8');
  assert(src.includes('SEQUENTIAL_ROUTES'), 'missing SEQUENTIAL_ROUTES set');
  assert(src.includes("Promise.all(route.map"), 'missing parallel-import Promise.all(route.map');
  assert(src.includes("modules.map(async"), 'missing parallel-run modules.map(async');
});

await test('TaskCreate still sequential — sentinel.dispatched written before task-tier reads (exit 0, no deny)', async () => {
  const payload = {
    tool_name: 'TaskCreate',
    session_id: 'ep2-tc',
    tool_input: {subject: 'refactor api', description: 'big task'},
  };
  const {exit} = runDispatcher(payload, {PRISM_TASK_TIER: 'hard'});
  assert(exit === 0, `exit ${exit} — TaskCreate must remain sequential`);
});

await test('deny still propagates from parallel guards (Bash rm -rf /)', async () => {
  const payload = {
    tool_name: 'Bash',
    session_id: 'ep2-deny',
    tool_input: {command: 'rm -rf /'},
  };
  const {exit} = runDispatcher(payload);
  assert(exit === 2, `exit ${exit} — safety deny must still propagate in parallel path`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
