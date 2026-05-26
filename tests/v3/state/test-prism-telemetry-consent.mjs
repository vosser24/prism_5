#!/usr/bin/env node
// Tests for v4.1 Phase C — telemetry auto-opt-in + aggregate.
//
// Covers:
//   - tools/prism-bootstrap.mjs detect-telemetry-consent (read)
//   - tools/prism-bootstrap.mjs set-telemetry-consent on/off (write)
//   - tools/prism-telemetry-aggregate.mjs (consent gate + rollup math)
//
// Each test uses an ephemeral $HOME so writes don't touch the real
// ~/.claude/prism-policy.json or rollup file.
//
// Run: node tests/v3/state/test-prism-telemetry-consent.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'tools', 'prism-bootstrap.mjs');
const AGGREGATE = join(REPO_ROOT, 'tools', 'prism-telemetry-aggregate.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assertContains(s, n, msg) {
  if (!s || !s.includes(n)) throw new Error(`expected to contain "${n}", got ${JSON.stringify(s)}${msg ? ' — ' + msg : ''}`);
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-telemetry-home-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

// Strip v4.2 env-var opt-outs from the test process env so the default-case
// tests run regardless of whether the developer / CI runner has those set
// globally. Per-test we explicitly RE-INJECT via the `extraEnv` arg when
// testing the override path.
function baseEnv(home, extraEnv = {}) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  delete env.DISABLE_TELEMETRY;
  delete env.DO_NOT_TRACK;
  return {...env, ...extraEnv};
}

function runBootstrap(home, ...args) {
  // Allow trailing {env: {...}} object to inject env vars for override tests.
  let extraEnv = {};
  if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
    extraEnv = args.pop().env || {};
  }
  const r = spawnSync(process.execPath, [BOOTSTRAP, ...args, '--home', home, '--no-git-guard'], {
    encoding: 'utf-8',
    timeout: 10000,
    env: baseEnv(home, extraEnv),
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function runAggregate(home, ...args) {
  let extraEnv = {};
  if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) {
    extraEnv = args.pop().env || {};
  }
  const r = spawnSync(process.execPath, [AGGREGATE, '--home', home, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
    env: baseEnv(home, extraEnv),
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function writeLog(home, events) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(home, '.claude', '.prism-routing.jsonl'), lines);
}

// ─── consent subcommands ──────────────────────────────────────────────

test('detect-telemetry-consent: opt_in=null when policy file absent', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'detect-telemetry-consent');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.policy_exists, false);
    assertEq(out.opt_in, null);
    assertEq(out.parse_error, null);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent on: writes opt_in=true', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'on');
    assertEq(r.status, 0, r.stderr);
    const policy = JSON.parse(readFileSync(join(home, '.claude', 'prism-policy.json'), 'utf-8'));
    assertEq(policy.telemetry.opt_in, true);
    assert(policy.telemetry.asked_at, 'asked_at stamped');
    assert(policy.schema_version, 'schema_version set on first write');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent off: writes opt_in=false', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'off');
    assertEq(r.status, 0, r.stderr);
    const policy = JSON.parse(readFileSync(join(home, '.claude', 'prism-policy.json'), 'utf-8'));
    assertEq(policy.telemetry.opt_in, false);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent: preserves other top-level keys', () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', 'prism-policy.json'), {
      schema_version: '3.1.0',
      preserved: {nested: 'value'},
    });
    runBootstrap(home, 'set-telemetry-consent', 'on');
    const policy = JSON.parse(readFileSync(join(home, '.claude', 'prism-policy.json'), 'utf-8'));
    assertEq(policy.preserved, {nested: 'value'});
    assertEq(policy.telemetry.opt_in, true);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent: rejects bad value with exit 22', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'maybe');
    assertEq(r.status, 22, r.stderr);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('detect-telemetry-consent: surfaces parse_error on malformed policy', () => {
  const home = makeHome();
  try {
    writeFileSync(join(home, '.claude', 'prism-policy.json'), '{not valid json');
    const r = runBootstrap(home, 'detect-telemetry-consent');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert(out.parse_error, 'expected parse_error: ' + JSON.stringify(out));
    assertEq(out.opt_in, null);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── aggregate helper ─────────────────────────────────────────────────

test('aggregate: refuses without opt-in (exit 13)', () => {
  const home = makeHome();
  try {
    writeLog(home, [{event: 'x', ts: '2026-01-01T00:00:00Z'}]);
    const r = runAggregate(home);
    assertEq(r.status, 13, r.stderr);
    assertContains(r.stderr, 'opt-in not set');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate: refuses when log missing (exit 14)', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    const r = runAggregate(home);
    assertEq(r.status, 14, r.stderr);
    assertContains(r.stderr, 'no routing log');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate: writes rollup with event counts', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    writeLog(home, [
      {event: 'classify', tier: 'sonnet', classifier_source: 'cache', ts: '2026-01-01T00:00:00Z'},
      {event: 'classify', tier: 'opus', classifier_source: 'opus', ts: '2026-01-01T00:01:00Z'},
      {event: 'classify', tier: 'haiku', classifier_source: 'keyword-floor', ts: '2026-01-01T00:02:00Z'},
    ]);
    const r = runAggregate(home);
    assertEq(r.status, 0, r.stderr);
    const rollup = JSON.parse(readFileSync(join(home, '.claude', '.prism-telemetry-rollup.json'), 'utf-8'));
    assertEq(rollup.events_aggregated, 3);
    assertEq(rollup.tier_distribution, {haiku: 1, sonnet: 1, opus: 1});
    assertEq(rollup.classifier_sources.cache, 1);
    assertEq(rollup.classifier_sources.opus, 1);
    assertEq(rollup.classifier_sources['keyword-floor'], 1);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate: surfaces tuning candidate when one guard dominates', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    // 4 mutation denies + 1 safety deny → mutation accounts for 80%
    writeLog(home, [
      {event: 'guard', guard_deny: 'mutation', ts: '2026-01-01T00:00:00Z'},
      {event: 'guard', guard_deny: 'mutation', ts: '2026-01-01T00:01:00Z'},
      {event: 'guard', guard_deny: 'mutation', ts: '2026-01-01T00:02:00Z'},
      {event: 'guard', guard_deny: 'mutation', ts: '2026-01-01T00:03:00Z'},
      {event: 'guard', guard_deny: 'safety', ts: '2026-01-01T00:04:00Z'},
    ]);
    const r = runAggregate(home);
    assertEq(r.status, 0, r.stderr);
    const rollup = JSON.parse(readFileSync(join(home, '.claude', '.prism-telemetry-rollup.json'), 'utf-8'));
    assert(rollup.tuning_candidates.length >= 1, 'expected at least one tuning candidate');
    const mut = rollup.tuning_candidates.find((c) => c.guard === 'mutation');
    assert(mut, 'mutation guard should be a tuning candidate');
    assertEq(mut.deny_count, 4);
    assert(mut.share_of_denies >= 75, 'expected share_of_denies ≥75%');
    assertContains(mut.recommendation, 'mutation');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate --dry-run: prints JSON, does NOT write file', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    writeLog(home, [{event: 'x', ts: '2026-01-01T00:00:00Z'}]);
    const r = runAggregate(home, '--dry-run');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.events_aggregated, 1);
    assert(!existsSync(join(home, '.claude', '.prism-telemetry-rollup.json')), 'dry-run must not write rollup');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate --force: bypasses opt-in gate (test path)', () => {
  const home = makeHome();
  try {
    writeLog(home, [{event: 'x', ts: '2026-01-01T00:00:00Z'}]);
    const r = runAggregate(home, '--force', '--dry-run');
    assertEq(r.status, 0, r.stderr);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── v4.2: env-var opt-out (DISABLE_TELEMETRY / DO_NOT_TRACK) ────────

test('aggregate: DISABLE_TELEMETRY=1 overrides opt_in=true (exit 13, env-reason in stderr)', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    writeLog(home, [{event: 'x', ts: '2026-01-01T00:00:00Z'}]);
    const r = runAggregate(home, {env: {DISABLE_TELEMETRY: '1'}});
    assertEq(r.status, 13, r.stderr);
    assertContains(r.stderr, 'DISABLE_TELEMETRY');
    assertContains(r.stderr, 'industry-standard');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('aggregate: DO_NOT_TRACK=1 overrides opt_in=true (exit 13)', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    writeLog(home, [{event: 'x', ts: '2026-01-01T00:00:00Z'}]);
    const r = runAggregate(home, {env: {DO_NOT_TRACK: '1'}});
    assertEq(r.status, 13, r.stderr);
    assertContains(r.stderr, 'DO_NOT_TRACK');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent on with DISABLE_TELEMETRY=1: forces opt_in=false + stderr explainer', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'on', {env: {DISABLE_TELEMETRY: '1'}});
    assertEq(r.status, 0, r.stderr);
    assertContains(r.stderr, 'DISABLE_TELEMETRY');
    assertContains(r.stderr, 'forcing opt_in:false');
    const policy = JSON.parse(readFileSync(join(home, '.claude', 'prism-policy.json'), 'utf-8'));
    assertEq(policy.telemetry.opt_in, false, 'env var must force false even when CLI said on');
    const out = JSON.parse(r.stdout);
    assertEq(out.forced_off_by_env, 'DISABLE_TELEMETRY');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent on with DO_NOT_TRACK=1: forces opt_in=false', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'on', {env: {DO_NOT_TRACK: '1'}});
    assertEq(r.status, 0, r.stderr);
    const policy = JSON.parse(readFileSync(join(home, '.claude', 'prism-policy.json'), 'utf-8'));
    assertEq(policy.telemetry.opt_in, false);
    const out = JSON.parse(r.stdout);
    assertEq(out.forced_off_by_env, 'DO_NOT_TRACK');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('set-telemetry-consent off with env var set: no stderr explainer (no contradiction)', () => {
  const home = makeHome();
  try {
    const r = runBootstrap(home, 'set-telemetry-consent', 'off', {env: {DISABLE_TELEMETRY: '1'}});
    assertEq(r.status, 0, r.stderr);
    assert(!r.stderr.includes('forcing opt_in:false'), 'no explainer when CLI already said off');
    const out = JSON.parse(r.stdout);
    assertEq(out.forced_off_by_env, 'DISABLE_TELEMETRY', 'still annotates env var in result for inspectability');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('detect-telemetry-consent with DISABLE_TELEMETRY=1: returns forced_off_by_env + effective_opt_in=false', () => {
  const home = makeHome();
  try {
    runBootstrap(home, 'set-telemetry-consent', 'on');
    const r = runBootstrap(home, 'detect-telemetry-consent', {env: {DISABLE_TELEMETRY: '1'}});
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.opt_in, true, 'file state preserved (env override is layered separately)');
    assertEq(out.forced_off_by_env, 'DISABLE_TELEMETRY');
    assertEq(out.effective_opt_in, false);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
