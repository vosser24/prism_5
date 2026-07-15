#!/usr/bin/env node
// TDD for prism-subagent-stop.mjs roster write under withRosterLock.
//
// BUG (handoff PENDING): subagent-stop does a roster.json read-modify-write
// UNLOCKED. Under the SubagentStop dispatcher's Promise.all it races phase-1-5-
// oob's *locked* roster write → a lost counter increment. Fix: wrap the
// read-modify-write in withRosterLock (the same lock phase-0d/phase-1-5 use).
//
// We can't deterministically force the race, so we assert the OBSERVABLE
// signature of "this write went through withRosterLock": a pre-planted STALE
// lock file is reaped + released (gone) after run(). The old unlocked code
// never touches roster.json.lock, so it would be left behind → RED.
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-subagent-stop.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const mod = await import(pathToFileURL(HOOK).href);

function setupHome(label) {
  const home = mkdtempSync(join(tmpdir(), `prism-sasrl-${label}-`));
  const refs = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(refs, {recursive: true});
  const rp = join(refs, 'roster.json');
  writeFileSync(rp, JSON.stringify({agents: {'test-agent': {total_tasks_completed: 4}}, last_updated: 'x'}, null, 2));
  return {home, rp};
}

await test('roster increment still works (behavior preserved)', async () => {
  const {home, rp} = setupHome('inc');
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    await mod.run({agent_name: 'test-agent', session_id: 's', model: '', usage: {}});
    const roster = JSON.parse(readFileSync(rp, 'utf-8'));
    assert(roster.agents['test-agent'].total_tasks_completed === 5, 'counter should go 4 → 5');
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    rmSync(home, {recursive: true, force: true});
  }
});

await test('write goes through withRosterLock — a stale lock is reaped + released', async () => {
  const {home, rp} = setupHome('lock');
  const lockPath = rp + '.lock';
  // Plant a STALE lock (created_at well past the 60s stale threshold).
  writeFileSync(lockPath, JSON.stringify({pid: 999999, created_at: '2000-01-01T00:00:00.000Z'}));
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    await mod.run({agent_name: 'test-agent', session_id: 's', model: '', usage: {}});
    assert(!existsSync(lockPath), 'stale lock must be reaped + released by withRosterLock (still present → write was unlocked)');
    const roster = JSON.parse(readFileSync(rp, 'utf-8'));
    assert(roster.agents['test-agent'].total_tasks_completed === 5, 'counter still increments through the lock');
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
