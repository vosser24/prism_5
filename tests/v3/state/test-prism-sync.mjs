#!/usr/bin/env node
// Tests for tools/prism-sync.mjs (Phase A.1 helper).
// Drives the helper as a subprocess against ephemeral testbeds.
//
// Run: node tests/v3/state/test-prism-sync.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-sync.mjs');
const BOOTSTRAP = join(__dirname, '..', '..', '..', 'tools', 'prism-bootstrap.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-sync-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

// Shared temp HOME for the generic runner so NO test writes prism_sync events
// (F8) into the real ~/.claude/.prism-routing.jsonl. F8-specific tests use
// runWithHome with their own isolated home to read back the exact lines.
const SHARED_HOME = mkdtempSync(join(tmpdir(), 'prism-sync-home-shared-'));

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd],
    {encoding: 'utf8', env: {...process.env, HOME: SHARED_HOME, USERPROFILE: SHARED_HOME}});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// F8: run with HOME/USERPROFILE redirected to a temp dir so the routing-log
// append (~/.claude/.prism-routing.jsonl) lands in the testbed, never the real
// user log. The helper resolves home as HOME || USERPROFILE || homedir().
function runWithHome(cwd, home, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd],
    {encoding: 'utf8', env: {...process.env, HOME: home, USERPROFILE: home}});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function makeHome(label) {
  return mkdtempSync(join(tmpdir(), `prism-sync-home-${label}-`));
}

function routingLines(home) {
  const p = join(home, '.claude', '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return {raw: l}; }
  });
}

function bootstrap(cwd, ...args) {
  const r = spawnSync(process.execPath, [BOOTSTRAP, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function readStateFile(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.claude', '.prism-state.json'), 'utf8'));
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-sync-nogit-'));
  try {
    const r = run(dir, 'plan');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('plan: no state file → exits 3 with helpful message', () => {
  const root = makeTestbed('plan-nostate');
  try {
    const r = run(root, 'plan');
    assertEq(r.status, 3, r.stderr);
    assert(/no state file/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan: conservative mode lists 4 phases by default (no identity refresh)', () => {
  const root = makeTestbed('plan-cons');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.mode, 'conservative');
    assertEq(out.pending, ['structure', 'discovery', 'roster', 'health']);
    assert(!out.claude_md_changed, 'no CLAUDE.md → no identity refresh');
    assertEq(out.reasons.discovery, 'conservative re-scan');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan: identity included when CLAUDE.md mtime > last_sync_at', () => {
  const root = makeTestbed('plan-claude');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    writeFileSync(join(root, 'CLAUDE.md'), '# tb\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'CLAUDE.md'), future, future);
    const r = run(root, 'plan');
    const out = JSON.parse(r.stdout);
    assert(out.pending.includes('identity'), 'identity should be planned: ' + JSON.stringify(out));
    assert(out.claude_md_changed, 'claude_md_changed flag');
    assertEq(out.reasons.identity, 'CLAUDE.md modified since last sync');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan --smart-drift: prints EXPERIMENTAL warning but falls back to conservative', () => {
  const root = makeTestbed('plan-smart');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan', '--smart-drift');
    assertEq(r.status, 0, r.stderr);
    assert(/EXPERIMENTAL/.test(r.stderr), 'warning on stderr: ' + r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.mode, 'conservative');
    assertEq(out.pending, ['structure', 'discovery', 'roster', 'health']);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: stamps last_sync_at and refreshes phase timestamps', () => {
  const root = makeTestbed('complete-basic');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    assertEq(before.last_sync_at, null, 'fresh state has null last_sync_at');

    const meta = JSON.stringify({
      discovery: {references_count: 12, tables_indexed: 4},
      roster: {agents_registered: 3, orphans_remaining: 0},
      health: {health_status: 'green', checks_passed: 5, checks_failed: 0},
    });
    const r = run(root, 'complete', '--meta', meta);
    assertEq(r.status, 0, r.stderr);
    assert(/sync complete/.test(r.stdout), r.stdout);

    const after = readStateFile(root);
    assert(after.last_sync_at, 'last_sync_at set');
    assert(after.next_sync_recommended, 'next_sync_recommended set');
    const gap = new Date(after.next_sync_recommended).getTime() - new Date(after.last_sync_at).getTime();
    assert(gap > 6 * 86400_000, `next_sync_recommended ~7d ahead, got ${gap}ms`);
    assertEq(after.phases.discovery.references_count, 12);
    assertEq(after.phases.roster.agents_registered, 3);
    assertEq(after.phases.health.health_status, 'green');
    assertEq(after.phases.health.status, 'complete');
    assertEq(after.phases.discovery.completed_at, after.last_sync_at);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: --meta with invalid JSON exits 5', () => {
  const root = makeTestbed('complete-badmeta');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'complete', '--meta', '{not json');
    assertEq(r.status, 5, r.stderr);
    assert(/--meta is not valid JSON/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: no --meta → still stamps sync timestamps, no phase mutations', () => {
  const root = makeTestbed('complete-nometa');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    bootstrap(root, 'phase-structure');
    const before = readStateFile(root);
    const r = run(root, 'complete');
    assertEq(r.status, 0, r.stderr);
    const after = readStateFile(root);
    assert(after.last_sync_at, 'last_sync_at set');
    assert(after.phases.discovery.completed_at, 'discovery refreshed');
    assert(after.phases.roster.completed_at, 'roster refreshed');
    assert(after.phases.health.completed_at, 'health refreshed');
    assertEq(after.phases.structure.dirs_created, before.phases.structure.dirs_created,
      'structure meta preserved');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: no state file exits 3', () => {
  const root = makeTestbed('complete-nostate');
  try {
    const r = run(root, 'complete');
    assertEq(r.status, 3, r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('idempotency: two completes in a row produce valid state with advanced timestamps', () => {
  const root = makeTestbed('idem');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r1 = run(root, 'complete');
    assertEq(r1.status, 0, r1.stderr);
    const after1 = readStateFile(root);

    const r2 = spawnSync('node', ['-e', 'setTimeout(() => process.exit(0), 50)'], {encoding: 'utf8'});
    assertEq(r2.status, 0);

    const r3 = run(root, 'complete');
    assertEq(r3.status, 0, r3.stderr);
    const after2 = readStateFile(root);

    assert(after2.last_sync_at > after1.last_sync_at, 'last_sync_at advanced');
    const planR = run(root, 'plan');
    assertEq(planR.status, 0, 'state valid after two completes: ' + planR.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('crash safety: complete fails atomically — state stays valid on bad --meta', () => {
  const root = makeTestbed('crash');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    const r = run(root, 'complete', '--meta', '{not json');
    assertEq(r.status, 5);
    const after = readStateFile(root);
    assertEq(after.last_sync_at, before.last_sync_at, 'state unchanged on meta error');
    assertEq(after.checksum, before.checksum, 'checksum unchanged');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ------------------------------ F8: routing-log observability ------------------------------

test('F8 FIRE: plan on stateless root → exit 3 AND a prism_sync/no-state routing line', () => {
  const root = makeTestbed('f8-fire');
  const home = makeHome('f8-fire');
  try {
    const r = runWithHome(root, home, 'plan');
    assertEq(r.status, 3, r.stderr);
    assert(/no state file/.test(r.stderr), 'exit-3 STOP message preserved: ' + r.stderr);
    const hits = routingLines(home).filter((l) => l.event === 'prism_sync' && l.action === 'no-state');
    assertEq(hits.length, 1, 'exactly one no-state line: ' + JSON.stringify(routingLines(home)));
    assertEq(hits[0].root, root, 'no-state line records the root');
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

test('F8 GOOD: complete on bootstrapped fixture → last_sync_at advances AND a prism_sync/complete line', () => {
  const root = makeTestbed('f8-good');
  const home = makeHome('f8-good');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    assertEq(before.last_sync_at, null, 'fresh state has null last_sync_at');
    const r = runWithHome(root, home, 'complete');
    assertEq(r.status, 0, r.stderr);
    const after = readStateFile(root);
    assert(after.last_sync_at, 'last_sync_at advanced in the state file');
    const hits = routingLines(home).filter((l) => l.event === 'prism_sync' && l.action === 'complete');
    assertEq(hits.length, 1, 'exactly one complete line: ' + JSON.stringify(routingLines(home)));
    assertEq(hits[0].last_sync_at, after.last_sync_at, 'logged last_sync_at matches the state stamp');
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

test('F8 QUIET: --help and --meta arg errors append NO routing lines', () => {
  const root = makeTestbed('f8-quiet');
  const home = makeHome('f8-quiet');
  try {
    const help = runWithHome(root, home, '--help');
    assertEq(help.status, 0, 'help exits 0');
    bootstrap(root, 'init-state-if-missing', 'tb');
    const bad = runWithHome(root, home, 'complete', '--meta', '{not json');
    assertEq(bad.status, 5, 'bad --meta exits 5: ' + bad.stderr);
    const prismSync = routingLines(home).filter((l) => l.event === 'prism_sync');
    assertEq(prismSync.length, 0, 'no prism_sync lines on help/arg errors: ' + JSON.stringify(routingLines(home)));
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

rmSync(SHARED_HOME, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
