#!/usr/bin/env node
// PRISM v3.6.0 audit runner.
//
// Loads tests/v3/audit-scenarios.json, spawns each scenario's target hook
// as a subprocess with the input_payload piped via stdin, captures
// timing + exit code + stdout + stderr, compares against expected_*,
// emits one JSON line per scenario to the output JSONL.
//
// Usage:
//   node tools/prism-audit-runner.mjs                              # run all
//   node tools/prism-audit-runner.mjs --category classifier         # filter
//   node tools/prism-audit-runner.mjs --output /tmp/audit-run.jsonl
//   node tools/prism-audit-runner.mjs --scenarios <path>           # custom catalog
//
// Exit 0 on all-pass, 1 on any fail or runner error.

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

// --- arg parsing ---
const args = process.argv.slice(2);
let category = null;
let output = '/tmp/prism-audit-run.jsonl';
let scenariosPath = join(REPO, 'tests/v3/audit-scenarios.json');
let help = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--category' && args[i + 1]) { category = args[i + 1]; i++; }
  else if (args[i] === '--output' && args[i + 1]) { output = args[i + 1]; i++; }
  else if (args[i] === '--scenarios' && args[i + 1]) { scenariosPath = args[i + 1]; i++; }
  else if (args[i] === '--help' || args[i] === '-h') { help = true; }
}

if (help) {
  console.log(`PRISM v3.6.0 audit runner

Usage:
  node tools/prism-audit-runner.mjs [--category <name>] [--output <path>] [--scenarios <path>]

Options:
  --category <name>   Filter scenarios by category (e.g., classifier, mutation-guard, safety)
  --output <path>     Output JSONL path (default: /tmp/prism-audit-run.jsonl)
  --scenarios <path>  Custom catalog (default: tests/v3/audit-scenarios.json)
  --help              This message

Exit 0 on all-pass, 1 on any fail or runner error.`);
  process.exit(0);
}

// --- load catalog ---
if (!existsSync(scenariosPath)) {
  console.error(`[audit] FATAL: scenarios file not found at ${scenariosPath}`);
  process.exit(1);
}
let catalog;
try {
  catalog = JSON.parse(readFileSync(scenariosPath, 'utf-8'));
} catch (err) {
  console.error(`[audit] FATAL: scenarios file invalid JSON: ${err.message}`);
  process.exit(1);
}

const allScenarios = catalog.scenarios || [];
const scenarios = category
  ? allScenarios.filter(s => s.category === category)
  : allScenarios;

if (scenarios.length === 0) {
  console.error(`[audit] no scenarios match (category=${category || 'all'})`);
  process.exit(1);
}

console.log(`[audit] Running ${scenarios.length} scenarios (output: ${output})`);
if (category) console.log(`[audit]   filter: category=${category}`);

// --- ensure output dir exists ---
try { mkdirSync(dirname(output), {recursive: true}); } catch {}

// --- runner ---
let pass = 0;
let fail = 0;
const results = [];

function runScenario(targetPath, sc) {
  return new Promise((resolve) => {
    const proc = spawn('node', [targetPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => resolve({exit_code: -1, stdout, stderr, error: err.message}));
    proc.on('close', exit_code => resolve({exit_code, stdout, stderr}));
    try {
      proc.stdin.write(JSON.stringify(sc.input_payload || {}));
      proc.stdin.end();
    } catch (err) {
      // stdin may be closed already; ignore
    }
    const timeoutMs = sc.max_duration_ms || 5000;
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs + 500); // grace period
  });
}

function checkPass(result, sc) {
  if (sc.expected_exit_code !== undefined && result.exit_code !== sc.expected_exit_code) {
    return {pass: false, reason: `exit_code expected=${sc.expected_exit_code} got=${result.exit_code}`};
  }
  if (sc.expected_stdout_pattern) {
    const haystack = (result.stdout || '') + '\n' + (result.stderr || '');
    if (!haystack.includes(sc.expected_stdout_pattern)) {
      return {pass: false, reason: `stdout/stderr did not contain pattern: ${sc.expected_stdout_pattern.slice(0, 60)}`};
    }
  }
  return {pass: true};
}

(async () => {
  for (const sc of scenarios) {
    const targetPath = join(REPO, sc.target_hook);
    if (!existsSync(targetPath)) {
      console.log(`[audit] ${sc.id} ✗ MISSING TARGET ${sc.target_hook}`);
      results.push({
        ts: new Date().toISOString(),
        scenario_id: sc.id,
        name: sc.name,
        category: sc.category,
        target_hook: sc.target_hook,
        pass: false,
        errors: ['target hook missing on disk'],
        duration_ms: 0,
      });
      fail++;
      continue;
    }

    const start = Date.now();
    const result = await runScenario(targetPath, sc);
    const duration_ms = Date.now() - start;
    const verdict = checkPass(result, sc);
    const symbol = verdict.pass ? '✓' : '✗';
    const tail = verdict.pass ? '' : ` — ${verdict.reason}`;
    console.log(`[audit] ${sc.id} ${symbol} ${duration_ms}ms${tail}`);

    results.push({
      ts: new Date().toISOString(),
      scenario_id: sc.id,
      name: sc.name,
      category: sc.category,
      capability: sc.capability,
      target_hook: sc.target_hook,
      pass: verdict.pass,
      reason: verdict.reason,
      exit_code: result.exit_code,
      duration_ms,
      stdout: (result.stdout || '').slice(0, 500),
      stderr: (result.stderr || '').slice(0, 500),
      expected_exit_code: sc.expected_exit_code,
      expected_stdout_pattern: sc.expected_stdout_pattern,
    });

    if (verdict.pass) pass++;
    else fail++;
  }

  // --- write JSONL ---
  try {
    writeFileSync(output, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    console.error(`[audit] FATAL: could not write output: ${err.message}`);
    process.exit(1);
  }

  // --- summary ---
  console.log('');
  console.log(`Run complete: ${pass} pass / ${fail} fail / ${scenarios.length} total.`);
  console.log(`Output: ${output}`);

  if (fail > 0) process.exit(1);
  process.exit(0);
})();
