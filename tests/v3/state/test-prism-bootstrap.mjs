#!/usr/bin/env node
// Tests for tools/prism-bootstrap.mjs (Phase 2 helper).
// Drives the helper as a subprocess against ephemeral testbeds.
//
// Run: node tests/v3/state/test-prism-bootstrap.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-bootstrap.mjs');

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
  const root = mkdtempSync(join(tmpdir(), `prism-bootstrap-test-${label}-`));
  // Create .git so the guard passes
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function readStateFile(cwd) {
  const path = join(cwd, '.claude', '.prism-state.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-bootstrap-nogit-'));
  try {
    const r = run(dir, 'plan');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('init-state-if-missing creates fresh state', () => {
  const root = makeTestbed('init');
  try {
    const r = run(root, 'init-state-if-missing', 'tb');
    assertEq(r.status, 0, r.stderr);
    assert(/initialized state for "tb"/.test(r.stdout));
    assert(/mode: fresh/.test(r.stdout));
    const state = readStateFile(root);
    assertEq(state.project_name, 'tb');
    assertEq(state.schema_version, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('init-state-if-missing detect-and-adopts v3.8.9 tree', () => {
  const root = makeTestbed('adopt');
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# tb\n');
    const claudeDir = join(root, '.claude');
    spawnSync('mkdir', ['-p', join(claudeDir, 'references'), join(claudeDir, 'agents')]);
    writeFileSync(join(claudeDir, 'agents', 'roster.json'), '[]');
    const r = run(root, 'init-state-if-missing', 'tb');
    assertEq(r.status, 0, r.stderr);
    assert(/mode: detect-and-adopt/.test(r.stdout));
    assert(/identity/.test(r.stdout));
    const state = readStateFile(root);
    assert(state.phases.identity.completed_at, 'identity adopted');
    assertEq(state.phases.identity.synthesized, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('init-state-if-missing is idempotent (no overwrite of valid state)', () => {
  const root = makeTestbed('idem');
  try {
    run(root, 'init-state-if-missing', 'first');
    const before = readStateFile(root);
    const r = run(root, 'init-state-if-missing', 'second-name-ignored');
    assertEq(r.status, 0);
    assert(/already initialized/.test(r.stdout));
    const after = readStateFile(root);
    assertEq(after.project_name, 'first', 'name not overwritten');
    assertEq(after.initialized_at, before.initialized_at);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan: lists pending phases for a fresh state', () => {
  const root = makeTestbed('plan-fresh');
  try {
    run(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.pending, ['identity', 'structure', 'discovery', 'roster', 'health']);
    assertEq(out.completed, []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan --skip-discover excludes discovery', () => {
  const root = makeTestbed('plan-skip');
  try {
    run(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan', '--skip-discover');
    const out = JSON.parse(r.stdout);
    assert(!out.pending.includes('discovery'));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan --force re-includes completed phases', () => {
  const root = makeTestbed('plan-force');
  try {
    run(root, 'init-state-if-missing', 'tb');
    run(root, 'phase-structure');
    const r = run(root, 'plan', '--force');
    const out = JSON.parse(r.stdout);
    assert(out.pending.includes('structure'));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('phase-structure creates 8 dirs and is idempotent', () => {
  const root = makeTestbed('struct');
  try {
    run(root, 'init-state-if-missing', 'tb');
    const r1 = run(root, 'phase-structure');
    assertEq(r1.status, 0, r1.stderr);
    assert(/created=8/.test(r1.stdout));
    for (const d of ['.claude/references', '.claude/rules', '.claude/agents', '.claude/hooks',
                     'docs/prism/adjudications', 'docs/prism/deviations', 'docs/prism/smoke', 'tasks']) {
      assert(existsSync(join(root, d)), `${d} should exist`);
    }
    // Idempotent re-run
    const r2 = run(root, 'phase-structure');
    assertEq(r2.status, 0);
    assert(/created=0 existed=8/.test(r2.stdout));
    // Phase marked complete with metadata
    const state = readStateFile(root);
    assert(state.phases.structure.completed_at, 'completed_at set');
    assertEq(state.phases.structure.dirs_created, 0, 'meta from latest run');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('phase-structure --dry-run does not create dirs or update state', () => {
  const root = makeTestbed('struct-dry');
  try {
    run(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    const r = run(root, 'phase-structure', '--dry-run');
    assertEq(r.status, 0);
    assert(/DRY-RUN/.test(r.stdout));
    assert(!existsSync(join(root, 'tasks')), 'tasks should NOT exist after dry-run');
    const after = readStateFile(root);
    assertEq(after.phases.structure.completed_at, before.phases.structure.completed_at);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('phase-conventions writes capture-conventions.md', () => {
  const root = makeTestbed('conv');
  try {
    run(root, 'init-state-if-missing', 'tb');
    run(root, 'phase-structure');
    const r = run(root, 'phase-conventions');
    assertEq(r.status, 0, r.stderr);
    assert(/wrote/.test(r.stdout));
    const path = join(root, '.claude/rules/capture-conventions.md');
    assert(existsSync(path));
    const body = readFileSync(path, 'utf8');
    assert(body.includes('# Capture conventions'));
    // Idempotent
    const r2 = run(root, 'phase-conventions');
    assert(/already present/.test(r2.stdout));
    // State records conventions_written
    const state = readStateFile(root);
    assertEq(state.phases.structure.conventions_written, true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('start-phase + complete-phase round trip', () => {
  const root = makeTestbed('round');
  try {
    run(root, 'init-state-if-missing', 'tb');
    run(root, 'start-phase', 'identity');
    let state = readStateFile(root);
    assertEq(state.last_command, 'bootstrap:identity');
    run(root, 'complete-phase', 'identity', '--meta', '{"claude_md_lines":190}');
    state = readStateFile(root);
    assertEq(state.last_command, null, 'cleared after complete');
    assert(state.phases.identity.completed_at);
    assertEq(state.phases.identity.claude_md_lines, 190);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('fail-phase appends to phase_failures', () => {
  const root = makeTestbed('fail');
  try {
    run(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'fail-phase', 'discovery', 'DB unreachable');
    assertEq(r.status, 0, r.stderr);
    const state = readStateFile(root);
    assertEq(state.phase_failures.length, 1);
    assertEq(state.phase_failures[0].phase, 'discovery');
    assert(/DB unreachable/.test(state.phase_failures[0].error));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan refuses to read corrupted state (exits non-zero)', () => {
  const root = makeTestbed('corrupt');
  try {
    run(root, 'init-state-if-missing', 'tb');
    // Tamper without rechecksumming
    const path = join(root, '.claude/.prism-state.json');
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    obj.project_name = 'tampered';
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
    const r = run(root, 'plan');
    assert(r.status !== 0);
    assert(/checksum_mismatch/.test(r.stderr));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('full bootstrap walk: init → structure → conventions → individual phase completes', () => {
  const root = makeTestbed('walk');
  try {
    run(root, 'init-state-if-missing', 'tb');
    run(root, 'phase-structure');
    run(root, 'phase-conventions');
    run(root, 'start-phase', 'identity');
    run(root, 'complete-phase', 'identity', '--meta', '{"claude_md_lines":210,"had_existing":false}');
    run(root, 'start-phase', 'discovery');
    run(root, 'complete-phase', 'discovery', '--meta', '{"references_count":5}');
    run(root, 'start-phase', 'roster');
    run(root, 'complete-phase', 'roster', '--meta', '{"agents_registered":12,"orphans_remaining":0}');
    run(root, 'start-phase', 'health');
    run(root, 'complete-phase', 'health', '--meta', '{"status":"green"}');
    const r = run(root, 'plan');
    const out = JSON.parse(r.stdout);
    assertEq(out.pending, []);
    assertEq(out.completed, ['identity', 'structure', 'discovery', 'roster', 'health']);
    const state = readStateFile(root);
    assertEq(state.phases.health.status, 'green');
    assertEq(state.phases.discovery.references_count, 5);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ------------------------------ summary ------------------------------

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
