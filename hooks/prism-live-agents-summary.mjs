#!/usr/bin/env node
// PRISM live-agents summary (Package E) — UserPromptSubmit advisory module.
// Reads the current session's live-agents ledger, reconciles last-write-wins per
// agentId, and emits ONE additionalContext line naming running/completed
// subagents so the orchestrator never GUESSES who is live (anti-confabulation).
//
// Wired into hooks/prism-userpromptsubmit-dispatcher.mjs (same raw-text-stdout
// contract as the other UPS sub-hooks — its stdout becomes additionalContext).
// Fail-open: no session_id / no ledger / any error → emit nothing.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';
import { reconcile, renderSummary } from './lib/prism-live-agents.mjs';

export async function run(payload) {
  try {
    const sessionId = payload && payload.session_id;
    if (!sessionId) return { exit: 0, stdout: '', stderr: '' };
    const map = reconcile(prismHome(), sessionId);
    const line = renderSummary(map);
    if (!line) return { exit: 0, stdout: '', stderr: '' };
    return { exit: 0, stdout: line, stderr: '' };
  } catch {
    return { exit: 0, stdout: '', stderr: '' };
  }
}

// Guard: only run as a hook when invoked directly, NOT when imported by tests
// or the dispatcher.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-live-agents-summary.mjs';
if (invokedDirectly) {
  (async () => {
    try {
      const input = JSON.parse(readFileSync(0, 'utf-8') || '{}');
      const res = await run(input);
      if (res && res.stdout) process.stdout.write(res.stdout);
    } catch {}
    process.exit(0);
  })();
}
