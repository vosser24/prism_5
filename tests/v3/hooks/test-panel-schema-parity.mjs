#!/usr/bin/env node
// T4 — Fix 2 schema-parity fence: the panel.json schema SHOWN to the model in
// phase-0d-adversarial.md must carry the same provenance fields the panel-guard
// ENFORCES (vertical / seat_source / agent_type). Guards the schema-shown ==
// schema-enforced invariant against a future edit dropping a field.
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'references', 'phase-0d-adversarial.md');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const doc = readFileSync(DOC, 'utf-8');

// Isolate the positions[] schema example block (the ```jsonc ... ``` fence that
// contains the per-position shape).
const fenceMatch = doc.match(/```jsonc[\s\S]*?```/);
assert(fenceMatch, 'phase-0d-adversarial.md must contain a ```jsonc schema block');
const schemaBlock = fenceMatch[0];

await test('fire-on-regression: shown positions[] schema carries vertical/seat_source/agent_type', async () => {
  for (const field of ['vertical', 'seat_source', 'agent_type']) {
    assert(schemaBlock.includes(`"${field}"`), `schema block must show the "${field}" field the guard enforces (missing → schema/enforcement drift)`);
  }
});

await test('quiet-on-good: the enforced-fields note is present', async () => {
  assert(/enforces provenance on tagged seats/.test(doc), 'the schema-shown == schema-enforced note must be present');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
