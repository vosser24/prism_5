#!/usr/bin/env node
// D042 both-paths test for Finding 1a (camelCase toolUseResult) — panel-53.
//
// PURPOSE
//   Pin the extractTaskSnapshot() key-read defect in hooks/prism-session-end.mjs.
//   PRIMARY assertion runs against a committed, PII-free SYNTHETIC fixture
//   (machine-independent, CI-safe). It is RED on the current snake-key hook and
//   GREEN after the 1a fix (line 109: obj.tool_use_result ->
//   obj.toolUseResult ?? obj.tool_use_result). A passing result on the UNFIXED
//   hook means the test is wrong.
//
//   OPTIONAL cross-check: set PRISM_REPLAY_TRANSCRIPT=<abs path to a real
//   session transcript> to also replay against live data (full-file scope).
//   Absent => that leg reports CANNOT-VERIFY and is skipped; it never fails the
//   run and never masquerades as a pass.
//
// SCOPE (deliberate — Finding 1a ONLY)
//   Runs extractTaskSnapshot over the FULL line set, isolating the camelCase
//   key (1a) from the separate 500KB tail-truncation vector (1b). Over the
//   DEPLOYED tail window a long real transcript can still collapse to [] — that
//   is 1b, a later slice, NOT a regression of this test.
//
// FIXTURE (tests/v3/hooks/fixtures/task-snapshot-camelcase.jsonl)
//   Hand-authored, zero real data. Encodes both silent-failure modes of the
//   snake-key reader against camelCase toolUseResult:
//     #1 alpha  — created + TaskList in_progress            => open (both readers)
//     #2 bravo  — created, completed ONLY via
//                 toolUseResult.statusChange.to (input has
//                 no status) => snake reader can't see the
//                 completion => FABRICATED as open           => open (buggy only)
//     #7 golf   — exists ONLY in toolUseResult.tasks[] as
//                 pending (no create/update) => snake reader
//                 can't read tur.tasks => DROPPED             => open (correct only)
//   CURRENT (snake) open-set = {1,2}; GOLDEN (camel) open-set = {1,7}.
//
// LIVE GOLDEN (optional leg) — provenance measured 2026-07-17, two methods:
//   transcript deadbeef-0000-4000-8000-000000000004.jsonl (prism_3 project),
//   full-file open-set = {9,15,16,17,18,19,31,33} (last TaskList snapshot
//   {9,15,16,17,18,19,31} plus #33, created after that TaskList and left open).

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const HOOK_PATH = join(REPO_ROOT, 'hooks', 'prism-session-end.mjs');
const LIB_PATH = join(REPO_ROOT, 'hooks', 'lib', 'prism-task-snapshot.mjs');
const FIXTURE_PATH = join(HERE, 'fixtures', 'task-snapshot-camelcase.jsonl');

const FIXTURE_GOLDEN = ['1', '7'];
const LIVE_GOLDEN = ['9', '15', '16', '17', '18', '19', '31', '33'];

// ── import the CURRENT extractTaskSnapshot (Slice 6: from the shared lib) ────
// hooks/lib/prism-task-snapshot.mjs is directly importable (no stdin/exit side
// effects). The loader keeps the anti-divergence guarantee the old verbatim
// source-slice gave us by asserting the hook actually imports that lib.
async function loadExtractor() {
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8');
  assert.ok(hookSrc.includes("from './lib/prism-task-snapshot.mjs'"),
    'hook no longer imports the shared task-snapshot lib — tool/hook divergence risk');
  assert.ok(!hookSrc.includes('function extractTaskSnapshot'),
    'hook still defines a local extractTaskSnapshot — shadowing the shared lib');
  const mod = await import(pathToFileURL(LIB_PATH).href);
  assert.ok(typeof mod.extractTaskSnapshot === 'function',
    'extractTaskSnapshot not exported by the shared lib');
  return mod.extractTaskSnapshot;
}

const openIds = (tasks) => tasks
  .filter(t => t.status === 'pending' || t.status === 'in_progress')
  .map(t => String(t.id))
  .sort((a, b) => Number(a) - Number(b));

function reportDelta(label, actual, golden) {
  const missed = golden.filter(x => !actual.includes(x));
  const fabricated = actual.filter(x => !golden.includes(x));
  console.log(`${label} actual=${JSON.stringify(actual)} golden=${JSON.stringify(golden)}`);
  if (missed.length || fabricated.length) {
    console.log(`  missed(true-open dropped)=${JSON.stringify(missed)} fabricated(false-open)=${JSON.stringify(fabricated)}`);
  }
}

async function main() {
  const extractTaskSnapshot = await loadExtractor();

  // ── PRIMARY: synthetic fixture (deterministic, CI-safe) ──────────────────
  assert.ok(existsSync(FIXTURE_PATH), `fixture missing: ${FIXTURE_PATH}`);
  const fxLines = readFileSync(FIXTURE_PATH, 'utf-8').split(/\r?\n/);
  const fxActual = openIds(extractTaskSnapshot(fxLines));
  reportDelta('[synthetic]', fxActual, FIXTURE_GOLDEN);
  assert.deepEqual(fxActual, FIXTURE_GOLDEN,
    `[synthetic] extractTaskSnapshot open-set mismatch — Finding 1a: line 109 ` +
    `reads obj.tool_use_result; camelCase toolUseResult is unread ` +
    `(=> #2 fabricated-open via unseen statusChange, #7 dropped via unread tasks[]).`);

  // ── OPTIONAL: live transcript cross-check (full-file scope) ───────────────
  const live = process.env.PRISM_REPLAY_TRANSCRIPT;
  if (live) {
    if (!existsSync(live)) {
      console.error(`[live] CANNOT VERIFY — PRISM_REPLAY_TRANSCRIPT not found: ${live} (exit 2)`);
      process.exit(2);
    }
    const liveLines = readFileSync(live, 'utf-8').split(/\r?\n/);
    const liveActual = openIds(extractTaskSnapshot(liveLines));
    reportDelta('[live full-file]', liveActual, LIVE_GOLDEN);
    assert.deepEqual(liveActual, LIVE_GOLDEN,
      `[live] full-file open-set mismatch against measured golden.`);
  } else {
    console.log('[live] skipped — set PRISM_REPLAY_TRANSCRIPT to enable the live cross-check.');
  }

  console.log('GREEN — extractTaskSnapshot matches golden (synthetic' + (live ? ' + live' : '') + ').');
}

main().catch((err) => {
  console.error('\nRED — ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
