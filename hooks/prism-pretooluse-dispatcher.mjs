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
//   Agent       → agent-model-guard, parallel-guard, skill-equip-nudge, specialist-routing-guard, dispatch-dedup-guard, parent-dispatch-guard
//   TaskCreate  → parent-dispatch-guard, task-tier-advisor
//   Edit/Write/MultiEdit/NotebookEdit/WebFetch/WebSearch → parent-dispatch-guard
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

import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);

const PARENT = 'prism-parent-dispatch-guard.mjs';
const ROUTES = {
  Bash:         ['prism-safety.mjs', 'prism-bash-hang-guard.mjs', 'prism-prepush-review.mjs', 'prism-mutation-guard.mjs', PARENT],
  PowerShell:   [PARENT],
  Agent:        ['prism-agent-model-guard.mjs', 'prism-parallel-guard.mjs', 'prism-skill-equip-nudge.mjs', 'prism-specialist-routing-guard.mjs', 'prism-dispatch-dedup-guard.mjs', PARENT],
  TaskCreate:   [PARENT, 'prism-task-tier-advisor.mjs'],
  Edit:         [PARENT],
  Write:        [PARENT],
  MultiEdit:    [PARENT],
  NotebookEdit: [PARENT],
  WebFetch:     [PARENT],
  WebSearch:    [PARENT],
};

// Normalize one guard result {exit, stdout, stderr} into a decision.
function normalize(r) {
  if (!r) return {kind: 'allow'};
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  const hso = json && json.hookSpecificOutput;
  const pd = hso && hso.permissionDecision;
  if (pd === 'deny' || r.exit === 2) {
    return {
      kind: 'deny',
      reason: (hso && hso.permissionDecisionReason) || (r.stderr || '').trim() || (typeof r.stdout === 'string' && !json ? r.stdout.trim() : ''),
      stderr: (r.stderr || '').trim(),
      context: hso && hso.additionalContext,
    };
  }
  if (pd === 'ask') {
    return {kind: 'ask', reason: (hso && hso.permissionDecisionReason) || '', context: hso && hso.additionalContext};
  }
  // advisory: hookSpecificOutput.additionalContext, top-level additionalContext, or plain stdout text
  const context = (hso && hso.additionalContext) || (json && json.additionalContext) || (json ? '' : (r.stdout || '').trim());
  return {kind: 'allow', context: context || ''};
}

async function main() {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
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
      decisions.push(normalize(res));
    }
  } else {
    const modules = await Promise.all(route.map(f => imp(f)));
    const results = await Promise.all(
      modules.map(async (m) => {
        if (!m || typeof m.run !== 'function') return normalize(null);
        try { return normalize(await m.run(payload)); } catch { return normalize(null); }
      })
    );
    decisions.push(...results);
  }

  const denies = decisions.filter(d => d.kind === 'deny');
  const asks = decisions.filter(d => d.kind === 'ask');
  const allows = decisions.filter(d => d.kind === 'allow');

  if (denies.length) {
    const reason = denies.map(d => d.reason).filter(Boolean).join('\n\n');
    const stderr = denies.map(d => d.stderr).filter(Boolean).join('\n');
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
    }));
    if (stderr) process.stderr.write(stderr);
    process.exit(2);
  }

  if (asks.length) {
    const reason = asks.map(d => d.reason).filter(Boolean).join('\n\n');
    const context = [...asks, ...allows].map(d => d.context).filter(Boolean).join('\n\n');
    const hso = {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason};
    if (context) hso.additionalContext = context;
    process.stdout.write(JSON.stringify({hookSpecificOutput: hso}));
    process.exit(0);
  }

  const context = allows.map(d => d.context).filter(Boolean).join('\n');
  if (context) {
    process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: context}}));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
