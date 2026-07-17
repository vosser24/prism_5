#!/usr/bin/env node
// tests/v3/install-manifest-completeness.test.mjs
//
// Guards tools/install-manifest.json against the "shipped != installed" bug
// class. This lesson was already WRITTEN DOWN (.claude/agents/MEMORY.md,
// v6.2.0 tactical lessons) and was violated a SECOND time anyway, on
// 2026-07-14, while building the very machinery meant to fix the first
// violation: hooks/prism-dispatch-preamble.mjs, hooks/prism-capture-
// evidence-guard.mjs, and hooks/lib/prism-advisory-log.mjs were correctly
// wired into hooks/prism-pretooluse-dispatcher.mjs's ROUTES table (and, for
// the lib, statically imported by the already-shipped
// hooks/prism-skill-equip-nudge.mjs) but never added to
// tools/install-manifest.json — so `node tools/prism-installer.mjs install`
// would never copy them, and the already-working skill-equip-nudge guard
// would have broken too (its own static import would fail on a fresh
// install). Per team-lead ruling: a lesson violated twice is a missing
// GUARD, not a missing paragraph. This file is that guard.
//
// Three static, dep-free checks (no install required to run any of them):
//
//   1. DISPATCHER ROUTES — every hook filename referenced by any of the 5
//      dispatcher files (hooks/prism-*-dispatcher.mjs: pretooluse,
//      posttooluse, subagentstop, sessionend, userpromptsubmit) must be
//      present in the manifest.
//   2. TRANSITIVE IMPORT CLOSURE — for every hooks/**/*.mjs file already in
//      the manifest, recursively resolve its LOCAL relative imports (./ and
//      ../ specifiers only — bare/package specifiers and node builtins are
//      ignored) and assert every resolved file is ALSO manifested. This is
//      the check that would have caught today's specific regression: a
//      manifested file (prism-skill-equip-nudge.mjs) statically importing
//      an unmanifested one (lib/prism-advisory-log.mjs).
//   3. TOP-LEVEL HOOK ENTRY POINTS — every hooks/*.mjs path referenced by
//      settings.fragment.json or .claude-plugin/plugin.json's hook wiring
//      must be present in the manifest (catches a NEW top-level hook entry
//      added to the settings fragment without a matching manifest entry —
//      same bug class, different surface).
//
// Every failure names: the missing file, the file/surface that references
// it, and the exact manifest JSON entry to add — a guard that blocks
// without teaching gets disabled.
//
// BOTH-PATHS PROOF (this file IS the proof, every run, not a one-off):
//   Part A (FIRES) mutates in-memory COPIES of the real manifest object
//   (never touches tools/install-manifest.json on disk) to strip out one
//   direct-route entry and one transitively-imported-but-unmanifested lib,
//   and asserts the checker reports exactly the expected violation, naming
//   the right file. This proves the detector isn't a guard that "looks
//   right" but never actually fires — it is exercised on every test run,
//   not just once by hand.
//   Part B (STAYS QUIET) runs the same checker against the REAL, current
//   tools/install-manifest.json and asserts zero violations — the actual
//   guard a CI/dev run relies on.
//
// Run: node tests/v3/install-manifest-completeness.test.mjs

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripLineComments, extractLocalImportSpecs, buildImportClosure} from '../../tools/lib/prism-import-closure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MANIFEST_PATH = join(REPO_ROOT, 'tools', 'install-manifest.json');
const SETTINGS_FRAGMENT_PATH = join(REPO_ROOT, 'settings.fragment.json');
const PLUGIN_JSON_PATH = join(REPO_ROOT, '.claude-plugin', 'plugin.json');

const DISPATCHER_FILES = [
  'prism-pretooluse-dispatcher.mjs',
  'prism-posttooluse-dispatcher.mjs',
  'prism-subagentstop-dispatcher.mjs',
  'prism-sessionend-dispatcher.mjs',
  'prism-userpromptsubmit-dispatcher.mjs',
];

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  PASS  ${name}`); }
function bad(name, msg) { fail++; console.log(`  FAIL  ${name}\n        ${msg}`); }
function check(name, cond, msg) { if (cond) ok(name); else bad(name, msg || 'assertion failed'); }

function toPosix(p) { return p.split('\\').join('/'); }

// stripLineComments / extractLocalImportSpecs / buildImportClosure live in
// tools/lib/prism-import-closure.mjs (shared with tools/prism-installer.mjs
// verify, which runs the same closure-walk against the INSTALLED tree
// instead of the repo tree) — imported above, not redefined here.

function loadManifestSrcSet(manifestObj) {
  return new Set((manifestObj.files || []).map(f => toPosix(f.src)));
}

function suggestManifestEntry(relPath) {
  // Best-effort convention match (top-level hooks/*.mjs guards are
  // executable:true in this manifest; hooks/lib/*.mjs helpers are usually
  // executable:false) — a SUGGESTION for the fix message, not enforced.
  const executable = relPath.startsWith('hooks/lib/') ? false : true;
  return `{"src": "${relPath}", "dst": "${relPath}", "executable": ${executable}}`;
}

// ── Check 1: dispatcher ROUTES/imp() references ────────────────────────────
const MJS_LITERAL_RE = /['"]([A-Za-z0-9][A-Za-z0-9_.-]*\.mjs)['"]/g;

function extractDispatcherReferences(dispatcherFilename) {
  const abs = join(REPO_ROOT, 'hooks', dispatcherFilename);
  const src = stripLineComments(readFileSync(abs, 'utf-8'));
  const refs = new Set();
  MJS_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = MJS_LITERAL_RE.exec(src))) refs.add(m[1]);
  return refs; // bare filenames — every current dispatcher references siblings by bare name, resolved relative to hooks/
}

function checkDispatcherRoutes(manifestSrcSet) {
  const violations = [];
  for (const dispatcherFile of DISPATCHER_FILES) {
    const dispatcherRel = `hooks/${dispatcherFile}`;
    const refs = extractDispatcherReferences(dispatcherFile);
    for (const bareName of refs) {
      const expectedSrc = `hooks/${bareName}`;
      if (!manifestSrcSet.has(expectedSrc)) {
        violations.push({
          kind: 'dispatcher-route-missing',
          missing: expectedSrc,
          referencedBy: dispatcherRel,
        });
      }
    }
  }
  return violations;
}

// ── Check 2: transitive local-import closure ────────────────────────────────
// extractLocalImportSpecs (tools/lib/prism-import-closure.mjs) matches real
// ES import/export syntax with a relative specifier:
//   import {x} from './y.mjs'   import y from '../y.mjs'   export * from './y.mjs'
//   import('./y.mjs')            (static string literal dynamic import only)
// Deliberately does NOT match the dispatcher's own pathToFileURL(join(HOOKS,
// f)) dynamic-dispatch pattern — those aren't literal import specifiers, and
// are already covered by Check 1.

// Walks the import graph starting from every MANIFESTED hooks/**/*.mjs file,
// resolved against REPO_ROOT (repo-side: is the resolved file in the
// manifest?). tools/prism-installer.mjs verify runs the same
// buildImportClosure against CLAUDE_DIR instead (installed-side: does the
// resolved file exist on disk?).
// Scope note: intentionally hooks/-only. tools/**/*.mjs uses the same ESM
// import syntax but those files are invoked directly as CLI scripts, not
// dynamically loaded by a dispatcher's fail-open `.catch(() => null)` —
// a missing tools/ import fails LOUDLY (unhandled module-resolution error
// on the next `node tools/foo.mjs` invocation), which is a different failure
// mode than the silent-death this guard targets. Out of scope for this file.
function buildTransitiveClosure(manifestSrcSet) {
  const seeds = [...manifestSrcSet].filter(p => p.startsWith('hooks/') && p.endsWith('.mjs'));
  return buildImportClosure(seeds, rel => join(REPO_ROOT, rel));
}

function checkTransitiveClosure(manifestSrcSet) {
  const violations = [];
  const {visited, dependents} = buildTransitiveClosure(manifestSrcSet);
  for (const resolvedRel of visited) {
    if (!manifestSrcSet.has(resolvedRel)) {
      const deps = dependents.get(resolvedRel) || new Set();
      violations.push({
        kind: 'transitive-import-missing',
        missing: resolvedRel,
        referencedBy: [...deps].sort().join(', '),
      });
    }
  }
  return violations;
}

// ── Check 3: top-level hook entry points (settings.fragment.json / plugin.json) ──
const SETTINGS_HOOK_RE = /~\/\.claude\/hooks\/([A-Za-z0-9_./-]+\.mjs)/g;
const PLUGIN_HOOK_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([A-Za-z0-9_./-]+\.mjs)/g;

function extractHookEntryPoints(fileAbsPath, re) {
  if (!existsSync(fileAbsPath)) return new Set();
  const src = readFileSync(fileAbsPath, 'utf-8');
  const refs = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src))) refs.add(m[1]);
  return refs;
}

function checkTopLevelEntryPoints(manifestSrcSet) {
  const violations = [];
  const sources = [
    {path: SETTINGS_FRAGMENT_PATH, re: SETTINGS_HOOK_RE, label: 'settings.fragment.json'},
    {path: PLUGIN_JSON_PATH, re: PLUGIN_HOOK_RE, label: '.claude-plugin/plugin.json'},
  ];
  for (const {path, re, label} of sources) {
    const refs = extractHookEntryPoints(path, re);
    for (const relFromHooks of refs) {
      const expectedSrc = `hooks/${relFromHooks}`;
      if (!manifestSrcSet.has(expectedSrc)) {
        violations.push({kind: 'entry-point-missing', missing: expectedSrc, referencedBy: label});
      }
    }
  }
  return violations;
}

function runAllChecks(manifestObj) {
  const manifestSrcSet = loadManifestSrcSet(manifestObj);
  return [
    ...checkDispatcherRoutes(manifestSrcSet),
    ...checkTransitiveClosure(manifestSrcSet),
    ...checkTopLevelEntryPoints(manifestSrcSet),
  ];
}

function formatViolation(v) {
  return `${v.kind}: "${v.missing}" is referenced by "${v.referencedBy}" but absent from tools/install-manifest.json.\n` +
    `        Add: ${suggestManifestEntry(v.missing)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Part A — FIRES: prove the checker actually detects both violation classes,
// using in-memory-mutated COPIES of the real manifest. Never touches
// tools/install-manifest.json on disk.
// ─────────────────────────────────────────────────────────────────────────

const realManifestRaw = readFileSync(MANIFEST_PATH, 'utf-8');
const realManifest = JSON.parse(realManifestRaw);

function cloneManifest(m) { return JSON.parse(JSON.stringify(m)); }
function withoutSrc(manifestObj, srcToRemove) {
  const clone = cloneManifest(manifestObj);
  clone.files = clone.files.filter(f => toPosix(f.src) !== srcToRemove);
  return clone;
}

console.log('Part A — FIRES (in-memory fixtures, real manifest file untouched)');

{
  // A1: direct ROUTES case — strip a file that IS directly referenced by
  // hooks/prism-pretooluse-dispatcher.mjs's ROUTES table. This is one of
  // today's 3 actual misses.
  const TARGET = 'hooks/prism-dispatch-preamble.mjs';
  check('real manifest actually contains the A1 target before mutation (sanity)',
    loadManifestSrcSet(realManifest).has(TARGET));
  const fixture = withoutSrc(realManifest, TARGET);
  const violations = runAllChecks(fixture);
  const hit = violations.find(v => v.kind === 'dispatcher-route-missing' && v.missing === TARGET);
  check(`A1 fires: removing "${TARGET}" from a manifest fixture is detected as a dispatcher-route violation`,
    !!hit,
    `expected a dispatcher-route-missing violation naming ${TARGET}; got: ${JSON.stringify(violations)}`);
  if (hit) check('A1 violation names the correct referencing dispatcher',
    hit.referencedBy === 'hooks/prism-pretooluse-dispatcher.mjs',
    `expected referencedBy=hooks/prism-pretooluse-dispatcher.mjs, got ${hit.referencedBy}`);
}

{
  // A1b — PRIOR INCIDENT #1, reproduced directly: hooks/prism-skill-trigger-
  // guard.mjs was silently dead since v3.1.0 because it was referenced by
  // hooks/prism-userpromptsubmit-dispatcher.mjs but absent from the
  // manifest at the time (since fixed in an earlier session — task #6). It
  // is manifested today, so this fixture strips it back out to prove the
  // checker generalizes across a DIFFERENT dispatcher (userpromptsubmit,
  // not pretooluse) and would have caught that exact historical incident,
  // not just today's.
  const TARGET = 'hooks/prism-skill-trigger-guard.mjs';
  check('real manifest actually contains the A1b target before mutation (sanity)',
    loadManifestSrcSet(realManifest).has(TARGET));
  const fixture = withoutSrc(realManifest, TARGET);
  const violations = runAllChecks(fixture);
  const hit = violations.find(v => v.kind === 'dispatcher-route-missing' && v.missing === TARGET);
  check(`A1b fires (prior incident #1 reproduction): removing "${TARGET}" is detected via a DIFFERENT dispatcher (userpromptsubmit)`,
    !!hit,
    `expected a dispatcher-route-missing violation naming ${TARGET}; got: ${JSON.stringify(violations)}`);
  if (hit) check('A1b violation names the correct referencing dispatcher',
    hit.referencedBy === 'hooks/prism-userpromptsubmit-dispatcher.mjs',
    `expected referencedBy=hooks/prism-userpromptsubmit-dispatcher.mjs, got ${hit.referencedBy}`);
}

{
  // A2: TRANSITIVE case — the one that would have caught today's actual
  // regression. Strip hooks/lib/prism-advisory-log.mjs while KEEPING
  // hooks/prism-skill-equip-nudge.mjs (which statically imports it) in the
  // manifest.
  const TARGET = 'hooks/lib/prism-advisory-log.mjs';
  const DEPENDENT = 'hooks/prism-skill-equip-nudge.mjs';
  const srcSet = loadManifestSrcSet(realManifest);
  check('real manifest contains the A2 target before mutation (sanity)', srcSet.has(TARGET));
  check('real manifest contains the A2 dependent before mutation (sanity)', srcSet.has(DEPENDENT));
  const fixture = withoutSrc(realManifest, TARGET);
  const violations = runAllChecks(fixture);
  const hit = violations.find(v => v.kind === 'transitive-import-missing' && v.missing === TARGET);
  check(`A2 fires: removing "${TARGET}" (imported by manifested ${DEPENDENT}) is detected as a transitive-import violation`,
    !!hit,
    `expected a transitive-import-missing violation naming ${TARGET}; got: ${JSON.stringify(violations)}`);
  if (hit) check('A2 violation names the correct dependent (the shipped file whose import breaks)',
    hit.referencedBy.split(', ').includes(DEPENDENT),
    `expected referencedBy to include ${DEPENDENT}, got "${hit.referencedBy}"`);
}

{
  // A3: entry-point case — strip a top-level dispatcher referenced directly
  // by settings.fragment.json.
  const TARGET = 'hooks/prism-pretooluse-dispatcher.mjs';
  const fixture = withoutSrc(realManifest, TARGET);
  const violations = runAllChecks(fixture);
  const hit = violations.find(v => v.kind === 'entry-point-missing' && v.missing === TARGET);
  check(`A3 fires: removing "${TARGET}" (wired in settings.fragment.json) is detected as an entry-point violation`,
    !!hit,
    `expected an entry-point-missing violation naming ${TARGET}; got: ${JSON.stringify(violations)}`);
}

{
  // A4 — negative control: removing something with NO dispatcher/import/
  // entry-point reference at all (a leaf command markdown file has no .mjs
  // reference chain) must NOT be flagged by THIS checker (it only guards
  // hook wiring, not the whole manifest) — proves the checker isn't just
  // screaming on every mutation regardless of relevance (that would be the
  // "always fires" cry-wolf failure mode from the other machine).
  const TARGET = 'commands/prism-help.md';
  check('real manifest contains the A4 negative-control target before mutation (sanity)',
    loadManifestSrcSet(realManifest).has(TARGET));
  const fixture = withoutSrc(realManifest, TARGET);
  const violations = runAllChecks(fixture);
  const hit = violations.find(v => v.missing === TARGET);
  check(`A4 negative control: removing "${TARGET}" (not referenced by any hook-wiring surface) produces NO violation`,
    !hit,
    `expected no violation for ${TARGET}; got: ${JSON.stringify(violations)}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Part B — STAYS QUIET: the actual guard. Run against the REAL, current
// tools/install-manifest.json and assert zero violations.
// ─────────────────────────────────────────────────────────────────────────

console.log('\nPart B — STAYS QUIET (real repo, real manifest)');
{
  const violations = runAllChecks(realManifest);
  if (violations.length === 0) {
    ok('real tools/install-manifest.json has zero hook-wiring completeness violations');
  } else {
    bad('real tools/install-manifest.json has zero hook-wiring completeness violations',
      `${violations.length} violation(s) found:\n` + violations.map(v => '        ' + formatViolation(v)).join('\n'));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
