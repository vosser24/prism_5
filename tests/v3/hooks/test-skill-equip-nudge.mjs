#!/usr/bin/env node
// Tests for hooks/prism-skill-equip-nudge.mjs (D1 / F9).
// Drives the DISPATCHER (not the guard directly) via spawnSync with isolated
// temp HOME + a seeded roster. Mirrors test-pretooluse-dispatcher.mjs style.
//
// Run: node tests/v3/hooks/test-skill-equip-nudge.mjs

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

// Roster with one skill. Post-F9 (precise, ranked matcher) the nudge fires on
// a SPECIFIC term (multi-word / hyphenated domain term or the skill's own
// last-segment), NOT on ultra-generic single words like "implement"/"feature".
const ROSTER_WITH_SKILL = {
  version: '3.1.0',
  agents: {},
  skills: {
    'superpowers:test-driven-development': {
      description: 'TDD discipline — write the failing test first',
      domains: ['tdd', 'testing'],
      keywords: ['implement', 'feature', 'bugfix', 'tdd', 'red-green-refactor'],
    },
  },
  tools: {},
  mcps: {},
};

function runDispatcher(payload, rosterContent = null) {
  const home = mkdtempSync(join(tmpdir(), 'prism-nudge-'));
  // Create sentinel so parent-dispatch-guard allows the Agent dispatch
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sentinel = {tier: 'haiku', rationale: 't', source: 't', dispatched: false};
  writeFileSync(
    join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`),
    JSON.stringify(sentinel)
  );
  // Seed the roster if provided
  if (rosterContent) {
    const rosterDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
    mkdirSync(rosterDir, {recursive: true});
    writeFileSync(join(rosterDir, 'roster.json'), JSON.stringify(rosterContent));
  }
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home},
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    const hso = parsed && parsed.hookSpecificOutput;
    return {
      exit: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
      parsed,
      hso,
      additionalContext: hso && hso.additionalContext,
      permissionDecision: hso && hso.permissionDecision,
    };
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

// Case 1: SPECIFIC term match + skill absent from prompt → nudge fires.
// (Post-F9: a generic "implement the feature" prompt no longer fires — that is
// exercised by tests/v3/skill-equip-nudge-precision.test.mjs.)
await test('specific-term match + skill absent → nudge fires (additionalContext, exit 0, no deny)', () => {
  const payload = {
    tool_name: 'Agent',
    session_id: 'nudge-test',
    tool_input: {
      subagent_type: 'general-purpose',
      prompt: 'Follow red-green-refactor: write the failing test first, add a balance endpoint',
    },
  };
  const r = runDispatcher(payload, ROSTER_WITH_SKILL);
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.permissionDecision !== 'deny', `should not be deny, got ${r.permissionDecision}`);
  assert(r.additionalContext, `additionalContext should be present, stdout=${r.stdout}`);
  assert(
    /relevant skill|skill-equip/i.test(r.additionalContext),
    `additionalContext should mention "relevant skill" or "skill-equip", got: ${r.additionalContext}`
  );
  assert(
    r.additionalContext.includes('superpowers:test-driven-development'),
    `additionalContext should include skill name, got: ${r.additionalContext}`
  );
});

// Case 2: keyword match + skill present in prompt → silent (no nudge)
await test('match + skill present in prompt → silent (no nudge marker)', () => {
  const payload = {
    tool_name: 'Agent',
    session_id: 'nudge-test',
    tool_input: {
      subagent_type: 'general-purpose',
      prompt: 'Implement the feature; follow superpowers:test-driven-development: write the failing test first',
    },
  };
  const r = runDispatcher(payload, ROSTER_WITH_SKILL);
  assert(r.exit === 0, `exit ${r.exit}`);
  // The nudge-specific marker should NOT appear (model-guard advisory may still appear)
  assert(
    !r.additionalContext || !/skill-equip advisory/i.test(r.additionalContext),
    `skill-equip advisory should be absent when skill is already in prompt. Got: ${r.additionalContext}`
  );
});

// Case 3: no keyword match → silent
await test('no keyword match → silent (no nudge)', () => {
  const payload = {
    tool_name: 'Agent',
    session_id: 'nudge-test',
    tool_input: {
      subagent_type: 'general-purpose',
      prompt: 'Summarize the meeting notes and prepare an agenda',
    },
  };
  const r = runDispatcher(payload, ROSTER_WITH_SKILL);
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(
    !r.additionalContext || !/skill-equip advisory/i.test(r.additionalContext),
    `skill-equip advisory should be absent for unmatched prompt. Got: ${r.additionalContext}`
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
