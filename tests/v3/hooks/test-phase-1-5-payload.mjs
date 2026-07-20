#!/usr/bin/env node
// R2 F2 — SubagentStop payload plumbing regression test.
//
// Ground truth (measured 2026-07-20, Claude Code 2.1.214): the real
// SubagentStop payload carries `agent_type` + `last_assistant_message`
// (+ `transcript_path`/`agent_transcript_path`) — there is NO `output`,
// `tool_response`, or `transcript` field. Before this fix, the hook's output
// resolver at hooks/prism-phase-1-5-oob.mjs only checked those three
// nonexistent fields, so `output` was always '' and the `no-output` bail
// fired before the roster-tag check was ever reached (UAT #16).
//
// This test mirrors tests/v3/state/test-prism-phase-1-5-oob.mjs's sandbox
// harness (temp HOME, fixture roster.json, PRISM_OOB_TEST_MOCK_SDK=1) and
// asserts the FIRE / QUIET / REGRESSION cases for the new output chain.
import {writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';

const REPO = process.cwd();
const HOOK = join(REPO, 'hooks', 'prism-phase-1-5-oob.mjs');

let pass = 0;
let total = 0;

// Set up sandbox HOME
const sandboxHome = mkdtempSync(join(tmpdir(), 'prism-oob-payload-test-'));
const sandboxClaude = join(sandboxHome, '.claude');

process.on('exit', () => {
  try { rmSync(sandboxHome, {recursive: true, force: true}); } catch {}
});
mkdirSync(sandboxClaude, {recursive: true});

// Fixture roster.json: 'code-reviewer' tagged requires_phase_1_5:true,
// 'demand-forecasting' explicitly untagged — mirrors the existing OOB test's
// fixture exactly.
mkdirSync(join(sandboxClaude, 'skills', 'prism-plan', 'references'), {recursive: true});
writeFileSync(join(sandboxClaude, 'skills', 'prism-plan', 'references', 'roster.json'), JSON.stringify({
  schema_version: '4.4.0',
  agents: {
    'code-reviewer': {requires_phase_1_5: true, requires_phase_1_5_block: false},
    'demand-forecasting': {requires_phase_1_5: false},
  },
}));

function runHook(input, env = {}) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      PRISM_OOB_TEST_MOCK_SDK: '1',
      ...env,
    },
    timeout: 10000,
  });
  return {status: res.status, stdout: res.stdout, stderr: res.stderr};
}

function verdictFileCount() {
  return readdirSync(sandboxClaude).filter(f => f.startsWith('.prism-phase-1-5-verdicts-')).length;
}

function routingLogHas(predicate) {
  const routingLog = join(sandboxClaude, '.prism-routing.jsonl');
  if (!existsSync(routingLog)) return false;
  return readFileSync(routingLog, 'utf-8').split('\n').filter(Boolean)
    .some(l => { try { return predicate(JSON.parse(l)); } catch { return false; } });
}

// --- Test 1 (FIRE): measured-shape payload — agent_type + last_assistant_message,
// tagged agent — must get PAST the no-output bail and produce a mock verdict.
total++;
{
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'code-reviewer',
    session_id: 'test-fire-1',
    last_assistant_message: 'The reviewed change is fast and secure. All tests pass on the new endpoint.',
  });
  const after = verdictFileCount();
  const loggedPendingOrVerdict = routingLogHas(o => o.action === 'pending-written' || o.action === 'verdict-mock');
  if (r.status === 0 && after > before && loggedPendingOrVerdict) {
    pass++;
  } else {
    console.log(`FAIL FIRE: status=${r.status} verdictFilesBefore=${before} after=${after} loggedPendingOrVerdict=${loggedPendingOrVerdict} stderr=${r.stderr}`);
  }
}

// --- Test 2 (QUIET): same shape, UNtagged agent_type — must bail
// agent-not-tagged, no pending/verdict file written.
total++;
{
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'demand-forecasting',
    session_id: 'test-quiet-1',
    last_assistant_message: 'Demand forecast for Q3 shows a 12% increase over Q2 baseline.',
  });
  const after = verdictFileCount();
  const loggedNotTagged = routingLogHas(o => o.action === 'agent-not-tagged' && o.agent === 'demand-forecasting');
  if (r.status === 0 && after === before && loggedNotTagged) {
    pass++;
  } else {
    console.log(`FAIL QUIET: status=${r.status} verdictFilesBefore=${before} after=${after} loggedNotTagged=${loggedNotTagged} stderr=${r.stderr}`);
  }
}

// --- Test 3 (REGRESSION): OLD input.output field still resolves output
// (proves fallback priority order is preserved — output > tool_response >
// transcript > last_assistant_message > transcript-tail).
total++;
{
  const before = verdictFileCount();
  const r = runHook({
    agent_name: 'code-reviewer',
    session_id: 'test-regression-1',
    output: 'This is a long-form legacy output field. The code is fast and secure. Tests pass across all inputs.',
    task_brief: 'legacy shape regression check',
  });
  const after = verdictFileCount();
  const loggedPendingOrVerdict = routingLogHas(o => o.action === 'pending-written' || o.action === 'verdict-mock');
  if (r.status === 0 && after > before && loggedPendingOrVerdict) {
    pass++;
  } else {
    console.log(`FAIL REGRESSION: status=${r.status} verdictFilesBefore=${before} after=${after} loggedPendingOrVerdict=${loggedPendingOrVerdict} stderr=${r.stderr}`);
  }
}

// --- Test 4 (bonus/no-output true-empty case): a payload with no output
// field of any kind and no readable transcript file still bails no-output
// (proves we did not accidentally widen the bail past emptiness).
total++;
{
  const r = runHook({
    agent_type: 'code-reviewer',
    session_id: 'test-empty-1',
    transcript_path: join(sandboxHome, 'does-not-exist-transcript.jsonl'),
  });
  const loggedNoOutput = routingLogHas(o => o.action === 'no-output');
  if (r.status === 0 && loggedNoOutput) {
    pass++;
  } else {
    console.log(`FAIL EMPTY: status=${r.status} loggedNoOutput=${loggedNoOutput} stderr=${r.stderr}`);
  }
}

// === D051 Part B — gated panel-seat arming path ===
// Panel seats are ad-hoc general-purpose dispatches, never roster-tagged
// requires_phase_1_5. PRISM_PANEL_SEAT_OOB=1 + a sentinel with
// summon_panel:true is a GATED-OFF alternative arming path for exactly this
// case. Default (flag unset) must remain byte-identical to today.

function writeSentinel(sessionId, payload) {
  writeFileSync(join(sandboxClaude, `.prism-turn-tier-${sessionId}.json`), JSON.stringify(payload));
}

// --- Test 5 (FIRE): PRISM_PANEL_SEAT_OOB=1 + summon_panel:true sentinel +
// UNtagged agent + valid output → hook ARMS (reaches pending-written) and
// the routing line carries arm_reason:'panel-seat'.
total++;
{
  const sessionId = 'test-panel-fire-1';
  writeSentinel(sessionId, {tier: 'opus', summon_panel: true});
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'demand-forecasting', // explicitly untagged in fixture roster
    session_id: sessionId,
    last_assistant_message: 'The panel seat output is fast and secure. All positions were reviewed.',
  }, {PRISM_PANEL_SEAT_OOB: '1'});
  const after = verdictFileCount();
  const loggedPanelSeatArm = routingLogHas(o => o.action === 'pending-written' && o.session_id === sessionId && o.arm_reason === 'panel-seat');
  if (r.status === 0 && after > before && loggedPanelSeatArm) {
    pass++;
  } else {
    console.log(`FAIL PANEL-FIRE: status=${r.status} verdictFilesBefore=${before} after=${after} loggedPanelSeatArm=${loggedPanelSeatArm} stderr=${r.stderr}`);
  }
}

// --- Test 6 (QUIET-1): flag UNSET + untagged seat → agent-not-tagged, no
// arm at all (proves default-off is byte-identical to pre-D051-B behavior).
total++;
{
  const sessionId = 'test-panel-quiet-1';
  writeSentinel(sessionId, {tier: 'opus', summon_panel: true});
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'demand-forecasting',
    session_id: sessionId,
    last_assistant_message: 'The panel seat output is fast and secure. All positions were reviewed.',
  }); // no PRISM_PANEL_SEAT_OOB env override
  const after = verdictFileCount();
  const loggedNotTagged = routingLogHas(o => o.action === 'agent-not-tagged' && o.agent === 'demand-forecasting' && !('arm_reason' in o));
  if (r.status === 0 && after === before && loggedNotTagged) {
    pass++;
  } else {
    console.log(`FAIL PANEL-QUIET-1: status=${r.status} verdictFilesBefore=${before} after=${after} loggedNotTagged=${loggedNotTagged} stderr=${r.stderr}`);
  }
}

// --- Test 7 (QUIET-2): flag SET but no sentinel (no summon_panel:true) →
// agent-not-tagged, no arm (proves the panel-session gate, not just the env flag).
total++;
{
  const sessionId = 'test-panel-quiet-2'; // deliberately: no sentinel file written for this session
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'demand-forecasting',
    session_id: sessionId,
    last_assistant_message: 'The panel seat output is fast and secure. All positions were reviewed.',
  }, {PRISM_PANEL_SEAT_OOB: '1'});
  const after = verdictFileCount();
  const loggedNotTagged = routingLogHas(o => o.action === 'agent-not-tagged' && o.agent === 'demand-forecasting');
  if (r.status === 0 && after === before && loggedNotTagged) {
    pass++;
  } else {
    console.log(`FAIL PANEL-QUIET-2: status=${r.status} verdictFilesBefore=${before} after=${after} loggedNotTagged=${loggedNotTagged} stderr=${r.stderr}`);
  }
}

// --- Test 8 (REGRESSION): a TAGGED agent still arms, now carrying
// arm_reason:'tagged' alongside the pre-existing fields.
total++;
{
  const sessionId = 'test-panel-regression-1';
  const before = verdictFileCount();
  const r = runHook({
    agent_type: 'code-reviewer', // tagged requires_phase_1_5:true in fixture roster
    session_id: sessionId,
    last_assistant_message: 'The reviewed change is fast and secure. All tests pass on the new endpoint.',
  }, {PRISM_PANEL_SEAT_OOB: '1'}); // flag on, but agent is tagged — should still take the 'tagged' path
  const after = verdictFileCount();
  const loggedTaggedArm = routingLogHas(o => o.action === 'pending-written' && o.session_id === sessionId && o.arm_reason === 'tagged');
  if (r.status === 0 && after > before && loggedTaggedArm) {
    pass++;
  } else {
    console.log(`FAIL PANEL-REGRESSION: status=${r.status} verdictFilesBefore=${before} after=${after} loggedTaggedArm=${loggedTaggedArm} stderr=${r.stderr}`);
  }
}

console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
