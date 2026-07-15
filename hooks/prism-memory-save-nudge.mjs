#!/usr/bin/env node
// PRISM Memory-Save Nudge (v2.9.1) — UserPromptSubmit
//
// v2.9.1 (ATOMIC-WRITE-001): counter-file writes now use tempfile + renameSync
// with catch-fallback to direct writeFileSync. Matches v2.8.0 sentinel-write
// pattern in prism-parent-dispatch-guard.mjs:90-107. Prevents truncated
// counter JSON from a mid-write crash (disk-full, antivirus interference,
// process kill) — readers on next turn would otherwise see a parse error
// and reset the counter to 0, suppressing a due nudge.
//
// Tracks per-session turn count. Starting at turn 15, and every 5 turns
// thereafter (20, 25, 30, ...), injects a directive via additionalContext
// telling Opus to review the session and save durable memories BEFORE the
// user runs /clear. Silent otherwise.
//
// Counter state: ~/.claude/.prism-memory-save-counter-<session_id>.json
// Schema: {session_id, turn_count, last_nudge_turn, last_ts}
//
// Tunables (env vars):
//   PRISM_MEMORY_NUDGE_FIRST    — first nudge turn (default 15)
//   PRISM_MEMORY_NUDGE_INTERVAL — cadence after first (default 5)
//   PRISM_MEMORY_NUDGE=off      — disable entirely

import {readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {claudeMemInstalled, claudeMemHealthy} from './lib/prism-claude-mem-detect.mjs';

const FIRST = parseInt(process.env.PRISM_MEMORY_NUDGE_FIRST ?? '15', 10);
const INTERVAL = parseInt(process.env.PRISM_MEMORY_NUDGE_INTERVAL ?? '5', 10);
const MODE = String(process.env.PRISM_MEMORY_NUDGE ?? 'on').toLowerCase();

function counterPath(H, sessionId) {
  return join(H, '.claude', `.prism-memory-save-counter-${sessionId || 'anon'}.json`);
}

function appendLog(LOG, obj) {
  try {
    mkdirSync(dirname(LOG), {recursive: true});
    appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch {}
}

function readCounter(H, sessionId) {
  try {
    const p = counterPath(H, sessionId);
    if (!existsSync(p)) return {turn_count: 0, last_nudge_turn: 0};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return {turn_count: 0, last_nudge_turn: 0}; }
}

// v2.9.1 ATOMIC-WRITE-001: tempfile + renameSync. Prevents truncated counter
// JSON from crashes mid-write (disk-full, antivirus interference, process kill).
// Matches the v2.8.0 sentinel-write pattern in prism-parent-dispatch-guard.mjs.
function writeCounter(H, sessionId, data) {
  try {
    const p = counterPath(H, sessionId);
    mkdirSync(dirname(p), {recursive: true});
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    // renameSync is atomic on POSIX + Windows (same filesystem). Readers
    // either see the previous valid file or the new one — never a partial.
    renameSync(tmp, p);
  } catch {
    // Fallback: direct write. On catastrophic failure (e.g. Windows EBUSY
    // from antivirus during rename), the direct write keeps the counter
    // advancing. Readers have try/catch JSON.parse guards downstream, so
    // worst case is a one-turn counter reset.
    try { writeFileSync(counterPath(H, sessionId), JSON.stringify(data, null, 2)); } catch {}
  }
}

export async function run(payload) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};

    const H = process.env.HOME || process.env.USERPROFILE;
    const LOG = join(H, '.claude', '.prism-routing.jsonl');

    // v5.x (F7): only stand down when claude-mem is installed AND its worker is
    // HEALTHY. If installed-but-unhealthy (worker down / consecutiveFailures>0 /
    // no heartbeat), claude-mem captures nothing — re-enable PRISM's native nudge
    // so the fallback fires. (Standdown still prevents the double-injector when
    // claude-mem is actually serving.)
    if (claudeMemInstalled(H) && claudeMemHealthy(H)) {
      appendLog(LOG, {event: 'memory_save_nudge', action: 'standdown-claude-mem-healthy'});
      return {exit: 0, stdout: '', stderr: ''};
    }
    if (claudeMemInstalled(H)) {
      appendLog(LOG, {event: 'memory_save_nudge', action: 'fallback-claude-mem-unhealthy'});
      // fall through — native nudge proceeds
    }

    const input = payload || {};
    const sessionId = input.session_id || 'anon';

    const state = readCounter(H, sessionId);
    state.turn_count = (state.turn_count || 0) + 1;
    state.last_ts = new Date().toISOString();
    state.session_id = sessionId;

    let shouldNudge = false;
    if (state.turn_count === FIRST) shouldNudge = true;
    else if (state.turn_count > FIRST && (state.turn_count - FIRST) % INTERVAL === 0) shouldNudge = true;

    if (shouldNudge && state.last_nudge_turn !== state.turn_count) {
      state.last_nudge_turn = state.turn_count;
      const nextTurn = state.turn_count + INTERVAL;
      const directive = `PRISM MEMORY-SAVE NUDGE: session at turn ${state.turn_count}. Before the user runs /clear, run /prism-clean to (1) write/update the session handoff doc and (2) fold this session's durable learnings into the project-master's MEMORY.md (.claude/agents/MEMORY.md) + docs/prism/ — applying the auto-memory guidance in your system prompt. If everything memorable is already saved since the last nudge, say so explicitly and move on. Next nudge at turn ${nextTurn} unless /clear resets the counter.`;

      writeCounter(H, sessionId, state);
      appendLog(LOG, {event: 'memory_save_nudge', session_id: sessionId, turn: state.turn_count, next: nextTurn});

      const out = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: directive,
        },
      };
      return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
    }

    writeCounter(H, sessionId, state);
    return {exit: 0, stdout: '', stderr: ''};
  } catch (e) {
    const H = process.env.HOME || process.env.USERPROFILE;
    const LOG = join(H, '.claude', '.prism-routing.jsonl');
    appendLog(LOG, {event: 'memory_save_nudge', error: String(e)});
    return {exit: 0, stdout: '', stderr: ''};
  }
}

import {basename as _basename} from 'node:path';
const invokedDirectly = process.argv[1] && _basename(process.argv[1]) === 'prism-memory-save-nudge.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch {}
    const res = await run(payload);
    if (res.stdout) process.stdout.write(res.stdout);
    process.exit(res.exit || 0);
  })();
}
