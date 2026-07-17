#!/usr/bin/env node
// D042 both-paths test for Finding 1b (tail-window truncation) — panel-53.
//
// PURPOSE
//   Pin the truncation defect: the pre-1b task snapshot read only the last
//   500KB of the transcript, so Task events further from EOF were silently
//   lost. 1b gives extractTaskSnapshot its own full-file pass (readTaskScanLines,
//   capped at PRISM_TASKSCAN_MAXBYTES, default 20MB) and carries a
//   tail_truncated flag.
//
// D042 PAIR (over the committed fixture task-snapshot-tail-truncation.jsonl,
// which places one OPEN task (#1) at the TOP followed by padding):
//   RED  leg — tiny cap (reads only the tail): the early Task events fall
//              outside the window => open-set = [] (task DROPPED) AND
//              tail_truncated = true.
//   GREEN leg — full scan (default cap): open-set = ["1"] (task CAUGHT) AND
//              tail_truncated = false.
//   A run where the tiny-cap leg still catches #1 means the fixture/cap is
//   wrong; a run where the full leg drops #1 means 1b regressed.
//
// Slice 6 (Fix A): readTaskScanLines + extractTaskSnapshot now live in the
// shared lib hooks/lib/prism-task-snapshot.mjs (importable directly — no
// data-URL slicing needed). The loader keeps the anti-divergence guarantee the
// old verbatim source-slice gave us by asserting the hook actually imports
// that lib.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const HOOK_PATH = join(REPO_ROOT, 'hooks', 'prism-session-end.mjs');
const LIB_PATH = join(REPO_ROOT, 'hooks', 'lib', 'prism-task-snapshot.mjs');
const FIXTURE_PATH = join(HERE, 'fixtures', 'task-snapshot-tail-truncation.jsonl');

const RED_CAP_BYTES = 1000; // < fixture size minus the top Task block => tail-only

async function loadFns() {
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8');
  assert.ok(hookSrc.includes("from './lib/prism-task-snapshot.mjs'"),
    'hook no longer imports the shared task-snapshot lib — tool/hook divergence risk');
  assert.ok(!hookSrc.includes('function readTaskScanLines'),
    'hook still defines a local readTaskScanLines — shadowing the shared lib');
  const mod = await import(pathToFileURL(LIB_PATH).href);
  assert.ok(typeof mod.readTaskScanLines === 'function' && typeof mod.extractTaskSnapshot === 'function',
    'shared lib missing readTaskScanLines/extractTaskSnapshot — 1b not implemented?');
  return mod;
}

const openIds = (tasks) => tasks
  .filter(t => t.status === 'pending' || t.status === 'in_progress')
  .map(t => String(t.id))
  .sort((a, b) => Number(a) - Number(b));

function leg(mod, capBytes) {
  const prev = process.env.PRISM_TASKSCAN_MAXBYTES;
  if (capBytes == null) delete process.env.PRISM_TASKSCAN_MAXBYTES;
  else process.env.PRISM_TASKSCAN_MAXBYTES = String(capBytes);
  try {
    const {lines, tail_truncated} = mod.readTaskScanLines(FIXTURE_PATH);
    const open = openIds(mod.extractTaskSnapshot(lines));
    return {open, tail_truncated};
  } finally {
    if (prev === undefined) delete process.env.PRISM_TASKSCAN_MAXBYTES;
    else process.env.PRISM_TASKSCAN_MAXBYTES = prev;
  }
}

async function main() {
  assert.ok(existsSync(FIXTURE_PATH), `fixture missing: ${FIXTURE_PATH}`);
  const mod = await loadFns();

  // RED leg — tiny cap: the early open task must be DROPPED, flag TRUE.
  const red = leg(mod, RED_CAP_BYTES);
  console.log(`[tiny-cap ${RED_CAP_BYTES}B] open=${JSON.stringify(red.open)} tail_truncated=${red.tail_truncated}`);
  assert.deepEqual(red.open, [], 'tiny-cap leg should DROP the early task (demonstrates the 1b truncation bug)');
  assert.equal(red.tail_truncated, true, 'tiny-cap leg should set tail_truncated=true');

  // GREEN leg — full scan: the early open task must be CAUGHT, flag FALSE.
  const green = leg(mod, null);
  console.log(`[full-scan] open=${JSON.stringify(green.open)} tail_truncated=${green.tail_truncated}`);
  assert.deepEqual(green.open, ['1'], 'full-scan leg should CATCH the early open task #1');
  assert.equal(green.tail_truncated, false, 'full-scan leg should set tail_truncated=false');

  console.log('GREEN — 1b full-file task scan catches events the 500KB tail would drop; tail_truncated computed correctly.');
}

main().catch((err) => {
  console.error('\nRED — ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
