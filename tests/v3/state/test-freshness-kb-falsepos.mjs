#!/usr/bin/env node
// TDD B3 — Suppress transient KB-index freshness false-positive (F4-guard).
// Covers: mtime-tolerance band (same-second quantization) + in-flight-rebuild
// lock suppression in checkKbIndexStale.
// Run: node tests/v3/state/test-freshness-kb-falsepos.mjs
// Exit: 0 = all pass; 1 = any failure.

import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SWEEP_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const FLAG_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-flag-file.mjs');
const SCOPE_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-agent-scope.mjs');

const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

// Build an ephemeral ~/.claude tree and copy in the sweep + its dependencies.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-falsepos-'));
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'skills', 'prism-plan', 'references'), {recursive: true});
  mkdirSync(join(home, '.claude', 'plugins'), {recursive: true});
  mkdirSync(join(home, '.claude', 'skills'), {recursive: true});
  writeFileSync(
    join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs'),
    readFileSync(SWEEP_REPO, 'utf-8'),
  );
  writeFileSync(
    join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs'),
    readFileSync(FLAG_HELPER_REPO, 'utf-8'),
  );
  writeFileSync(
    join(home, '.claude', 'tools', 'lib', 'prism-agent-scope.mjs'),
    readFileSync(SCOPE_HELPER_REPO, 'utf-8'),
  );
  return home;
}

async function importSweep(home) {
  // Dynamic import from the home copy so the relative imports inside it resolve.
  const url = pathToFileURL(join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs')).href;
  return import(url);
}

// Set atime+mtime on a file to an exact value in seconds (POSIX).
function setMtimeSec(path, secs) {
  utimesSync(path, secs, secs);
}

// ── Case 1: Within tolerance is silent ───────────────────────────────────────
// index.source_mtime_max = now_sec; one skill doc is now_sec + 1 (1 second newer).
// With tolerance >= 2, this should be silent (no rebuild).
test('within-tolerance: 1s newer than index is silent (no rebuild called)', async () => {
  const home = makeHome();
  try {
    const {runFreshnessSweep} = await importSweep(home);

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // Create the KB index with source_mtime_max = nowSec
    const kbIndexPath = join(home, '.claude', '.prism-kb-index.json');
    writeFileSync(kbIndexPath, JSON.stringify({
      schema_version: 2,
      source_mtime_max: nowSec,
      entries: [],
    }));

    // Create a skill doc with mtime = nowSec + 1 (just 1 second ahead)
    const skillsDir = join(home, '.claude', 'skills');
    const docPath = join(skillsDir, 'x.md');
    writeFileSync(docPath, '# skill');
    setMtimeSec(docPath, nowSec + 1);

    // Stub rebuildKb that records calls
    let rebuildCalled = false;
    const stubRebuild = () => { rebuildCalled = true; return {ok: true}; };

    const result = runFreshnessSweep({home, force: true, rebuildKb: stubRebuild});

    assert(!rebuildCalled,
      `rebuildKb stub should NOT have been called (within tolerance), but it was`);

    const kbNotices = result.notices.filter(n => n.includes('KB index'));
    assert(kbNotices.length === 0,
      `should have no "KB index" notices (within tolerance), got: ${JSON.stringify(kbNotices)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Case 2: In-flight rebuild lock is silent ─────────────────────────────────
// index.source_mtime_max is clearly behind a doc (doc is 10s newer), but a
// fresh rebuild lock exists. Should stay silent (defer to in-flight session).
test('in-flight lock: stale index but fresh lock → silent (no rebuild called)', async () => {
  const home = makeHome();
  try {
    const {runFreshnessSweep} = await importSweep(home);

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // KB index clearly behind: source_mtime_max = nowSec - 20
    const kbIndexPath = join(home, '.claude', '.prism-kb-index.json');
    writeFileSync(kbIndexPath, JSON.stringify({
      schema_version: 2,
      source_mtime_max: nowSec - 20,
      entries: [],
    }));

    // A skill doc that is 10s newer than the index
    const skillsDir = join(home, '.claude', 'skills');
    const docPath = join(skillsDir, 'x.md');
    writeFileSync(docPath, '# skill');
    setMtimeSec(docPath, nowSec);

    // Create a fresh rebuild lock (mtime = now → within REBUILD_LOCK_STALE_MS = 10min)
    const lockPath = join(home, '.claude', '.prism-kb-rebuild.lock');
    writeFileSync(lockPath, String(nowMs));
    // Ensure lock's mtime is current (writeFileSync sets it to now)

    let rebuildCalled = false;
    const stubRebuild = () => { rebuildCalled = true; return {ok: true}; };

    const result = runFreshnessSweep({home, force: true, rebuildKb: stubRebuild});

    assert(!rebuildCalled,
      `rebuildKb stub should NOT have been called (in-flight lock), but it was`);

    const kbNotices = result.notices.filter(n => n.includes('KB index'));
    assert(kbNotices.length === 0,
      `should have no "KB index" notices (in-flight lock), got: ${JSON.stringify(kbNotices)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Case 3: Genuinely stale still warns/rebuilds ──────────────────────────────
// doc is 10s newer than index, no lock present. Rebuild stub returns {ok:true}.
// Should emit notice about "rebuilt automatically".
test('genuinely stale (no lock): rebuild is called and notice emitted', async () => {
  const home = makeHome();
  try {
    const {runFreshnessSweep} = await importSweep(home);

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    // KB index clearly behind: source_mtime_max = nowSec - 20
    const kbIndexPath = join(home, '.claude', '.prism-kb-index.json');
    writeFileSync(kbIndexPath, JSON.stringify({
      schema_version: 2,
      source_mtime_max: nowSec - 20,
      entries: [],
    }));

    // A skill doc that is 10s newer than the index (well beyond tolerance)
    const skillsDir = join(home, '.claude', 'skills');
    const docPath = join(skillsDir, 'x.md');
    writeFileSync(docPath, '# skill');
    setMtimeSec(docPath, nowSec);

    // No lock file — genuinely stale

    let rebuildCalled = false;
    const stubRebuild = () => { rebuildCalled = true; return {ok: true}; };

    const result = runFreshnessSweep({home, force: true, rebuildKb: stubRebuild});

    assert(rebuildCalled,
      `rebuildKb stub SHOULD have been called (genuinely stale, no lock)`);

    const kbNotices = result.notices.filter(n => n.includes('KB index'));
    assert(kbNotices.length > 0,
      `should have at least one "KB index" notice (rebuilt automatically), got: ${JSON.stringify(result.notices)}`);
    assert(kbNotices.some(n => n.includes('rebuilt automatically')),
      `KB notice should say "rebuilt automatically", got: ${JSON.stringify(kbNotices)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Run all tests ─────────────────────────────────────────────────────────────
for (const [name, fn] of tests) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n        ${e.stack || e.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
