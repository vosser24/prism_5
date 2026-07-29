#!/usr/bin/env node
// RB-04 follow-up — guard-telemetry-skew regression.
//
// Root cause: the dispatch-guard visibility fix (RB-04) makes several
// previously-SILENT allow paths in prism-parent-dispatch-guard.mjs emit a
// `dispatch_guard` record (blocked:false, carrying `tier`). Two downstream
// analytics consumers counted `dispatch_guard` records by `tier` WITHOUT a
// blocked filter, because historically `dispatch_guard` only ever fired on
// the deny path — so every such record was assumed to be a block. The new
// allow records (most commonly force_opus) inflate:
//   1. tools/prism-rollup-weekly.mjs      — computeCalibration()'s `actual`
//      tier tally (feeds the "Actual model used" line in the weekly digest).
//   2. tools/prism-telemetry-aggregate.mjs — aggregate()'s `tier_distribution`
//      counter.
//
// This test feeds each consumer a synthetic routing log containing:
//   - one baseline `prompt_tier_router` haiku-advised event (routing signal,
//     unaffected by the fix — proves the fix is scoped to dispatch_guard only)
//   - two `dispatch_guard` ALLOW records (blocked:false, tier:'opus',
//     reason:'force_opus') — the new, previously-impossible record shape
// and asserts the allow records do NOT inflate either consumer's opus count.
//
// Run: node tests/v3/state/test-prism-guard-telemetry-skew.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const AGG = join(REPO, 'tools', 'prism-telemetry-aggregate.mjs');
const ROLLUP = join(REPO, 'tools', 'prism-db.mjs');
const ROLLUP_SCRIPT = join(REPO, 'tools', 'prism-rollup-weekly.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

// computeCalibration() in tools/prism-rollup-weekly.mjs windows strictly on
// `Date.now() - 7 days` (wall clock at run time), not on any fixture-supplied
// "now". A fixture pinned to a hardcoded calendar date rots the instant the
// real clock advances 7 days past it — the fixture ages OUT of the window
// and every assertion in this file starts reading an empty rollup, which is
// indistinguishable from a genuine "hooks not firing" defect. Anchor
// fixture timestamps to the actual run-time clock instead (a few hours ago,
// nowhere near the 7-day boundary) so the test can never silently rot.
const NOW_MS = Date.now();
const agoIso = (minutesAgo) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();

// The synthetic log: one legit routing decision (haiku) + two force_opus
// dispatch_guard ALLOW records (tier: opus, blocked: false) — the exact shape
// introduced by the RB-04 visibility fix, never possible before it.
const EVENTS = [
  {event: 'prompt_tier_router', tier: 'haiku', source: 'keyword-floor', summon_panel: false, ts: agoIso(180)},
  {event: 'dispatch_guard', tier: 'opus', blocked: false, reason: 'force_opus', source: 'conversation-model-override', ts: agoIso(179)},
  {event: 'dispatch_guard', tier: 'opus', blocked: false, reason: 'force_opus', source: 'conversation-model-override', ts: agoIso(178)},
];

// ── (a) tools/prism-telemetry-aggregate.mjs: tier_distribution must not count the allow records ──
test('aggregate: tier_distribution.opus stays 0 despite two force_opus ALLOW records', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-tel-skew-'));
  try {
    mkdirSync(join(home, '.claude'), {recursive: true});
    writeFileSync(join(home, '.claude', '.prism-routing.jsonl'), EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [AGG, '--force', '--dry-run', '--home', home], {encoding: 'utf-8', timeout: 15000});
    const out = JSON.parse(r.stdout);
    assertEq(out.tier_distribution.opus, 0, 'opus count must exclude blocked:false dispatch_guard records');
    assertEq(out.tier_distribution.haiku, 1, 'the legit routing-signal haiku count is untouched');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// Drives the REAL rollup-weekly script end-to-end (subprocess) against a
// fresh temp HOME with a pre-seeded, schema-initialized .prism.db
// (rollup-weekly opens it readonly; the schema must already exist or every
// query throws "no such table"). Returns the rendered weekly-digest markdown
// — the only externally observable surface of computeCalibration() (it is
// not exported).
function runRollupWeekly(events) {
  const home = mkdtempSync(join(tmpdir(), 'prism-rollup-skew-'));
  try {
    mkdirSync(join(home, '.claude'), {recursive: true});
    writeFileSync(join(home, '.claude', '.prism-routing.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');

    // Pre-create the sqlite db WITH schema (openDb({readonly:true}) skips the
    // CREATE TABLE statements entirely — see prism-db.mjs — so a from-scratch
    // readonly open on a brand-new HOME throws "no such table: spend").
    const initEnv = {...process.env, HOME: home, USERPROFILE: home};
    const initCode = `import('${pathToFileURL(ROLLUP).href}').then(({openDb, close}) => { close(openDb({readonly:false})); });`;
    const initR = spawnSync(process.execPath, ['--input-type=module', '-e', initCode], {encoding: 'utf-8', env: initEnv, timeout: 15000});
    if (initR.status !== 0) throw new Error(`db init failed: ${initR.stderr}`);

    const r = spawnSync(process.execPath, [ROLLUP_SCRIPT, '--quiet'], {encoding: 'utf-8', env: initEnv, timeout: 15000});
    if (r.status !== 0) throw new Error(`rollup-weekly failed: ${r.stderr}`);

    const outDir = join(home, '.claude', '.prism-rollups');
    return existsSync(outDir) ? readFileSync(join(outDir, findWeekFile(outDir)), 'utf-8') : '';
  } finally { rmSync(home, {recursive: true, force: true}); }
}

function findWeekFile(dir) {
  const names = readdirSync(dir).filter(n => n.endsWith('.md'));
  if (!names.length) throw new Error('no weekly rollup .md written');
  return names[0];
}

// ── (b) tools/prism-rollup-weekly.mjs: computeCalibration()'s `actual` tally must not count the allow records ──
test('rollup-weekly: "Actual model used" stays absent (hasActual=false) despite two force_opus ALLOW records', () => {
  const md = runRollupWeekly(EVENTS);
  if (/Actual model used/.test(md)) {
    throw new Error('"Actual model used" line present — force_opus ALLOW records inflated `actual` (skew NOT fixed)');
  }
  if (!/Advised tier distribution/.test(md)) {
    throw new Error('calibration section missing entirely — test setup broken, not a pass');
  }
});

// ── (c) tools/prism-rollup-weekly.mjs: a genuine dispatch_guard DENY record (blocked:true) must STILL increment `actual` ──
// Proves the exclusion is scoped to the new allow shape only, not an
// over-filter that also swallows the deny path the counter existed for.
const EVENTS_WITH_DENY = [
  {event: 'prompt_tier_router', tier: 'haiku', source: 'keyword-floor', summon_panel: false, ts: agoIso(180)},
  {event: 'dispatch_guard', tier: 'sonnet', blocked: true, reason: 'tier-gate-deny', sentinel_dispatched: false, ts: agoIso(179)},
];
test('rollup-weekly: a dispatch_guard DENY record (blocked:true) still increments `actual` (no over-filter)', () => {
  const md = runRollupWeekly(EVENTS_WITH_DENY);
  if (!/Actual model used:\s+opus 0\.0% \/ sonnet 100\.0% \/ haiku 0\.0%/.test(md)) {
    throw new Error(`expected "Actual model used" to show sonnet 100.0% from the DENY record; got:\n${md}`);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
