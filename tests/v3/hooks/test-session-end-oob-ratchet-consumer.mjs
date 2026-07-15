#!/usr/bin/env node
// Sub-task 3 (Phase 1.5 evidence pipeline revival) — hooks/prism-session-end.mjs
// deterministic SessionEnd consumer for the OOB evidence-discipline ratchet.
//
// D040: a durable signal must propagate DETERMINISTICALLY (never a manual step
// that can silently fail). Prior to this block, `--apply-ratchet` only ran
// under the manual /prism-clean path (tools/prism-clean.mjs:288-300) — a
// session that never runs /prism-clean left
// ~/.claude/.prism-phase-1-5-verdicts.jsonl un-drained indefinitely.
//
// D042: a fix/guard is not proven until it FIRES on a bad input AND STAYS
// QUIET on a good one. This file proves both branches with real subprocess
// output — no mocked assertions on source text.
//
// Approach: point the sandbox HOME's .claude/tools/prism-roster.mjs at a
// harmless MOCK script (not the real ratchet tool) that just records that it
// was invoked with --apply-ratchet. This lets us observe the hook's spawn
// DECISION without ever running a real ratchet mutation, per the dispatch
// instructions.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-end.mjs');

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n        ${e.stack || e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const MOCK_ROSTER_SCRIPT = `
import {writeFileSync} from 'fs';
const markerPath = process.env.MOCK_RATCHET_MARKER;
if (markerPath) {
  writeFileSync(markerPath, JSON.stringify({args: process.argv.slice(2), ts: Date.now()}));
}
`;

function setupFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `se-ratchet-home-${label}-`));
  const cwd = mkdtempSync(join(tmpdir(), `se-ratchet-cwd-${label}-`));
  mkdirSync(join(home, '.claude', 'tools'), {recursive: true});
  const sessionId = `sess-ratchet-${label}-${Date.now()}`;
  const transcriptPath = join(home, `${sessionId}.transcript.jsonl`);
  // Minimal valid transcript — zero Task events, graceful no-op elsewhere in
  // the hook (verified pattern from test-session-end-task-snapshot.mjs).
  const lines = [
    JSON.stringify({type: 'user', message: {role: 'user', content: 'just a normal prompt'}, timestamp: '2026-07-13T08:00:00.000Z'}),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  writeFileSync(join(home, '.claude', 'tools', 'prism-roster.mjs'), MOCK_ROSTER_SCRIPT);
  return {home, cwd, sessionId, transcriptPath};
}

function runHook(fx, extraEnv = {}) {
  const payload = JSON.stringify({session_id: fx.sessionId, transcript_path: fx.transcriptPath, cwd: fx.cwd});
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {...process.env, HOME: fx.home, USERPROFILE: fx.home, ...extraEnv},
  });
}

// Polls for the marker file since the ratchet spawn is detached+unref'd —
// it may still be completing shortly after the parent hook process exits.
async function waitFor(pathToCheck, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(pathToCheck)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return existsSync(pathToCheck);
}

// ─── Branch A (FIRES): verdict log present, kill-switch unset ──────────────

await test('spawns the ratchet tool when verdict log exists and PRISM_DISABLE_OOB_RATCHET is unset', async () => {
  const fx = setupFixture('fires');
  const markerPath = join(fx.home, 'ratchet-invoked.json');
  try {
    writeFileSync(join(fx.home, '.claude', '.prism-phase-1-5-verdicts.jsonl'), JSON.stringify({verdict: 'EVIDENCED'}) + '\n');
    const r = runHook(fx, {MOCK_RATCHET_MARKER: markerPath});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const fired = await waitFor(markerPath, 3000);
    assert(fired, 'expected ratchet mock to be invoked (marker file missing)');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    assert(marker.args.includes('--apply-ratchet'), `expected --apply-ratchet arg, got ${JSON.stringify(marker.args)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── Branch B (QUIET): verdict log present, kill-switch SET ────────────────

await test('does NOT spawn the ratchet tool when PRISM_DISABLE_OOB_RATCHET=1, even with a verdict log present', async () => {
  const fx = setupFixture('killswitch');
  const markerPath = join(fx.home, 'ratchet-invoked.json');
  try {
    writeFileSync(join(fx.home, '.claude', '.prism-phase-1-5-verdicts.jsonl'), JSON.stringify({verdict: 'EVIDENCED'}) + '\n');
    const r = runHook(fx, {MOCK_RATCHET_MARKER: markerPath, PRISM_DISABLE_OOB_RATCHET: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    // Negative wait: give the same window as the positive case a chance to
    // prove absence isn't just "didn't check yet".
    const fired = await waitFor(markerPath, 800);
    assert(!fired, 'ratchet mock should NOT have been invoked (kill-switch set)');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── Branch C (QUIET): verdict log absent ───────────────────────────────────

await test('does NOT spawn the ratchet tool when the verdict log does not exist', async () => {
  const fx = setupFixture('nolog');
  const markerPath = join(fx.home, 'ratchet-invoked.json');
  try {
    // Deliberately do NOT write .prism-phase-1-5-verdicts.jsonl.
    const r = runHook(fx, {MOCK_RATCHET_MARKER: markerPath});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const fired = await waitFor(markerPath, 800);
    assert(!fired, 'ratchet mock should NOT have been invoked (no verdict log)');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
