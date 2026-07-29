#!/usr/bin/env node
// hooks/prism-panel-seat-recorder.mjs
// F7 Phase 2 (D072) — deterministic STRUCTURAL panel.json PRODUCER.
//
// THE HOLE THIS CLOSES: every structural panel-quality gate — the phase-0d OOB
// reviewer (D070), the challenge-logger, and panel-guard PATH B — fires ONLY off
// a MODEL-authored PostToolUse `Write` to `.prism-task-<id>/panel.json` (routed
// by hooks/prism-posttooluse-dispatcher.mjs, the Write route →
// prism-panel-guard.mjs#runPostToolUse). But `panel.json` has NO deterministic
// producer (the tier-router's own comment admits it: "a live panel never writes
// that file … so those hooks have never fired"). A master that convenes a panel
// by hand-rolling seats via direct Agent() calls and never hand-writes panel.json
// therefore emits ZERO instrumentation and every structural gate silently no-ops.
//
// This hook moves the STRUCTURE half of the instrumentation onto the UNAVOIDABLE
// event — the `Agent` dispatch itself. It fires on the Agent route of the
// PostToolUse dispatcher and deterministically emits/append the structural
// panel.json from the real Agent-dispatch payload, then drives panel-guard Path B
// off that HOOK-WRITTEN (unevadable) file. See
// docs/prism/adjudications/D072-panel-instrumentation-off-agent-dispatch-not-model-panel-json.md
//
// TRIGGER (D072 decision 2): fire iff payload.tool_name === 'Agent' AND
// isPanelLatchLive(session_id). There is DELIBERATELY NO opt-in seat marker:
// recording ALL latch-live Agent dispatches is the whole point of the
// unevadability — an opt-in field the master sets would reintroduce exactly the
// trust-fragility F7 removes. The latch is only armed on panel-summon turns in
// opus/master-orchestrator sessions (Phase 1, hooks/lib/prism-panel-latch.mjs),
// so latch-live already implies a panel context. An ordinary worker dispatched
// in the post-panel/pre-TTL window being recorded as a seat is a KNOWN,
// ACCEPTABLE advisory false-positive (the gates are advisory-only) — we do not
// build heuristics to suppress it.
//
// PAYLOAD SHAPE (D072 step A — verified against the real event, 2026-07-24):
// PostToolUse[Agent] does NOT reliably expose a returned agent id. The only
// existing Agent PostToolUse consumer (prism-dispatch-cap.mjs) reads only
// tool_input.subagent_type/description and comments that the event "doesn't
// expose true sibling dispatches"; the per-instance agent_id (a<type>-<16hex>)
// is carried by SubagentStart/SubagentStop (hooks/lib/prism-live-agents.mjs),
// NOT the Agent tool call. So dispatched_agent_id is recorded ONLY when a genuine
// agent-id key is present (best-effort), and dispatch_mode is DELIBERATELY LEFT
// ABSENT (D072 decision 5 caveat) so panel-guard checkDispatchMode stays additive
// and never throws exit 2 on a partial/absent id.
//
// ADVISORY ONLY — PostToolUse cannot block. Always exits 0. Fail-open on every
// error. Kill switch: PRISM_DISABLE_PANEL_SEAT_RECORDER=1.
//
// Patterns reused (cite explicitly):
//   - prismHome() at USE time (test HOME-flip seam): hooks/lib/prism-home.mjs.
//   - Atomic tempfile+rename write + catch-fallback: hooks/lib/prism-panel-latch.mjs
//     writePanelLatch() / prism-panel-guard.mjs atomicWritePanel().
//   - logAdvisory() routing-log record: hooks/lib/prism-advisory-log.mjs.
//   - Panel-active latch API (isPanelLatchLive/readPanelLatch):
//     hooks/lib/prism-panel-latch.mjs.
//   - Path B driver (runPostToolUse): hooks/prism-panel-guard.mjs.
//   - Dual-mode run(input)->{exit,stdout,stderr} + standalone shim:
//     prism-panel-name-guard.mjs / prism-agent-model-guard.mjs.

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {prismHome} from './lib/prism-home.mjs';
import {logAdvisory} from './lib/prism-advisory-log.mjs';
import {isPanelLatchLive, readPanelLatch} from './lib/prism-panel-latch.mjs';
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';
import {runPostToolUse} from './prism-panel-guard.mjs';

// Non-vertical (generic/infra) subagent types — a seat of one of these is NOT a
// domain-vertical specialist. Superset of prism-panel-guard.mjs GENERIC_AGENT_TYPES
// plus PRISM infra roles that are never a "vertical" panel seat.
const NON_VERTICAL = new Set([
  'general-purpose', 'generic', 'claude', 'unknown', '',
  'claude-master', 'master-orchestrator', 'explore', 'plan',
]);

function norm(s) {
  return String(s || '').toLowerCase().trim().replace(/^@/, '');
}

// Deterministic task id from the session id — DO NOT depend on a model-chosen
// task_id (D072 decision 3). Every sibling seat in the same session derives the
// SAME id, so they all write to the SAME panel.json without any coordination.
function deriveTaskId(sessionId) {
  return createHash('sha256').update(String(sessionId || 'anon')).digest('hex').slice(0, 12);
}

function panelPathForTask(taskId) {
  return join(prismHome(), '.claude', `.prism-task-${taskId}`, 'panel.json');
}

// Deterministic task id for a session: reuse a latch-carried panel_task_id if
// the arming layer supplied one (future tier-router hook), else derive from the
// session id (D072 decision 3). SINGLE SOURCE used by BOTH run() (the producer)
// and resolvePanelPath() (the Stop-gated consumer) so the two can never drift.
function resolveTaskId(sessionId) {
  const latch = readPanelLatch(sessionId);
  return (latch && typeof latch.panel_task_id === 'string' && latch.panel_task_id.trim())
    ? latch.panel_task_id.trim()
    : deriveTaskId(sessionId);
}

// F7 Phase 3 — SINGLE SOURCE OF TRUTH for "session -> structural panel.json
// path". The Stop-gated phase-0d trigger (hooks/prism-session-end.mjs) must
// resolve the EXACT SAME path this recorder writes, or it silently reads the
// wrong file and never fires.
export function resolvePanelPath(sessionId) {
  return panelPathForTask(resolveTaskId(sessionId));
}

// Roster agent-key set for specialist resolution. Read per-call (no module-level
// cache) so a test flipping HOME between calls resolves the right roster.
function rosterAgentKeys() {
  try {
    const rp = join(prismHome(), '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    if (!existsSync(rp)) return new Set();
    const r = JSON.parse(readFileSync(rp, 'utf-8'));
    return new Set(Object.keys(r.agents || {}).map(norm));
  } catch {
    return new Set();
  }
}

// Best-effort dispatched-agent-id extraction. PostToolUse[Agent] does NOT
// reliably carry one (see header); we only accept a genuine agent-id key, never
// the tool_use_id (which is the id of the Agent tool_use itself, not the returned
// agent). Returns '' when none is present.
function extractDispatchedAgentId(payload) {
  const tr = payload && payload.tool_response;
  const cands = [
    payload && payload.agent_id,
    tr && tr.agent_id,
    tr && tr.agentId,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

// Atomic write — same shape as prism-panel-latch.mjs writePanelLatch().
function writePanelAtomic(filePath, obj) {
  try {
    mkdirSync(dirname(filePath), {recursive: true});
    const tmp = filePath + '.tmp';
    const body = JSON.stringify(obj, null, 2);
    writeFileSync(tmp, body);
    try {
      renameWithRetry(renameSync, tmp, filePath);
    } catch (renameErr) {
      try {
        writeFileSync(filePath, body);
        logAdvisory({event: 'panel_seat_recorder_write', path: filePath,
          status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
      } catch (fallbackErr) {
        logAdvisory({event: 'panel_seat_recorder_write', path: filePath,
          status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
      }
    }
  } catch { /* fail-open */ }
}

export async function run(payload) {
  try {
    if (process.env.PRISM_DISABLE_PANEL_SEAT_RECORDER === '1') {
      return {exit: 0, stdout: '', stderr: ''};
    }
    if (!payload || payload.tool_name !== 'Agent') {
      return {exit: 0, stdout: '', stderr: ''};
    }
    const sessionId = payload.session_id || 'anon';
    // Only record while a panel is in progress (latch armed on the summon turn).
    if (!isPanelLatchLive(sessionId)) {
      return {exit: 0, stdout: '', stderr: ''};
    }

    const ti = payload.tool_input || {};
    const subagentType = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
    const title = (typeof ti.name === 'string' && ti.name.trim())
      ? ti.name.trim()
      : (subagentType || '(unnamed)');
    const vertical = !NON_VERTICAL.has(norm(subagentType));
    const specialist = rosterAgentKeys().has(norm(subagentType)) ? subagentType : undefined;
    const dispatchedAgentId = extractDispatchedAgentId(payload);

    // Deterministic task id (shared resolveTaskId — see its comment). We do NOT
    // write the derived id back into the latch: writePanelLatch() re-arms the TTL
    // as a side effect (it always resets opened_ts/until_ts), which would extend
    // the false-positive window on every seat dispatch — not "trivially clean",
    // so it is skipped. Deriving from the session id is already fully
    // deterministic and every sibling agrees.
    const taskId = resolveTaskId(sessionId);
    const panelPath = panelPathForTask(taskId);

    // Load-or-init the structural panel.
    let panel = null;
    if (existsSync(panelPath)) {
      try { panel = JSON.parse(readFileSync(panelPath, 'utf-8')); } catch { panel = null; }
    }
    if (!panel || typeof panel !== 'object') {
      panel = {task_id: taskId, seat_producer: 'hook-recorded', positions: []};
    }
    if (!Array.isArray(panel.positions)) panel.positions = [];

    // Idempotent: dedupe by dispatched_agent_id when we actually have one. On the
    // natural path (id absent) each Agent PostToolUse is a distinct real dispatch,
    // so there is no natural duplicate to collapse.
    if (dispatchedAgentId) {
      const dup = panel.positions.some((p) => p && p.dispatched_agent_id === dispatchedAgentId);
      if (dup) {
        logAdvisory({
          event: 'panel_seat_recorded', session_id: sessionId, action: 'dedupe-skip',
          task_id: taskId, dispatched_agent_id: dispatchedAgentId, subagent_type: subagentType,
        });
        return {exit: 0, stdout: '', stderr: ''};
      }
    }

    // seat_source: 'hook-recorded' is a NEW value marking hook-produced seats,
    // distinguishable from model-authored 'rostered'/'factory-created'.
    const seat = {
      agent_type: subagentType,
      title,
      vertical,
      seat_source: 'hook-recorded',
      challenges: [],
    };
    if (specialist) seat.specialist = specialist;
    if (dispatchedAgentId) seat.dispatched_agent_id = dispatchedAgentId;
    // dispatch_mode is DELIBERATELY NOT set (D072 decision 5): without a reliable
    // per-seat dispatched_agent_id, dispatch_mode:'dispatch' would make
    // panel-guard checkDispatchMode throw exit 2. Absent → additive/unenforced.
    panel.positions.push(seat);

    // Reset dropped_positions before Path B recomputes. panel-guard Path B
    // APPENDS drops on every run (it does not dedupe), and we invoke it once per
    // seat, so a stale dropped_positions from the prior seat's Path B run would
    // pile up (seat 1→+1, seat 2→+2, seat 3→+3 = 6 for 3 seats). dropped_positions
    // is FULLY DERIVABLE from positions (every empty-challenges seat →
    // insufficient_challenges), and on this HOOK-PRODUCED file every drop is
    // hook-derived — so clearing it here is safe (no model-authored drops to
    // clobber) and lets each per-seat Path B run regenerate the complete correct
    // set. After N seat dispatches the file has exactly N drops, zero duplicates.
    delete panel.dropped_positions;

    writePanelAtomic(panelPath, panel);

    logAdvisory({
      event: 'panel_seat_recorded', session_id: sessionId, action: 'record',
      task_id: taskId, panel_path: panelPath, subagent_type: subagentType, title,
      vertical, seat_source: 'hook-recorded',
      dispatched_agent_id: dispatchedAgentId || null, seat_count: panel.positions.length,
    });

    // Drive panel-guard PATH B off the HOOK-WRITTEN file with a SYNTHETIC Write
    // payload so drops/dup/provenance analysis runs on the unevadable file.
    // runPostToolUse is a pure {exit,stdout,stderr} return; we NEVER propagate its
    // exit 2 (PostToolUse cannot block) — just log the outcome.
    try {
      const pb = runPostToolUse({tool_name: 'Write', tool_input: {file_path: panelPath}});
      if (pb && pb.exit !== 0) {
        logAdvisory({
          event: 'panel_seat_recorder_pathb', session_id: sessionId, task_id: taskId,
          pathb_exit: pb.exit, pathb_stderr: String(pb.stderr || '').slice(0, 300),
        });
      }
    } catch (e) {
      logAdvisory({
        event: 'panel_seat_recorder_pathb', session_id: sessionId, task_id: taskId,
        pathb_error: String((e && e.message) || e).slice(0, 300),
      });
    }

    return {exit: 0, stdout: '', stderr: ''};
  } catch {
    // FAIL-OPEN — a recorder error must never disturb the tool call it observes.
    return {exit: 0, stdout: '', stderr: ''};
  }
}

// Standalone shim — same contract as sibling Agent hooks. Guarded so an import
// (dispatcher / tests) never triggers it.
if (process.argv[1] && basename(process.argv[1]) === 'prism-panel-seat-recorder.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  run(input).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  }).catch(() => process.exit(0));
}
