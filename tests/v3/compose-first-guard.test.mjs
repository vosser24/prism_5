#!/usr/bin/env node
// Tests for the COMPOSE-FIRST guard (Package G enforcement) added to
// hooks/prism-specialist-routing-guard.mjs.
//
// Fires ONLY on an agent-factory dispatch (the create-a-new-capability
// boundary). Advisory default (nudge, always allow); enforce mode denies
// unless '!build-new-force:' override present; off = no-op. Neutral for every
// non-agent-factory dispatch.
//
// Driven through the DISPATCHER subprocess (isolated temp HOME + seeded roster
// + sentinel) — mirrors tests/v3/hooks/test-specialist-routing-guard.mjs.
//
// Run: node tests/v3/compose-first-guard.test.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// Roster with a frontend build specialist — used by the regression case to
// prove the pre-existing specialist-routing behavior is untouched.
const ROSTER = {
  version: '3.1.0',
  agents: {
    'dedecomp-frontend-design-engineer': {
      core_domains: ['frontend', 'ui', 'design system', 'component', 'tailwind'],
      status: 'available',
      build_class: true,
      archived: false,
    },
  },
  skills: {}, tools: {}, mcps: {},
};

function runDispatcher(payload, {roster = null, env = {}, sentinel = null} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-cfg-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sent = sentinel || {tier: 'opus', rationale: 't', source: 't', dispatched: false};
  writeFileSync(
    join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`),
    JSON.stringify(sent)
  );
  if (roster) {
    const dir = join(home, '.claude', 'skills', 'prism-plan', 'references');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'roster.json'), JSON.stringify(roster));
  }
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload),
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...env},
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    const hso = parsed && parsed.hookSpecificOutput;
    return {
      exit: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
      decision: hso && hso.permissionDecision,
      additionalContext: hso && hso.additionalContext,
      reason: hso && hso.permissionDecisionReason,
    };
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

const FACTORY = (extra = {}) => ({
  tool_name: 'Agent',
  session_id: extra.session_id || 'c1',
  tool_input: {
    subagent_type: 'agent-factory',
    model: 'opus',
    description: extra.description || 'create a new expert agent',
    prompt: extra.prompt || 'Author a brand-new specialist for widget frobnication.',
  },
});

// Case 1 — advisory (default) + agent-factory → ALLOW + compose nudge present.
await test('1. advisory default + agent-factory → allow + COMPOSE-FIRST nudge', () => {
  const r = runDispatcher(FACTORY({session_id: 'c1'}), {roster: ROSTER}); // no env → default advisory
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `must not deny in advisory, got ${r.decision}`);
  assert(/COMPOSE-FIRST/.test(r.additionalContext || ''), `expected compose nudge, got: ${r.additionalContext}`);
  assert(/CAPABILITY CATALOG/.test(r.additionalContext || ''), `nudge should cite the catalog, got: ${r.additionalContext}`);
});

// Case 2 — advisory + a NORMAL (non-agent-factory) dispatch → no compose nudge.
await test('2. advisory + non-agent-factory dispatch → no COMPOSE-FIRST behavior', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'c2', tool_input: {subagent_type: 'general-purpose', model: 'haiku', prompt: 'read-only: map the repo layout and list files'}},
    {roster: ROSTER}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `should not deny, got ${r.decision}`);
  assert(!/COMPOSE-FIRST/.test(r.additionalContext || ''), `no compose nudge expected, got: ${r.additionalContext}`);
});

// Case 3 — enforce + agent-factory WITHOUT override → DENY (exit 2).
await test('3. enforce + agent-factory (no override) → deny (exit 2)', () => {
  const r = runDispatcher(FACTORY({session_id: 'c3'}), {roster: ROSTER, env: {PRISM_COMPOSE_GUARD: 'enforce'}});
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
  assert(/COMPOSE-FIRST/.test(r.reason || ''), `deny reason should name the guard, got: ${r.reason}`);
  assert(/build-new-force/.test(r.reason || ''), `deny reason should mention the override token, got: ${r.reason}`);
});

// Case 4 — enforce + agent-factory WITH override token → ALLOW.
await test('4. enforce + agent-factory + !build-new-force: override → allow', () => {
  const r = runDispatcher(
    FACTORY({session_id: 'c4', prompt: '!build-new-force: verified nothing exists — author the new specialist.'}),
    {roster: ROSTER, env: {PRISM_COMPOSE_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `override must allow, got ${r.decision}`);
  assert(/COMPOSE-FIRST/.test(r.additionalContext || ''), `should still nudge, got: ${r.additionalContext}`);
});

// Case 5 — off → no compose behavior at all (agent-factory passes untouched).
await test('5. PRISM_COMPOSE_GUARD=off + agent-factory → no compose behavior', () => {
  const r = runDispatcher(FACTORY({session_id: 'c5'}), {roster: ROSTER, env: {PRISM_COMPOSE_GUARD: 'off'}});
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `off must not deny, got ${r.decision}`);
  assert(!/COMPOSE-FIRST/.test(r.additionalContext || ''), `off must emit no compose nudge, got: ${r.additionalContext}`);
});

// Case 6 — REGRESSION: pre-existing specialist-routing behavior preserved.
// gp + frontend BUILD + specialist exists + PRISM_SPECIALIST_GUARD=enforce → deny.
// (compose guard stays at its advisory default and must NOT interfere.)
await test('6. regression: gp + build + specialist + specialist-guard enforce → deny', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'c6', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'build the map-tree confirmation UI component with the design system'}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
  assert(/SPECIALIST-ROUTING/.test(r.reason || ''), `reason should name the specialist guard, got: ${r.reason}`);
  assert(/dedecomp-frontend-design-engineer/.test(r.reason || ''), `reason should name the specialist, got: ${r.reason}`);
  assert(!/COMPOSE-FIRST/.test(r.reason || ''), `compose guard must not fire for a non-agent-factory dispatch, got: ${r.reason}`);
});

console.log(`\ncompose-first-guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
