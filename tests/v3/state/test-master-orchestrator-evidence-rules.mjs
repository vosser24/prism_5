#!/usr/bin/env node
// CI drift-guard for D004 §J (Phase J — tightened evidence rules):
//   "PHASE 1.5 senior review rejects un-cited claims more aggressively;
//    no challenge-count bump."
//
// Reads skills/master-orchestrator/SKILL.md and asserts that PHASE 1.5
// retains the structured evidence rules introduced in Phase J:
//   - ### Evidence taxonomy heading
//   - ### Per-claim verdict heading
//   - EVIDENCED / UN-CITED / REJECTED verdict tokens
//   - "bounce back ONCE" + "known limitation" escalation phrases
//   - "Claims rejected" bullet in the Visible output subsection
//
// Also asserts the negative — D004 §7 invariants the phase MUST preserve:
//   - Five Unbreakable Rules block still present
//   - PHASE 0d still says "at least two substantive challenges"
//   - No challenge-count bump to "three" / "≥3" in PHASE 0d
//
// Failure = someone trimmed the Phase J structure back out, OR bumped
// the PHASE 0d challenge floor without a follow-up D### adjudication.
//
// Run: node tests/v3/state/test-master-orchestrator-evidence-rules.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'SKILL.md');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const raw = readFileSync(SKILL_FILE, 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────
// Positive assertions: Phase J structure must be present
// ─────────────────────────────────────────────────────────────────────────

test('PHASE 1.5 introduces an "Evidence taxonomy" subsection heading', () => {
  assert(/^### Evidence taxonomy\b/m.test(raw),
         'expected "### Evidence taxonomy" heading inside PHASE 1.5');
});

test('PHASE 1.5 introduces a "Per-claim verdict" subsection heading', () => {
  assert(/^### Per-claim verdict\b/m.test(raw),
         'expected "### Per-claim verdict" heading inside PHASE 1.5');
});

test('PHASE 1.5 defines the three verdict tokens EVIDENCED / UN-CITED / REJECTED', () => {
  assert(/\bEVIDENCED\b/.test(raw), 'EVIDENCED token missing');
  assert(/\bUN-CITED\b/.test(raw), 'UN-CITED token missing');
  assert(/\bREJECTED\b/.test(raw), 'REJECTED token missing');
});

test('PHASE 1.5 escalation rule: bounce ONCE then ship as known limitation', () => {
  // The exact phrasing — pinning this prevents the rule from being softened
  // to "bounce twice" or "ship anyway" without an explicit follow-up decision.
  assert(/bounce[^.]*\bONCE\b/i.test(raw),
         'expected "bounce ... ONCE" rule in PHASE 1.5');
  assert(/known limitation/i.test(raw),
         'expected "known limitation" escalation in PHASE 1.5');
});

test('Visible output requires a rejected-claims line in the user-facing Senior Review', () => {
  // The bullet must mention rejected claims so the user sees the bounce outcome
  // rather than getting a clean-but-opaque summary.
  assert(/Claims rejected|rejected (?:as |claims)/i.test(raw),
         'expected a "Claims rejected" bullet in PHASE 1.5 Visible output');
});

test('Delegation boilerplate names the taxonomy classes specialists must satisfy', () => {
  // The specialist-facing block must enumerate the categories so the bounce
  // criteria are visible at delegation time, not just at review time.
  const categories = ['performance', 'security', 'correctness', 'compatibility'];
  for (const cat of categories) {
    assert(new RegExp(`\\b${cat}\\b`, 'i').test(raw),
           `delegation boilerplate must name claim category "${cat}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Negative assertions: D004 §7 invariants Phase J MUST preserve
// ─────────────────────────────────────────────────────────────────────────

test('Five Unbreakable Rules block is preserved verbatim (rule 4 + rule 5 anchors)', () => {
  assert(/Five unbreakable rules:/i.test(raw),
         'Five Unbreakable Rules header missing');
  assert(/at least two substantive challenges/.test(raw),
         'rule 4 "at least two substantive challenges" wording missing — challenge floor MUST stay at ≥2 per D004 §7');
  assert(/PHASE 1\.5 senior review on FULL-NOVEL and HIGH-STAKES/.test(raw),
         'rule 5 PHASE 1.5 anchor missing');
});

test('PHASE 0d still requires "at least two substantive challenges" (no bump to ≥3)', () => {
  // Match the PHASE 0d sentence specifically — the floor phrase appears in
  // multiple places (rule 4 + PHASE 0d body); both must read "two", not "three".
  const phase0dBlock = raw.split(/^### PHASE 0d:/m)[1] || '';
  assert(phase0dBlock.length > 0, 'PHASE 0d section missing entirely');
  assert(/at least two substantive challenges/.test(phase0dBlock),
         'PHASE 0d floor phrase must remain "two" — D004 §7 defers ≥3 to v4.1');
  assert(!/at least three substantive challenges|≥\s*3 substantive challenges/i.test(phase0dBlock),
         'PHASE 0d MUST NOT bump to three challenges — D004 §7 requires telemetry first');
});

test('Phase J does not leak into the thin-wrapper agent file', () => {
  // Re-assert the thin-wrapper invariant locally so a Phase J reviewer doesn't
  // need to also run the thin-wrapper test to confirm the boundary held.
  const agentFile = join(__dirname, '..', '..', '..', 'agents', 'master-orchestrator.md');
  const agent = readFileSync(agentFile, 'utf8');
  assert(!/Evidence taxonomy|Per-claim verdict|EVIDENCED|UN-CITED/.test(agent),
         'Phase J prose leaked into agents/master-orchestrator.md — must live only in the skill body');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
