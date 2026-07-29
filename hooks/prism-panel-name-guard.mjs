#!/usr/bin/env node
// PRISM Panel Name-Guard (v1.0.0) — PreToolUse on the `Agent` tool.
//
// D062 (docs/prism/adjudications/D062-named-teammate-report-loss.md):
// passing `name:` to Agent() makes the dispatch an Agent-Teams TEAMMATE
// instead of a one-shot subagent call. Its output does NOT return as the
// tool result — the caller receives only a payload-free
// `{"type":"idle_notification","from":<name>,"idleReason":"available"}`.
// The teammate must proactively SendMessage its findings; if it doesn't,
// the report is silently lost. On a PANEL-SUMMON turn this means a seat's
// position/challenges vanish and the master is tempted to author the
// challenge itself instead of relaying the dispatched expert's real one —
// exactly the failure mode D062 documents ("its verdicts were lost").
//
// This is F1: the mechanical detection layer only. `name:` IS inspectable
// in the PreToolUse Agent tool_input, so this is real, not speculative.
//
// FIRES when ALL of:
//   - PreToolUse, tool_name === 'Agent'
//   - tool_input.name is a non-empty string
//   - EITHER the per-session tier sentinel
//     (~/.claude/.prism-turn-tier-<session>.json, written by
//     prism-prompt-tier-router.mjs) has summon_panel === true (same-turn
//     dispatch) OR a panel-active LATCH is live for this session
//     (~/.claude/.prism-panel-active-<session>.json, F7 Phase 1).
//
// F7 (2026-07-24): the summon_panel-only gate meant this guard NEVER fired in
// production — a real self-chaired panel dispatches its seats on the
// POST-APPROVAL turn, by which point summon_panel has reset to false
// (hooks/prism-prompt-tier-router.mjs:354 / fresh non-panel re-classification).
// The latch (hooks/lib/prism-panel-latch.mjs) persists the panel-in-progress
// signal across turns, decoupled from the per-turn sentinel, so the guard fires
// on the seat dispatch that actually matters.
//
// ADVISORY ONLY — never blocks, never denies. Fail-open on every error
// (missing sentinel, parse error, anything) → exit 0 / no output. Honor
// PRISM_DISABLE_PANEL_NAME_GUARD=1.
//
// Patterns copied (cite explicitly):
//   - Sentinel path + read: prism-agent-model-guard.mjs sentinelPath()/
//     readSentinel() (same `.prism-turn-tier-<session>.json` file, same
//     existsSync-guarded try/catch shape).
//   - Home resolution: hooks/lib/prism-home.mjs prismHome() (same
//     validating resolver prism-panel-guard.mjs uses — called at USE time,
//     not captured at module load, so tests can flip HOME between calls).
//   - Dual-mode run(input) → {exit, stdout, stderr} + standalone shim:
//     prism-agent-model-guard.mjs / prism-specialist-routing-guard.mjs.
//   - Advisory additionalContext-only emission (never updatedInput, never
//     permissionDecision): prism-specialist-routing-guard.mjs allow() shape.
//   - Routing-log record via the shared logAdvisory() helper:
//     hooks/lib/prism-advisory-log.mjs (existing shared lib — reused as-is,
//     no new logging plumbing).

import {readFileSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';
import {prismHome} from './lib/prism-home.mjs';
import {logAdvisory} from './lib/prism-advisory-log.mjs';
import {isPanelLatchLive} from './lib/prism-panel-latch.mjs';

function sentinelPath(sessionId) {
  return join(prismHome(), '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// v5.7 dual-mode: run(input) → {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the
// same contract for direct/standalone invocation and tests.
export async function run(input) {
  try {
    if (process.env.PRISM_DISABLE_PANEL_NAME_GUARD === '1') {
      return {exit: 0, stdout: '', stderr: ''};
    }
    if (!input || input.tool_name !== 'Agent') {
      return {exit: 0, stdout: '', stderr: ''};
    }

    const ti = input.tool_input || {};
    const name = typeof ti.name === 'string' ? ti.name.trim() : '';
    if (!name) return {exit: 0, stdout: '', stderr: ''};

    const sessionId = input.session_id || 'anon';
    // F7 Phase 1: fire when EITHER the current-turn sentinel says summon_panel
    // (same-turn dispatch) OR a panel-active latch is live (cross-turn: the
    // real seat dispatch happens on the post-approval turn where summon_panel
    // has already reset to false — the exact gap that kept this guard at
    // 0 lifetime fires; see hooks/lib/prism-panel-latch.mjs).
    const sentinel = readSentinel(sessionId);
    const summonNow = !!(sentinel && sentinel.summon_panel === true);
    const latchLive = isPanelLatchLive(sessionId);
    if (!summonNow && !latchLive) {
      return {exit: 0, stdout: '', stderr: ''};
    }

    const msg = `PRISM PANEL NAME-GUARD (D062): this is a panel-summon turn and you dispatched an Agent() with name:'${name}' — a named seat becomes an Agent-Teams teammate whose written position does NOT return as your tool result (only a payload-free idle_notification), so its challenges will be lost and you'll be tempted to author them yourself. Dispatch panel seats WITHOUT name: so the position returns. (Advisory; PRISM_DISABLE_PANEL_NAME_GUARD=1 to suppress.)`;

    logAdvisory({
      event: 'panel_name_guard',
      session_id: sessionId,
      tool: 'Agent',
      subagent_type: ti.subagent_type || 'unknown',
      name,
      trigger: summonNow ? 'summon' : 'latch',  // F7: which signal fired the guard
      action: 'nudge',
    });

    return {
      exit: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: msg},
      }),
      stderr: '',
    };
  } catch {
    // FAIL-OPEN: any unexpected error (bad payload shape, fs error, ...)
    // must never block the tool call this guard is only advising on.
    return {exit: 0, stdout: '', stderr: ''};
  }
}

// Standalone shim — same contract as sibling Agent guards.
if (process.argv[1] && basename(process.argv[1]) === 'prism-panel-name-guard.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  run(input).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  }).catch(() => process.exit(0));
}
