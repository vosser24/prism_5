#!/usr/bin/env node
// PRISM Live-Work Dedup (v1.0.0) — PreToolUse:Agent + PreToolUse:SendMessage
//
// PROBLEM (2026-07-14 incident, docs/prism/2026-07-14-dispatch-dedup-diagnosis.md):
// the exact-signature dedup guard compares a new dispatch only against each live
// agent's ORIGINAL spawn-time text. When a live agent's scope is EXPANDED via
// SendMessage ("also measure X"), a later independent dispatch of that same X is
// invisible to the exact-hash fence — two agents answer one question. Task #17
// made SendMessage visible to PreToolUse; this guard closes the loop:
//
//   • PreToolUse:SendMessage → a scope-assigning message TO a live agent appends
//     a taskText record to the live-agents ledger (hooks/lib/prism-live-agents.mjs)
//     under the recipient's id. Chatter/status pings are ignored (conservative
//     deterministic heuristic — every doubt resolves to no-record).
//   • PreToolUse:Agent → the FRESH dispatch's description+prompt keywords are
//     compared (deterministic keyword/topic overlap — keywordsOf/taskOverlap,
//     NO fuzzy/semantic/embeddings, per the diagnosis's rejected-option) against
//     the ACCUMULATED task summaries of every LIVE agent. Likely-duplicate live
//     work → ADVISORY additionalContext, exit 0. Then the fresh dispatch's own
//     task is recorded under its agent id.
//
// ADVISORY-ONLY BY DESIGN (soft-first, D-diagnosis recommendation): a topical-
// overlap match is probabilistic; a hard deny here would be the next guard that
// cries wolf. NO deny path exists in this file. Promote to hard only on
// measured false-positive evidence, as a separate change.
//
// THRESHOLDS (deterministic constants, documented): advise when the fresh
// dispatch shares ≥4 meaningful keywords with a live agent's summary AND the
// overlap coefficient (|∩|/min set size) is ≥0.30.
//
// FAIL-OPEN: every path swallows errors → exit 0, no output.
//
// Kill-switch: PRISM_LIVE_WORK_DEDUP=off (default on). Read per call.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';
import {
  appendTaskSummary, collectLiveWork, keywordsOf, taskOverlap,
} from './lib/prism-live-agents.mjs';

const MIN_SHARED = 4;
const MIN_COEFF = 0.30;

// Orphan-task liveness window (a task record whose SubagentStart never landed):
// PRISM_LIVE_WORK_TTL_MS, integer ms, clamped 30s..1h, default 15 min.
function ttlMs(env = process.env) {
  const raw = env.PRISM_LIVE_WORK_TTL_MS;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (n >= 30000 && n <= 3600000) return n;
  }
  return 15 * 60000;
}

function enabled(env = process.env) {
  return String(env.PRISM_LIVE_WORK_DEDUP ?? 'on').toLowerCase() !== 'off';
}

function inSubagentContext(payload, env = process.env) {
  if (payload && payload.parent_tool_use_id) return true;
  if (String(env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent') return true;
  return false;
}

function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// Scope-assignment filter for SendMessage (mirrors the conservative stance of
// prism-dispatch-preamble.mjs's SM heuristic, but LOOSER on purpose: this path
// only feeds the advisory keyword pool for an already-live agent — a false
// record costs at worst one soft advisory, never a rewrite or a block).
const SM_STATUS_OPEN_RE = /^\s*(?:phase\s+\d+\s+(?:complete|done)|task\s*#?\d+\s+(?:complete|done)|completed?\b|done[.:!\s]|status\b|update[:\s]|fyi\b|re:|thanks\b|ok\b|yes\b|no\b)/i;

function runSendMessage(payload, env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  const ti = (payload && payload.tool_input) || {};
  const to = typeof ti.to === 'string' ? ti.to.trim() : '';
  const message = ti.message;
  if (!to || to === 'main') return quiet;
  if (typeof message !== 'string' || message.length < 80) return quiet;
  if (SM_STATUS_OPEN_RE.test(message)) return quiet;
  const sessionId = (payload && payload.session_id) || 'anon';
  appendTaskSummary(prismHome(), sessionId, to, message);
  return quiet;
}

export async function run(payload, env = process.env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  try {
    if (!enabled(env)) return quiet;
    const tool = payload && payload.tool_name;
    if (tool === 'SendMessage') return runSendMessage(payload, env);
    if (tool !== 'Agent') return quiet;
    if (inSubagentContext(payload, env)) return quiet;

    const sessionId = (payload && payload.session_id) || 'anon';
    const ti = (payload && payload.tool_input) || {};
    const freshId = String(ti.name || ti.subagent_type || ti.agent_type || 'general-purpose').trim().replace(/^@/, '');
    const freshText = `${String(ti.description || '')} ${String(ti.prompt || '')}`.trim();
    const H = prismHome();

    const freshKw = keywordsOf(freshText);
    const hits = [];
    if (freshKw.size > 0) {
      const live = collectLiveWork(H, sessionId, ttlMs(env));
      for (const [id, info] of live) {
        if (id === freshId) continue; // re-steering the same agent is not a dup
        const { shared, coefficient } = taskOverlap(freshKw, keywordsOf(info.texts.join(' ')));
        if (shared.length >= MIN_SHARED && coefficient >= MIN_COEFF) {
          hits.push({ id, shared: shared.sort(), coefficient });
        }
      }
    }

    // Record the fresh dispatch's task AFTER comparing (never self-match).
    if (freshText) appendTaskSummary(H, sessionId, freshId, freshText);

    appendLog({
      event: 'live_work_dedup',
      ts: new Date().toISOString(),
      session_id: sessionId,
      target: freshId,
      overlap_hits: hits.map(h => h.id),
      advised: hits.length > 0,
    });

    if (!hits.length) return quiet;

    hits.sort((a, b) => b.coefficient - a.coefficient);
    const lines = hits.slice(0, 3).map(h =>
      `  • ${h.id} — shared topics: ${h.shared.slice(0, 8).join(', ')} (overlap ${Math.round(h.coefficient * 100)}%)`);
    const notice = [
      `PRISM LIVE-WORK DEDUP (advisory): this dispatch overlaps work a LIVE agent already holds:`,
      ...lines,
      `A live agent's scope includes SendMessage-assigned work, not just its original dispatch.`,
      `Consider: SendMessage the live agent to check/extend its scope instead of dispatching a`,
      `second agent for the same question. Proceeding is allowed — this is advisory only.`,
      `Kill-switch: PRISM_LIVE_WORK_DEDUP=off.`,
    ].join('\n');

    return {
      exit: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
      }),
      stderr: '',
    };
  } catch {
    return quiet; // FAIL OPEN
  }
}

// Standalone shim (parity with sibling guards).
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-live-work-dedup.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
    try {
      const r = await run(payload);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.exit || 0);
    } catch { process.exit(0); }
  })();
}
