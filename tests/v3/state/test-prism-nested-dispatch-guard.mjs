#!/usr/bin/env node
// v5.7.6 — NESTED-DISPATCH GUARD in hooks/prism-parent-dispatch-guard.mjs.
//
// Root cause (live-repro 2026-06-16): the Claude Code runtime PRISM was built
// against (a) stripped the `Agent` tool from dispatched subagents and (b) did
// NOT fire hooks inside subagents — so "dispatch is main-loop-only" held for
// free. The updated runtime no longer does either: a worker subagent CAN spawn
// a sub-subagent, and that nested Agent() call DOES reach this PreToolUse hook
// ("1 PreToolUse hook ran" observed on the nested call). An unsanctioned nested
// spawn stalls the agent tree (98-minute throttled/near-zero hang, live-repro).
//
// PRISM doctrine is unchanged — NO subagent dispatches (even
// @master-orchestrator-as-subagent only role-plays) — so denying Agent() from
// subagent context breaks nothing sanctioned. This test pins that enforcement:
//   - Agent() from subagent context (parent_tool_use_id OR
//     CLAUDE_CODE_ENTRYPOINT=subagent) → HARD deny (exit 2).
//   - Non-Agent subagent tool calls (Edit/TaskCreate) → still pass (bypass kept).
//   - Agent() in PARENT context (no subagent signal) → still allowed (no false
//     positive on the parent's legitimate parallel fan-out).
//   - PRISM_NESTED_DISPATCH_GUARD=off / soft and the master PRISM_DISPATCH_GUARD
//     =off switches behave.
//
// Run: node tests/v3/state/test-prism-nested-dispatch-guard.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-parent-dispatch-guard.mjs');

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) pass++; else console.log('FAIL: ' + l); };

const SID = 'nested-dispatch-test';

// Run the guard on a haiku turn that has ALREADY dispatched (dispatched=true) —
// this is the realistic state when a subagent is running: the parent's dispatch
// flipped the sentinel. It also proves the deny fires regardless of the
// dispatched flag (i.e. not relying on / defeated by the sentinel path).
function runGuard(payload, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-nest-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`),
      JSON.stringify({ tier: 'haiku', dispatched: true, force_opus: false, summon_panel: false }));
    // Explicitly clear CLAUDE_CODE_ENTRYPOINT unless a case sets it, so ambient
    // env can't make a "parent context" case look like a subagent.
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: '', ...extraEnv };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, ...payload }),
      encoding: 'utf-8', env, timeout: 10000,
    });
    return { status: r.status, out: r.stdout || '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const AGENT = { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', model: 'sonnet', prompt: 'do x' } };
const denied = (r) => r.status === 2 && /deny|denied|main-loop-only|NESTED-DISPATCH/i.test(r.out);
const allowed = (r) => r.status === 0 && !/permissionDecision":"deny/i.test(r.out);

// ── DENY: nested Agent() via parent_tool_use_id (the live-repro signal) ──
check('DENY: Agent + parent_tool_use_id (hard)',
  denied(runGuard({ ...AGENT, parent_tool_use_id: 'p1' })));

// ── DENY: nested Agent() via CLAUDE_CODE_ENTRYPOINT=subagent ──
check('DENY: Agent + CLAUDE_CODE_ENTRYPOINT=subagent (hard)',
  denied(runGuard({ ...AGENT }, { CLAUDE_CODE_ENTRYPOINT: 'subagent' })));

// ── ALLOW (no false positive): Agent() in PARENT context still dispatches ──
check('ALLOW: Agent in parent context (no subagent signal)',
  allowed(runGuard({ ...AGENT })));

// ── ALLOW (regression): subagents still use NON-Agent tools freely ──
check('ALLOW: subagent Edit (only Agent is gated)',
  allowed(runGuard({ tool_name: 'Edit', parent_tool_use_id: 'p1', tool_input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } })));
check('ALLOW: subagent TaskCreate (only Agent is gated)',
  allowed(runGuard({ tool_name: 'TaskCreate', parent_tool_use_id: 'p1', tool_input: { subject: 's', description: 'd' } })));

// ── Kill switches ──
check('ALLOW: nested Agent + PRISM_NESTED_DISPATCH_GUARD=off',
  allowed(runGuard({ ...AGENT, parent_tool_use_id: 'p1' }, { PRISM_NESTED_DISPATCH_GUARD: 'off' })));
check('ALLOW: nested Agent + PRISM_DISPATCH_GUARD=off (master switch)',
  allowed(runGuard({ ...AGENT, parent_tool_use_id: 'p1' }, { PRISM_DISPATCH_GUARD: 'off' })));

// ── SOFT mode: advisory only, exit 0, but a notice is emitted ──
{
  const r = runGuard({ ...AGENT, parent_tool_use_id: 'p1' }, { PRISM_NESTED_DISPATCH_GUARD: 'soft' });
  check('SOFT: nested Agent → exit 0 + notice (no deny JSON)',
    r.status === 0 && /main-loop-only|NESTED-DISPATCH/i.test(r.out) && !/permissionDecision":"deny/i.test(r.out));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
