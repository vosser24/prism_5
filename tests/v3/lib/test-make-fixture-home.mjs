#!/usr/bin/env node
// tests/v3/lib/test-make-fixture-home.mjs
//
// Self-test for tests/v3/lib/make-fixture-home.mjs (F38 / task #55, chair
// refinement). Two jobs:
//   1. Prove the helper FAILS LOUDLY when a declared dep is incomplete —
//      reproducing the real #66 two-level chain (prism-capability-catalog
//      -> prism-specialist-routing-guard -> prism-home) against the actual
//      repo files, not a synthetic stand-in.
//   2. Probe the chair-refinement's static-scan approach against the cases
//      the task asked for: dynamic import(), re-exports, node:/bare
//      specifiers, a legitimately-not-needed dep, and the genuine two-level
//      chain.

import {existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeFixtureHome, scanForMissingDeps} from './make-fixture-home.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const HOOKS = join(REPO, 'hooks');
const CATALOG_SRC = join(HOOKS, 'lib', 'prism-capability-catalog.mjs');
const ROUTING_GUARD_SRC = join(HOOKS, 'prism-specialist-routing-guard.mjs');
const PRISM_HOME_SRC = join(HOOKS, 'lib', 'prism-home.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n        ${e.stack || e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// ═══════════════════════════════════════════════════════════════════════
// 1. The real #66 shape, against the actual repo files.
// ═══════════════════════════════════════════════════════════════════════

test('DELIBERATELY-OMITTED DEP: declaring only the catalog lib throws, naming BOTH missing transitive files in one scan (#66 two-level chain resolved in a single pass)', () => {
  const deps = [{src: CATALOG_SRC, dest: '.claude/hooks/lib/prism-capability-catalog.mjs'}];
  const missing = scanForMissingDeps(deps);
  const resolvedSet = new Set(missing.map((m) => m.resolved));
  assert(resolvedSet.has(ROUTING_GUARD_SRC.replace(/\\/g, '/')) || [...resolvedSet].some((p) => p.includes('prism-specialist-routing-guard.mjs')),
    `expected prism-specialist-routing-guard.mjs to be reported missing. Got: ${JSON.stringify(missing, null, 2)}`);
  assert([...resolvedSet].some((p) => p.includes('prism-home.mjs')),
    `expected the SECOND-LEVEL dep prism-home.mjs to also be reported missing in the SAME scan. Got: ${JSON.stringify(missing, null, 2)}`);

  let threw = null;
  try { makeFixtureHome(deps, {label: 'f38-incomplete'}); } catch (e) { threw = e; }
  assert(threw, 'makeFixtureHome must THROW when deps list is incomplete — this is the deliberately-omitted-dependency case');
  assert(threw.message.includes('prism-specialist-routing-guard.mjs'), `error must name the missing file. Got: ${threw.message}`);
  assert(threw.message.includes('prism-home.mjs'), `error must name the second-level missing file too. Got: ${threw.message}`);
});

test('declaring catalog + routing-guard but NOT prism-home still throws, naming exactly the remaining second-level gap', () => {
  const deps = [
    {src: CATALOG_SRC, dest: '.claude/hooks/lib/prism-capability-catalog.mjs'},
    {src: ROUTING_GUARD_SRC, dest: '.claude/hooks/prism-specialist-routing-guard.mjs'},
  ];
  const missing = scanForMissingDeps(deps);
  assert(missing.length === 1, `expected exactly 1 missing dep (prism-home.mjs). Got: ${JSON.stringify(missing, null, 2)}`);
  assert(missing[0].resolved.includes('prism-home.mjs'), `expected the gap to be prism-home.mjs. Got: ${JSON.stringify(missing[0])}`);
});

test('declaring all three (the complete #66 fix) succeeds: no throw, files copied to the right dest paths, cleanup removes them', () => {
  const deps = [
    {src: CATALOG_SRC, dest: '.claude/hooks/lib/prism-capability-catalog.mjs'},
    {src: ROUTING_GUARD_SRC, dest: '.claude/hooks/prism-specialist-routing-guard.mjs'},
    {src: PRISM_HOME_SRC, dest: '.claude/hooks/lib/prism-home.mjs'},
  ];
  assert(scanForMissingDeps(deps).length === 0, 'expected zero missing deps for the complete set');

  const fx = makeFixtureHome(deps, {label: 'f38-complete'});
  try {
    for (const {src, dest} of deps) {
      const destAbs = join(fx.home, dest);
      assert(existsSync(destAbs), `expected ${dest} to exist under fixture home`);
      assert(readFileSync(destAbs, 'utf-8') === readFileSync(src, 'utf-8'), `expected ${dest} content to match source`);
    }
  } finally {
    fx.cleanup();
  }
  assert(!existsSync(fx.home), 'cleanup() must remove the fixture home directory');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Chair-refinement probes on synthetic files (full control over shape).
// ═══════════════════════════════════════════════════════════════════════

const scratchSrc = mkdtempSync(join(tmpdir(), 'f38-probe-src-'));
function writeSynthetic(relPath, content) {
  const abs = join(scratchSrc, relPath);
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, content);
  return abs;
}

test('PROBE dynamic import(): a string-literal import(\'./x.mjs\') IS caught by the static scan', () => {
  const target = writeSynthetic('dyn-target.mjs', 'export const x = 1;\n');
  const entry = writeSynthetic('dyn-entry.mjs', `export async function load() {\n  return import('./dyn-target.mjs');\n}\n`);
  const missing = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}]);
  assert(missing.some((m) => m.resolved === target), `expected dyn-target.mjs to be flagged missing. Got: ${JSON.stringify(missing)}`);
  // and declaring it satisfies the scan
  const clean = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}, {src: target, dest: 'dyn-target.mjs'}]);
  assert(clean.length === 0, `expected zero missing once declared. Got: ${JSON.stringify(clean)}`);
});

test('PROBE re-exports: both "export * from" and "export {x} from" are caught by the static scan', () => {
  const target1 = writeSynthetic('reexport-star-target.mjs', 'export const a = 1;\n');
  const target2 = writeSynthetic('reexport-named-target.mjs', 'export const b = 2;\n');
  const entry = writeSynthetic(
    'reexport-entry.mjs',
    `export * from './reexport-star-target.mjs';\nexport {b} from './reexport-named-target.mjs';\n`,
  );
  const missing = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}]);
  const resolvedSet = new Set(missing.map((m) => m.resolved));
  assert(resolvedSet.has(target1), `expected 'export * from' target flagged. Got: ${JSON.stringify(missing)}`);
  assert(resolvedSet.has(target2), `expected 'export {x} from' target flagged. Got: ${JSON.stringify(missing)}`);
});

test('PROBE node:/bare specifiers: ignored by the scan (not treated as missing local deps)', () => {
  const entry = writeSynthetic(
    'bare-entry.mjs',
    `import {readFileSync} from 'node:fs';\nimport something from 'some-bare-package';\nexport const y = 1;\n`,
  );
  // Must NOT throw trying to read a nonexistent 'node:fs' or 'some-bare-package'
  // file, and must report zero missing local deps.
  const missing = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}]);
  assert(missing.length === 0, `expected node:/bare specifiers to be ignored entirely. Got: ${JSON.stringify(missing)}`);
});

test('PROBE "legitimately should not be copied" dep: static scan is OVER-inclusive (safe direction) — flags an import() inside a branch never reached at runtime', () => {
  const optional = writeSynthetic('optional-feature.mjs', 'export const feature = "never actually loaded in this test scenario";\n');
  const entry = writeSynthetic(
    'conditional-entry.mjs',
    `export function maybeLoad(flag) {\n  if (flag) {\n    return import('./optional-feature.mjs');\n  }\n  return null;\n}\n`,
  );
  // Runtime behaviour: this test scenario never calls maybeLoad(true), so
  // optional-feature.mjs is never actually needed. The static scanner has
  // no way to know that — it flags it anyway. This is the documented,
  // ACCEPTED limitation: fails closed (unnecessary-but-harmless copy
  // required) rather than open (silent gap). Not a bug in the helper.
  const missing = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}]);
  assert(missing.some((m) => m.resolved === optional),
    `expected the scan to be OVER-inclusive and flag optional-feature.mjs even though it is unreachable in this scenario. Got: ${JSON.stringify(missing)}`);
});

test('PROBE comment-stripping: an import-shaped line inside a // comment or /* block */ comment is NOT treated as a real dependency', () => {
  const real = writeSynthetic('commented-real-target.mjs', 'export const z = 1;\n');
  const entry = writeSynthetic(
    'commented-entry.mjs',
    `// import {fake} from './does-not-exist.mjs';\n/* import {alsoFake} from './also-does-not-exist.mjs'; */\nimport {z} from './commented-real-target.mjs';\nexport {z};\n`,
  );
  // Declare BOTH entry and the real target — proves the scan finds exactly
  // the real dep (satisfied once declared) and never chases the fake
  // commented-out specifiers (which point at files that don't exist on
  // disk at all — if the comment strip failed, scanning them would throw
  // an ENOENT read error instead of a clean empty missing list).
  const missing = scanForMissingDeps([{src: entry, dest: 'entry.mjs'}, {src: real, dest: 'commented-real-target.mjs'}]);
  assert(missing.length === 0, `expected zero missing: real dep satisfied, commented-out fake specifiers ignored entirely. Got: ${JSON.stringify(missing)}`);
  assert(!existsSync(join(scratchSrc, 'does-not-exist.mjs')), 'sanity: the commented-out target genuinely does not exist on disk');
  assert(!existsSync(join(scratchSrc, 'also-does-not-exist.mjs')), 'sanity: the block-commented-out target genuinely does not exist on disk');
});

rmSync(scratchSrc, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
