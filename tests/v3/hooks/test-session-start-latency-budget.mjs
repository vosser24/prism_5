#!/usr/bin/env node
// Task #9: SessionStart latency BUDGET assertion — assert the PROPERTY (fast
// session start), not just the proxy (no spawnSync — that grep lives in
// test-session-start-async-audit.mjs and stays).
//
// WHY: on another machine a handoff-staleness guard spawned one `git log` per
// handoff file across ~60 files at ~0.5s/spawn on Windows, adding 90,000+ ms
// to EVERY session start. The structural spawnSync grep banned that specific
// pattern, but a future guard can be slow in a way the grep does not catch
// (async-but-awaited fan-out, sync fs walks over huge trees, etc.). This test
// EXECUTES the hook and fails on wall-clock, whatever the mechanism.
//
// BUDGET: 5000 ms, compared against the MEDIAN of 5 warm runs.
// Measured 2026-07-16 on this machine (repo on SMB Y:, hermetic fake HOME):
//   cold/first run 797ms (node+SMB warmup), warm runs 259-501ms, median 371ms.
// Reasoning:
//   - First run is DISCARDED as warmup: cold node/SMB start was measured at
//     ~11.7s on 2026-07-14 — that is machine warmup, not a hook defect, and a
//     budget that flags it would train everyone to ignore red (a flaky latency
//     test is worse than none).
//   - Median-of-5 warm runs: a single OS hiccup cannot fail the test; a real
//     regression shifts every run, so it shifts the median.
//   - 5000ms is ~13x the measured warm median — generous enough that even a
//     4-5x slow machine/SMB day stays green — while still catching any guard
//     that adds seconds (the incident class added 90s; even one 0.5s spawn
//     per file over 10 files = +5s would trip it).
// Catch-proof (D042): verified 2026-07-16 by pointing PRISM_SS_LATENCY_HOOK
// at a copy of the hook with a deliberate 6s top-level delay → test FAILS;
// real hook untouched and green.
//
// Env override PRISM_SS_LATENCY_HOOK=<path> exists ONLY so the catch-proof
// can run against a deliberately-slowed copy without modifying the real hook.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = process.env.PRISM_SS_LATENCY_HOOK
  || join(__dirname, '..', '..', '..', 'hooks', 'prism-session-start.mjs');

const BUDGET_MS = 5000;   // median of warm runs must stay under this
const WARM_RUNS = 5;      // runs measured after the discarded warmup
const PER_RUN_TIMEOUT_MS = 120000; // hard kill so a 90s-class hang still reports

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Minimal fake HOME the hook will accept (hermetic — never touches real ~/.claude).
function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `latency-ss-${label}-`));
  mkdirSync(join(home, '.claude', 'tools'), {recursive: true});
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  return home;
}

// One timed hook run in a fresh fake HOME. Returns {status, stderr, elapsed}.
function runHookTimed(label) {
  const home = makeHome(label);
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({session_id: 'test-latency-budget', cwd: home}),
      encoding: 'utf-8',
      timeout: PER_RUN_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PRISM_DISABLE_FRESHNESS_SWEEP: '1',
        PRISM_DISABLE_PARALLEL_REMINDER: '1',
      },
    });
    return {status: r.status, stderr: r.stderr, elapsed: Date.now() - t0};
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

await test(`SessionStart median warm wall-clock < ${BUDGET_MS}ms (${WARM_RUNS} runs, first-run warmup discarded)`, () => {
  const warmup = runHookTimed('warmup');
  console.log(`    [latency] warmup ${warmup.elapsed}ms (discarded; cold node/SMB start is not a hook defect)`);

  const runs = [];
  for (let i = 0; i < WARM_RUNS; i++) {
    const r = runHookTimed(`warm${i}`);
    assert(r.status === 0, `run ${i}: hook exited ${r.status} (timeout/crash?). stderr=${(r.stderr || '').slice(0, 300)}`);
    runs.push(r.elapsed);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`    [latency] warm runs=[${runs.join(', ')}]ms median=${median}ms budget=${BUDGET_MS}ms`);
  assert(median < BUDGET_MS,
    `SessionStart warm median ${median}ms exceeds the ${BUDGET_MS}ms budget ` +
    `(runs: ${runs.join(', ')}ms). A guard is doing blocking work at session start — ` +
    `find it (per-file child spawns, sync fs walks) and make it async/detached or cached. ` +
    `Baseline on 2026-07-16 was ~371ms median; the budget already carries ~13x headroom, ` +
    `so this is a real regression, not machine noise.`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
