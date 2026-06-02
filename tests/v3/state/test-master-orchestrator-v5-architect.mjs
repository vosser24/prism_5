#!/usr/bin/env node
// Drift-guard for the v5.x "learning solution architect" master identity.
// Reads skills/master-orchestrator/SKILL.md and asserts:
//   - the master is framed as a top-class SOLUTION ARCHITECT (not just a router)
//   - the knowledge-growth loop is wired: RECALL before design, ARCHIVE after
//   - the SOLE-DISPATCHER rule (STEP 0 spike: subagent dispatch is main-loop-only)
// Origin: docs/prism/plans/2026-06-02-independent-agent-panel-design.md §4.1 (build step 1).
//
// Run: node tests/v3/state/test-master-orchestrator-v5-architect.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'SKILL.md');
const PHASE_0D_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references', 'phase-0d-adversarial.md');
const PHASE_0_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references', 'phase-0-team-assembly.md');
const PHASE_1_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references', 'phase-1-execution.md');
const DISPATCH_SHAPES_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references', 'dispatch-shapes.md');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const raw = readFileSync(SKILL_FILE, 'utf8').replace(/\r\n/g, '\n');

test('SKILL.md frames the master as a top-class solution architect (v5.x)', () => {
  assert(/solution architect/i.test(raw), 'must identify the master as a solution architect');
});

test('SKILL.md wires the knowledge-growth loop: recall before design, archive after (v5.x)', () => {
  assert(/knowledge[- ]growth loop/i.test(raw), 'must name the knowledge-growth loop');
  assert(/recall/i.test(raw), 'must reference the recall step');
  assert(/archive/i.test(raw), 'must reference the archive step');
});

test('SKILL.md states the sole-dispatcher rule — dispatch is main-loop-only (v5.x)', () => {
  assert(/sole dispatcher/i.test(raw), 'must state the sole-dispatcher rule');
  assert(/main[- ]loop[- ]only/i.test(raw), 'must explain dispatch is main-loop-only');
});

// Regression: the existing Five Unbreakable Rules block must survive the rewrite.
test('SKILL.md still contains the Five unbreakable rules (regression)', () => {
  assert(/Five unbreakable rules/i.test(raw), 'must preserve the existing rules block');
});

// ── PHASE 0d dispatch doctrine (v5.x build step 2) ──────────────────────────
const raw0d = readFileSync(PHASE_0D_FILE, 'utf8').replace(/\r\n/g, '\n');

test('phase-0d mandates REAL multi-agent dispatch (one Agent() per seat), not role-play by default (v5.x)', () => {
  assert(/real multi-agent dispatch/i.test(raw0d), 'must have the real-dispatch section');
  assert(/Agent\(\)[^\n]*per[^\n]*seat/i.test(raw0d), 'must instruct one Agent() per seat');
  assert(/dispatch_mode/.test(raw0d), 'must reference dispatch_mode');
  assert(/dispatched_agent_id/.test(raw0d), 'must reference per-position dispatched_agent_id');
});

test('phase-0d keeps role-play as an OPT-IN fast mode, not the default (v5.x)', () => {
  assert(/PRISM_PANEL_MODE\s*=\s*roleplay/i.test(raw0d) || /dispatch_mode:\s*"?roleplay"?/i.test(raw0d), 'must document the roleplay opt-in');
  assert(/not the default/i.test(raw0d), 'must state role-play is not the default');
});

test('phase-0d schema includes dispatch_mode + dispatched_agent_id fields (v5.x)', () => {
  assert(/"dispatch_mode"\s*:/.test(raw0d), 'schema block must include dispatch_mode key');
  assert(/"dispatched_agent_id"\s*:/.test(raw0d), 'schema block must include dispatched_agent_id key');
});

test('phase-0d states cost guardrails: seat cap (default 3, max 5), model defaults, cost estimate (v5.x item 8)', () => {
  assert(/cost guardrail/i.test(raw0d), 'must have a cost-guardrails section');
  assert(/seat cap/i.test(raw0d) && /\b3\b/.test(raw0d) && /\b5\b/.test(raw0d), 'seat cap default 3 / max 5');
  assert(/opus[^\n]*chair|chair[^\n]*opus/i.test(raw0d), 'opus chair default');
  assert(/sonnet/i.test(raw0d), 'seats default sonnet (haiku for scouts)');
  assert(/estimat/i.test(raw0d), 'must offer a cost estimate before a full real-dispatch panel');
});

// ── PHASE 0 panel-seat sourcing doctrine (v5.x build item 2) ────────────────
const raw0 = readFileSync(PHASE_0_FILE, 'utf8').replace(/\r\n/g, '\n');

test('phase-0 sources panel seats as real reusable experts: match roster first, else create+persist (v5.x)', () => {
  assert(/panel seat sourcing/i.test(raw0), 'must have the panel-seat-sourcing section');
  assert(/match the roster first/i.test(raw0), 'must match roster first (reuse)');
  assert(/persist/i.test(raw0) && /agent-factory/i.test(raw0), 'must create+persist via agent-factory when no match');
  assert(/role-?play/i.test(raw0), 'must exclude persona/role-play from real seats');
});

test('phase-0 makes panel experts persistent + learning with a per-project domain memory (v5.x)', () => {
  assert(/learns/i.test(raw0), 'must reference the learns flag');
  assert(/domain_memory_file/i.test(raw0), 'must reference the domain_memory_file pointer');
  assert(/recall/i.test(raw0), 'must recall the expert memory on reuse');
});

test('phase-0 gives panel experts an evolving owned-skills toolkit (v5.x)', () => {
  assert(/owned_skills/i.test(raw0), 'must reference owned_skills');
  assert(/inject/i.test(raw0), 'must equip workers by injecting the skill file');
});

test('phase-0 pins expert learning write-back to the existing context-adapters convention (v5.x item 5)', () => {
  assert(/context-adapters/i.test(raw0), 'must reuse the experience/context-adapters convention (no parallel memory tree)');
  assert(/append|write-back|writes? back/i.test(raw0), 'must APPEND the learning delta (master-brokered write-back)');
  assert(/across sessions|next session|startup/i.test(raw0), 'must explain cross-session persistence via the expert STARTUP pickup');
});

test('phase-0 detects NotebookLM by EXECUTION, not `command -v` (AppLocker false-positive guard)', () => {
  // Review finding (item 9): `command -v notebooklm` is a FALSE POSITIVE on
  // Windows AppLocker/WDAC (PATH resolves while the .exe is blocked). Must detect
  // by execution, matching agent-factory's own check.
  assert(!/Run\s+`?command -v notebooklm/i.test(raw0), 'must NOT instruct running `command -v notebooklm` (AppLocker false positive)');
  assert(/notebooklm --version/i.test(raw0), 'must detect NotebookLM by execution (notebooklm --version)');
  assert(/Do NOT use `?command -v notebooklm/i.test(raw0), 'must explicitly warn against `command -v notebooklm`');
});

test('phase-0 details expert skill authoring/evolution via skill-creator into the project skills root (v5.x item 5b)', () => {
  assert(/skill-creator/i.test(raw0), 'must author/evolve domain skills via skill-creator');
  assert(/\.claude[\/\\]skills/i.test(raw0), 'authored skills must live in the project skills root (.claude/skills)');
  assert(/evolv|refine|improve/i.test(raw0), 'must describe skill evolution across sessions');
  assert(/registered|discover/i.test(raw0), 'cross-session: authored skill becomes a registered/discoverable skill');
});

// ── PHASE 1 execution = model A (experts plan, master dispatches) (v5.x item 4) ──
const raw1 = readFileSync(PHASE_1_FILE, 'utf8').replace(/\r\n/g, '\n');
const rawDS = readFileSync(DISPATCH_SHAPES_FILE, 'utf8').replace(/\r\n/g, '\n');

test('phase-1 execution states model A: experts plan, the master dispatches workers on their spec (v5.x)', () => {
  assert(/experts? plan|experts own (the )?planning/i.test(raw1), 'must state experts plan');
  assert(/master dispatches/i.test(raw1), 'must state the master dispatches the workers');
  assert(/worker spec/i.test(raw1), 'must reference the written worker spec');
  assert(/main[- ]loop[- ]only/i.test(raw1) || /cannot spawn/i.test(raw1), 'must state experts cannot spawn');
});

test('dispatch-shapes states dispatch is main-loop-only; teammates message but do not spawn (v5.x)', () => {
  assert(/who dispatches/i.test(rawDS), 'must have the who-dispatches rule');
  assert(/main[- ]loop[- ]only/i.test(rawDS), 'must state main-loop-only');
  assert(/not[^\n]*spawn/i.test(rawDS) || /cannot[^\n]*Agent\(\)/i.test(rawDS), 'must clarify teammates do not spawn');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
