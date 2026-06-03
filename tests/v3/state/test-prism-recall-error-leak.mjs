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

// non-cross-project tier-1 error must still surface (single prefix)
const envPlain = {classification: {tier: 1, reason: 'r'}, result: {error: tier1Error}};
const outPlain = formatEnvelope(envPlain, {});
check('plain tier-1 error still surfaced', outPlain.includes('index missing'));
check('plain tier-1 error not double-prefixed', !outPlain.includes('ERROR: ERROR:'));

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
