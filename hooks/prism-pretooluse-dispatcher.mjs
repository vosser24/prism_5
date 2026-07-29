#!/usr/bin/env node
// PRISM PreToolUse dispatcher (v5.7) — replaces 7 separate PreToolUse hook
// entries with ONE node process. Each routed guard exports run(payload) →
// {exit, stdout, stderr} (dual-mode; the guards still run standalone too).
//
// WHY: the 7-entry PreToolUse config spawned bash+node up to 4× per Bash call
// and 3× per Agent call — ~1s of process-startup latency on every such call.
// This dispatcher reads stdin ONCE and runs the applicable guards in-process,
// collapsing that to a single spawn.
//
// ROUTING mirrors the shipped matchers + array order exactly:
//   Bash        → safety, prepush-review, mutation-guard, parent-dispatch-guard
//   PowerShell  → parent-dispatch-guard
//   Agent       → agent-model-guard, panel-name-guard, parallel-guard, skill-equip-nudge, specialist-routing-guard, dispatch-dedup-guard, parent-dispatch-guard
//   TaskCreate  → parent-dispatch-guard, task-tier-advisor
//   Edit/Write/MultiEdit → capture-evidence-guard, parent-dispatch-guard
//   NotebookEdit/WebFetch/WebSearch → parent-dispatch-guard
// (prepush-review's old `if: Bash(git *)` filter is unnecessary in-process — the
//  guard self-filters: non-git/non-push Bash returns exit 0 with no output.)
//
// DECISION MERGE (most-restrictive wins, matching Claude Code's native multi-
// hook semantics): every matching guard RUNS (preserving side-effects — routing
// logs, sentinel marking, parallel-trace writes), then results are merged:
//   • any deny  → emit permissionDecision:'deny' (combined reasons) + exit 2
//   • else any ask → emit permissionDecision:'ask' (combined reason + context)
//   • else        → emit combined additionalContext advisory, exit 0
// The guards use three deny conventions (exit 2 + stderr; deny-JSON + exit 0;
// deny-JSON + exit 2) — normalize() unifies all three.
//
// FAIL-OPEN: bad stdin, an unrouted tool, or a guard that throws → exit 0
// (never blocks the tool on an internal error). A single guard throwing is
// caught per-guard so the others still run.

import {readFileSync, appendFileSync, mkdirSync, realpathSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {prismHome} from './lib/prism-home.mjs';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);

const PARENT = 'prism-parent-dispatch-guard.mjs';
const ROUTES = {
  Bash:         ['prism-safety.mjs', 'prism-bash-hang-guard.mjs', 'prism-prepush-review.mjs', 'prism-mutation-guard.mjs', PARENT],
  PowerShell:   [PARENT],
  // NOTE: prism-dispatch-preamble.mjs MUST precede prism-anti-nesting-inject.mjs
  // here. Both rewrite tool_input.prompt; consolidate()'s updatedInput merge is
  // first-writer-wins PER KEY (see consolidate() doc comment above), and
  // dispatch-preamble composes ON TOP of anti-nesting's footer by calling its
  // exported run() directly (see prism-dispatch-preamble.mjs header) — so its
  // rewrite is the superset that must win the same-key race. Reordering these
  // two silently drops one hook's footer from every dispatched prompt.
  // Task #19 (2026-07-16) — prism-live-work-dedup + prism-file-lease-guard are
  // ADVISORY-ONLY (never deny; additionalContext + exit 0) and each has its own
  // kill-switch (PRISM_LIVE_WORK_DEDUP=off / PRISM_FILE_LEASE=off). They MUST
  // run BEFORE prism-dispatch-preamble.mjs so they see the raw, pre-footer
  // prompt (the preamble's fixed clause text would pollute keyword overlap).
  // Neither emits updatedInput, so the preamble/anti-nesting rewrite pair below
  // keeps its documented first-writer-wins contract untouched.
  Agent:        ['prism-agent-model-guard.mjs', 'prism-panel-name-guard.mjs', 'prism-parallel-guard.mjs', 'prism-skill-equip-nudge.mjs', 'prism-specialist-routing-guard.mjs', 'prism-dispatch-dedup-guard.mjs', 'prism-live-work-dedup.mjs', 'prism-file-lease-guard.mjs', 'prism-dispatch-preamble.mjs', 'prism-anti-nesting-inject.mjs', PARENT],
  TaskCreate:   [PARENT, 'prism-task-tier-advisor.mjs'],
  Edit:         ['prism-capture-evidence-guard.mjs', PARENT],
  Write:        ['prism-capture-evidence-guard.mjs', PARENT],
  MultiEdit:    ['prism-capture-evidence-guard.mjs', PARENT],
  NotebookEdit: [PARENT],
  WebFetch:     [PARENT],
  WebSearch:    [PARENT],
  // Task #17 (2026-07-16) — SendMessage joins PreToolUse so agent-teams work
  // assignments receive the dispatch preamble. OPT-IN, NOT BLANKET: only the
  // preamble is routed — the Agent-route guards were never designed to parse a
  // SendMessage payload ({to, message, summary}) and would false-fire. The
  // preamble is therefore the SOLE writer of the `message` updatedInput key on
  // this route (consolidate() is first-writer-wins per key — any future guard
  // added here must NOT rewrite `message`). Kill-switch:
  // PRISM_SENDMESSAGE_ROUTE=off (checked in main() below and in the preamble).
  // Task #19 — live-work-dedup records scope-assigning messages into the
  // live-agents ledger; file-lease-guard parses PRISM-LEASE declarations.
  // NEITHER rewrites `message` (advisory/ledger-only) — the preamble stays the
  // SOLE writer of that updatedInput key, per the contract above.
  SendMessage:  ['prism-dispatch-preamble.mjs', 'prism-live-work-dedup.mjs', 'prism-file-lease-guard.mjs'],
};

// Normalize one guard result {exit, stdout, stderr} into a decision.
// A guard MAY additionally propose rewriting the tool's arguments before it
// runs via `hookSpecificOutput.updatedInput` (an object of field→new-value;
// see the live PreToolUse hooks doc). We capture it here as `updatedInput` on
// the decision, but whether it is ACTUALLY emitted is decided later by
// consolidate() — a sibling `deny`/`ask` always suppresses a rewrite. No
// shipped guard emits updatedInput today, so this is behavior-neutral plumbing.
export function normalize(r) {
  if (!r) return {kind: 'allow'};
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  const hso = json && json.hookSpecificOutput;
  const pd = hso && hso.permissionDecision;
  const updatedInput = (hso && hso.updatedInput && typeof hso.updatedInput === 'object' && !Array.isArray(hso.updatedInput))
    ? hso.updatedInput : undefined;
  if (pd === 'deny' || r.exit === 2) {
    // deny ALWAYS wins — a rewrite proposed by this same guard is irrelevant
    // (and a sibling's rewrite is dropped in consolidate), so we do not carry
    // updatedInput on a deny decision.
    return {
      kind: 'deny',
      reason: (hso && hso.permissionDecisionReason) || (r.stderr || '').trim() || (typeof r.stdout === 'string' && !json ? r.stdout.trim() : ''),
      stderr: (r.stderr || '').trim(),
      context: hso && hso.additionalContext,
    };
  }
  if (pd === 'ask') {
    // ask outranks a plain updatedInput; we still carry it so the precedence is
    // explicit, but consolidate() will NOT apply it while any guard asks.
    return {kind: 'ask', reason: (hso && hso.permissionDecisionReason) || '', context: hso && hso.additionalContext, updatedInput};
  }
  // advisory: hookSpecificOutput.additionalContext, top-level additionalContext, or plain stdout text
  const context = (hso && hso.additionalContext) || (json && json.additionalContext) || (json ? '' : (r.stdout || '').trim());
  return {kind: 'allow', context: context || '', updatedInput};
}

// Merge the per-guard decisions into ONE dispatcher result.
//
// PRECEDENCE (documented; exercised by tests/v3/dispatcher-updatedinput.test.mjs):
//   1. deny (from ANY guard) wins over everything — including a sibling's
//      updatedInput, which is dropped. A rewrite must never mask a block.
//   2. ask (from ANY guard) wins over a plain updatedInput — a rewrite is NOT
//      auto-applied while another guard wants user confirmation.
//   3. otherwise (all guards allow): updatedInput objects are merged across
//      guards by DISJOINT keys. On a SAME-KEY conflict the FIRST writer in
//      dispatcher/route order wins; the later value is dropped and a warning
//      is recorded to the routing log (deterministic — ROUTES order is fixed).
//
// Returns {exit, stdout, stderr, warnings}. stdout is the exact bytes to write
// (empty string ⇒ write nothing). Behavior is byte-identical to the pre-
// updatedInput dispatcher whenever no guard emits updatedInput.
export function consolidate(decisions) {
  const warnings = [];
  const denies = decisions.filter(d => d.kind === 'deny');
  const asks = decisions.filter(d => d.kind === 'ask');
  const allows = decisions.filter(d => d.kind === 'allow');

  if (denies.length) {
    const reason = denies.map(d => d.reason).filter(Boolean).join('\n\n');
    const stderr = denies.map(d => d.stderr).filter(Boolean).join('\n');
    return {
      exit: 2,
      stdout: JSON.stringify({
        hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
      }),
      stderr,
      warnings,
    };
  }

  if (asks.length) {
    const reason = asks.map(d => d.reason).filter(Boolean).join('\n\n');
    const context = [...asks, ...allows].map(d => d.context).filter(Boolean).join('\n\n');
    const hso = {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason};
    if (context) hso.additionalContext = context;
    return {exit: 0, stdout: JSON.stringify({hookSpecificOutput: hso}), stderr: '', warnings};
  }

  // all-allow: merge updatedInput (first-writer-wins on same key)
  let merged;
  const mergedSource = {};
  for (const d of allows) {
    if (!d.updatedInput) continue;
    for (const [k, v] of Object.entries(d.updatedInput)) {
      if (merged && Object.prototype.hasOwnProperty.call(merged, k)) {
        warnings.push({field: k, keptFrom: mergedSource[k], droppedFrom: d.source, kept: merged[k], dropped: v});
        continue; // keep first writer
      }
      if (!merged) merged = {};
      merged[k] = v;
      mergedSource[k] = d.source;
    }
  }
  const context = allows.map(d => d.context).filter(Boolean).join('\n');
  const hso = {hookEventName: 'PreToolUse'};
  if (context) hso.additionalContext = context;
  if (merged) hso.updatedInput = merged;
  // Byte-neutral: emit stdout ONLY when there is something to say (an advisory
  // context and/or a rewrite). No context + no updatedInput ⇒ '' (write nothing).
  const stdout = (context || merged) ? JSON.stringify({hookSpecificOutput: hso}) : '';
  return {exit: 0, stdout, stderr: '', warnings};
}

// Append a same-field updatedInput conflict to the routing log (fail-open).
function logConflict(payload, w) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), {recursive: true});
    appendFileSync(p, JSON.stringify({
      ts: new Date().toISOString(),
      hook: 'pretooluse-dispatcher',
      event: 'updatedinput_conflict',
      schema_version: 4,
      tool_name: payload && payload.tool_name,
      field: w.field,
      kept_from: w.keptFrom,
      dropped_from: w.droppedFrom,
    }) + '\n');
  } catch { /* never block on a log-write failure */ }
}

async function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  // Task #17 — route-level kill-switch: PRISM_SENDMESSAGE_ROUTE=off restores
  // the pre-#17 behavior (SendMessage unrouted, no guard runs). Read per-run.
  if (payload && payload.tool_name === 'SendMessage'
      && String(process.env.PRISM_SENDMESSAGE_ROUTE ?? 'on').toLowerCase() === 'off') process.exit(0);
  const route = ROUTES[payload && payload.tool_name];
  if (!route || !route.length) process.exit(0);

  // E-P2: parallel import + parallel run for all routes except TaskCreate
  // (TaskCreate must stay sequential: parent-dispatch writes sentinel.dispatched
  //  before task-tier-advisor reads it — see test-pretooluse-dispatcher.mjs).
  const SEQUENTIAL_ROUTES = new Set(['TaskCreate']);
  const decisions = [];
  if (SEQUENTIAL_ROUTES.has(payload.tool_name)) {
    for (const file of route) {
      const m = await imp(file);
      if (!m || typeof m.run !== 'function') continue;
      let res;
      try { res = await m.run(payload); } catch { res = null; }
      const d = normalize(res); d.source = file; decisions.push(d);
    }
  } else {
    const modules = await Promise.all(route.map(f => imp(f)));
    const results = await Promise.all(
      modules.map(async (m, i) => {
        let d;
        if (!m || typeof m.run !== 'function') d = normalize(null);
        else { try { d = normalize(await m.run(payload)); } catch { d = normalize(null); } }
        d.source = route[i];
        return d;
      })
    );
    decisions.push(...results);
  }

  const out = consolidate(decisions);
  for (const w of out.warnings) logConflict(payload, w);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exit);
}

// Only drive the pipeline when executed directly (as a hook / by the golden-
// master subprocess test). When IMPORTED (the unit test imports normalize +
// consolidate) main() must NOT run — otherwise it would block on stdin.
let __isMain = true;
try { __isMain = realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url)); }
catch { __isMain = true; }
if (__isMain) main().catch(() => process.exit(0));
