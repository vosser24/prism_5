#!/usr/bin/env node
// PRISM SubagentStart — live-agents ledger append (Package E).
// Fires when a subagent is dispatched. Appends a `running` record to the
// session-scoped ledger ~/.claude/.prism-live-agents-<session_id>.jsonl so the
// orchestrator has a deterministic "who is live" source instead of confabulating
// agent names/ids/status. Keys on the SAME identity resolution the SubagentStop
// hook uses (agent_type → subagent_type → agent_name → agent) so start and stop
// records reconcile together.
//
// Fully fail-open: missing session_id / missing id / any error → skip and ALWAYS
// exit 0. Dep-free ESM.
import { readFileSync as r } from 'node:fs';
import { basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';
import { extractAgentId, extractAgentType, appendRecord } from './lib/prism-live-agents.mjs';

export async function run(payload) {
  try {
    const input = payload || {};
    const sessionId = input.session_id || '';
    const agentId = extractAgentId(input);
    // Missing fields → skip (fail-open). Nothing to key on / nowhere to key it.
    if (!sessionId || !agentId) return { exit: 0, stdout: '', stderr: '' };
    const H = prismHome();
    appendRecord(H, sessionId, {
      agentId,
      agentType: extractAgentType(input) || agentId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  } catch {
    /* fail-open */
  }
  return { exit: 0, stdout: '', stderr: '' };
}

// Guard: only run as a hook when invoked directly, NOT when imported by tests
// or a dispatcher.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-subagent-start.mjs';
if (invokedDirectly) {
  (async () => {
    try {
      const input = JSON.parse(r(0, 'utf-8') || '{}');
      await run(input);
    } catch {}
    process.exit(0);
  })();
}
