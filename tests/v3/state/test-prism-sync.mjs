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

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
