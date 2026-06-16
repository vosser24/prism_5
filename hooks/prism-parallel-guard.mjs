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
import {resolveParallelCap} from './lib/prism-cap.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const POLICY_PATH = join(H, '.claude', 'prism-policy.json');
const RECENT_WINDOW_MS = 60_000;
const MAX_TRACE_ENTRIES = 8;

// pgroup annotation patterns the orchestrator emits when it intends a
// parallel batch. Recognised forms (case-insensitive):
//   [pgroup:foo]   pgroup=foo   <pgroup foo>   "pgroup: foo"
const PGROUP_RE = /(?:\[pgroup[:=]\s*|pgroup[:=]\s*|<pgroup\s+)([a-z0-9_\-]+)/i;

// WS-B (v5.7.4): soft factory-hire hint. A dispatch is "domain-research on a
// throwaway agent" when the subagent_type is GENERIC (not a named rostered
// specialist) AND the prompt reads like durable domain research/design. Counting
// these per-turn lets the guard nudge toward @agent-factory before a flood of
// throwaway workers burns tokens with no reusable asset. Heuristic → SOFT only.
const GENERIC_SUBAGENT_TYPES = new Set(['general-purpose', 'claude', 'unknown', '']);
const DOMAIN_RESEARCH_RE = /\b(research|deep[- ]?dive|best practices?|state[- ]of[- ]the[- ]art|conventions?|typography|design system|landscape|survey|guidelines?|standards?)\b/i;

function resolveFactoryHint(env = process.env) {
  const raw = env.PRISM_FACTORY_HINT;
  const enabled = !(typeof raw === 'string' && raw.toLowerCase() === 'off');
  let threshold = 3;
  const t = env.PRISM_FACTORY_HINT_THRESHOLD;
  if (t != null && /^\d+$/.test(String(t).trim())) {
    const n = parseInt(String(t).trim(), 10);
    if (n >= 1 && n <= 16) threshold = n;
  }
  return {enabled, threshold};
}

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

// v5.7: dual-mode. run(input) returns {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the original
// wire behavior (byte-identical, verified by golden-master).
export function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});
  if (input.tool_name !== 'Agent') return done(0);

  const MODE = resolveMode();
  if (MODE === 'off') return done(0);

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
    return done(0);
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
    return done(0);
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
  // Reuse the SAME trace object already read above (no extra I/O). The filtered
  // set = how many Agent dispatches have already fired this turn within the
  // window; its length drives WS3 cap-enforcement, its last element drives the
  // pre-existing pgroup detection.
  const recentSameTurn = (trace.entries || [])
    .filter(e => (now - (e.ts || 0)) <= RECENT_WINDOW_MS)
    .filter(e => !turnId || e.turn_id === turnId);
  const recent = recentSameTurn[recentSameTurn.length - 1] || undefined;
  // WS3 (v5.7.3): concurrency-cap ceiling. A correct single-message batch of
  // N≤cap calls fires N rapid same-turn hook invocations counting 0..N-1, all
  // < cap. The (cap+1)th same-turn in-window dispatch is the first over-cap
  // call → flagged. resolveParallelCap() is a regex test over a short env
  // string; recentSameTurn is bounded by MAX_TRACE_ENTRIES — microsecond cost.
  const cap = resolveParallelCap();
  const overCap = recentSameTurn.length >= cap;

  // WS-B (v5.7.4): factory-hire hint. Classify THIS dispatch as domain-research
  // on a generic/throwaway agent, persist the `dr` flag on the trace entry, and
  // count the same-turn running total. When it reaches the threshold, append a
  // SOFT advisory (below) — never a deny. Reuses the SAME trace already read.
  const currentIsDr = GENERIC_SUBAGENT_TYPES.has(subagentType) &&
    DOMAIN_RESEARCH_RE.test(`${description} ${prompt}`);
  const {enabled: hintEnabled, threshold: hintThreshold} = resolveFactoryHint();
  const priorDr = recentSameTurn.filter(e => e && e.dr === true).length;
  const totalDr = priorDr + (currentIsDr ? 1 : 0);
  const factoryHint = hintEnabled && currentIsDr && totalDr >= hintThreshold;
  const factoryHintText = factoryHint ? [
    `PRISM FACTORY-HINT: ${totalDr} domain-research dispatch(es) on throwaway generic agents this turn (threshold ${hintThreshold}).`,
    `Durable domain work like this should be a SPECIALIST — consider @agent-factory (NotebookLM-grounded) so the expertise persists and isn't re-derived per task. See SKILL.md DISPATCH CONTRACT step 1 (factory-hire fork).`,
    `Advisory only (never blocks). Disable: PRISM_FACTORY_HINT=off. Tune: PRISM_FACTORY_HINT_THRESHOLD.`,
  ].join('\n') : '';

  // Default action: append this call to the trace and exit cleanly.
  // Trim to MAX_TRACE_ENTRIES so the file stays small.
  const newEntry = {
    ts: now,
    pgroup,
    subagent_type: subagentType,
    turn_id: turnId,
    dr: currentIsDr,
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
  const pgroupFlagged = !!recent && (sharedPgroup || (pgroup && promptSignalsParallel));
  const flagged = pgroupFlagged || (!!recent && overCap);

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
      action: factoryHint ? 'passthrough+factory-hint' : 'passthrough',
      factory_hint: factoryHint || undefined,
      dr_count: totalDr || undefined,
      mode: MODE,
      prompt_hash: sha256short(prompt),
    });
    // The factory hint is a SOFT advisory — appended additively on the clean
    // passthrough path; it never changes the exit code.
    if (factoryHintText) write(factoryHintText);
    return done(0);
  }

  // pgroup-flagged calls keep the original notice; an over-cap-only flag (no
  // shared pgroup) gets a cap-specific message explaining the ceiling + knobs.
  const notice = pgroupFlagged ? [
    `PRISM PARALLEL-GUARD: this Agent({subagent_type:'${subagentType}'}) call shares pgroup='${pgroup}' with a prior dispatch ${Math.round((now - (recent.ts || now)) / 1000)}s ago in the same turn.`,
    `Parallel-tagged subagents must dispatch in a SINGLE assistant message — the harness only parallelises Agent() calls that arrive together.`,
    `Fix: re-emit both Agent() calls in one message. Or remove the pgroup tag if the work is genuinely sequential.`,
    `Override for this turn: prefix the user prompt with !opus-force:. Disable: set PRISM_PARALLEL_GUARD=off.`,
  ].join('\n') : [
    `PRISM PARALLEL-GUARD: this Agent({subagent_type:'${subagentType}'}) dispatch is over the concurrency cap — ${recentSameTurn.length} Agent call(s) already fired this turn within ${Math.round(RECENT_WINDOW_MS / 1000)}s, cap=${cap}.`,
    `Spawning past the cap risks a 429 spawn-storm. Decompose into ≤${cap} concurrent slices, or pipeline the extras sequentially after the first batch returns.`,
    `Raise the ceiling deliberately: set PRISM_PARALLEL_CAP (up to 16). Override for this turn: prefix the user prompt with !opus-force:. Disable: set PRISM_PARALLEL_GUARD=off.`,
  ].join('\n');

  appendLog({
    ts: new Date().toISOString(),
    event: 'parallel_guard',
    session_id: sessionId,
    subagent_type: subagentType,
    pgroup,
    prior_pgroup: recentPgroup,
    delta_ms: now - (recent.ts || now),
    reason: pgroupFlagged ? 'pgroup' : 'over-cap',
    cap,
    count: recentSameTurn.length,
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
    write(JSON.stringify(deny));
    return done(2);
  }

  // Soft mode: emit the cap/pgroup notice + (additively) the factory hint if it
  // fired. The hard-deny path above returns first, so the deny JSON stays clean.
  write(factoryHintText ? `${notice}\n${factoryHintText}` : notice);
  return done(0);
}

// Standalone shim — preserves original wire behavior + parse-error fail-open.
import {basename} from 'node:path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-parallel-guard.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  try {
    const r = run(input);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exit || 0);
  } catch { process.exit(0); }
}
