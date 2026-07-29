#!/usr/bin/env node
// F2/F5 — drift guard between the phase-0d-oob-reviewer's canonical 7-class
// evidence_class taxonomy (agents/phase-0d-oob-reviewer.md, "Evaluation
// criteria (7-class taxonomy)" section) and the enum literal now injected by
// PANEL_JSON_WRITE_CLAUSE in hooks/prism-prompt-tier-router.mjs. Fails if
// either side changes without the other — the two files have no shared
// import, so this test is the only thing that keeps them in sync.
//
// Also asserts F5 (alternatives_considered): PANEL_JSON_WRITE_CLAUSE must
// instruct the chair to write the rationale.alternatives_considered[] field
// the phase-0d reviewer treats as optional-but-recognized (v4.5+).
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEWER_MD = join(__dirname, '..', '..', '..', 'agents', 'phase-0d-oob-reviewer.md');
const ROUTER_MJS = join(__dirname, '..', '..', '..', 'hooks', 'prism-prompt-tier-router.mjs');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); } }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Extract the 7-class taxonomy bullets from the reviewer doc, scoped to the
// "Evaluation criteria (7-class taxonomy)" section only (stop at the next
// "## " heading, "Anti-defer rules") — the doc has other "- **NAME**" bullets
// elsewhere (severity rules) that must NOT be picked up.
function extractReviewerTaxonomy() {
  const md = readFileSync(REVIEWER_MD, 'utf-8');
  const start = md.indexOf('## Evaluation criteria (7-class taxonomy)');
  const end = md.indexOf('## Anti-defer rules');
  assert(start !== -1, 'reviewer doc must have the "Evaluation criteria (7-class taxonomy)" heading');
  assert(end !== -1 && end > start, 'reviewer doc must have the "Anti-defer rules" heading after the taxonomy');
  const section = md.slice(start, end);
  const re = /^- \*\*([A-Z][A-Z-]*)\*\*/gm;
  const values = [];
  let m;
  while ((m = re.exec(section)) !== null) values.push(m[1]);
  return values;
}

// Extract the evidence_class enum literal from PANEL_JSON_WRITE_CLAUSE in the
// router source (regex over source text — no need to import/execute the
// module for this static-drift check).
function extractRouterEnum() {
  const src = readFileSync(ROUTER_MJS, 'utf-8');
  const m = /"evidence_class":((?:"[A-Z][A-Z-]*"\|?)+)/.exec(src);
  assert(m, 'router source must contain an "evidence_class":"..."|"..." enum literal in PANEL_JSON_WRITE_CLAUSE');
  return m[1].split('|').map(s => s.replace(/^"|"$/g, ''));
}

test('reviewer taxonomy extraction finds exactly 7 classes', () => {
  const values = extractReviewerTaxonomy();
  assert(values.length === 7, `expected 7 taxonomy bullets, got ${values.length}: ${JSON.stringify(values)}`);
});

test('router enum literal contains exactly 7 values', () => {
  const values = extractRouterEnum();
  assert(values.length === 7, `expected 7 enum values, got ${values.length}: ${JSON.stringify(values)}`);
});

test('F2 drift guard: reviewer taxonomy SET === router evidence_class enum SET', () => {
  const reviewerSet = new Set(extractReviewerTaxonomy());
  const routerSet = new Set(extractRouterEnum());
  const missingFromRouter = [...reviewerSet].filter(v => !routerSet.has(v));
  const extraInRouter = [...routerSet].filter(v => !reviewerSet.has(v));
  assert(missingFromRouter.length === 0, `router enum is missing: ${JSON.stringify(missingFromRouter)}`);
  assert(extraInRouter.length === 0, `router enum has values not in the reviewer taxonomy: ${JSON.stringify(extraInRouter)}`);
  assert(reviewerSet.size === routerSet.size, 'sets must be equal size (no duplicates hiding a mismatch)');
});

test('F5: PANEL_JSON_WRITE_CLAUSE contains alternatives_considered', () => {
  const src = readFileSync(ROUTER_MJS, 'utf-8');
  const clauseMatch = /const PANEL_JSON_WRITE_CLAUSE =([\s\S]*?);/.exec(src);
  assert(clauseMatch, 'router source must define PANEL_JSON_WRITE_CLAUSE');
  assert(/alternatives_considered/.test(clauseMatch[1]), 'PANEL_JSON_WRITE_CLAUSE must contain the substring "alternatives_considered"');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
