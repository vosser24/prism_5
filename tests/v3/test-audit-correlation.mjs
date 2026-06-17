#!/usr/bin/env node
// TDD B2 — (tier,source) correlation against routing log.
// Run: node tests/v3/test-audit-correlation.mjs
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

// ── Assertion 1: Analyzer matches when records carry expected{tier,source} ───
await test('analyzer reports Matched in real session > 0 when records carry expected{tier,source}', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-b2-analyzer-'));
  try {
    // 2-line audit JSONL with expected {tier, source}
    const auditPath = join(tmp, 'audit.jsonl');
    const routingPath = join(tmp, 'routing.jsonl');

    const auditLine1 = JSON.stringify({
      scenario_id: 'B2-A1',
      category: 'classifier',
      capability: 'tier_haiku_keyword_floor',
      target_hook: 'hooks/prism-prompt-tier-router.mjs',
      pass: true,
      duration_ms: 90,
      hooks_fired: [{hook: 'prism-prompt-tier-router', duration_ms: 90}],
      expected: {tier: 'haiku', source: 'keyword-floor'},
    });
    const auditLine2 = JSON.stringify({
      scenario_id: 'B2-A2',
      category: 'classifier',
      capability: 'tier_sonnet_keyword_floor',
      target_hook: 'hooks/prism-prompt-tier-router.mjs',
      pass: true,
      duration_ms: 110,
      hooks_fired: [{hook: 'prism-prompt-tier-router', duration_ms: 110}],
      expected: {tier: 'sonnet', source: 'keyword-floor'},
    });
    writeFileSync(auditPath, auditLine1 + '\n' + auditLine2 + '\n');

    // Routing log with one matching (tier, source) pair
    writeFileSync(routingPath, JSON.stringify({tier: 'haiku', source: 'keyword-floor'}) + '\n');

    const r = spawnSync(process.execPath, [ANALYZER, auditPath, routingPath], {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 15000,
    });

    const out = r.stdout || '';
    assert(out.includes('## Real-session correlation'),
      `missing "## Real-session correlation" section\noutput: ${out.slice(0, 500)}`);
    assert(/Matched in real session: \*\*[1-9][0-9]*\*\*/.test(out),
      `"Matched in real session" should be non-zero\noutput: ${out.slice(0, 500)}`);
    assert(!out.includes('Matched in real session: **0**'),
      `matched should not be 0`);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

// ── Assertion 2: Runner emits expected{tier,source} when scenario has expected_tier/source ──
await test('runner record has expected{tier,source} when scenario carries expected_tier + expected_source', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-b2-runner-'));
  try {
    // 1-scenario catalog with expected_tier and expected_source
    const catalog = {
      schema_version: '3.6.0',
      scenarios: [{
        id: 'B2-T1',
        name: 'test correlation emit',
        category: 'classifier',
        capability: 'tier_haiku_keyword_floor',
        target_hook: 'hooks/prism-prompt-tier-router.mjs',
        input_event: 'UserPromptSubmit',
        input_payload: {session_id: 'audit-b2-t1', prompt: 'what does SIGTERM mean'},
        expected_exit_code: 0,
        expected_stdout_pattern: 'haiku',
        expected_tier: 'haiku',
        expected_source: 'keyword-floor',
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

    assert(rec.expected !== null && typeof rec.expected === 'object',
      `rec.expected should be an object, got ${JSON.stringify(rec.expected)}`);
    assert(rec.expected.tier === 'haiku',
      `rec.expected.tier should be "haiku", got ${JSON.stringify(rec.expected && rec.expected.tier)}`);
    assert(rec.expected.source === 'keyword-floor',
      `rec.expected.source should be "keyword-floor", got ${JSON.stringify(rec.expected && rec.expected.source)}`);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
