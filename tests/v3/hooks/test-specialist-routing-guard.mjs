#!/usr/bin/env node
// Tests for hooks/prism-specialist-routing-guard.mjs (v5.12.0).
// Drives the guard via the DISPATCHER (subprocess, isolated temp HOME + seeded
// roster + sentinel), mirroring test-skill-equip-nudge.mjs style. Covers the 7
// cases from the proposal §5.7 plus red-team additions (force_gp, archived
// specialist, subagent bypass, enforce-block vs advisory-nudge).
//
// Run: node tests/v3/hooks/test-specialist-routing-guard.mjs

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

// Roster with a frontend specialist (core_domains only — NO domain_keywords, to
// prove the guard uses the canonical field) plus a read-only analyst.
const ROSTER = {
  version: '3.1.0',
  agents: {
    'dedecomp-frontend-design-engineer': {
      core_domains: ['frontend', 'ui', 'design system', 'component', 'tailwind'],
      status: 'available',
      build_class: true,
      archived: false,
    },
    'backend-readonly-analyst': {
      core_domains: ['django', 'backend', 'api'],
      status: 'available',
      build_class: false, // read/analysis only — must NOT be recommended for builds
      archived: false,
    },
  },
  skills: {}, tools: {}, mcps: {},
};

const ROSTER_ARCHIVED = {
  version: '3.1.0',
  agents: {
    'dedecomp-frontend-design-engineer': {
      core_domains: ['frontend', 'ui', 'design system', 'component'],
      status: 'available',
      archived: true, // archived → must be skipped
    },
  },
  skills: {}, tools: {}, mcps: {},
};

function runDispatcher(payload, {roster = null, env = {}, sentinel = null} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-srg-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  // Sentinel: default opus (so parent-dispatch-guard never denies the Agent call
  // for unrelated reasons) unless caller overrides.
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
      // Default the model guard / parallel guard to non-interfering modes is not
      // needed — they only ADD advisory text; we assert on SPECIALIST-ROUTING
      // markers + the merged permissionDecision.
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

const FE_BUILD = 'build the map-tree confirmation UI component with the design system';
const BE_RECON = 'map the W2 backend endpoints and document the API surface';

// §5.7 case 1 — generic + frontend build + specialist exists → ENFORCE block.
await test('1. enforce: gp + frontend build + specialist exists → deny (exit 2)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's1', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 2, `exit ${r.exit}`);
  assert(r.decision === 'deny', `decision ${r.decision}`);
  assert(/SPECIALIST-ROUTING/.test(r.reason || ''), `reason should name the guard, got: ${r.reason}`);
  assert(/dedecomp-frontend-design-engineer/.test(r.reason || ''), `reason should name the specialist, got: ${r.reason}`);
});

// §5.7 case 2 — generic + recon (read) → silent.
await test('2. recon (read-class) to gp → silent (exit 0, no specialist marker)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's2', tool_input: {subagent_type: 'general-purpose', model: 'haiku', prompt: BE_RECON}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `should not deny recon, got ${r.decision}`);
  assert(!/SPECIALIST-ROUTING/.test(r.additionalContext || ''), `no specialist marker expected, got: ${r.additionalContext}`);
});

// §5.7 case 3 — generic + build + NO matching specialist → nudge-to-hire (exit 0).
await test('3. gp + build + no specialist → nudge to hire (exit 0, no deny)', () => {
  const EMPTY = {version: '3.1.0', agents: {}, skills: {}, tools: {}, mcps: {}};
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's3', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: EMPTY, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `must NOT block when no specialist exists, got ${r.decision}`);
  assert(/agent-factory|hiring|hire/i.test(r.additionalContext || ''), `should nudge to hire, got: ${r.additionalContext}`);
});

// §5.7 case 4 — specialist subagent_type → exempt (silent).
await test('4. specialist subagent_type → exempt (silent)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's4', tool_input: {subagent_type: 'dedecomp-frontend-design-engineer', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/SPECIALIST-ROUTING/.test(r.additionalContext || '') && !/SPECIALIST-ROUTING/.test(r.reason || ''), `exempt → no marker, got: ${r.additionalContext}`);
});

// §5.7 case 5 — malformed JSON → fail-open (handled by dispatcher).
await test('5. malformed stdin → exit 0 (fail-open)', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-srg-'));
  try {
    const rr = spawnSync(process.execPath, [DISPATCHER], {input: 'not json', encoding: 'utf8', windowsHide: true, env: {...process.env, HOME: home, USERPROFILE: home, PRISM_SPECIALIST_GUARD: 'enforce'}});
    assert(rr.status === 0, `exit ${rr.status}`);
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
});

// §5.7 case 6 — !gp-force: (force_gp on sentinel) → override (exit 0).
await test('6. force_gp override → exit 0 even on enforce + specialist', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's6', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}, sentinel: {tier: 'opus', rationale: 't', source: 't', dispatched: false, force_gp: true}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `force_gp must bypass, got ${r.decision}`);
});

// §5.7 case 7 — fork subagent_type → exempt.
await test('7. fork subagent_type → exempt (silent)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 's7', tool_input: {subagent_type: 'fork', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/SPECIALIST-ROUTING/.test(r.additionalContext || '') && !/SPECIALIST-ROUTING/.test(r.reason || ''), `fork exempt, got: ${r.additionalContext}`);
});

// ── Red-team additions ───────────────────────────────────────────────────────

// A — advisory mode: same dispatch as case 1 → nudge, NOT deny.
await test('A. advisory mode: gp + frontend build + specialist → nudge (exit 0, no deny)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'a', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `advisory must not deny, got ${r.decision}`);
  assert(/dedecomp-frontend-design-engineer/.test(r.additionalContext || ''), `advisory should name specialist, got: ${r.additionalContext}`);
});

// B — off mode: no-op even on a confident build match.
await test('B. off mode → no specialist output at all', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'b', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'off'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/SPECIALIST-ROUTING/.test(r.additionalContext || '') && !/SPECIALIST-ROUTING/.test(r.reason || ''), `off → silent, got: ${r.additionalContext}`);
});

// C — archived specialist → treated as no-specialist (nudge-to-hire, not block).
await test('C. archived specialist → not blocked (nudge-to-hire at most)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'c', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER_ARCHIVED, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `archived specialist must not cause a block, got ${r.decision}`);
});

// D — subagent context (parent_tool_use_id) → MY guard bypasses. (The
// parent-dispatch nested-dispatch guard would itself deny an Agent() call from
// subagent context, so disable it here to isolate the specialist-routing guard.)
await test('D. subagent context (parent_tool_use_id) → specialist-routing bypass', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'd', parent_tool_use_id: 'p1', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: FE_BUILD}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce', PRISM_NESTED_DISPATCH_GUARD: 'off'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `subagent ctx must bypass specialist-routing, got ${r.decision}`);
  assert(!/SPECIALIST-ROUTING/.test(r.reason || ''), `no specialist-routing deny expected, got: ${r.reason}`);
});

// E — build_class:false specialist must NOT be recommended for a build.
await test('E. build_class:false specialist → not recommended for build (no deny)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'e', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'implement the django serializer and add a backend api endpoint'}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'enforce'}}
  );
  // backend-readonly-analyst is build_class:false → skipped. May nudge-to-hire
  // (known backend domain, no build-capable specialist) but must NOT deny.
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.decision !== 'deny', `build_class:false must not trigger a block, got ${r.decision}`);
});

// ── D055/D056 ambient-token + weak-match regression (2026-07-21) ────────────
// agentTerms() mints match-terms by splitting the SPECIALIST NAME on '-'/':'.
// Ambient repo tokens like "claude" and "prism" are common in nearly every
// task description in THIS repo, so 'claude-master' / 'prism-updater' false-
// match on those bare tokens alone (score=1) — nothing to do with their real
// domain. Mirrors the real roster.json shapes for these two agents.
const AMBIENT_ROSTER = {
  version: '3.1.0',
  agents: {
    'claude-master': {
      core_domains: ['uncategorized'], // real placeholder value, never matches real text
      status: 'available',
      archived: false,
    },
    'prism-updater': {
      core_domains: ['prism-infrastructure', 'self-update'], // real value, compound slugs
      status: 'available',
      archived: false,
    },
    'html-email-esp-engineer': {
      core_domains: ['bulletproof-responsive-html-email', 'mso-conditional-comments-ghost-tables'],
      status: 'available',
      build_class: true,
      archived: false,
    },
  },
  skills: {}, tools: {}, mcps: {},
};

// F — name-collision false-positive: "claude" ambient token must not surface
// claude-master as a routing suggestion for an unrelated hook-refactor task.
await test('F. ambient "claude" token → must NOT nudge toward claude-master', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'f', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'refactor the claude code hook'}},
    {roster: AMBIENT_ROSTER, env: {PRISM_SPECIALIST_GUARD: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/claude-master/.test(r.additionalContext || ''), `must not suggest claude-master on ambient token alone, got: ${r.additionalContext}`);
});

// G — name-collision false-positive: "prism" ambient token must not surface
// prism-updater as a routing suggestion for an unrelated classifier task.
await test('G. ambient "prism" token → must NOT nudge toward prism-updater', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'g', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'refactor the prism classifier scoring'}},
    {roster: AMBIENT_ROSTER, env: {PRISM_SPECIALIST_GUARD: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/prism-updater/.test(r.additionalContext || ''), `must not suggest prism-updater on ambient token alone, got: ${r.additionalContext}`);
});

// H — weak single-token match (score=1, post-stoplist) must not nudge: the
// raised threshold (nudge requires score>=2) suppresses noise even for a
// genuine (non-ambient) but single-term match.
await test('H. genuine but weak (score=1) single-term match → no nudge', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'h', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'build the tailwind utility classes for the page'}},
    {roster: ROSTER, env: {PRISM_SPECIALIST_GUARD: 'advisory'}}
  );
  // Only 'tailwind' (a single core_domains term) is present — 'frontend',
  // 'ui', 'design system', 'component' are all absent from this text.
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/SPECIALIST-ROUTING/.test(r.additionalContext || ''), `score=1 match must not nudge post-fix, got: ${r.additionalContext}`);
});

// I — recall preserved: a genuine multi-term domain match (score>=2) still
// nudges toward the real specialist even after the stoplist + threshold fix.
await test('I. genuine strong match (score>=2) → still nudges (recall preserved)', () => {
  const r = runDispatcher(
    {tool_name: 'Agent', session_id: 'i', tool_input: {subagent_type: 'general-purpose', model: 'sonnet', prompt: 'build a bulletproof responsive HTML email template'}},
    {roster: AMBIENT_ROSTER, env: {PRISM_SPECIALIST_GUARD: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(/html-email-esp-engineer/.test(r.additionalContext || ''), `strong match should still nudge, got: ${r.additionalContext}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
