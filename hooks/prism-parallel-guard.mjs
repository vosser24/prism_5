#!/usr/bin/env node
// PRISM Parallel-Dispatch Guard (v3.1.0) — closes T10.3 in tests/v3/
//
// PreToolUse on `Agent`. Detects sequentially-dispatched Agent calls that
// should have been emitted in a single assistant message (parallel pgroup).
// Closes the v3.0 audit gap T10.3: "subagents tagged with the same pgroup
// dispatched in two consecutive assistant messages instead of batched —
// the orchestrator pattern requires concurrent dispatch when a pgroup
// annotation is present."
//
// Patterns copied (cite explicitly):
//   - Three-path subagent bypass: prism-mutation-guard.mjs:227-271 +
//     prism-agent-model-guard.mjs:97-124 (parent_tool_use_id /
//     CLAUDE_CODE_ENTRYPOINT / sentinel.dispatched). Without this a
//     subagent that internally dispatches further Agent() calls would be
//     spuriously flagged.
//   - force_opus sentinel honoring: prism-mutation-guard.mjs:281-311.
//     One-turn user override via !opus-force: prefix is read from the
//     sentinel (set by prism-prompt-tier-router on UserPromptSubmit).
//   - Atomic tempfile + rename + catch-fallback for state writes:
//     prism-parent-dispatch-guard.mjs:90-107 (verbatim shape).
//   - Sentinel-aware mode handling (soft / hard): mirrors
//     prism-agent-model-guard.mjs:200-238.
//
// Tracks Agent calls within a single turn via a small per-session counter
// at ~/.claude/.prism-parallel-trace-<session>.json. Each Agent call
// appends {ts, pgroup, subagent_type}. When the Nth call arrives AND the
// previous call is recent (within 60s) AND either both are pgroup-marked
// the same OR the user prompt (via sentinel.user_prompt_meta) contains
// pgroup annotations → emit advisory denial that the dispatches should
// have been batched in one assistant message.
//
// Modes:
//   soft (default): nudge on stdout, exit 0
//   hard:           deny on second sequential pgroup-tagged call (exit 2)
//   off:            silent passthrough
//
// Precedence chain (read order):
//   1. ~/.claude/prism-policy.json `guards.parallel` if present
//   2. PRISM_PARALLEL_GUARD env var
//   3. default 'soft'
// If PRISM_POLICY_OVERRIDE=1, env wins over the policy file.
//
// Latency: cap state file at last 8 entries; only one small JSON read +
// one atomic write per call. Target <50ms.

import {readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const POLICY_PATH = join(H, '.claude', 'prism-policy.json');
const RECENT_WINDOW_MS = 60_000;
const MAX_TRACE_ENTRIES = 8;

// pgroup annotation patterns the orchestrator emits when it intends a
// parallel batch. Recognised forms (case-insensitive):
//   [pgroup:foo]   pgroup=foo   <pgroup foo>   "pgroup: foo"
const PGROUP_RE = /(?:\[pgroup[:=]\s*|pgroup[:=]\s*|<pgroup\s+)([a-z0-9_\-]+)/i;

function tracePath(sessionId) {
  return join(H, '.claude', `.prism-parallel-trace-${sessionId || 'anon'}.json`);
}

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function readTrace(sessionId) {
  try {
    const p = tracePath(sessionId);
    if (!existsSync(p)) return {entries: []};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return {entries: []}; }
}

// Atomic write — tempfile + rename + catch-fallback. Pattern copied
// verbatim from prism-parent-dispatch-guard.mjs:90-107.
function writeTrace(sessionId, trace) {
  try {
    const p = tracePath(sessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(trace, null, 2));
    renameSync(tmp, p);
  } catch {
    try { writeFileSync(tracePath(sessionId), JSON.stringify(trace, null, 2)); } catch {}
  }
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

// Resolve mode via the documented precedence chain.
function resolveMode() {
  const envRaw = process.env.PRISM_PARALLEL_GUARD;
  const envSet = typeof envRaw === 'string' && envRaw.length > 0;
  const override = process.env.PRISM_POLICY_OVERRIDE === '1';

  let policyMode = null;
  try {
    if (existsSync(POLICY_PATH)) {
      const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8'));
      if (policy && policy.guards && typeof policy.guards.parallel === 'string') {
        policyMode = policy.guards.parallel.toLowerCase();
      }
    }
  } catch {}

  let mode;
  if (override && envSet) mode = envRaw.toLowerCase();
  else if (policyMode) mode = policyMode;
  else if (envSet) mode = envRaw.toLowerCase();
  else mode = 'soft';

  return ['soft', 'hard', 'off'].includes(mode) ? mode : 'soft';
}

function extractPgroup(text) {
  if (!text) return null;
  const m = String(text).match(PGROUP_RE);
  return m ? m[1].toLowerCase() : null;
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  if (input.tool_name !== 'Agent') process.exit(0);

  const MODE = resolveMode();
  if (MODE === 'off') process.exit(0);

  const sessionId = input.session_id || 'anon';
  const ti = input.tool_input || {};
  const subagentType = ti.subagent_type || 'unknown';
  const prompt = ti.prompt || '';
  const description = ti.description || '';

  // Three-path subagent bypass (parity with mutation-guard / model-guard).
  // A subagent dispatching further Agent() calls is doing nested
  // delegation — not the parent's parallel-batch concern.
  const isSubagentById = !!input.parent_tool_use_id;
  const isSubagentByEnv = String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  const sentinel = readSentinel(sessionId);
  const isSubagentByDispatched = !!(sentinel && sentinel.dispatched === true);
  if (isSubagentById || isSubagentByEnv || isSubagentByDispatched) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'parallel_guard',
      session_id: sessionId,
      action: 'passthrough-subagent-context',
      reason: isSubagentById ? 'parent_tool_use_id' : isSubagentByEnv ? 'env' : 'sentinel.dispatched',
      mode: MODE,
    });
    process.exit(0);
  }

  // force_opus sentinel: one-turn user override.
  if (sentinel && sentinel.force_opus === true) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'parallel_guard',
      session_id: sessionId,
      action: 'passthrough-opus-force',
      mode: MODE,
    });
    process.exit(0);
  }

  // Compute current call's pgroup signal. Sources, in priority order:
  //   1. tool_input.metadata.pgroup (if planner sets it)
  //   2. inline annotation in description / prompt
  //   3. user-prompt-level annotation captured on the sentinel
  const meta = ti.metadata || {};
  const pgroup =
    (typeof meta.pgroup === 'string' && meta.pgroup) ||
    extractPgroup(description) ||
    extractPgroup(prompt) ||
    (sentinel && extractPgroup(sentinel.user_prompt_meta || sentinel.rationale)) ||
    null;

  const now = Date.now();
  const trace = readTrace(sessionId);

  // Find the most recent prior entry for the same turn (sentinel-tagged
  // turn id if available, else fall back to time window only).
  const turnId = sentinel?.turn_id || sentinel?.session_turn || null;
  const recent = (trace.entries || [])
    .filter(e => (now - (e.ts || 0)) <= RECENT_WINDOW_MS)
    .filter(e => !turnId || e.turn_id === turnId)
    .pop();

  // Default action: append this call to the trace and exit cleanly.
  // Trim to MAX_TRACE_ENTRIES so the file stays small.
  const newEntry = {
    ts: now,
    pgroup,
    subagent_type: subagentType,
    turn_id: turnId,
  };
  const updated = {
    entries: [...(trace.entries || []), newEntry].slice(-MAX_TRACE_ENTRIES),
  };

  // Detection: previous call recent AND (same pgroup OR user prompt
  // signalled batch intent). Only trigger when *both* calls share a pgroup
  // tag — this avoids flagging legitimate sequential dispatches.
  const recentPgroup = recent?.pgroup;
  const sharedPgroup = pgroup && recentPgroup && pgroup === recentPgroup;
  const promptSignalsParallel = !!(sentinel && /\bpgroup\b|\bin parallel\b|\bbatch dispatch\b/i.test(
    sentinel.user_prompt_meta || sentinel.rationale || ''
  ));
  const flagged = !!recent && (sharedPgroup || (pgroup && promptSignalsParallel));

  // Persist the trace before deciding — even denied calls should be
  // recorded so a subsequent retry isn't double-counted.
  writeTrace(sessionId, updated);

  if (!flagged) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'parallel_guard',
      session_id: sessionId,
      subagent_type: subagentType,
      pgroup,
      action: 'passthrough',
      mode: MODE,
      prompt_hash: sha256short(prompt),
    });
    process.exit(0);
  }

  const notice = [
    `PRISM PARALLEL-GUARD: this Agent({subagent_type:'${subagentType}'}) call shares pgroup='${pgroup}' with a prior dispatch ${Math.round((now - (recent.ts || now)) / 1000)}s ago in the same turn.`,
    `Parallel-tagged subagents must dispatch in a SINGLE assistant message — the harness only parallelises Agent() calls that arrive together.`,
    `Fix: re-emit both Agent() calls in one message. Or remove the pgroup tag if the work is genuinely sequential.`,
    `Override for this turn: prefix the user prompt with !opus-force:. Disable: set PRISM_PARALLEL_GUARD=off.`,
  ].join('\n');

  appendLog({
    ts: new Date().toISOString(),
    event: 'parallel_guard',
    session_id: sessionId,
    subagent_type: subagentType,
    pgroup,
    prior_pgroup: recentPgroup,
    delta_ms: now - (recent.ts || now),
    action: MODE === 'hard' ? 'deny' : 'nudge',
    mode: MODE,
    prompt_hash: sha256short(prompt),
  });

  if (MODE === 'hard') {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: notice,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(2);
  }

  process.stdout.write(notice);
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
