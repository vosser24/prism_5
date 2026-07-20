#!/usr/bin/env node
// PRISM Anti-Nesting Injection (v1.0.0) — PreToolUse / Agent
//
// Root cause (Dedecomp incident 2026-07-10): a dispatched worker spawned its own
// sub-agents 4-5 deep, each re-describing the same task instead of doing it — an
// over-delegation chain that stalls the tree. PRISM's dispatch contract MANDATES
// injecting an anti-over-delegation clause into every worker prompt, but that was
// doctrine-only with no mechanical enforcement, so a model that skipped it made
// the chain.
//
// This guard makes the injection MECHANICAL. For every Agent() dispatch whose
// prompt lacks the clause it (a) emits hookSpecificOutput.updatedInput to APPEND
// the clause to the worker's prompt (honored if the runtime supports PreToolUse
// arg-rewrite), and (b) emits an advisory additionalContext fallback. It NEVER
// denies — zero regression to legitimate parallel / background dispatch.
// Idempotent: if the prompt already contains the clause it no-ops (never
// double-appends).
//
// Env: PRISM_ANTI_NESTING_INJECT = on (default) | off.

const MODE = String(process.env.PRISM_ANTI_NESTING_INJECT ?? 'on').toLowerCase();

const PRESENT_RE = /main-loop-only|do NOT spawn|don't spawn|MUST NOT spawn|compute your own result|report YOUR OWN result|dispatch is main-loop|you cannot dispatch/i;

// Single source of truth for the holding-string ban clause (F1 Layer A).
// Referenced by BOTH FOOTER and FORK_FOOTER here, and imported by
// prism-dispatch-preamble.mjs so the SendMessage work-assignment path carries
// the SAME ban verbatim (previously it only reached the Agent dispatch path).
// Wording is byte-identical to the prior FOOTER/FORK_FOOTER text; only the
// intra-sentence line-wrapping is normalized to one line so a single const can
// feed all three emit sites without drift.
export const HOLDING_STRING_BAN = "A final message that is only a holding/status string (e.g. 'verifying...', 'the child is checking...') is a FAILED result.";

const FOOTER = [
  '',
  '---',
  '[PRISM anti-nesting] You are a DISPATCHED SUBAGENT. Subagent dispatch is MAIN-LOOP-ONLY:',
  'you CANNOT and MUST NOT spawn sub-agents (no Agent/Task dispatch, no `claude -p`).',
  'Do the work YOURSELF with the tools you have and report YOUR OWN result. Do not delegate',
  'by re-describing this task to another agent. If you genuinely need parallel help, return a',
  'short dispatch plan to the main loop and let IT fan out. ' + HOLDING_STRING_BAN,
].join('\n');

// Fork-aware variant (D039 follow-up): a `subagent_type: 'fork'` dispatch is a
// PEER CONTINUATION of the dispatching agent — it inherits the parent's full
// context and runs on its model, it is not a fresh worker. The opening line is
// corrected accordingly, but the load-bearing constraint is unchanged and
// verbatim: dispatch is main-loop-only, so a fork also cannot spawn children.
const FORK_FOOTER = [
  '',
  '---',
  '[PRISM anti-nesting] You are a FORKED CONTINUATION of the dispatching agent (you inherit',
  'its full context and run on its model, and are a peer, not a fresh worker). Subagent',
  'dispatch is MAIN-LOOP-ONLY: you CANNOT and MUST NOT spawn sub-agents (no Agent/Task dispatch,',
  'no `claude -p`).',
  'Do the work YOURSELF with the tools you have and report YOUR OWN result. Do not delegate',
  'by re-describing this task to another agent. If you genuinely need parallel help, hand it',
  'back to the dispatching agent so IT can fan out — a fork cannot fan out itself. ' + HOLDING_STRING_BAN,
].join('\n');

export function run(input) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};
    if (!input || input.tool_name !== 'Agent') return {exit: 0, stdout: '', stderr: ''};
    const ti = input.tool_input || {};
    const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
    if (!prompt.trim()) return {exit: 0, stdout: '', stderr: ''};
    if (PRESENT_RE.test(prompt)) return {exit: 0, stdout: '', stderr: ''};
    const isFork = ti.subagent_type === 'fork';
    const footer = isFork ? FORK_FOOTER : FOOTER;
    const augmented = prompt + '\n' + footer;
    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {...ti, prompt: augmented},
        additionalContext: 'PRISM: anti-nesting clause auto-appended to the worker prompt (subagents must not spawn sub-agents). If your runtime does not honor PreToolUse arg-rewrite, include the clause in worker prompts yourself.',
      },
    };
    return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
  } catch {
    return {exit: 0, stdout: '', stderr: ''};
  }
}

import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-anti-nesting-inject.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  try {
    const r = run(input);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exit || 0);
  } catch { process.exit(0); }
}
