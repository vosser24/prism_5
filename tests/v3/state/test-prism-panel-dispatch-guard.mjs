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
// opts.roster — optional roster object written to the sandbox roster.json (so the
//   factory-first guard can resolve position.specialist against roster.agents).
// opts.env — optional extra env vars (e.g. {PRISM_PANEL_GUARD: 'hard'}).
function runGuard(panelObj, label, opts = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), `prism-pdg-${label}-`));
  try {
    const taskDir = join(sandbox, '.prism-task-test');
    mkdirSync(taskDir, { recursive: true });
    const refsDir = join(sandbox, '.claude', 'skills', 'prism-plan', 'references');
    mkdirSync(refsDir, { recursive: true });
    if (opts.roster) writeFileSync(join(refsDir, 'roster.json'), JSON.stringify(opts.roster));
    const panelPath = join(taskDir, 'panel.json');
    writeFileSync(panelPath, JSON.stringify(panelObj));
    const payload = { tool_name: 'Write', tool_input: { file_path: panelPath }, session_id: 'pdg-test' };
    const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, ...(opts.env || {}) };
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

// ─── FACTORY-FIRST seat-sourcing guard (v5.x — adjacency-is-not-fitness) ──────
// A dispatched panel's VERTICAL/domain-expertise seats (tagged vertical:true)
// must resolve to a durable rostered specialist (created via @agent-factory),
// not a generic general-purpose subagent role-scoped as a persona. Enforced
// only on vertical:true seats → fully additive (legacy panels untouched).

// A vertical seat whose specialist names a real rostered agent.
const vpos = (title, extra = {}) => ({
  title, expert_name: title, vertical: true,
  specialist: extra.specialist ?? ('@' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  dispatched_agent_id: extra.id ?? ('id-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '')),
  ...(extra.agent_type ? { agent_type: extra.agent_type } : {}),
  ...(extra.seat_source ? { seat_source: extra.seat_source } : {}),
  challenges: [{ id: 'c1', text: 'fails when X at file.mjs:10', verdict: 'SURVIVES' }],
});

const ROSTER_WITH = (key) => ({ agents: { [key]: { core_domains: ['x'] } }, skills: {}, tools: {} });

// 7 — vertical seat whose specialist resolves to a rostered agent → ALLOW.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch',
    positions: [vpos('Greek ecommerce conversion', { specialist: '@greek-ecommerce-conversion-specialist' })] };
  const r = runGuard(panel, 'ff-rostered', { roster: ROSTER_WITH('greek-ecommerce-conversion-specialist'), env: { PRISM_PANEL_GUARD: 'hard' } });
  check('vertical seat backed by a rostered specialist is ALLOWED (exit 0)', r.status === 0);
}

// 8 — vertical seat, specialist NOT in roster, HARD mode → BLOCK (exit 2) + factory advice.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch',
    positions: [vpos('UX/UI pro', { specialist: '@ux-ui-pro' })] };
  const r = runGuard(panel, 'ff-unrostered-hard', { roster: { agents: {}, skills: {}, tools: {} }, env: { PRISM_PANEL_GUARD: 'hard' } });
  check('vertical seat with no rostered specialist is BLOCKED in hard mode (exit 2)', r.status === 2);
  check('block message names agent-factory as the fix', /agent-factory/.test(r.stderr));
  check('block message names the offending seat', /UX\/UI pro/.test(r.stderr));
}

// 9 — vertical seat explicitly filled by a general-purpose subagent → BLOCK even if specialist looks rostered.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch',
    positions: [vpos('Conversion expert', { specialist: '@conversion-specialist', agent_type: 'general-purpose' })] };
  const r = runGuard(panel, 'ff-generic-hard', { roster: ROSTER_WITH('conversion-specialist'), env: { PRISM_PANEL_GUARD: 'hard' } });
  check('vertical seat filled by a general-purpose subagent is BLOCKED (exit 2)', r.status === 2);
  check('generic-fill block message mentions general-purpose', /general-purpose/.test(r.stderr));
}

// 10 — vertical seat with seat_source:"factory-created" → ALLOW even with empty roster.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch',
    positions: [vpos('Demand forecasting', { specialist: '@demand-forecasting-specialist', seat_source: 'factory-created' })] };
  const r = runGuard(panel, 'ff-factorycreated', { roster: { agents: {}, skills: {}, tools: {} }, env: { PRISM_PANEL_GUARD: 'hard' } });
  check('vertical seat tagged seat_source=factory-created is ALLOWED (exit 0)', r.status === 0);
}

// 11 — vertical seat not rostered, SOFT (default) → ALLOW (exit 0) but advisory on stderr.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch',
    positions: [vpos('UX/UI pro', { specialist: '@ux-ui-pro' })] };
  const r = runGuard(panel, 'ff-unrostered-soft', { roster: { agents: {}, skills: {}, tools: {} } });
  check('vertical seat with no rostered specialist is ALLOWED in soft mode (exit 0)', r.status === 0);
  check('soft mode still emits a factory-first advisory', /FACTORY-FIRST|agent-factory/.test(r.stderr));
}

// 12 — archetype seats WITHOUT a vertical flag (legacy) → unenforced ALLOW even in hard mode.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch', positions: [pos('Architect', 'a1'), pos('Skeptic', 'b2')] };
  const r = runGuard(panel, 'ff-legacy-archetype', { roster: { agents: {}, skills: {}, tools: {} }, env: { PRISM_PANEL_GUARD: 'hard' } });
  check('untagged archetype seats are NOT factory-first-enforced (exit 0, additive)', r.status === 0);
}

// 13 — kill switch disables enforcement.
{
  const panel = { task_id: 't', dispatch_mode: 'dispatch', positions: [vpos('UX/UI pro', { specialist: '@ux-ui-pro' })] };
  const r = runGuard(panel, 'ff-killswitch', { roster: { agents: {}, skills: {}, tools: {} }, env: { PRISM_PANEL_GUARD: 'hard', PRISM_DISABLE_FACTORY_FIRST: '1' } });
  check('PRISM_DISABLE_FACTORY_FIRST=1 disables the guard (exit 0)', r.status === 0);
}

// 14 — roleplay fast mode is the sanctioned escape: vertical seats unenforced.
{
  const panel = { task_id: 't', dispatch_mode: 'roleplay', positions: [vpos('UX/UI pro', { specialist: '@ux-ui-pro' })] };
  const r = runGuard(panel, 'ff-roleplay', { roster: { agents: {}, skills: {}, tools: {} }, env: { PRISM_PANEL_GUARD: 'hard' } });
  check('roleplay fast-mode is exempt from factory-first (exit 0)', r.status === 0);
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
