#!/usr/bin/env node
// tests/v3/hooks/acl-production-factory.test.mjs — TDD: productionFactory dispatch
//
// Tests the production factory path in hooks/prism-acl-worker.mjs.
// productionFactory spawns PRISM_ACL_CLAUDE_BIN (default: 'claude') headlessly
// to author a capability .md file into stagingDir, then returns its path.
//
// Strategy: PRISM_ACL_CLAUDE_BIN is pointed at a stub Node.js script that:
//   success  → reads PRISM_ACL_STAGING_DIR env, writes <stagingDir>/<name>.md,
//              exits 0.  Also writes its argv to a sidecar file for assertion.
//   fallback → writes file to simulated agent-factory default path
//              (~/.claude/agents/<name>/<name>.md) instead of staging; exits 0.
//   timeout  → sleeps indefinitely (hung LLM simulation)
//   error    → exits non-zero immediately (no file written)
//
// PRISM_ACL_FACTORY_TIMEOUT_MS is set to 2000ms so the timeout test completes fast.
//
// Assertions:
//   (1) success  → productionFactory resolves with file path; file has frontmatter;
//                  argv contains --agent agent-factory; no --name/--output-dir
//   (2) timeout  → resolves null (or throws) within timeout+margin; no file left
//   (3) error    → resolves null (or throws) gracefully; no file left
//   (4) injection proof → bin override is what gets called (not hardcoded 'claude')
//   (5) fallback-move → stub writes to default agent-factory location
//                       (~/.claude/agents/<name>/<name>.md); productionFactory
//                       detects it and moves it into staging, returning staging path

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

// SUCCESS: productionFactory now reads output dir from PRISM_ACL_STAGING_DIR env.
// The stub also writes its argv to a sidecar file (PRISM_ACL_ARGV_LOG) for assertion.
// Argv must contain --agent agent-factory; must NOT contain --name or --output-dir.
const SUCCESS_BODY = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// Log argv for assertion
const argvLog = process.env.PRISM_ACL_ARGV_LOG;
if (argvLog) {
  writeFileSync(argvLog, JSON.stringify(args), 'utf-8');
}

// Derive output dir from env (NOT --output-dir arg, which is removed)
const stagingDir = process.env.PRISM_ACL_STAGING_DIR || process.env.STAGING_DIR;
if (!stagingDir) {
  process.stderr.write('[stub-success] missing PRISM_ACL_STAGING_DIR env\\n');
  process.exit(1);
}

// Derive capability name: look for -p prompt arg and extract name from it.
// Fallback: use the spec name embedded as the last non-flag arg, or 'unknown-cap'.
// More robustly: just use the sidecar env PRISM_ACL_CAP_NAME if provided,
// or parse out the name from the prompt "Create a skill capability named <name>".
const prompt = args[args.indexOf('-p') + 1] || '';
const nameMatch = prompt.match(/named ([\\w-]+)/);
const capName = nameMatch ? nameMatch[1] : 'unknown-cap';

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

const dest = join(stagingDir, capName + '.md');
writeFileSync(dest, content, 'utf-8');
process.exit(0);
`.trim();

// FALLBACK: stub does NOT write to stagingDir. Instead writes to the
// agent-factory DEFAULT location: ~/.claude/agents/<name>/<name>.md
// (where HOME is the temp HOME set via env PRISM_ACL_TEST_HOME).
// productionFactory should detect this and MOVE the file to staging.
const FALLBACK_BODY = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// Log argv for assertion
const argvLog = process.env.PRISM_ACL_ARGV_LOG;
if (argvLog) {
  writeFileSync(argvLog, JSON.stringify(args), 'utf-8');
}

// Get the capability name from prompt
const prompt = args[args.indexOf('-p') + 1] || '';
const nameMatch = prompt.match(/named ([\\w-]+)/);
const capName = nameMatch ? nameMatch[1] : 'unknown-cap';

// Write to the DEFAULT agent-factory path (not staging):
//   ~/.claude/agents/<name>/<name>.md   (DUAL FILE REQUIREMENT: flat file)
const home = process.env.HOME || process.env.USERPROFILE;
const agentsDir = join(home, '.claude', 'agents', capName);
mkdirSync(agentsDir, { recursive: true });

const content = [
  '---',
  \`name: \${capName}\`,
  \`description: Fallback-authored capability for \${capName}\`,
  'type: skill',
  'version: 1',
  '---',
  '',
  \`# \${capName}\`,
  '',
  'Stub written to agent-factory default location (fallback-move test).',
].join('\\n');

// Write both the directory form and the flat form (dual file requirement)
writeFileSync(join(agentsDir, capName + '.md'), content, 'utf-8');
writeFileSync(join(home, '.claude', 'agents', capName + '.md'), content, 'utf-8');

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

// ── Test 1: SUCCESS + ARGV ASSERTIONS ────────────────────────────────────────

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-success-builder');
  const stubPath = writeStub(stubsDir, 'stub-success', SUCCESS_BODY);

  // Sidecar file to receive argv from stub
  const argvLog = join(stubsDir, 'argv-success.json');

  // Set PRISM_ACL_CLAUDE_BIN to "<node> <stubPath>" (space-split supported)
  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  // Use a generous timeout for success case
  const prevFT = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '10000');
  const prevAL = setEnv('PRISM_ACL_ARGV_LOG', argvLog);

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

    // Argv assertions — require corrected invocation
    let spawnedArgv = null;
    if (existsSync(argvLog)) {
      try { spawnedArgv = JSON.parse(readFileSync(argvLog, 'utf-8')); } catch {}
    }
    check('(1g) argv: --agent agent-factory present',
      Array.isArray(spawnedArgv) && spawnedArgv.includes('--agent') &&
        spawnedArgv[spawnedArgv.indexOf('--agent') + 1] === 'agent-factory',
      `argv: ${JSON.stringify(spawnedArgv)}`);
    check('(1h) argv: --name is ABSENT (fake flag removed)',
      Array.isArray(spawnedArgv) && !spawnedArgv.includes('--name'),
      `argv: ${JSON.stringify(spawnedArgv)}`);
    check('(1i) argv: --output-dir is ABSENT (fake flag removed)',
      Array.isArray(spawnedArgv) && !spawnedArgv.includes('--output-dir'),
      `argv: ${JSON.stringify(spawnedArgv)}`);
    check('(1j) argv: --bare is ABSENT (it strips OAuth → "Not logged in"; removed v5.9.4)',
      Array.isArray(spawnedArgv) && !spawnedArgv.includes('--bare'),
      `argv: ${JSON.stringify(spawnedArgv)}`);
    check('(1k) argv: --dangerously-skip-permissions present',
      Array.isArray(spawnedArgv) && spawnedArgv.includes('--dangerously-skip-permissions'),
      `argv: ${JSON.stringify(spawnedArgv)}`);
    check('(1l) argv: --settings {"disableAllHooks":true} present (replaces --bare; sandboxes factory from PRISM guards without killing auth)',
      Array.isArray(spawnedArgv) && spawnedArgv.includes('--settings') &&
        /disableAllHooks/.test(spawnedArgv[spawnedArgv.indexOf('--settings') + 1] || ''),
      `argv: ${JSON.stringify(spawnedArgv)}`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    restoreEnv('PRISM_ACL_ARGV_LOG', prevAL);
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

// ── Test 5: FALLBACK-MOVE ─────────────────────────────────────────────────────
// Stub exits 0 but writes the file to the agent-factory DEFAULT location
// (~/.claude/agents/<name>/<name>.md in a temp HOME), NOT to stagingDir.
// productionFactory should detect the missing staging file, check the default
// location, MOVE it to staging, and return the staging path.

{
  const stagingDir = makeStaging();
  const spec = makeSpec('cap-fallback-builder');
  const stubPath = writeStub(stubsDir, 'stub-fallback', FALLBACK_BODY);

  // Use a temp HOME so the stub writes under a controlled path
  const tempHome = mkdtempSync(join(tmpdir(), 'prism-pf-home-'));

  const prevBin = setEnv('PRISM_ACL_CLAUDE_BIN', `${process.execPath} ${stubPath}`);
  const prevFT  = setEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', '10000');
  // Override HOME so productionFactory's fallback check and the stub both use tempHome
  const prevHome = setEnv('HOME', tempHome);
  // Also override USERPROFILE on Windows
  const prevUP   = setEnv('USERPROFILE', tempHome);

  try {
    let result = null;
    try {
      result = await productionFactory(spec, stagingDir);
    } catch (e) {
      console.log(`  [test-5] threw: ${e.message}`);
    }

    const expectedStaging = join(stagingDir, spec.name + '.md');
    check('(5a) fallback-move: returns staging path (not null)',
      typeof result === 'string' && result.length > 0,
      `got: ${JSON.stringify(result)}`);
    check('(5b) fallback-move: returned path is inside stagingDir',
      typeof result === 'string' && result === expectedStaging,
      `got: ${result}, expected: ${expectedStaging}`);
    check('(5c) fallback-move: file exists at staging path',
      existsSync(expectedStaging),
      `staging path: ${expectedStaging}`);

    if (existsSync(expectedStaging)) {
      const content = readFileSync(expectedStaging, 'utf-8');
      check('(5d) fallback-move: moved file has valid frontmatter',
        content.startsWith('---') && /^name:/m.test(content),
        `snippet: ${content.slice(0, 80)}`);
    } else {
      fail++;
      console.log('FAIL  (5d) fallback-move: staged file absent, skipped');
    }

    // The file should no longer exist at the default location (moved, not copied)
    const defaultFlat = join(tempHome, '.claude', 'agents', spec.name + '.md');
    const defaultDir  = join(tempHome, '.claude', 'agents', spec.name, spec.name + '.md');
    check('(5e) fallback-move: default location file was moved (not left behind)',
      !existsSync(defaultFlat) && !existsSync(defaultDir),
      `flat=${existsSync(defaultFlat)}, dir=${existsSync(defaultDir)}`);
  } finally {
    restoreEnv('PRISM_ACL_CLAUDE_BIN', prevBin);
    restoreEnv('PRISM_ACL_FACTORY_TIMEOUT_MS', prevFT);
    restoreEnv('HOME', prevHome);
    restoreEnv('USERPROFILE', prevUP);
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  }
}

// ── Cleanup + Summary ─────────────────────────────────────────────────────────
try { rmSync(stubsDir, { recursive: true, force: true }); } catch {}

console.log(`\nResults: ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
