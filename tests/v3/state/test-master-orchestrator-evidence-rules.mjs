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
//   - "bounce back ONCE" + "KNOWN LIMITATION" escalation phrases
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
const REFS_DIR = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references');
const SKILL_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'SKILL.md');

// v4.4: content has moved to references/. The drift-guard now reads both the
// nav-index SKILL.md and the relevant reference files so the invariants still hold.
const EVIDENCE_TAX_FILE = join(REFS_DIR, 'evidence-taxonomy.md');
const SENIOR_REVIEW_FILE = join(REFS_DIR, 'phase-1-5-senior-review.md');
const PHASE_0D_FILE = join(REFS_DIR, 'phase-0d-adversarial.md');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const raw = readFileSync(SKILL_FILE, 'utf8').replace(/\r\n/g, '\n');
// Combined corpus: nav-index + evidence-taxonomy + senior-review + adversarial references
const rawEvidenceTax = readFileSync(EVIDENCE_TAX_FILE, 'utf8').replace(/\r\n/g, '\n');
const rawSeniorReview = readFileSync(SENIOR_REVIEW_FILE, 'utf8').replace(/\r\n/g, '\n');
const rawPhase0d = readFileSync(PHASE_0D_FILE, 'utf8').replace(/\r\n/g, '\n');
const rawAll = raw + '\n' + rawEvidenceTax + '\n' + rawSeniorReview + '\n' + rawPhase0d;

// ─────────────────────────────────────────────────────────────────────────
// Positive assertions: Phase J structure must be present
// ─────────────────────────────────────────────────────────────────────────

// v4.4: "Evidence taxonomy" heading moved to references/evidence-taxonomy.md
test('PHASE 1.5 introduces an "Evidence taxonomy" subsection heading', () => {
  assert(/^### Evidence taxonomy\b/m.test(rawEvidenceTax),
         'expected "### Evidence taxonomy" heading inside evidence-taxonomy.md (v4.4: moved from SKILL.md)');
});

// v4.4: "Per-claim verdict" heading moved to references/evidence-taxonomy.md
test('PHASE 1.5 introduces a "Per-claim verdict" subsection heading', () => {
  assert(/^### Per-claim verdict\b/m.test(rawEvidenceTax),
         'expected "### Per-claim verdict" heading inside evidence-taxonomy.md (v4.4: moved from SKILL.md)');
});

test('PHASE 1.5 defines the three verdict tokens EVIDENCED / UN-CITED / REJECTED', () => {
  assert(/\bEVIDENCED\b/.test(rawEvidenceTax), 'EVIDENCED token missing from evidence-taxonomy.md');
  assert(/\bUN-CITED\b/.test(rawEvidenceTax), 'UN-CITED token missing from evidence-taxonomy.md');
  assert(/\bREJECTED\b/.test(rawEvidenceTax), 'REJECTED token missing from evidence-taxonomy.md');
});

test('PHASE 1.5 escalation rule: bounce ONCE then ship as KNOWN LIMITATION', () => {
  // Pin uppercase ONCE and KNOWN LIMITATION — these are deliberate verdict-style
  // tokens introduced by Phase J. The pre-Phase-J prose uses lowercase ("bounced
  // back once", "Known limitations remaining"), so case-sensitive matching here
  // gives the TDD-red state Task 2 must satisfy.
  // v4.4: these tokens live in references/evidence-taxonomy.md.
  assert(/[Bb]ounce[^.\n]{1,60}\bONCE\b/.test(rawEvidenceTax),
         'expected "Bounce ... ONCE" (uppercase ONCE token) rule in evidence-taxonomy.md');
  assert(/KNOWN LIMITATION/.test(rawEvidenceTax),
         'expected "KNOWN LIMITATION" (uppercase singular token) in evidence-taxonomy.md');
  // Also pin the normative bullet in # Per-claim verdict — the bold "**Bounce
  // back ONCE**" phrase may wrap across lines, so use \s+ here rather than the
  // single-line [^.\n] used above. A targeted lowercase revert of just that
  // bullet would otherwise slip past the single-line assertion.
  assert(/\*\*Bounce\s+back ONCE\*\*/.test(rawEvidenceTax),
         'expected "**Bounce back ONCE**" (bold uppercase token) in Per-claim verdict bullet');
});

test('Visible output requires a rejected-claims line in the user-facing Senior Review', () => {
  // The bullet must mention rejected claims so the user sees the bounce outcome
  // rather than getting a clean-but-opaque summary.
  // v4.4: visible-output section lives in references/phase-1-5-senior-review.md.
  assert(/Claims rejected|rejected (?:as |claims)/i.test(rawSeniorReview),
         'expected a "Claims rejected" bullet in PHASE 1.5 Visible output (phase-1-5-senior-review.md)');
});

test('Delegation boilerplate names the taxonomy classes specialists must satisfy', () => {
  // The specialist-facing block must enumerate the categories so the bounce
  // criteria are visible at delegation time, not just at review time.
  // v4.4: delegation boilerplate lives in references/evidence-taxonomy.md.
  const categories = ['performance', 'security', 'correctness', 'completeness', 'compatibility'];
  for (const cat of categories) {
    assert(new RegExp(`\\b${cat}\\b`, 'i').test(rawEvidenceTax),
           `delegation boilerplate must name claim category "${cat}" (evidence-taxonomy.md)`);
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
  // v4.4: PHASE 0d body lives in references/phase-0d-adversarial.md; nav-index SKILL.md
  // retains rule 4 which also contains "at least two substantive challenges".
  // Search combined corpus for the floor phrase.
  const phase0dBlock = rawPhase0d;
  assert(phase0dBlock.length > 0, 'PHASE 0d section missing entirely (phase-0d-adversarial.md)');
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
