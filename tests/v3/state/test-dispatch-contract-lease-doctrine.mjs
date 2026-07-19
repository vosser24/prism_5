#!/usr/bin/env node
// v6.6.0 FIX-2 — file-lease-guard doctrine wiring assertion.
//
// The file-lease-guard (hooks/prism-file-lease-guard.mjs) fires only on an
// explicit `PRISM-LEASE:` line, but nothing previously instructed the master
// orchestrator to emit that line — the guard was tested and dispatched but
// dormant in practice. This test pins the doctrine sentence in the DISPATCH
// CONTRACT section of skills/master-orchestrator/SKILL.md so a future
// SKILL.md rewrite cannot silently re-orphan the guard.
//
// Run: node tests/v3/state/test-dispatch-contract-lease-doctrine.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const SKILL_FILE = join(repoRoot, 'skills', 'master-orchestrator', 'SKILL.md');

let pass = 0, fail = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const raw = readFileSync(SKILL_FILE, 'utf8');

function dispatchContractSection(text) {
  const startIdx = text.indexOf('### DISPATCH CONTRACT');
  assert(startIdx >= 0, 'DISPATCH CONTRACT section header must exist in SKILL.md');
  const rest = text.slice(startIdx);
  const nextHeaderIdx = rest.slice(1).search(/\n### /);
  return nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx + 1);
}

test('DISPATCH CONTRACT section carries the PRISM-LEASE doctrine sentence', () => {
  const section = dispatchContractSection(raw);
  assert(/PRISM-LEASE:\s*agent=/.test(section),
    'DISPATCH CONTRACT must instruct workers to emit a `PRISM-LEASE: agent=...` line on parallel Write/Edit fan-out — see FIX-2 (v6.6.0)');
});

test('doctrine sentence names the file-lease-guard mechanism it wires', () => {
  const section = dispatchContractSection(raw);
  assert(/file-lease-guard/.test(section),
    'doctrine sentence should reference the file-lease-guard so the connection between doctrine and mechanism is discoverable');
});

process.stdout.write(`\ntests passed: ${pass}/${total}\n`);
process.exit(fail === 0 ? 0 : 1);
