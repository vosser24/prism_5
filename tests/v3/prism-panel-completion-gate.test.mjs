#!/usr/bin/env node
// tests/v3/prism-panel-completion-gate.test.mjs
//
// F7 Phase 4 — 0-seats panel completion gate.
//
// THE GAP THIS CLOSES: hooks/prism-session-end.mjs's existing Stop-gated
// phase-0d trigger only acts when seatCount>=2 AND the latch window is still
// LIVE (isPanelLatchLive()). There was no branch for a master that narrates
// a panel (arms the latch) but never dispatches a single Agent() seat — that
// case fell through silently on every Stop for the whole 45-min latch TTL.
//
// This test drives the REAL Stop hook (hooks/prism-session-end.mjs) as a
// subprocess (mirrors tests/v3/hooks/test-phase-0d-latch-trigger.mjs's
// pattern) because the hook reads its JSON payload from stdin (fd 0) at
// top-level module-execution time — an in-process dynamic import would
// contend for the TEST's own stdin, not a clean per-case payload. Each case
// gets a fresh sandboxed HOME/USERPROFILE and its own session id.
//
// Run: node tests/v3/prism-panel-completion-gate.test.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const sessionEndHook = join(repoRoot, 'hooks', 'prism-session-end.mjs');

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }

const sandbox = mkdtempSync(join(tmpdir(), 'prism-completion-gate-'));
const claudeDir = join(sandbox, '.claude');
mkdirSync(claudeDir, {recursive: true});

// Minimal empty transcript — the gate does not need transcript content, but
// the Stop hook's later resume-summary code path reads it, so give it a
// harmless empty-ish file to avoid unrelated noise.
const transcriptPath = join(sandbox, 'transcript.jsonl');
writeFileSync(transcriptPath, '');

function fireStop(sessionId) {
  const payload = JSON.stringify({session_id: sessionId, transcript_path: transcriptPath, cwd: repoRoot});
  return spawnSync(process.execPath, [sessionEndHook], {
    input: payload, encoding: 'utf-8',
    env: {...process.env, HOME: sandbox, USERPROFILE: sandbox},
  });
}

function routingEvents(eventName) {
  const p = join(claudeDir, '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return {}; } })
    .filter(o => o.event === eventName);
}

function warningPath(sessionId) {
  return join(claudeDir, `.prism-panel-completion-warning-${sessionId}.json`);
}

function markerPath(sessionId, openedTs) {
  const sha = createHash('sha256').update(sessionId + '|' + openedTs).digest('hex').slice(0, 16);
  return join(claudeDir, `.prism-panel-completion-gate-${sha}.json`);
}

// The latch and seat-recorder libs resolve paths via prismHome() (reads
// process.env.HOME at CALL time, per prism-home.mjs), so setting HOME here
// in THIS process before importing them lets us arm latches / write
// panel.json files directly into the same sandbox the subprocess Stop hook
// will read from.
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
const {writePanelLatch, readPanelLatch, panelLatchPath} = await import(pathToFileURL(join(repoRoot, 'hooks', 'lib', 'prism-panel-latch.mjs')).href);
const {resolvePanelPath} = await import(pathToFileURL(join(repoRoot, 'hooks', 'prism-panel-seat-recorder.mjs')).href);

function armClosedLatch(sessionId) {
  // Arm normally (until_ts = now + TTL), then hand-edit the file to move
  // until_ts into the past — this is the deterministic "window closed"
  // state per the latch's TTL-only-clear design (no synthetic close event).
  writePanelLatch(sessionId);
  const p = panelLatchPath(sessionId);
  const latch = JSON.parse(readFileSync(p, 'utf-8'));
  latch.until_ts = new Date(Date.now() - 60_000).toISOString(); // 1 min in the past
  writeFileSync(p, JSON.stringify(latch, null, 2));
  return latch;
}

function armLiveLatch(sessionId) {
  writePanelLatch(sessionId); // until_ts = now + TTL (future) — untouched
  return readPanelLatch(sessionId);
}

// ── CASE 1: FIRES — closed window, 0 seats, no panel.json, no marker ───────
{
  const sessionId = 'gate-fires-001';
  const latch = armClosedLatch(sessionId);
  const panelPath = resolvePanelPath(sessionId);
  check('case 1 setup: no structural panel.json exists yet', !existsSync(panelPath));

  const res = fireStop(sessionId);
  check('case 1: Stop hook exits 0', res.status === 0);

  const events = routingEvents('panel_completion_gate');
  check('case 1: exactly one panel_completion_gate/warned event logged',
    events.filter(e => e.action === 'warned').length === 1);
  const ev = events.find(e => e.action === 'warned');
  check('case 1: event carries schema_version 4', ev && ev.schema_version === 4);
  check('case 1: event carries session_id', ev && ev.session_id === sessionId);
  check('case 1: event carries active_master (null when latch had none)', ev && ev.active_master === null);
  check('case 1: event reason names the 0-seats/no-panel.json case',
    ev && /panel narrated but never instrumented/.test(ev.reason));

  const wp = warningPath(sessionId);
  check('case 1: warning file written', existsSync(wp));
  if (existsSync(wp)) {
    const w = JSON.parse(readFileSync(wp, 'utf-8'));
    check('case 1: warning file has session_id', w.session_id === sessionId);
    check('case 1: warning file has message', /panel narrated but never instrumented/.test(w.message));
  }

  const mp = markerPath(sessionId, latch.opened_ts);
  check('case 1: idempotency marker written', existsSync(mp));
}

// ── CASE 2: IDEMPOTENT — second Stop for the SAME latch does not re-fire ───
{
  const sessionId = 'gate-fires-001'; // reuse case 1's session/latch — marker already exists
  const before = routingEvents('panel_completion_gate').filter(e => e.action === 'warned').length;
  const res = fireStop(sessionId);
  check('case 2: Stop hook exits 0', res.status === 0);
  const after = routingEvents('panel_completion_gate').filter(e => e.action === 'warned').length;
  check('case 2: no additional warned event (idempotency marker prevented re-fire)', after === before);
}

// ── CASE 3: NO-FIRE — seats present (structural panel.json with 2 seats) ───
{
  const sessionId = 'gate-nofire-seats-002';
  armClosedLatch(sessionId);
  const panelPath = resolvePanelPath(sessionId);
  mkdirSync(dirname(panelPath), {recursive: true});
  writeFileSync(panelPath, JSON.stringify({
    seat_producer: 'hook-recorded',
    positions: [{name: 'Security'}, {name: 'Perf'}],
  }, null, 2));

  const res = fireStop(sessionId);
  check('case 3: Stop hook exits 0', res.status === 0);
  const events = routingEvents('panel_completion_gate').filter(e => e.session_id === sessionId);
  check('case 3: NO panel_completion_gate event for this session (seats present)', events.length === 0);
  check('case 3: NO warning file written', !existsSync(warningPath(sessionId)));
}

// ── CASE 4: NO-FIRE — latch window still LIVE (until_ts in the future) ─────
{
  const sessionId = 'gate-nofire-live-003';
  armLiveLatch(sessionId);
  const panelPath = resolvePanelPath(sessionId);
  check('case 4 setup: no structural panel.json exists', !existsSync(panelPath));

  const res = fireStop(sessionId);
  check('case 4: Stop hook exits 0', res.status === 0);
  const events = routingEvents('panel_completion_gate').filter(e => e.session_id === sessionId);
  check('case 4: NO panel_completion_gate event for this session (window still live)', events.length === 0);
  check('case 4: NO warning file written', !existsSync(warningPath(sessionId)));
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
try { rmSync(sandbox, {recursive: true, force: true}); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
