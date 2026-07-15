#!/usr/bin/env node
// tests/v3/hooks/test-anti-nesting-inject.mjs — USAGE TEST for
// hooks/prism-anti-nesting-inject.mjs
//
// The guard mechanically appends an anti-over-delegation clause to every
// Agent() dispatch prompt that doesn't already carry it. Idempotent (never
// double-appends), never denies, and no-ops for non-Agent tools and empty
// prompts.
//
// Run: node tests/v3/hooks/test-anti-nesting-inject.mjs

import { run } from '../../../hooks/prism-anti-nesting-inject.mjs';

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

// 1. Normal Agent dispatch → footer appended
{
  const r = run({ tool_name: 'Agent', tool_input: { prompt: 'do a thing' } });
  check('normal dispatch: exit 0', r.exit === 0);
  let updatedPrompt = '';
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  updatedPrompt = parsed?.hookSpecificOutput?.updatedInput?.prompt || '';
  check('normal dispatch: updatedInput.prompt starts with original prompt', updatedPrompt.startsWith('do a thing'));
  check('normal dispatch: footer contains MAIN-LOOP-ONLY', updatedPrompt.includes('MAIN-LOOP-ONLY'));
  check('normal dispatch: footer contains MUST NOT spawn', updatedPrompt.includes('MUST NOT spawn'));
  check('normal dispatch: updatedInput.prompt ends with footer', updatedPrompt.endsWith(
    "holding/status string (e.g. 'verifying...', 'the child is checking...') is a FAILED result."
  ));
}

// 2. Idempotency: prompt already contains the clause → no injection
{
  const r = run({ tool_name: 'Agent', tool_input: { prompt: 'some prompt where dispatch is main-loop-only already stated' } });
  check('idempotent: exit 0', r.exit === 0);
  check('idempotent: stdout empty (no injection)', r.stdout === '');
}

// 3. Non-Agent tool → no-op
{
  const r = run({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  check('non-Agent no-op: exit 0', r.exit === 0);
  check('non-Agent no-op: stdout empty', r.stdout === '');
}

// 4. Missing/empty prompt → no-op
{
  const r = run({ tool_name: 'Agent', tool_input: {} });
  check('missing prompt: exit 0', r.exit === 0);
  check('missing prompt: stdout empty', r.stdout === '');
}

// 5. Off switch — MODE is captured at import time from process.env, so we
// re-import the module with a cache-busting query string after setting the
// env var, to get a fresh module evaluation with MODE='off'.
{
  process.env.PRISM_ANTI_NESTING_INJECT = 'off';
  const { run: runOff } = await import(`../../../hooks/prism-anti-nesting-inject.mjs?cachebust=${Date.now()}`);
  const r = runOff({ tool_name: 'Agent', tool_input: { prompt: 'do a thing' } });
  check('off switch: exit 0', r.exit === 0);
  check('off switch: stdout empty (no injection)', r.stdout === '');
  delete process.env.PRISM_ANTI_NESTING_INJECT;
}

// 6. subagent_type: 'fork' dispatch → fork-aware opening line, but the
// main-loop-only / cannot-spawn constraint is still present verbatim.
// Also: the runtime schema-rejects Agent() dispatches whose updatedInput
// drops fields present in the original tool_input (regression: v6.1.0
// returned only {prompt}, which dropped subagent_type/description and broke
// every Agent dispatch once this hook went live). Assert the FULL field set
// is preserved by value, not just the prompt text.
{
  const toolInput = { subagent_type: 'fork', description: 'continue investigation', prompt: 'continue the investigation' };
  const r = run({ tool_name: 'Agent', tool_input: toolInput });
  check('fork dispatch: exit 0', r.exit === 0);
  let updatedInput = null;
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  updatedInput = parsed?.hookSpecificOutput?.updatedInput || {};
  const updatedPrompt = updatedInput.prompt || '';
  check('fork dispatch: updatedInput.prompt starts with original prompt', updatedPrompt.startsWith('continue the investigation'));
  check('fork dispatch: opening line says FORKED CONTINUATION', updatedPrompt.includes('You are a FORKED CONTINUATION of the dispatching agent'));
  check('fork dispatch: opening line does NOT say DISPATCHED SUBAGENT', !updatedPrompt.includes('You are a DISPATCHED SUBAGENT'));
  check('fork dispatch: footer contains MAIN-LOOP-ONLY', updatedPrompt.includes('MAIN-LOOP-ONLY'));
  check('fork dispatch: footer contains MUST NOT spawn', updatedPrompt.includes('MUST NOT spawn'));
  check('fork dispatch: footer contains hand-back-to-dispatching-agent instruction', updatedPrompt.includes('hand it') && updatedPrompt.includes('back to the dispatching agent'));
  check('fork dispatch: footer contains holding/status FAILED-result line', updatedPrompt.includes("is a FAILED result."));
  // Regression guard: updatedInput must PRESERVE subagent_type/description
  // (equal to the input values), not silently drop them.
  check('fork dispatch: updatedInput.subagent_type === input value', updatedInput.subagent_type === toolInput.subagent_type);
  check('fork dispatch: updatedInput.description === input value', updatedInput.description === toolInput.description);
  check('fork dispatch: updatedInput.prompt !== original (overwritten with augmented text)', updatedInput.prompt !== toolInput.prompt);
  check('fork dispatch: updatedInput keys === {subagent_type, description, prompt} (no fields dropped or added)',
    JSON.stringify(Object.keys(updatedInput).sort()) === JSON.stringify(['description', 'prompt', 'subagent_type'].sort()));
}

// 7. subagent_type: 'general-purpose' (non-fork) dispatch → original wording
// unchanged, byte-identical to the plain (no subagent_type) case. Same
// field-preservation regression guard as case 6, for the non-fork path.
{
  const toolInput = { subagent_type: 'general-purpose', description: 'do a thing', prompt: 'do a thing' };
  const r = run({ tool_name: 'Agent', tool_input: toolInput });
  check('general-purpose dispatch: exit 0', r.exit === 0);
  let updatedInput = null;
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  updatedInput = parsed?.hookSpecificOutput?.updatedInput || {};
  const updatedPrompt = updatedInput.prompt || '';
  check('general-purpose dispatch: opening line says DISPATCHED SUBAGENT', updatedPrompt.includes('You are a DISPATCHED SUBAGENT'));
  check('general-purpose dispatch: opening line does NOT say FORKED CONTINUATION', !updatedPrompt.includes('FORKED CONTINUATION'));
  check('general-purpose dispatch: updatedInput.prompt ends with footer', updatedPrompt.endsWith(
    "holding/status string (e.g. 'verifying...', 'the child is checking...') is a FAILED result."
  ));
  // Regression guard: updatedInput must PRESERVE subagent_type/description
  // (equal to the input values), not silently drop them (the v6.1.0 bug:
  // updatedInput returned only {prompt}, schema-rejected by the runtime).
  check('general-purpose dispatch: updatedInput.subagent_type === input value', updatedInput.subagent_type === toolInput.subagent_type);
  check('general-purpose dispatch: updatedInput.description === input value', updatedInput.description === toolInput.description);
  check('general-purpose dispatch: updatedInput.prompt !== original (overwritten with augmented text)', updatedInput.prompt !== toolInput.prompt);
  check('general-purpose dispatch: updatedInput keys === {subagent_type, description, prompt} (no fields dropped or added)',
    JSON.stringify(Object.keys(updatedInput).sort()) === JSON.stringify(['description', 'prompt', 'subagent_type'].sort()));
}

// 8. Idempotency for the fork variant: second pass on the already-augmented
// fork prompt is a no-op (PRESENT_RE matches the fork footer too).
{
  const first = run({ tool_name: 'Agent', tool_input: { subagent_type: 'fork', prompt: 'continue the investigation' } });
  let augmentedPrompt = '';
  try { augmentedPrompt = JSON.parse(first.stdout)?.hookSpecificOutput?.updatedInput?.prompt || ''; } catch {}
  const second = run({ tool_name: 'Agent', tool_input: { subagent_type: 'fork', prompt: augmentedPrompt } });
  check('fork idempotent: exit 0', second.exit === 0);
  check('fork idempotent: stdout empty (no re-injection)', second.stdout === '');
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
