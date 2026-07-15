#!/usr/bin/env node
// tests/v3/hooks/test-nested-cli-guard.mjs — USAGE TEST for the v6.2.0
// nested-CLI spawn guard in hooks/prism-parent-dispatch-guard.mjs.
//
// Rationale (2026-07-10 analysis): shelling out to a non-interactive
// `claude -p` / `--print` session launches an out-of-band nested agent that
// never presents as an Agent tool_use — so the existing nested-dispatch guard
// (which only inspects Agent() calls) never sees it. This is evasion path #2
// around "dispatch is main-loop-only". The new guard inspects Bash/PowerShell
// commands for a `claude ... -p` / `claude ... --print` invocation and emits
// an advisory (default: warn) or hard-denies (PRISM_NESTED_CLI_GUARD=hard).
//
// Run: node tests/v3/hooks/test-nested-cli-guard.mjs

// PRISM_DISPATCH_GUARD/PRISM_NESTED_CLI_GUARD are read inside run() (or at
// module load for the master switch) — set the master switch explicitly
// before importing so behavior is pinned regardless of ambient env.
process.env.PRISM_DISPATCH_GUARD = process.env.PRISM_DISPATCH_GUARD || 'hard';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../hooks/prism-parent-dispatch-guard.mjs';

test('default warn: claude -p command is advisory (exit 0, message present)', () => {
  const r = run({
    tool_name: 'Bash',
    tool_input: { command: 'claude -p "do X"' },
    session_id: 't',
  });
  assert.equal(r.exit, 0);
  assert.match(r.stdout, /NESTED-CLI GUARD/);
  // advisory, not a deny
  assert.doesNotMatch(r.stdout, /"permissionDecision":"deny"/);
});

test('non-claude Bash is untouched (no NESTED-CLI GUARD message)', () => {
  const r = run({
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
    session_id: 't',
  });
  assert.doesNotMatch(r.stdout, /NESTED-CLI GUARD/);
});

test('--print form also warns', () => {
  const r = run({
    tool_name: 'Bash',
    tool_input: { command: 'claude --print hi' },
    session_id: 't',
  });
  assert.equal(r.exit, 0);
  assert.match(r.stdout, /NESTED-CLI GUARD/);
});

test('mention in quotes/data does not falsely fire without -p/--print', () => {
  const r = run({
    tool_name: 'Bash',
    tool_input: { command: 'echo "run claude interactively"' },
    session_id: 't',
  });
  assert.doesNotMatch(r.stdout, /NESTED-CLI GUARD/);
});
