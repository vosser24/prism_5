#!/usr/bin/env node
// Slice 5 (Fix A, panel-53 E1/F1) — hooks/prism-session-end.mjs extraction meta.
//
// D042 fire/not-fire pair over committed fixtures:
//   FIRE  fixtures/task-snapshot-shape-miss.jsonl — Task tool_results present but
//         the structured sibling key is unrecognized (`toolUseResultV2`, the
//         "next rename" scenario). Expects the snapshot payload to carry
//         meta = {structured_hits:0, regex_fallbacks:2, unmatched_task_results:1,
//         tail_truncated:false, degraded:true} AND exactly one
//         `task_snapshot_integrity` line appended to ~/.claude/.prism-routing.jsonl.
//   QUIET fixtures/task-snapshot-healthy.jsonl — live camelCase `toolUseResult`
//         shape. Expects meta.structured_hits:2, degraded:false, and NO
//         task_snapshot_integrity ledger line (the ledger stays silent when
//         the pipeline is healthy — E1 criterion "ledger complete, alarm sparse").
//
// Subprocess harness, matching tests/v3/hooks/test-session-end-task-snapshot.mjs.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-end.mjs');
const FIXTURES = join(__dirname, 'fixtures');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function setupFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `se-meta-home-${label}-`));
  const cwd = mkdtempSync(join(tmpdir(), `se-meta-cwd-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return {home, cwd};
}

function runHook({home, cwd}, sessionId, transcriptPath, extraEnv = {}) {
  const payload = JSON.stringify({session_id: sessionId, transcript_path: transcriptPath, cwd});
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {...process.env, HOME: home, USERPROFILE: home, ...extraEnv},
  });
}

function integrityLedgerLines(home) {
  const p = join(home, '.claude', '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n')
    .filter(l => l.includes('task_snapshot_integrity'));
}

// ─── 1. FIRE: shape-missed transcript -> degraded meta + one ledger line ────

await test('shape-miss transcript -> meta {structured:0, regex:2, unmatched:1, degraded:true} in sidecar + pointer, ONE integrity ledger line', () => {
  const fx = setupFixture('miss');
  try {
    const sessionId = 'sess-shape-miss';
    const r = runHook(fx, sessionId, join(FIXTURES, 'task-snapshot-shape-miss.jsonl'));
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${sessionId}.tasks.json`);
    assert(existsSync(sidecarPath), `sidecar missing: ${sidecarPath}`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));

    assert(sidecar.meta && typeof sidecar.meta === 'object', 'sidecar carries a meta block');
    assert(sidecar.meta.structured_hits === 0, `structured_hits === 0, got ${sidecar.meta.structured_hits}`);
    assert(sidecar.meta.regex_fallbacks === 2, `regex_fallbacks === 2 (TaskCreate via "Task #7" text + TaskUpdate via input.taskId), got ${sidecar.meta.regex_fallbacks}`);
    assert(sidecar.meta.unmatched_task_results === 1, `unmatched_task_results === 1 (block-array TaskCreate result), got ${sidecar.meta.unmatched_task_results}`);
    assert(sidecar.meta.tail_truncated === false, 'meta.tail_truncated false for a small fixture');
    assert(sidecar.meta.degraded === true, 'degraded === true — the Finding-1 signature (seen>0, structured==0)');

    const pointer = JSON.parse(readFileSync(join(fx.cwd, '.claude', '.prism-open-tasks.json'), 'utf-8'));
    assert(pointer.meta && pointer.meta.degraded === true, 'pointer payload carries the same degraded meta');

    const lines = integrityLedgerLines(fx.home);
    assert(lines.length === 1, `exactly ONE task_snapshot_integrity ledger line per snapshot, got ${lines.length}`);
    const evt = JSON.parse(lines[0]);
    assert(evt.session_id === sessionId, 'ledger line carries session_id');
    assert(evt.structured_hits === 0 && evt.degraded === true, `ledger line carries the counts, got ${lines[0]}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── 2. QUIET: healthy transcript -> healthy meta, NO ledger line ───────────

await test('healthy camelCase transcript -> meta {structured:2, degraded:false}, NO integrity ledger line', () => {
  const fx = setupFixture('healthy');
  try {
    const sessionId = 'sess-healthy';
    const r = runHook(fx, sessionId, join(FIXTURES, 'task-snapshot-healthy.jsonl'));
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${sessionId}.tasks.json`);
    assert(existsSync(sidecarPath), `sidecar missing: ${sidecarPath}`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));

    assert(sidecar.meta && sidecar.meta.structured_hits === 2, `structured_hits === 2, got ${JSON.stringify(sidecar.meta)}`);
    assert(sidecar.meta.regex_fallbacks === 0, 'regex_fallbacks === 0');
    assert(sidecar.meta.unmatched_task_results === 0, 'unmatched_task_results === 0');
    assert(sidecar.meta.degraded === false, 'degraded === false');

    const lines = integrityLedgerLines(fx.home);
    assert(lines.length === 0, `NO integrity ledger line when healthy, got: ${lines.join(' | ')}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
