#!/usr/bin/env node
// TDD B1 — Runner emits hooks_fired; analyzer renders p95 Timing Distribution table.
// Run: node tests/v3/test-audit-timing.mjs
// Exit: 0 = all pass; 1 = any failure.

import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const RUNNER = join(REPO, 'tools', 'prism-audit-runner.mjs');
const ANALYZER = join(REPO, 'tests', 'v3', 'analyze-audit.mjs');

let pass = 0, fail = 0;
async function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

// ── Assertion 1: Runner emits numeric duration_ms AND hooks_fired array ──────
await test('runner emits hooks_fired with hook name and duration_ms', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-b1-runner-'));
  try {
    // Minimal 1-scenario catalog pointing at the real classifier hook (CLF-001 target)
    const catalog = {
      schema_version: '3.6.0',
      scenarios: [{
        id: 'B1-T1',
        name: 'test timing emit',
        category: 'classifier',
        capability: 'test_timing',
        target_hook: 'hooks/prism-prompt-tier-router.mjs',
        input_event: 'UserPromptSubmit',
        input_payload: {session_id: 'audit-b1-t1', prompt: 'what does SIGTERM mean'},
        expected_exit_code: 0,
        expected_stdout_pattern: 'haiku',
        max_duration_ms: 500,
      }],
    };
    const catalogPath = join(tmp, 'catalog.json');
    const jsonlPath = join(tmp, 'run.jsonl');
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const r = spawnSync(process.execPath, [RUNNER, '--scenarios', catalogPath, '--output', jsonlPath], {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 30000,
    });

    assert(r.status === 0, `runner exited ${r.status};\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

    const lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
    assert(lines.length >= 1, 'expected at least 1 JSONL line');
    const rec = JSON.parse(lines[0]);

    assert(typeof rec.duration_ms === 'number',
      `duration_ms should be a number, got ${typeof rec.duration_ms}`);
    assert(Array.isArray(rec.hooks_fired),
      `hooks_fired should be an array, got ${JSON.stringify(rec.hooks_fired)}`);
    assert(rec.hooks_fired.length >= 1,
      `hooks_fired should have at least 1 entry, got ${rec.hooks_fired.length}`);
    assert(typeof rec.hooks_fired[0].duration_ms === 'number',
      `hooks_fired[0].duration_ms should be a number, got ${typeof rec.hooks_fired[0].duration_ms}`);
    const expectedHookName = rec.target_hook.replace(/^.*[\\/]/, '').replace(/\.mjs$/, '');
    assert(rec.hooks_fired[0].hook === expectedHookName,
      `hooks_fired[0].hook="${rec.hooks_fired[0].hook}" should equal "${expectedHookName}"`);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

// ── Assertion 2: Analyzer renders Timing Distribution table ──────────────────
await test('analyzer renders ## Timing distribution table (not "No hook timing samples")', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-b1-analyzer-'));
  try {
    // Hand-craft a 2-line JSONL with hooks_fired
    const jsonlPath = join(tmp, 'run.jsonl');
    const line1 = JSON.stringify({
      scenario_id: 'B1-A1',
      category: 'classifier',
      capability: 'tier_haiku',
      target_hook: 'hooks/prism-prompt-tier-router.mjs',
      pass: true,
      duration_ms: 92,
      hooks_fired: [{hook: 'prism-prompt-tier-router', duration_ms: 92}],
    });
    const line2 = JSON.stringify({
      scenario_id: 'B1-A2',
      category: 'classifier',
      capability: 'tier_haiku',
      target_hook: 'hooks/prism-prompt-tier-router.mjs',
      pass: true,
      duration_ms: 140,
      hooks_fired: [{hook: 'prism-prompt-tier-router', duration_ms: 140}],
    });
    writeFileSync(jsonlPath, line1 + '\n' + line2 + '\n');

    const r = spawnSync(process.execPath, [ANALYZER, jsonlPath], {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 15000,
    });

    const out = r.stdout || '';
    assert(out.includes('## Timing distribution'),
      `missing "## Timing distribution" section\noutput: ${out.slice(0, 400)}`);
    assert(out.includes('| Hook | Count | Min | p50 | p95 | p99 | Max |'),
      `missing table header row in timing section`);
    assert(out.includes('prism-prompt-tier-router'),
      `missing hook name "prism-prompt-tier-router" in timing table`);
    assert(!out.includes('No hook timing samples'),
      `output should NOT contain "No hook timing samples"`);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
