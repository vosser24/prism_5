#!/usr/bin/env node
// tests/v3/hooks/acl-production-factory.test.mjs — TDD: productionFactory dispatch
//
// Tests the production factory path in hooks/prism-acl-worker.mjs.
// productionFactory spawns PRISM_ACL_CLAUDE_BIN (default: 'claude') headlessly
// to author a capability .md file into stagingDir, then returns its path.
//
// Strategy: PRISM_ACL_CLAUDE_BIN is pointed at a stub Node.js script that:
//   success  → writes <stagingDir>/<name>.md with valid frontmatter, exits 0
//   timeout  → sleeps indefinitely (hung LLM simulation)
//   error    → exits non-zero immediately (no file written)
//
// PRISM_ACL_FACTORY_TIMEOUT_MS is set to 2000ms so the timeout test completes fast.
//
// Assertions:
//   (1) success  → productionFactory resolves with file path; file has frontmatter
//   (2) timeout  → resolves null (or throws) within timeout+margin; no file left
//   (3) error    → resolves null (or throws) gracefully; no file left
//   (4) injection proof → bin override is what gets called (not hardcoded 'claude')

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const WORKER_PATH = join(REPO_ROOT, 'hooks', 'prism-acl-worker.mjs');

// Import productionFactory directly — it MUST be exported (named export)
const workerMod = await import(pathToFileURL(WORKER_PATH).href);
const { productionFactory } = workerMod;

if (typeof productionFactory !== 'function') {
  console.error('FATAL: productionFactory is not exported from prism-acl-worker.mjs');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStaging() {
  return mkdtempSync(join(tmpdir(), 'prism-pf-test-'));
}

function makeSpec(name = 'test-skill-builder') {
  return {
    name,
    description: `Auto-test capability ${name}`,
    type: 'skill',
    members: ['test-member-1', 'test-member-2'],
  };
}

// Write a Node.js stub script to tmpDir/<stubName>.mjs and return its path.
// On Windows there is no reliable shebang execution, so we invoke stubs via
// PRISM_ACL_CLAUDE_BIN = "<node-exe> <stubPath>" (space-split in productionFactory).
function writeStub(tmpDir, stubName, body) {
  const p = join(tmpDir, stubName + '.mjs');
  writeFileSync(p, body, 'utf-8');
  return p;
}

// ── Stub bodies ───────────────────────────────────────────────────────────────

// SUCCESS: productionFactory passes --name <name> --output-dir <stagingDir>
// The stub writes a valid .md file into outputDir and exits 0.
const SUCCESS_BODY = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const odIdx = args.indexOf('--output-dir');
const nmIdx = args.indexOf('--name');
const outputDir = odIdx !== -1 ? args[odIdx + 1] : null;
const capName   = nmIdx !== -1 ? args[nmIdx + 1] : 'unknown-cap';

if (!outputDir) {
  process.stderr.write('[stub-success] missing --output-dir\\n');
  process.exit(1);
}

const content = [
  '---',
  \`name: \${capName}\`,
  \`description: Auto-authored capability for \${capName}\`,
  'type: skill',
  'version: 1',
  '---',
  '',
  \`# \${capName}\`,
  '',
  'Stub-authored capability for production-factory tests.',
].join('\\n');

const dest = join(outputDir, capName + '.md');
writeFileSync(dest, content, 'utf-8');
process.exit(0);
`.trim();

// TIMEOUT: hangs indefinitely
const TIMEOUT_BODY = `
setTimeout(() => {}, 600000);
`.trim();

// ERROR: non-zero exit, no file
const ERROR_BODY = `
process.stderr.write('[stub-error] simulated claude failure\\n');
process.exit(2);
`.trim();

// ── Test runner ───────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const stubsDir = mkdtempSync(join(tmpdir(), 'prism-pf-stubs-'));

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

function setEnv(key, value) {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return prev;
}

function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

// ── Test 1: SUCCESS ───────────────────────────────────────────────────────────

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-success-builder');
  const stubPath = writeStub(stubsDir, 'stub-success', SUCCESS_BODY);

  // Set PRISM_ACL_CLAUDE_BIN to "<node> <stubPath>" (space-split supported)
  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  // Use a generous timeout for success case
  const prevFT = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '10000');

  try {
    const t0 = Date.now();
    let result = null;
    try {
      result = await productionFactory(spec, stagingDir);
    } catch (e) {
      console.log(`  [test-1] threw: ${e.message}`);
    }
    const elapsed = Date.now() - t0;

    check('(1a) success: returns a string path', typeof result === 'string' && result.length > 0,
      `got: ${JSON.stringify(result)}`);
    check('(1b) success: returned path exists', typeof result === 'string' && existsSync(result),
      `path: ${result}`);

    if (typeof result === 'string' && existsSync(result)) {
      const content = readFileSync(result, 'utf-8');
      check('(1c) success: file starts with ---', content.startsWith('---'),
        `snippet: ${content.slice(0, 60)}`);
      check('(1d) success: file has name: field', /^name:/m.test(content),
        `snippet: ${content.slice(0, 120)}`);
      check('(1e) success: file has description: field', /^description:/m.test(content),
        `snippet: ${content.slice(0, 120)}`);
    } else {
      fail += 3;
      console.log('FAIL  (1c) (1d) (1e) — file absent, skipped');
    }
    check('(1f) success: elapsed < 15s', elapsed < 15000, `elapsed=${elapsed}ms`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Test 2: TIMEOUT ───────────────────────────────────────────────────────────

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-timeout-builder');
  const stubPath = writeStub(stubsDir, 'stub-timeout', TIMEOUT_BODY);

  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  // Short factory timeout so this test finishes in ~2s
  const prevFT = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '2000');

  try {
    const t0 = Date.now();
    let result = 'NOT_SET';
    let threw = false;
    try {
      result = await productionFactory(spec, stagingDir);
    } catch (e) {
      threw = true;
      result = null;
    }
    const elapsed = Date.now() - t0;

    const timedOut = result === null || threw;
    check('(2a) timeout: returns null or throws', timedOut,
      `result=${result}, threw=${threw}`);

    const timeoutMs = 2000;
    const margin = 4000; // generous kill margin
    check('(2b) timeout: completes within timeout + margin', elapsed < timeoutMs + margin,
      `elapsed=${elapsed}ms, budget=${timeoutMs + margin}ms`);

    // No file should remain in staging after graceful failure
    const filesLeft = existsSync(stagingDir) ? readdirSync(stagingDir) : [];
    check('(2c) timeout: no file left in staging', filesLeft.length === 0,
      `staging: [${filesLeft.join(', ')}]`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Test 3: ERROR ─────────────────────────────────────────────────────────────

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-error-builder');
  const stubPath = writeStub(stubsDir, 'stub-error', ERROR_BODY);

  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  const prevFT = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '10000');

  try {
    const t0 = Date.now();
    let result = 'NOT_SET';
    let threw = false;
    try {
      result = await productionFactory(spec, stagingDir);
    } catch (e) {
      threw = true;
      result = null;
    }
    const elapsed = Date.now() - t0;

    check('(3a) error: returns null or throws', result === null || threw,
      `result=${result}, threw=${threw}`);
    check('(3b) error: completes quickly (< 5s)', elapsed < 5000,
      `elapsed=${elapsed}ms`);

    const filesLeft = existsSync(stagingDir) ? readdirSync(stagingDir) : [];
    check('(3c) error: no file left in staging', filesLeft.length === 0,
      `staging: [${filesLeft.join(', ')}]`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Test 4: INJECTABLE BIN ────────────────────────────────────────────────────
// If PRISM_ACL_CLAUDE_BIN is respected, the success stub works.
// If it were ignored and 'claude' were called, it would either fail or hang.

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-inject-builder');
  const stubPath = writeStub(stubsDir, 'stub-inject', SUCCESS_BODY);

  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  const prevFT = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '10000');

  try {
    let result = null;
    try {
      result = await productionFactory(spec, stagingDir);
    } catch (e) {
      result = null;
    }
    check('(4a) injectable bin: PRISM_ACL_CLAUDE_BIN stub was used',
      typeof result === 'string' && existsSync(result),
      `result=${result}`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Cleanup + Summary ─────────────────────────────────────────────────────────
try { rmSync(stubsDir, { recursive: true, force: true }); } catch {}

console.log(`\nResults: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
