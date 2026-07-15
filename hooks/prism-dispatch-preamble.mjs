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

import {run as antiNestingRun} from './prism-anti-nesting-inject.mjs';

const MODE = String(process.env.PRISM_DISPATCH_PREAMBLE ?? 'on').toLowerCase();

const TAG = '[PRISM dispatch-preamble]';

const PRESENT_RE = /\[PRISM dispatch-preamble\]|write your output to disk|reproduce before you fix|report artifacts, not counters|(there is no bug|the premise is wrong)[^\n]{0,80}valid outcome/i;

const FOOTER = [
  '',
  '---',
  `${TAG} Before you report a result, hold yourself to these:`,
  '1. WRITE YOUR OUTPUT TO DISK at a stated path. A verbal result that evaporates is worse than none.',
  '2. "There is no bug" / "the premise is wrong" is a VALID outcome. Do not manufacture a finding to look useful.',
  '3. REPRODUCE before you fix. An inherited diagnosis is a hypothesis, not a fact.',
  '4. Report ARTIFACTS, not counters or prose. Show the command and its output.',
].join('\n');

export function run(input) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};
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
        additionalContext: 'PRISM: dispatch-preamble clauses auto-appended to the worker prompt (write-to-disk, no-bug-is-a-valid-outcome, reproduce-first, artifacts-not-prose). If your runtime does not honor PreToolUse arg-rewrite, include the clauses in worker prompts yourself.',
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
