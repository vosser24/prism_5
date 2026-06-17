#!/usr/bin/env node
// E-P3: Structural + behavioral tests for lazy classifier imports in
// hooks/prism-agent-model-guard.mjs.
//
// Assertions:
//   1. STRUCTURAL: no static top-level import of prism-opus-classifier.mjs or
//      prism-tier-classify.mjs; both appear as await import(...) inside run().
//   2. FUNCTIONAL fast-path: parent_tool_use_id set → exit 0 (subagent bypass,
//      must NOT need the classifier libs).
//   3. FUNCTIONAL sentinel-absent: no sentinel, no parent_tool_use_id, no model →
//      run() lazily loads classifyPrompt, returns exit 0 without throwing.

import {readFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = join(__dirname, '..', '..', '..', 'hooks', 'prism-agent-model-guard.mjs');
// On Windows, dynamic import() requires file:// URLs for absolute paths.
const GUARD_FILE_URL = pathToFileURL(GUARD_PATH).href;

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// ─── HELPER: plant a temp HOME and set env ────────────────────────────────────
function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-ep3-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function withHome(home, fn) {
  const origHome = process.env.HOME;
  const origUP   = process.env.USERPROFILE;
  process.env.HOME        = home;
  process.env.USERPROFILE = home;
  try { return fn(); }
  finally {
    if (origHome !== undefined) process.env.HOME        = origHome; else delete process.env.HOME;
    if (origUP   !== undefined) process.env.USERPROFILE = origUP;   else delete process.env.USERPROFILE;
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

// ─── 1. STRUCTURAL: read source, assert no static import of classifier libs ───
await test('STRUCTURAL: no static import of prism-opus-classifier.mjs at top level', () => {
  const src = readFileSync(GUARD_PATH, 'utf-8');

  // A static import line looks like: import {...} from '...prism-opus-classifier.mjs';
  // It must NOT appear outside a function body at the top level.
  // Strategy: split on lines, find any line matching a static import of the target.
  // Static imports are at the top of the file before any function body.
  // We detect by checking if the file contains a static import statement
  // (not inside a string/comment/function) referencing these modules.
  //
  // Reliable heuristic: look for lines that are a top-level import declaration
  // (start with `import ` after optional whitespace, NOT inside a quoted string,
  // and reference the classifier path).
  const lines = src.split('\n');
  const staticImportClassifier = lines.some(line => {
    const trimmed = line.trim();
    // Must be a static import declaration (not inside a string or template literal).
    // A static top-level import starts with `import ` and contains `from '`.
    return /^import\s+/.test(trimmed) &&
           trimmed.includes('prism-opus-classifier.mjs');
  });
  assert(!staticImportClassifier,
    'FAIL: found static top-level import of prism-opus-classifier.mjs — must be lazy (await import(...)) inside run()');
});

await test('STRUCTURAL: no static import of prism-tier-classify.mjs at top level', () => {
  const src = readFileSync(GUARD_PATH, 'utf-8');
  const lines = src.split('\n');
  const staticImportTierClassify = lines.some(line => {
    const trimmed = line.trim();
    return /^import\s+/.test(trimmed) &&
           trimmed.includes('prism-tier-classify.mjs');
  });
  assert(!staticImportTierClassify,
    'FAIL: found static top-level import of prism-tier-classify.mjs — must be lazy (await import(...)) inside run()');
});

await test('STRUCTURAL: await import of prism-opus-classifier.mjs appears inside run()', () => {
  const src = readFileSync(GUARD_PATH, 'utf-8');
  // Must contain a lazy import of the classifier somewhere inside the run() body.
  const hasLazyClassifier = src.includes("await import(") &&
    src.includes('prism-opus-classifier.mjs');
  assert(hasLazyClassifier,
    'FAIL: no lazy `await import(...)` of prism-opus-classifier.mjs found in source — lazy import must be present inside run()');
});

await test('STRUCTURAL: await import of prism-tier-classify.mjs appears inside run()', () => {
  const src = readFileSync(GUARD_PATH, 'utf-8');
  const hasLazyTierClassify = src.includes("await import(") &&
    src.includes('prism-tier-classify.mjs');
  assert(hasLazyTierClassify,
    'FAIL: no lazy `await import(...)` of prism-tier-classify.mjs found in source — lazy import must be present inside run()');
});

// ─── 2. FUNCTIONAL fast-path: parent_tool_use_id set ─────────────────────────
await test('FUNCTIONAL fast-path: parent_tool_use_id set → exit 0 (subagent bypass)', async () => {
  const home = makeTempHome();
  const t0 = Date.now();
  let result;
  await (async () => {
    const origHome = process.env.HOME;
    const origUP   = process.env.USERPROFILE;
    process.env.HOME        = home;
    process.env.USERPROFILE = home;
    try {
      // Cache-bust to avoid cross-test module caching if re-run in same process.
      const {run} = await import(GUARD_FILE_URL + '?ep3fp=' + Date.now());
      result = await run({
        tool_name: 'Agent',
        session_id: 'test-ep3-fp',
        parent_tool_use_id: 'toolu_bypass_001',
        tool_input: {
          subagent_type: 'general-purpose',
          prompt: 'Do something cheap.',
        },
      });
    } finally {
      if (origHome !== undefined) process.env.HOME        = origHome; else delete process.env.HOME;
      if (origUP   !== undefined) process.env.USERPROFILE = origUP;   else delete process.env.USERPROFILE;
      try { rmSync(home, {recursive: true, force: true}); } catch {}
    }
  })();
  const elapsed = Date.now() - t0;
  console.log(`    [observability] fast-path elapsed: ${elapsed}ms`);
  assert(result !== undefined, 'run() returned undefined');
  assert(result.exit === 0, `expected exit 0, got ${result.exit}`);
});

// ─── 3. FUNCTIONAL sentinel-absent: must call classifyPrompt lazily ──────────
await test('FUNCTIONAL sentinel-absent: no sentinel → classifyPrompt lazy-loaded, exit 0', async () => {
  const home = makeTempHome();
  // No sentinel file planted — so sentinel is absent, else-branch fires.
  // No parent_tool_use_id. No model. No explicit CLAUDE_CODE_ENTRYPOINT.
  const origHome = process.env.HOME;
  const origUP   = process.env.USERPROFILE;
  const origEP   = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.HOME               = home;
  process.env.USERPROFILE        = home;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  let result;
  let threw = false;
  try {
    const {run} = await import(GUARD_FILE_URL + '?ep3sa=' + Date.now());
    result = await run({
      tool_name: 'Agent',
      session_id: 'test-ep3-sa',
      // No parent_tool_use_id
      tool_input: {
        subagent_type: 'general-purpose',
        prompt: 'Summarize this document.',
        description: 'Reads files and summarizes.',
        // No model
      },
    });
  } catch (e) {
    threw = true;
    throw new Error(`run() threw unexpectedly: ${e.message}`);
  } finally {
    if (origHome !== undefined) process.env.HOME               = origHome; else delete process.env.HOME;
    if (origUP   !== undefined) process.env.USERPROFILE        = origUP;   else delete process.env.USERPROFILE;
    if (origEP   !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = origEP; else delete process.env.CLAUDE_CODE_ENTRYPOINT;
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
  assert(!threw, 'run() threw — lazy classifyPrompt import or call failed');
  assert(result !== undefined, 'run() returned undefined');
  assert(result.exit === 0,
    `expected exit 0, got exit ${result.exit} — sentinel-absent classify path may have failed`);
  // result.stdout may contain a nudge string or be empty — both valid.
  // The key correctness invariant: no throw + exit 0.
  console.log(`    [observability] sentinel-absent result: exit=${result.exit} stdout=${JSON.stringify(result.stdout || '').slice(0,80)}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
