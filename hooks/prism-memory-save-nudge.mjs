#!/usr/bin/env node
// PRISM Memory-Save Nudge (v1.0.0) — UserPromptSubmit
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

import {readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG = join(H, '.claude', '.prism-routing.jsonl');
const FIRST = parseInt(process.env.PRISM_MEMORY_NUDGE_FIRST ?? '15', 10);
const INTERVAL = parseInt(process.env.PRISM_MEMORY_NUDGE_INTERVAL ?? '5', 10);
const MODE = String(process.env.PRISM_MEMORY_NUDGE ?? 'on').toLowerCase();

function counterPath(sessionId) {
  return join(H, '.claude', `.prism-memory-save-counter-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG), {recursive: true});
    appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch {}
}

function readCounter(sessionId) {
  try {
    const p = counterPath(sessionId);
    if (!existsSync(p)) return {turn_count: 0, last_nudge_turn: 0};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return {turn_count: 0, last_nudge_turn: 0}; }
}

function writeCounter(sessionId, data) {
  try {
    const p = counterPath(sessionId);
    mkdirSync(dirname(p), {recursive: true});
    writeFileSync(p, JSON.stringify(data, null, 2));
  } catch {}
}

try {
  if (MODE === 'off') process.exit(0);

  const raw = readFileSync(0, 'utf-8');
  const input = JSON.parse(raw || '{}');
  const sessionId = input.session_id || 'anon';

  const state = readCounter(sessionId);
  state.turn_count = (state.turn_count || 0) + 1;
  state.last_ts = new Date().toISOString();
  state.session_id = sessionId;

  let shouldNudge = false;
  if (state.turn_count === FIRST) shouldNudge = true;
  else if (state.turn_count > FIRST && (state.turn_count - FIRST) % INTERVAL === 0) shouldNudge = true;

  if (shouldNudge && state.last_nudge_turn !== state.turn_count) {
    state.last_nudge_turn = state.turn_count;
    const nextTurn = state.turn_count + INTERVAL;
    const directive = `PRISM MEMORY-SAVE NUDGE: session at turn ${state.turn_count}. Review this session for durable memories (user preferences, project decisions, surprising findings, recurring corrections) and save them to the project's memory directory using the auto-memory guidance in your system prompt. Do this BEFORE the user runs /clear. If you have already saved everything memorable since the last nudge, say so explicitly and move on. Next nudge at turn ${nextTurn} unless /clear resets the counter.`;

    writeCounter(sessionId, state);
    appendLog({event: 'memory_save_nudge', session_id: sessionId, turn: state.turn_count, next: nextTurn});

    const out = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: directive,
      },
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  writeCounter(sessionId, state);
  process.exit(0);
} catch (e) {
  appendLog({event: 'memory_save_nudge', error: String(e)});
  process.exit(0);
}
