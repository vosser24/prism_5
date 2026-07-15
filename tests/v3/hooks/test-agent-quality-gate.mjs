#!/usr/bin/env node
// Tests for the Agent Quality Gate (hooks/prism-agent-quality-gate.mjs +
// hooks/lib/prism-agent-quality.mjs). Covers the proposal §10 acceptance
// criteria: a pre-upgrade builder FAILS (skills not wired / tier-3 / missing
// depth refs), an upgraded builder PASSES, a composes_with-only entry FAILS the
// skills-wired check, recon role is low-bar, and the gate fails open.
//
// Pure scorer cases run in-process; the wiring/fail-open case runs the dispatcher
// as a subprocess with an isolated HOME (mirrors the other hook tests).
//
// Run: node tests/v3/hooks/test-agent-quality-gate.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scoreAgent, isSkillWired, splitFrontmatter, parseListField} from '../../../hooks/lib/prism-agent-quality.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', '..', 'hooks', 'prism-posttooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

const MAP = {
  frontend: {
    skills: ['ui-ux-pro-max', 'frontend-design'],
    depth_refs: ['accessibility', 'performance', 'responsive', 'forms'],
    min_research_tier_for_builder: 1,
  },
};

// The pre-upgrade agent: skills only in composes_with / prose, NOT in skills:
// frontmatter; no depth refs; research_tier 3.
const PRE_UPGRADE = `---
name: dedecomp-frontend-design-engineer
description: Frontend specialist for the Dedecomp app
core_domains: [frontend, ui]
composes_with: [ui-ux-pro-max]
---
You build React + Tailwind components with strong codebase fidelity.
You compose with ui-ux-pro-max for design decisions.
`;

// The upgraded agent: skills wired (frontmatter + body invocation), depth refs
// present, research_tier 1.
const UPGRADED = `---
name: dedecomp-frontend-design-engineer
description: Frontend specialist for the Dedecomp app
core_domains: [frontend, ui]
research_tier: 1
skills:
  - ui-ux-pro-max
  - frontend-design
---
## Operating protocol
For any new screen, invoke ui-ux-pro-max to get the pattern + palette + anti-patterns.
For visual reshaping, invoke frontend-design for aesthetic direction.
Always cover accessibility (WCAG 2.2 AA, focus-trap, aria-live), performance
(Core Web Vitals budget), responsive breakpoints, and forms UX.
`;

// 1 — pre-upgrade builder FAILS (would have caught the incident).
await test('1. pre-upgrade frontend builder → FAIL (skills not wired, tier 3, depth refs missing)', () => {
  const card = scoreAgent({name: 'dedecomp-frontend-design-engineer', text: PRE_UPGRADE, roster: {agents: {'dedecomp-frontend-design-engineer': {research_tier: 3}}}, skillDomainMap: MAP});
  assert(card.role === 'builder', `role ${card.role}`);
  assert(card.domain === 'frontend', `domain ${card.domain}`);
  assert(card.pass === false, 'must FAIL');
  assert(card.skills_missing.includes('ui-ux-pro-max'), 'ui-ux-pro-max should be unwired (composes_with only)');
  assert(card.skills_missing.includes('frontend-design'), 'frontend-design should be missing');
  assert(card.research_ok === false, 'tier 3 must fail the builder bar');
  assert(card.depth_refs_missing.length > 0, 'depth refs should be missing');
});

// 2 — upgraded builder PASSES.
await test('2. upgraded frontend builder → PASS (skills wired, tier 1, depth refs present)', () => {
  const card = scoreAgent({name: 'dedecomp-frontend-design-engineer', text: UPGRADED, roster: null, skillDomainMap: MAP});
  assert(card.pass === true, `must PASS, gaps: ${JSON.stringify(card.gaps)}`);
  assert(card.skills_missing.length === 0, `no missing skills, got ${card.skills_missing}`);
  assert(card.research_ok === true, 'tier 1 ok');
  assert(card.depth_refs_missing.length === 0, `no missing depth, got ${card.depth_refs_missing}`);
  assert(card.quality_score === 5, `score ${card.quality_score}`);
});

// 3 — composes_with-only entry FAILS the skills-wired check (no false pass).
await test('3. composes_with-only → isSkillWired false (mention != equip)', () => {
  const {fmText, body} = splitFrontmatter(PRE_UPGRADE);
  const fmSkills = parseListField(fmText, 'skills');
  assert(fmSkills.length === 0, `pre-upgrade has no skills: frontmatter, got ${fmSkills}`);
  assert(isSkillWired('ui-ux-pro-max', fmSkills, body) === false, 'composes_with + prose mention must NOT count as wired');
});

// 3b — skill in frontmatter but NOT referenced in body → also not wired.
await test('3b. skills: frontmatter without body invocation → not wired', () => {
  const text = `---\nname: x\nskills:\n  - frontend-design\n---\nNo invocation here.\n`;
  const {fmText, body} = splitFrontmatter(text);
  const fmSkills = parseListField(fmText, 'skills');
  assert(isSkillWired('frontend-design', fmSkills, body) === false, 'frontmatter-only (no body ref) must not be wired');
});

// 4 — recon role is low-bar (not gated).
await test('4. recon role → PASS (low bar, no gaps)', () => {
  const text = `---\nname: scout\nrole: recon\ncore_domains: [frontend]\n---\nRead-only: search and map the UI files.\n`;
  const card = scoreAgent({name: 'scout', text, roster: null, skillDomainMap: MAP});
  assert(card.pass === true, 'recon must pass');
  assert(card.gaps.length === 0, 'recon has no gaps');
});

// 5 — gate wired in dispatcher: a real agent-file Write fires the gate (advisory),
//      and malformed input fails open.
function runDispatcher(payload, {env = {}, files = {}} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-aqg-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  // seed skill-domain-map
  const refDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(refDir, {recursive: true});
  writeFileSync(join(refDir, 'skill-domain-map.json'), JSON.stringify(MAP));
  // write any agent files into the isolated home, rewriting the payload path
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, content);
  }
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload(home)), encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...env},
    });
    // PostToolUse dispatcher emits concatenated PLAIN TEXT (not JSON) — assert on
    // the raw stdout, matching the agent-write-register / kb-autosync convention.
    const scorecard = existsSync(join(home, '.claude', '.prism-quality', 'dedecomp-frontend-design-engineer.json'))
      ? JSON.parse(readFileSync(join(home, '.claude', '.prism-quality', 'dedecomp-frontend-design-engineer.json'), 'utf8'))
      : null;
    return {exit: r.status, stdout: (r.stdout || '').trim(), additionalContext: (r.stdout || '').trim(), scorecard};
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
}

await test('5. dispatcher fires gate on agent-file Write → scorecard written + advisory', () => {
  const rel = join('.claude', 'agents', 'dedecomp-frontend-design-engineer.md');
  const r = runDispatcher(
    (home) => ({tool_name: 'Write', session_id: 'q', tool_input: {file_path: join(home, rel)}}),
    {files: {[rel]: PRE_UPGRADE}, env: {PRISM_AGENT_QUALITY: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.scorecard && r.scorecard.pass === false, 'scorecard written and failing');
  assert(/AGENT QUALITY GATE/.test(r.additionalContext || ''), `advisory present, got: ${r.additionalContext}`);
});

await test('6. enforce mode → not_ready flag on failing builder + escalated message', () => {
  const rel = join('.claude', 'agents', 'dedecomp-frontend-design-engineer.md');
  const r = runDispatcher(
    (home) => ({tool_name: 'Write', session_id: 'q', tool_input: {file_path: join(home, rel)}}),
    {files: {[rel]: PRE_UPGRADE}, env: {PRISM_AGENT_QUALITY: 'enforce'}}
  );
  assert(r.exit === 0, `exit ${r.exit} (PostToolUse never blocks)`);
  assert(r.scorecard && r.scorecard.not_ready === true, 'not_ready flag set in enforce');
  assert(/NOT production-ready/.test(r.additionalContext || ''), `escalated message, got: ${r.additionalContext}`);
});

await test('7. off mode → no scorecard, no output', () => {
  const rel = join('.claude', 'agents', 'dedecomp-frontend-design-engineer.md');
  const r = runDispatcher(
    (home) => ({tool_name: 'Write', session_id: 'q', tool_input: {file_path: join(home, rel)}}),
    {files: {[rel]: PRE_UPGRADE}, env: {PRISM_AGENT_QUALITY: 'off'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.scorecard === null, 'no scorecard in off mode');
});

await test('8. non-agent Write → gate silent (no scorecard)', () => {
  const rel = join('src', 'foo.ts');
  const r = runDispatcher(
    (home) => ({tool_name: 'Write', session_id: 'q', tool_input: {file_path: join(home, rel)}}),
    {files: {[rel]: 'const x = 1;'}, env: {PRISM_AGENT_QUALITY: 'advisory'}}
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!/AGENT QUALITY GATE/.test(r.additionalContext || ''), 'no gate output for non-agent file');
});

await test('9. malformed stdin → exit 0 (fail-open)', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-aqg-'));
  try {
    const rr = spawnSync(process.execPath, [DISPATCHER], {input: 'not json', encoding: 'utf8', windowsHide: true, env: {...process.env, HOME: home, USERPROFILE: home, PRISM_AGENT_QUALITY: 'enforce'}});
    assert(rr.status === 0, `exit ${rr.status}`);
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
