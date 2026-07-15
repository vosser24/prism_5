#!/usr/bin/env node
// Tests for v5.x FIX-C — prism-recall cross-project output hygiene.
// Stress-test finding: every --cross-project query leaked a doubled
// "ERROR: ERROR: index missing …prism-kb-index.json" line (the Tier-1 resource
// index is separate from the F4 knowledge index, and its error string already
// began with "ERROR:"). The scary line dominated the cross-project results the
// user actually asked for.
//
// Run: node tests/v3/state/test-prism-recall-error-leak.mjs

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD = join(__dirname, '..', '..', '..', 'tools', 'prism-recall.mjs');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const {formatEnvelope} = await import(pathToFileURL(MOD).href);

const tier1Error = 'ERROR: index missing: C:/x/.prism-kb-index.json — run prism-kb-rebuild.mjs first';

// --cross-project with a tier-1 resource-index error present
const envCP = {
  classification: {tier: 1, reason: 'r'},
  result: {error: tier1Error},
  crossProject: {label: '(lexical only — trivial)', results: [{project_label: 'prism-stress-test', type: 'lesson', title: 'coffee-netting', source_path: 'p.md'}]},
};
const outCP = formatEnvelope(envCP, {});
check('no doubled "ERROR: ERROR:" prefix', !outCP.includes('ERROR: ERROR:'));
check('cross-project results still shown', outCP.includes('[prism-stress-test] lesson: coffee-netting'));
check('tier-1 index error demoted to a note on cross-project', /tier-1 .*unavailable/i.test(outCP) && !outCP.includes('prism-kb-rebuild.mjs'));

// v5.1.9: a plain (non-cross-project) tier-1 "KB not initialized" error is the
// EXPECTED default (the NotebookLM KB is opt-in cloud), so render it as a friendly,
// actionable note — NOT a raw ERROR with a leaked path (UAT 2026-06-03). Covers
// both the index-missing (rebuild) and meta-missing (notebook-init) preconditions.
const metaError = 'ERROR: meta missing: C:/fixture-home/.claude/.prism-kb-meta.json — run prism-kb-notebook-init.mjs first';
for (const [label, err] of [['index-missing', tier1Error], ['meta-missing', metaError]]) {
  const out = formatEnvelope({classification: {tier: 1, reason: 'r'}, result: {error: err}}, {});
  check(`${label}: rendered as a friendly note`, /tier-1 .*unavailable/i.test(out) && /(opt-in|isn't initialized|not initialized)/i.test(out));
  check(`${label}: does not leak the internal path`, !/\.prism-kb-(index|meta)\.json/.test(out) && !/C:[\\/]/.test(out));
  check(`${label}: not raw-ERROR-prefixed`, !/^ERROR:/m.test(out));
  check(`${label}: points to the init/rebuild tool`, /prism-kb-(rebuild|notebook-init)\.mjs/.test(out));
}

// a GENUINE (non-KB-init) tier-1 error must STILL surface as ERROR (not swallowed).
const outReal = formatEnvelope({classification: {tier: 1, reason: 'r'}, result: {error: 'tier-1 delegate failed: ECONNRESET'}}, {});
check('genuine tier-1 error still surfaces as ERROR', /ERROR:/.test(outReal) && outReal.includes('ECONNRESET'));
check('genuine tier-1 error not double-prefixed', !outReal.includes('ERROR: ERROR:'));

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
