#!/usr/bin/env node
// tests/v3/state/test-prism-panel-dispatch-guard.mjs
// v5.x build step 2 — dispatch-mode guard in hooks/prism-panel-guard.mjs.
//
// THE load-bearing test that would have caught the Round-12 role-play gap:
// when panel.json declares dispatch_mode="dispatch", EVERY position must carry
// a real, UNIQUE dispatched_agent_id (the agentId returned by a real per-seat
// Agent() dispatch). A panel that claims dispatch mode but records zero/partial/
// duplicate real dispatches = role-play masquerading as dispatch → BLOCK (exit 2).
// dispatch_mode="roleplay" is the sanctioned opt-in fast mode (no ids required).
// Absent dispatch_mode = legacy/additive → unenforced.
//
// Origin: docs/prism/plans/2026-06-02-independent-agent-panel-design.md §4.3 + §6.
//
// Run: node tests/v3/state/test-prism-panel-dispatch-guard.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const hookPath = join(repoRoot, 'hooks', 'prism-panel-guard.mjs');

let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// Run the guard against a panel.json built from `panelObj`. Returns {status, stderr, stdout}.
function runGuard(panelObj, label) {
  const sandbox = mkdtempSync(join(tmpdir(), `prism-pdg-${label}-`));
  try {
    const taskDir = join(sandbox, '.prism-task-test');
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(join(sandbox, '.claude', 'skills', 'prism-plan', 'references'), { recursive: true });
    const panelPath = join(taskDir, 'panel.json');
    writeFileSync(panelPath, JSON.stringify(panelObj));
    const payload = { tool_name: 'Write', tool_input: { file_path: panelPath }, session_id: 'pdg-test' };
    const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox };
    const r = spawnSync('node', [hookPath], { input: JSON.stringify(payload), env, encoding: 'utf-8', timeout: 30_000 });
    return { status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Build a position. Pass agentId=undefined to omit dispatched_agent_id.
const pos = (title, agentId) => ({
  title, expert_name: title, specialist: '@' + title.toLowerCase(),
  ...(agentId !== undefined ? { dispatched_agent_id: agentId } : {}),
  challenges: [{ id: 'ch-1', text: 'this fails when X at file.mjs:10', response: 'ACCEPT', verdict: 'SURVIVES' }],
});

// 1 — LOAD-BEARING: dispatch mode, positions present, NO dispatched_agent_id → BLOCK.
{
  const r = runGuard({ task_id: 't', dispatch_mode: 'dispatch', positions: [pos('Architect'), pos('Security')] }, 'noid');
  check('dispatch mode with zero dispatched_agent_id is BLOCKED (exit 2)', r.status === 2);
  check('block message mentions dispatched_agent_id', /dispatched_agent_id/.test(r.stderr));
}

// 2 — valid dispatch: every position has a real, unique id → ALLOW.
{
  const r = runGuard({ task_id: 't', dispatch_mode: 'dispatch', positions: [pos('Architect', 'a1b2c3'), pos('Security', 'd4e5f6')] }, 'valid');
  check('dispatch mode with a unique id per seat is ALLOWED (exit 0)', r.status === 0);
}

// 3 — roleplay (opt-in fast mode): no ids required → ALLOW.
{
  const r = runGuard({ task_id: 't', dispatch_mode: 'roleplay', positions: [pos('Architect'), pos('Security')] }, 'rp');
  check('roleplay fast-mode is ALLOWED without dispatched ids (exit 0)', r.status === 0);
}

// 4 — anti-cheat: duplicate ids across seats → BLOCK.
{
  const r = runGuard({ task_id: 't', dispatch_mode: 'dispatch', positions: [pos('Architect', 'same'), pos('Security', 'same')] }, 'dup');
  check('dispatch mode with duplicate dispatched_agent_id is BLOCKED (exit 2)', r.status === 2);
}

// 5 — backwards-compat: no dispatch_mode field → unenforced ALLOW.
{
  const r = runGuard({ task_id: 't', positions: [pos('Architect'), pos('Security')] }, 'legacy');
  check('legacy panel without dispatch_mode is ALLOWED (exit 0, additive)', r.status === 0);
}

// 6 — invalid dispatch_mode value → BLOCK.
{
  const r = runGuard({ task_id: 't', dispatch_mode: 'pretend', positions: [pos('Architect', 'a1')] }, 'badmode');
  check('invalid dispatch_mode value is BLOCKED (exit 2)', r.status === 2);
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
