#!/usr/bin/env node
// Tests for prism-pretooluse-dispatcher.mjs (v5.7 consolidation).
// Verifies routing + most-restrictive merge (deny > ask > allow) + fail-open,
// running the dispatcher as a subprocess with an isolated HOME + sentinel.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

function run(payload, {env = {}, sentinel = null} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ptd-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  if (sentinel) writeFileSync(join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`), JSON.stringify(sentinel));
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, windowsHide: true,
      // Pin single-actor determinism: clear the agent-teams marker so these
      // dispatcher assertions (which pin single-actor hard-deny behavior) do not
      // flip when the harness itself runs inside an agent-teams session, where
      // the ambient CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 would trigger the D043
      // advisory-downgrade in prism-parent-dispatch-guard. Teams behavior has its
      // own dedicated test (state/test-prism-dispatch-guard-teams.mjs). Kept
      // before `...env` so a future teams case can still opt in explicitly.
      env: {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '', ...env},
    });
    let decision;
    try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { decision = undefined; }
    return {exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), decision};
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
}

const HAIKU = {tier: 'haiku', rationale: 't', source: 't', dispatched: false};
const OPUS = {tier: 'opus', rationale: 't', source: 't', dispatched: false};

await test('Bash rm -rf / → deny (safety, exit 2)', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: 'rm -rf /'}}, {sentinel: HAIKU});
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
});

await test('Bash ls → allow (parent RO fast-path, exit 0)', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: 'ls -la'}}, {sentinel: HAIKU});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `decision ${r.decision}`);
});

await test('Bash npm build (haiku, undispatched) → deny (parent-dispatch)', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: 'npm run build'}}, {sentinel: HAIKU});
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
});

await test('Bash Set-Content write (hard) → deny (mutation + parent combined)', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: "Set-Content -Path x.json -Value '1'"}}, {sentinel: HAIKU});
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
  assert(/MUTATION-GUARD/.test(r.stdout), 'mutation reason present');
});

await test('Agent no-model (haiku) → allow + model-guard nudge (exit 0)', () => {
  const r = run({tool_name: 'Agent', session_id: 's', tool_input: {subagent_type: 'general-purpose', prompt: 'do x'}}, {sentinel: HAIKU});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `decision ${r.decision}`);
  assert(/MODEL GUARD/.test(r.stdout), 'model-guard nudge present in additionalContext');
});

await test('TaskCreate (sentinel) → parent-dispatch marks dispatched FIRST, task-tier bypasses (settings-order preserved)', () => {
  // Faithful to the shipped settings order: parent-dispatch (entry 6) runs
  // before task-tier-advisor (entry 7) and marks sentinel.dispatched=true on
  // the TaskCreate; task-tier then takes its dispatched-bypass → no hard deny.
  // The dispatcher reproduces this sequential semantic exactly (no behavior change).
  const r = run({tool_name: 'TaskCreate', session_id: 's', tool_input: {subject: 'redesign', description: 'big'}}, {env: {PRISM_TASK_TIER: 'hard'}, sentinel: OPUS});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `decision ${r.decision}`);
});

await test('Bash git push (opus tier) → ask (prepush, parent allows opus)', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: 'git push origin feature'}}, {sentinel: OPUS});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision === 'ask', `decision ${r.decision}`);
});

await test('safety deny independent of dispatch-guard off', () => {
  const r = run({tool_name: 'Bash', session_id: 's', tool_input: {command: 'rm -rf /'}}, {env: {PRISM_DISPATCH_GUARD: 'off'}, sentinel: HAIKU});
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', 'safety still denies');
});

await test('unrouted tool (Read) → exit 0, no output', () => {
  const r = run({tool_name: 'Read', session_id: 's', tool_input: {file_path: 'a.ts'}}, {sentinel: HAIKU});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.stdout === '', `stdout ${r.stdout}`);
});

await test('malformed stdin → exit 0 (fail-open)', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-ptd-'));
  try {
    const rr = spawnSync(process.execPath, [DISPATCHER], {input: 'not json', encoding: 'utf8', windowsHide: true, env: {...process.env, HOME: home, USERPROFILE: home}});
    assert(rr.status === 0, `exit ${rr.status}`);
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
