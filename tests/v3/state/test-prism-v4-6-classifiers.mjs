#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-classifiers.mjs
// v4.6 Layer 3 — C1 validation classifier, C2 failure taxonomy, D1 stakes detection
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const c1Path = join(repoRoot, 'tools', 'lib', 'prism-validation-classify.mjs');
const c2Path = join(repoRoot, 'tools', 'lib', 'prism-failure-taxonomy.mjs');
check('C1 lib exists', existsSync(c1Path));
check('C2 lib exists', existsSync(c2Path));

if (existsSync(c1Path)) {
  const { classifyValidation } = await import(pathToFileURL(c1Path).href);
  check('C1 valid verdict → valid', classifyValidation({ severity: 'EVIDENCED', summary: { total: 5, un_cited: 0, rejected: 0 } }).status === 'valid');
  check('C1 all-uncited → invalid', classifyValidation({ severity: 'REJECTED', summary: { total: 4, un_cited: 4, rejected: 0 } }).status === 'invalid');
  check('C1 mixed → partial', classifyValidation({ severity: 'UN-CITED', summary: { total: 4, un_cited: 2, rejected: 0 } }).status === 'partial');
  check('C1 empty → unverifiable', classifyValidation({ summary: { total: 0 } }).status === 'unverifiable');
}
if (existsSync(c2Path)) {
  const { classifyFailureMode } = await import(pathToFileURL(c2Path).href);
  check('C2 missing-evidence', classifyFailureMode('claim has no citation, no evidence given').mode === 'missing_evidence');
  check('C2 hallucinated-resource', classifyFailureMode('references a file that does not exist').mode === 'hallucinated_resource');
}
// D1 stakes detection
const { classifyWithScore, PANEL_MIN_WORDS } = await import(pathToFileURL(join(repoRoot, 'tools', 'lib', 'prism-tier-classify.mjs')).href);

// D025 Fix 2a: implicit panel signals floored at PANEL_MIN_WORDS. padToMinWords()
// guarantees the test prompt clears the floor while preserving trigger vocabulary.
function padToMinWords(prompt) {
  let p = prompt; let n = 0;
  while (p.trim().split(/\s+/).length < PANEL_MIN_WORDS) p += ` filler${n++}`;
  return p;
}

// D034 Amendment (2026-06-25): explicit-only panel trigger.
// Stakes still escalates to opus tier, but panel no longer auto-fires — it
// requires an explicit user request. The two properties are now independent.
check('D1 migration prompt → opus tier (stakes still escalates)', (() => {
  // Padded to ≥50 words to clear D025 PANEL_MIN_WORDS floor.
  const r = classifyWithScore(padToMinWords('run the database migration to drop the users table'), '');
  return r.tier_by_score === 'opus';
})());
check('D1 migration prompt → summon_panel=false (explicit-only, D034)', (() => {
  // Stakes no longer triggers the panel mechanism (not an explicit request).
  // The master may offer the panel aloud as soft judgment, but no mechanism fires.
  const r = classifyWithScore(padToMinWords('run the database migration to drop the users table'), '');
  return r.summon_panel === false;
})());
check('D1 trivial prompt unaffected', classifyWithScore('rename this variable to camelCase', '').tier_by_score !== 'opus');
// D1 anchoring guards (prevent STAKES_SIGNALS over-firing on everyday vocab)
check('D1 benign "token" prompt not over-escalated', classifyWithScore('parse the JWT token from the request header', '').stakes === false);
check('D1 benign "migrate React component" not over-escalated', classifyWithScore('migrate this React component from class to hooks', '').stakes === false);
check('D1 credential rotation (plural) detected', classifyWithScore('rotate the production API credentials', '').stakes === true);
// D1 "ledger" must be ANCHORED — a bare domain noun in any ledger/finance app
// (it appears in every file path) must NOT escalate everyday reads/cosmetic edits.
check('D1 "ledger balance" read not over-escalated', classifyWithScore('what is the current ledger balance for Alice?', '').stakes === false);
check('D1 "ledger README typo" not over-escalated', classifyWithScore('fix the typo in the ledger README', '').stakes === false);
check('D1 "rename ledger folder" not over-escalated', classifyWithScore('rename the ledger app folder', '').stakes === false);
check('D1 "ledger summary column" not over-escalated', classifyWithScore('add a column to the ledger summary table', '').stakes === false);
check('D1 Purchase note field (prompt-18) not over-escalated', (() => { const r = classifyWithScore('add an optional note field to the Purchase model and expose it in the API', ''); return r.stakes === false && r.summon_panel === false; })());
// genuine high-stakes ledger MUTATIONS must still escalate (anchor, not delete)
check('D1 "reconcile the ledger" still detected', classifyWithScore('reconcile the ledger', '').stakes === true);
check('D1 "reverse a ledger entry" still detected', classifyWithScore('reverse a ledger entry', '').stakes === true);

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
