#!/usr/bin/env node
// Tests for v5.x FIX-B — telemetry aggregator bucket-matching.
// Stress-test finding: guard_denies / classifier_sources / panel_summons read 0
// in the rollup despite the raw log clearly containing those events, because the
// aggregator read fields (`guard_deny`, `classifier_source`, `panel_summon`) that
// don't match the emitted schema (`event`+`blocked`, `source`, `summon_panel`).
//
// Run: node tests/v3/state/test-prism-telemetry-buckets.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const AGG = join(REPO, 'tools', 'prism-telemetry-aggregate.mjs');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

// A routing log written in the REAL emitted schema.
const EVENTS = [
  {event: 'prompt_tier_router', tier: 'haiku', source: 'keyword-floor', summon_panel: false, ts: '2026-06-01T00:00:01Z'},
  {event: 'prompt_tier_router', tier: 'opus', source: 'keyword-floor', summon_panel: true, ts: '2026-06-01T00:00:02Z'},
  {event: 'prompt_tier_router', tier: 'opus', source: 'force-opus', force_opus: true, summon_panel: false, ts: '2026-06-01T00:00:03Z'},
  {event: 'mutation_guard', blocked: true, tool: 'Write', ts: '2026-06-01T00:00:04Z'},
  {event: 'mutation_guard', blocked: false, reason: 'subagent-parent-tool-use-id-passthrough', ts: '2026-06-01T00:00:05Z'},
  {event: 'dispatch_guard_panel', blocked: true, ts: '2026-06-01T00:00:06Z'},
  {event: 'parallel_guard', blocked: true, ts: '2026-06-01T00:00:07Z'},
  {event: 'skill_trigger_guard', blocked: true, ts: '2026-06-01T00:00:08Z'},
];

function runAgg() {
  const home = mkdtempSync(join(tmpdir(), 'prism-tel-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  writeFileSync(join(home, '.claude', '.prism-routing.jsonl'), EVENTS.map(e => JSON.stringify(e)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [AGG, '--force', '--dry-run', '--home', home], {encoding: 'utf-8', timeout: 15000});
  rmSync(home, {recursive: true, force: true});
  return JSON.parse(r.stdout);
}

test('classifier_sources counts the `source` field on routing events', () => {
  const r = runAgg();
  assertEq(r.classifier_sources['keyword-floor'], 2, 'keyword-floor');
  assertEq(r.classifier_sources['force-opus'], 1, 'force-opus');
});

test('guard_denies counts guard events with blocked===true, by guard', () => {
  const r = runAgg();
  assertEq(r.guard_denies.mutation, 1, 'mutation (1 blocked, 1 passthrough)');
  assertEq(r.guard_denies.dispatch, 1, 'dispatch (dispatch_guard_panel blocked)');
  assertEq(r.guard_denies.parallel, 1, 'parallel');
  assertEq(r.guard_denies.skill_trigger, 1, 'skill_trigger');
});

test('panel_summons counts the `summon_panel` field', () => {
  const r = runAgg();
  assertEq(r.panel_summons.true, 1, 'one panel summon');
  assertEq(r.panel_summons.false, 2, 'two non-panel router events');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
