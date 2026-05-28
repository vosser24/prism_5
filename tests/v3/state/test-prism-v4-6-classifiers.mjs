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
const { classifyWithScore } = await import(pathToFileURL(join(repoRoot, 'tools', 'lib', 'prism-tier-classify.mjs')).href);
check('D1 migration prompt → opus + panel', (() => { const r = classifyWithScore('run the database migration to drop the users table', ''); return r.tier_by_score === 'opus' && r.summon_panel === true; })());
check('D1 trivial prompt unaffected', classifyWithScore('rename this variable to camelCase', '').tier_by_score !== 'opus');

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
