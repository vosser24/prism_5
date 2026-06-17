#!/usr/bin/env node
// tests/v3/hooks/test-hook-parallel-imports.mjs
// E-P1: prism-hook.mjs top-level imports must run in parallel, not serial.
//
// THREE-PART GUARD:
//   1. STRUCTURAL  — assert Promise.all([import(router), import(tier-classify)]) exists
//                    and neither lib is imported serially outside that Promise.all.
//   2. FUNCTIONAL  — import module, call run(), assert {exit:0, stdout:string}.
//   3. OBSERVABILITY — cold-start timing logged (NOT asserted; cache-dependent).

import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-hook.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// ── PART 1: STRUCTURAL (deterministic) ────────────────────────────────────────
// Read the hook source and assert the parallel import structure exists.
//
// Strategy:
//   a) Verify a single Promise.all([ ... ]) block exists that contains BOTH
//      import refs to prism-router.mjs AND prism-tier-classify.mjs.
//   b) Strip the Promise.all block from the source, then assert no standalone
//      `await import(` referencing either lib remains — proving those import
//      sites live ONLY inside the Promise.all and nowhere else (serial pattern).
//
// This is resilient to whitespace changes and will fail loudly if someone
// reverts to two separate top-level `await import(...)` calls.

await test('STRUCTURAL: Promise.all([import(router), import(tier-classify)]) exists', async () => {
  const src = readFileSync(HOOK, 'utf-8');

  // ── (a) Promise.all block must contain both lib specifiers ──────────────────
  // Match: Promise.all([ ... ]) across multiple lines, non-greedy.
  // We look for the block that begins with Promise.all([ and ends with ]);
  // and verify both heavy libs appear as import(...) arguments inside it.
  const allBlockMatch = src.match(/Promise\.all\(\s*\[[\s\S]*?\]\s*\)/);
  assert(
    allBlockMatch !== null,
    'No Promise.all([...]) block found in hooks/prism-hook.mjs — E-P1 may have been reverted to serial imports.'
  );

  const allBlock = allBlockMatch[0];

  const hasRouter = /import\s*\(\s*[^\)]*prism-router\.mjs/.test(allBlock);
  assert(
    hasRouter,
    'Promise.all block found but does NOT contain import(...prism-router.mjs). Router import may have been extracted to a serial await.'
  );

  const hasTierClassify = /import\s*\(\s*[^\)]*prism-tier-classify\.mjs/.test(allBlock);
  assert(
    hasTierClassify,
    'Promise.all block found but does NOT contain import(...prism-tier-classify.mjs). Tier-classify import may have been extracted to a serial await.'
  );

  // ── (b) After stripping the Promise.all block, neither lib must appear ──────
  // as a standalone import site — proving there's no second serial await.
  const srcWithoutAll = src.replace(/Promise\.all\(\s*\[[\s\S]*?\]\s*\)/, '__PROMISE_ALL_REMOVED__');

  const serialRouter = /import\s*\(\s*[^\)]*prism-router\.mjs/.test(srcWithoutAll);
  assert(
    !serialRouter,
    'prism-router.mjs appears in an import() call OUTSIDE the Promise.all block — serial import detected (E-P1 regression).'
  );

  const serialTierClassify = /import\s*\(\s*[^\)]*prism-tier-classify\.mjs/.test(srcWithoutAll);
  assert(
    !serialTierClassify,
    'prism-tier-classify.mjs appears in an import() call OUTSIDE the Promise.all block — serial import detected (E-P1 regression).'
  );
});

// ── PART 2: FUNCTIONAL (behavioral) ──────────────────────────────────────────
// Import the hook module fresh and call run() with a real payload.
// Assert {exit:0, stdout:string}.

const home = mkdtempSync(join(tmpdir(), 'prism-ep1-'));
mkdirSync(join(home, '.claude'), { recursive: true });
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

try {
  const mod = await import(pathToFileURL(HOOK).href);

  await test('FUNCTIONAL: run({prompt, session_id}) returns {exit:0, stdout:string}', async () => {
    const res = await mod.run({ prompt: 'hello world', session_id: 'test-ep1' });
    assert(res != null, 'run() returned null/undefined');
    assert(res.exit === 0, `exit should be 0, got ${res && res.exit}`);
    assert(typeof res.stdout === 'string', `stdout must be string, got ${typeof res && typeof res.stdout}`);
  });

  await test('FUNCTIONAL: second run() call also returns {exit:0, stdout:string}', async () => {
    const res = await mod.run({ prompt: 'hello world', session_id: 'test-ep1b' });
    assert(res != null, 'run() returned null/undefined on second call');
    assert(res.exit === 0, `exit should be 0, got ${res && res.exit}`);
    assert(typeof res.stdout === 'string', `stdout must be string, got ${typeof res && typeof res.stdout}`);
  });
} finally {
  process.env.HOME = prevH;
  process.env.USERPROFILE = prevU;
  rmSync(home, { recursive: true, force: true });
}

// ── PART 3: OBSERVABILITY (cold-start timing, NOT asserted) ──────────────────
// Measure cold importMs and runMs in a fresh child process so t0 is captured
// BEFORE the module load (unlike the old test that set t0 after import).
// Numbers are logged for human/CI visibility only — not asserted, cache-dependent.

const obsScript = join(tmpdir(), `_prism-ep1-obs-${Date.now()}.mjs`);
const hookUrl = pathToFileURL(HOOK).href;
// Use a cache-buster query param so node doesn't reuse a cached module instance.
const obsCode = `
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'prism-obs-'));
mkdirSync(join(home, '.claude'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const hookUrl = ${JSON.stringify(hookUrl)} + '?cb=' + Date.now();
const t0 = Date.now();
const mod = await import(hookUrl);
const importMs = Date.now() - t0;

const t1 = Date.now();
await mod.run({ prompt: 'hello world', session_id: 'obs-ep1' });
const runMs = Date.now() - t1;

rmSync(home, { recursive: true, force: true });
console.log('[observability] cold importMs=' + importMs + ' runMs=' + runMs + ' (not asserted; cache-dependent)');
`;

try {
  writeFileSync(obsScript, obsCode, 'utf-8');
  const obs = spawnSync(process.execPath, ['--input-type=module'], {
    input: obsCode,
    encoding: 'utf-8',
    timeout: 30000,
  });
  if (obs.stdout && obs.stdout.trim()) {
    console.log('\n' + obs.stdout.trim());
  } else if (obs.stderr && obs.stderr.trim()) {
    console.log('[observability] cold-start probe failed (non-fatal):', obs.stderr.trim().split('\n')[0]);
  }
} catch {
  console.log('[observability] cold-start probe skipped (non-fatal)');
} finally {
  try { if (existsSync(obsScript)) unlinkSync(obsScript); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
