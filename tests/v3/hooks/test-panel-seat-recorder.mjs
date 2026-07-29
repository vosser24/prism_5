#!/usr/bin/env node
// F7 Phase 2 (D072) — panel-seat-recorder integration test.
//
// Proves the deterministic STRUCTURAL panel.json PRODUCER on the natural path: a
// panel run that NEVER hand-writes panel.json still yields
// ~/.claude/.prism-task-<id>/panel.json containing the dispatched seats, deduped
// by dispatched_agent_id, and drives panel-guard PATH B off the hook-written file.
//
// Assertions:
//   1. RECORD   — latch live + Agent dispatch → panel.json created with the seat.
//   2. APPEND+DEDUPE — a second distinct dispatch is appended; a repeat of the
//                 same dispatched_agent_id is deduped (no duplicate seat).
//   3. QUIET    — latch NOT live → no panel.json written.
//   4. KILLSWITCH — PRISM_DISABLE_PANEL_SEAT_RECORDER=1 → no-op.
//   5. PATH B   — panel-guard Path B ran on the hook-written file (empty-challenge
//                 seats classify as dropped → dropped_positions + panel_guard_dropped
//                 routing event).

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const RECORDER = join(ROOT, 'hooks', 'prism-panel-seat-recorder.mjs');
const LATCH_LIB = join(ROOT, 'hooks', 'lib', 'prism-panel-latch.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-seat-recorder-home-'));
const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE;
const prevDisable = process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER;
const prevDroppedLog = process.env.PRISM_DISABLE_DROPPED_LOG;

function deriveTaskId(sessionId) {
  return createHash('sha256').update(String(sessionId || 'anon')).digest('hex').slice(0, 12);
}
function panelPath(sessionId) {
  return join(HOME, '.claude', `.prism-task-${deriveTaskId(sessionId)}`, 'panel.json');
}
function readPanel(sessionId) {
  const p = panelPath(sessionId);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}
function routingRecords(event) {
  const p = join(HOME, '.claude', '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.event === event);
}

try {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER;
  delete process.env.PRISM_DISABLE_DROPPED_LOG;

  const recorder = await import(pathToFileURL(RECORDER).href);
  const latch = await import(pathToFileURL(LATCH_LIB).href);
  assert(typeof recorder.run === 'function', 'recorder must export run');

  await test('1 RECORD: latch live + Agent dispatch -> panel.json created with the seat', async () => {
    const sessionId = 's-record';
    latch.writePanelLatch(sessionId, {active_master: 'master-x'});
    const res = await recorder.run({
      tool_name: 'Agent',
      session_id: sessionId,
      agent_id: 'asoftware-architecture-expert-aaaa000000000001',
      tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat', prompt: 'be the vertical seat'},
    });
    assert(res.exit === 0, 'never blocks');
    const panel = readPanel(sessionId);
    assert(panel, 'panel.json must be created on the natural (no hand-write) path');
    assert(panel.positions.length === 1, `one seat recorded, got ${panel.positions.length}`);
    const seat = panel.positions[0];
    assert(seat.agent_type === 'software-architecture-expert', 'agent_type = subagent_type');
    assert(seat.title === 'arch-seat', 'title = tool_input.name when present');
    assert(seat.vertical === true, 'a real specialist type is vertical');
    assert(seat.seat_source === 'hook-recorded', 'seat_source marks a hook-produced seat');
    assert(seat.dispatched_agent_id === 'asoftware-architecture-expert-aaaa000000000001', 'records the agent id when present');
    assert(routingRecords('panel_seat_recorded').some((r) => r.action === 'record' && r.session_id === sessionId), 'logs a record event');
  });

  await test('2 APPEND+DEDUPE: second distinct dispatch appends; repeat id is deduped', async () => {
    const sessionId = 's-record'; // same session -> same deterministic task id
    // distinct id -> appended
    await recorder.run({
      tool_name: 'Agent', session_id: sessionId, agent_id: 'ageneral-purpose-bbbb000000000002',
      tool_input: {subagent_type: 'general-purpose', name: 'skeptic-seat', prompt: 'challenge'},
    });
    let panel = readPanel(sessionId);
    assert(panel.positions.length === 2, `distinct dispatch appended -> 2 seats, got ${panel.positions.length}`);
    const generic = panel.positions[1];
    assert(generic.vertical === false, 'general-purpose seat is not vertical');
    // duplicate id (re-processed same dispatch) -> deduped, still 2
    await recorder.run({
      tool_name: 'Agent', session_id: sessionId, agent_id: 'ageneral-purpose-bbbb000000000002',
      tool_input: {subagent_type: 'general-purpose', name: 'skeptic-seat', prompt: 'challenge'},
    });
    panel = readPanel(sessionId);
    assert(panel.positions.length === 2, `dup dispatched_agent_id deduped -> still 2 seats, got ${panel.positions.length}`);
    assert(routingRecords('panel_seat_recorded').some((r) => r.action === 'dedupe-skip'), 'logs a dedupe-skip event');
  });

  await test('3 QUIET: latch NOT live -> no panel.json written', async () => {
    const sessionId = 's-nolatch';
    // Deliberately arm NO latch for this session.
    const res = await recorder.run({
      tool_name: 'Agent', session_id: sessionId,
      tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(readPanel(sessionId) === null, 'no panel.json without a live latch');
  });

  await test('4 KILLSWITCH: PRISM_DISABLE_PANEL_SEAT_RECORDER=1 -> no-op', async () => {
    const sessionId = 's-killswitch';
    latch.writePanelLatch(sessionId);
    process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER = '1';
    try {
      const res = await recorder.run({
        tool_name: 'Agent', session_id: sessionId,
        tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat'},
      });
      assert(res.exit === 0, 'exit 0');
      assert(readPanel(sessionId) === null, 'kill switch suppresses all recording');
    } finally {
      delete process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER;
    }
  });

  await test('5 PATH B: panel-guard Path B ran on the hook-written file (dropped_positions + routing event)', async () => {
    const sessionId = 's-pathb';
    latch.writePanelLatch(sessionId);
    await recorder.run({
      tool_name: 'Agent', session_id: sessionId, agent_id: 'asoftware-architecture-expert-cccc000000000003',
      tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat', prompt: 'x'},
    });
    const panel = readPanel(sessionId);
    // Empty-challenge seats classify as dropped (insufficient_challenges) — Path B
    // writes dropped_positions back into the SAME hook-written panel.json.
    assert(Array.isArray(panel.dropped_positions) && panel.dropped_positions.length > 0,
      'panel-guard Path B wrote dropped_positions into the hook-written panel.json');
    const dropped = routingRecords('panel_guard_dropped').filter((r) => r.panel_path === panelPath(sessionId));
    assert(dropped.length > 0, 'panel-guard Path B logged a panel_guard_dropped event for the hook-written file');
  });

  await test('6 DROPS DO NOT PILE UP: N seat dispatches -> exactly N dropped_positions, no dupes', async () => {
    const sessionId = 's-nopileup';
    latch.writePanelLatch(sessionId);
    const seats = [
      {subagent_type: 'concurrency-expert', name: 'conc-1', agent_id: 'aconcurrency-expert-1111'},
      {subagent_type: 'software-architecture-expert', name: 'arch-1', agent_id: 'asoftware-architecture-expert-2222'},
      {subagent_type: 'general-purpose', name: 'gp-1', agent_id: 'ageneral-purpose-3333'},
    ];
    for (const s of seats) {
      await recorder.run({
        tool_name: 'Agent', session_id: sessionId, agent_id: s.agent_id,
        tool_input: {subagent_type: s.subagent_type, name: s.name, prompt: 'x'},
      });
    }
    const panel = readPanel(sessionId);
    assert(panel.positions.length === 3, `3 seats recorded, got ${panel.positions.length}`);
    // The bug: Path B appended per-seat, yielding 1+2+3 = 6 drops for 3 seats.
    assert(Array.isArray(panel.dropped_positions) && panel.dropped_positions.length === 3,
      `expected exactly 3 dropped_positions (one per seat), got ${panel.dropped_positions ? panel.dropped_positions.length : 'none'}`);
    const keys = panel.dropped_positions.map((d) => `${d.position}|${d.reason}`);
    assert(new Set(keys).size === keys.length, `no duplicate (position,reason) pairs; got ${JSON.stringify(keys)}`);
  });
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  if (prevDisable === undefined) delete process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER; else process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER = prevDisable;
  if (prevDroppedLog === undefined) delete process.env.PRISM_DISABLE_DROPPED_LOG; else process.env.PRISM_DISABLE_DROPPED_LOG = prevDroppedLog;
  rmSync(HOME, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
