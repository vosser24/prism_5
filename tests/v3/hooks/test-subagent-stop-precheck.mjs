#!/usr/bin/env node
// TDD for E-P5: existence pre-check before roster lock in prism-subagent-stop.mjs.
//
// Problem: withRosterLock is acquired UNCONDITIONALLY even for unregistered agents
// (agents NOT in roster.agents). The inner `if(roster.agents&&roster.agents[agentName])`
// guard means the write is a no-op, but the full lock+parse+write overhead is paid
// on every unregistered subagent stop (Explore, Plan, Haiku mappers, etc.).
//
// Fix: do a cheap lock-FREE pre-read to check if agentName is in roster.agents.
// If NOT present, skip withRosterLock entirely. Only acquire the lock when a write
// will actually happen.
//
// Assertions:
// 1) UNREGISTERED agent + fresh contending lock → run() completes < 200ms (DETERMINISTIC PRIMARY).
//    Technique: plant a fresh (non-stale) lock file before calling run().
//    - Pre-fix: withRosterLock() IS called; it cannot acquire the lock (EEXIST + non-stale);
//      it polls via await sleep(100ms). run() will stall for ≥100ms just on the first poll
//      interval alone → reliably > 200ms in practice.
//    - Post-fix: withRosterLock() is NEVER called; the contending lock is invisible;
//      run() returns in < 20ms regardless of the planted lock.
//    This is the deterministic primary signal: pre-fix locks on a non-stale contending lock.
// 2) UNREGISTERED agent (no contending lock, warm file cache) → run() < 50ms (observability).
// 3) REGISTERED agent → total_tasks_completed increments correctly (behavioral).
// 4) REGISTERED agent + stale lock → stale lock reaped + counter still increments (regression).

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-subagent-stop.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Build a ~107KB roster with 120 dummy agents. Optionally include a registered agent.
function buildLargeRoster(registeredName) {
  const agents = {};
  for (let i = 0; i < 120; i++) {
    const name = `dummy-agent-${String(i).padStart(4,'0')}`;
    agents[name] = {
      description: 'A'.repeat(700), // inflate to ~92KB total
      total_tasks_completed: i,
      last_used: new Date().toISOString(),
      projects_worked: [{name: 'proj', date: new Date().toISOString(), tasks_completed: i}],
    };
  }
  if (registeredName) {
    agents[registeredName] = {
      total_tasks_completed: 7,
      last_used: new Date().toISOString(),
      projects_worked: [],
    };
  }
  return {agents, last_updated: new Date().toISOString()};
}

function setupHome(label, {withRegistered = null} = {}) {
  const home = mkdtempSync(join(tmpdir(), `prism-ep5-${label}-`));
  const refs = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(refs, {recursive: true});
  const rp = join(refs, 'roster.json');
  writeFileSync(rp, JSON.stringify(buildLargeRoster(withRegistered), null, 2));
  return {home, rp};
}

// Import module once (cold import cost excluded from timing assertions below).
const mod = await import(pathToFileURL(HOOK).href);

// ── Test 1 (DETERMINISTIC PRIMARY): UNREGISTERED agent + contending lock
//    Pre-fix: withRosterLock() polls the contending lock → stalls > 200ms.
//    Post-fix: withRosterLock() never called → run() < 200ms with room to spare.
await test('unregistered agent — contending lock does NOT stall run() (withRosterLock skipped)', async () => {
  const {home, rp} = setupHome('lockblock');
  const lockPath = rp + '.lock';
  // Plant a FRESH (non-stale) contending lock. created_at = now, so it's not stale.
  // withRosterLock will see EEXIST, check staleness (not stale), then poll every 100ms.
  writeFileSync(lockPath, JSON.stringify({pid: 99999, created_at: new Date().toISOString()}));
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  let runInFlight = null;
  try {
    const t0 = performance.now();
    // Race run() against a 200ms sentinel.
    // Pre-fix:  run() stalls on lock poll (100ms/interval) → takes >> 200ms → sentinel wins.
    // Post-fix: run() ignores the lock entirely → completes << 200ms → run wins.
    let timedOut = false;
    const timeoutP = new Promise(res => setTimeout(() => { timedOut = true; res('timeout'); }, 200));
    runInFlight = mod.run({agent_name: 'Explore', session_id: 's1', model: '', usage: {}});
    await Promise.race([runInFlight, timeoutP]);
    const elapsed = performance.now() - t0;
    console.log(`        (contending-lock test elapsed: ${elapsed.toFixed(2)}ms, timedOut=${timedOut})`);
    assert(
      !timedOut,
      `run() stalled for > 200ms on unregistered agent 'Explore' — withRosterLock was entered and is polling the contending lock (pre-fix behavior)`
    );
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    // Give in-flight run() a moment to settle before cleanup (avoids ENOENT on cleanup)
    if (runInFlight) await Promise.race([runInFlight, new Promise(r => setTimeout(r, 60))]).catch(() => {});
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Test 2 (secondary/observability): UNREGISTERED agent, warm file cache → run() < 50ms ──
await test('unregistered agent — run() completes < 50ms with warm cache (lock+write skipped)', async () => {
  const {home, rp} = setupHome('timing');
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    // Pre-warm the file cache to exclude Windows cold-read overhead (~56ms first read).
    readFileSync(rp, 'utf-8');
    const t0 = performance.now();
    await mod.run({agent_name: 'Plan', session_id: 's2', model: '', usage: {}});
    const elapsed = performance.now() - t0;
    console.log(`        (warm unregistered run() elapsed: ${elapsed.toFixed(2)}ms)`);
    assert(elapsed < 50, `run() took ${elapsed.toFixed(2)}ms with warm cache — expected < 50ms (lock+parse+write should be skipped)`);
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Test 3: REGISTERED agent → counter increments correctly ──
await test('registered agent — total_tasks_completed increments 7 → 8', async () => {
  const {home, rp} = setupHome('reg', {withRegistered: 'my-registered-agent'});
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    await mod.run({agent_name: 'my-registered-agent', session_id: 's3', model: '', usage: {}});
    const roster = JSON.parse(readFileSync(rp, 'utf-8'));
    const count = roster.agents['my-registered-agent'].total_tasks_completed;
    assert(count === 8, `expected total_tasks_completed=8, got ${count}`);
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    rmSync(home, {recursive: true, force: true});
  }
});

// ── Test 4: REGISTERED agent + stale lock → stale lock reaped + counter increments ──
await test('registered agent + stale lock — stale lock reaped and counter still increments', async () => {
  const {home, rp} = setupHome('stale', {withRegistered: 'my-registered-agent'});
  const lockPath = rp + '.lock';
  // Plant a stale lock (created_at well past the 60s stale threshold).
  writeFileSync(lockPath, JSON.stringify({pid: 999999, created_at: '2000-01-01T00:00:00.000Z'}));
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    await mod.run({agent_name: 'my-registered-agent', session_id: 's4', model: '', usage: {}});
    assert(
      !existsSync(lockPath),
      'stale lock must be reaped + released by withRosterLock (still present → lock was never acquired or not released)'
    );
    const roster = JSON.parse(readFileSync(rp, 'utf-8'));
    const count = roster.agents['my-registered-agent'].total_tasks_completed;
    assert(count === 8, `counter should go 7 → 8 through the lock, got ${count}`);
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU;
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
