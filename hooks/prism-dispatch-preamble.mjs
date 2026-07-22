#!/usr/bin/env node
// PRISM Dispatch Preamble (v1.0.0) — PreToolUse / Agent
//
// Root cause (PRISM 6.2.0 field evidence, sibling project): the ONE
// intervention that worked all session was a clause set hand-pasted into
// every worker dispatch prompt — 14/14 agents delivered. A prior session on
// the same project held the IDENTICAL text as doctrine in a lessons file
// instead of a prompt — 4 specialists ran, 0 delivered, and nobody noticed
// the gap. Same words; document vs prompt. Only the prompt worked. This hook
// makes that mechanical: it appends the clause set to every Agent() worker
// prompt so it is never optional and never forgotten.
//
// For every Agent() dispatch whose prompt lacks the preamble it (a) emits
// hookSpecificOutput.updatedInput to APPEND the clauses to the worker's
// prompt (honored if the runtime supports PreToolUse arg-rewrite), and
// (b) emits an advisory additionalContext fallback. It NEVER denies — zero
// regression to legitimate dispatch. Idempotent: if the prompt already
// carries the clauses (this hook's own tag, or an equivalent hand-pasted
// doctrine) it no-ops.
//
// COMPOSITION WITH prism-anti-nesting-inject.mjs: both hooks rewrite the same
// `tool_input.prompt` field. The dispatcher's updatedInput merge
// (prism-pretooluse-dispatcher.mjs consolidate()) is documented
// first-writer-wins PER KEY on a same-key conflict — if each hook
// independently computed a single-footer rewrite, only ONE footer would
// survive the merge and the other hook would be silently defeated. Instead
// of racing it, this hook CALLS the sibling's exported run(input) and layers
// its own footer on top of whatever the sibling returns (or the raw prompt,
// if the sibling is off/idempotent/absent). It then registers BEFORE
// prism-anti-nesting-inject.mjs in ROUTES.Agent (see dispatcher comment) so
// the merge keeps this hook's superset rewrite and drops the sibling's
// now-redundant one. Net effect: both footers land regardless of which
// hook's env kill-switch is toggled.
//
// Env: PRISM_DISPATCH_PREAMBLE = on (default) | off.

import {run as antiNestingRun, HOLDING_STRING_BAN} from './prism-anti-nesting-inject.mjs';

const MODE = String(process.env.PRISM_DISPATCH_PREAMBLE ?? 'on').toLowerCase();

const TAG = '[PRISM dispatch-preamble]';

export const PRESENT_RE = /\[PRISM dispatch-preamble\]|write your output to disk|reproduce before you fix|report artifacts, not counters|(there is no bug|the premise is wrong)[^\n]{0,80}valid outcome/i;

const FOOTER = [
  '',
  '---',
  `${TAG} Before you report a result, hold yourself to these:`,
  '1. WRITE YOUR OUTPUT TO DISK at a stated path. A verbal result that evaporates is worse than none.',
  '2. "There is no bug" / "the premise is wrong" is a VALID outcome. Do not manufacture a finding to look useful.',
  '3. REPRODUCE before you fix. An inherited diagnosis is a hypothesis, not a fact.',
  '4. Report ARTIFACTS, not counters or prose. Show the command and its output.',
  '5. KARPATHY DISCIPLINE: make surgical, minimal changes — no speculative features or abstractions; surface your assumptions instead of picking silently; define verifiable success criteria and verify them before reporting. Before you remove, collapse, or quieten an existing mechanism, QUOTE the comment saying why it is there — the verbosity may BE the feature.',
  '6. ABSENCE IS A CLAIM. Before writing that something is absent, empty, missing, or unmatched, read and QUOTE the source field you are describing. A value from a classifier, inference, or default bucket is not evidence the source lacks data — suspect your own mapping first.',
].join('\n');

// v1.1.0 (task #17, 2026-07-16) — SendMessage work-assignment preamble.
// Agent-teams assign real work over SendMessage, which historically bypassed
// PreToolUse entirely, so those workers never received the clause set. The
// dispatcher now routes SendMessage to THIS hook only (see ROUTES.SendMessage).
//
// HEURISTIC (conservative + deterministic — a false rewrite of teammate
// chatter is the failure mode to avoid, so every doubt resolves to NO-OP):
//   rewrite ONLY when ALL hold:
//   1. tool_input.message is a plain string (structured protocol messages —
//      shutdown/plan-approval JSON — are never touched);
//   2. length ≥ 200 chars (status pings and questions are short);
//   3. the message does NOT OPEN with a completion/status marker
//      ("phase N complete", "task #N complete/done", "status:", "update:",
//      "fyi", "re:") — reports ABOUT tasks are not assignments OF tasks;
//   4. an ASSIGNMENT marker appears in the first 400 chars ("new task",
//      "task #N", "your task", "you are a/the … worker/specialist/agent");
//   5. a COMPLETION-CRITERIA marker appears anywhere ("acceptance",
//      "deliverable(s)", "done when", "budget … tool calls").
//   Idempotent via the same PRESENT_RE as the Agent path.
// Kill-switch: PRISM_SENDMESSAGE_ROUTE=off (read per call; ALSO enforced at
// route level in prism-pretooluse-dispatcher.mjs main()). The hook-wide
// PRISM_DISPATCH_PREAMBLE=off kills this branch too.
export const SM_STATUS_OPEN_RE = /^\s*(?:phase\s+\d+\s+(?:complete|done)|task\s*#?\d+\s+(?:complete|done)|completed?\b|done[.:!\s]|status\b|update[:\s]|fyi\b|re:)/i;
export const SM_ASSIGN_RE = /\b(?:new task|task\s*#\d+|your task|you are (?:a|the) [^\n]{0,80}\b(?:worker|specialist|agent)\b)/i;
export const SM_CRITERIA_RE = /\b(?:acceptance|deliverables?|done when|budget\b[^\n]{0,40}\btool calls)\b/i;

function runSendMessage(input) {
  const quiet = {exit: 0, stdout: '', stderr: ''};
  if (String(process.env.PRISM_SENDMESSAGE_ROUTE ?? 'on').toLowerCase() === 'off') return quiet;
  const ti = input.tool_input || {};
  const message = ti.message;
  if (typeof message !== 'string') return quiet;
  if (message.length < 200) return quiet;
  if (PRESENT_RE.test(message)) return quiet;
  if (SM_STATUS_OPEN_RE.test(message)) return quiet;
  if (!SM_ASSIGN_RE.test(message.slice(0, 400))) return quiet;
  if (!SM_CRITERIA_RE.test(message)) return quiet;
  // F1 Layer A: the holding-string ban previously reached only the Agent
  // dispatch path (via prism-anti-nesting-inject's FOOTER/FORK_FOOTER). Append
  // it here as clause 7 so SendMessage work assignments — ~half of agent-teams
  // hand-offs — carry the same ban verbatim. Agent-path FOOTER usage is
  // untouched (this addition is local to runSendMessage).
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {...ti, message: message + '\n' + FOOTER + '\n7. ' + HOLDING_STRING_BAN},
      additionalContext: 'PRISM: dispatch-preamble clauses auto-appended to a SendMessage work assignment (write-to-disk, no-bug-is-a-valid-outcome, reproduce-first, artifacts-not-prose, karpathy-discipline, absence-needs-evidence, holding-string-is-a-failed-result). If your runtime does not honor PreToolUse arg-rewrite, include the clauses in assignment messages yourself.',
    },
  };
  return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
}

export function run(input) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};
    if (input && input.tool_name === 'SendMessage') return runSendMessage(input);
    if (!input || input.tool_name !== 'Agent') return {exit: 0, stdout: '', stderr: ''};
    const ti = input.tool_input || {};
    const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
    if (!prompt.trim()) return {exit: 0, stdout: '', stderr: ''};

    // Compose on top of the sibling hook's rewrite rather than racing it for
    // the same `prompt` key (see file header). Never let a sibling failure
    // block our own injection.
    let basePrompt = prompt;
    let siblingFired = false;
    try {
      const sibling = antiNestingRun(input);
      const parsed = sibling && sibling.stdout ? JSON.parse(sibling.stdout) : null;
      const siblingPrompt = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput
        ? parsed.hookSpecificOutput.updatedInput.prompt : undefined;
      if (typeof siblingPrompt === 'string') { basePrompt = siblingPrompt; siblingFired = true; }
    } catch { /* sibling hook missing/erroring never blocks our own injection */ }

    const alreadyOurs = PRESENT_RE.test(prompt);
    if (alreadyOurs && !siblingFired) return {exit: 0, stdout: '', stderr: ''};

    const augmented = alreadyOurs ? basePrompt : (basePrompt + '\n' + FOOTER);
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {...ti, prompt: augmented},
        additionalContext: 'PRISM: dispatch-preamble clauses auto-appended to the worker prompt (write-to-disk, no-bug-is-a-valid-outcome, reproduce-first, artifacts-not-prose, karpathy-discipline, absence-needs-evidence). If your runtime does not honor PreToolUse arg-rewrite, include the clauses in worker prompts yourself.',
      },
    };
    return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
  } catch {
    return {exit: 0, stdout: '', stderr: ''};
  }
}

import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-dispatch-preamble.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  try {
    const r = run(input);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exit || 0);
  } catch { process.exit(0); }
}
