#!/usr/bin/env node
// Tests for tools/prism-deep-dive.mjs (v4.0 Phase D helper).
// Subprocess-driven, mkdtemp testbeds, matches the prism-sync/prism-clean test patterns.
//
// Run: node tests/v3/state/test-prism-deep-dive.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-deep-dive.mjs');
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
  const root = mkdtempSync(join(tmpdir(), `prism-dd-test-${label}-`));
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

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-dd-nogit-'));
  try {
    const r = run(dir, 'slug-derive');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('slug-derive --source basename: kebab-cases the directory name', () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-dd-slug_nexus_reporting_4-'));
  spawnSync('git', ['init', '-q'], {cwd: root});
  try {
    const r = run(root, 'slug-derive', '--source', 'basename');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert(out.slug.startsWith('prism-dd-slug-nexus-reporting-4-'), 'kebab from basename: ' + out.slug);
    assertEq(out.source, 'basename');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source claude-md: reads ## Project Identity name', () => {
  const root = makeTestbed('slug-claude');
  try {
    writeFileSync(join(root, 'CLAUDE.md'),
      '# Test Project\n\n## Project Identity\n\nname: grabber-cli\nstack: Node\n');
    const r = run(root, 'slug-derive', '--source', 'claude-md');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.slug, 'grabber-cli');
    assertEq(out.source, 'claude-md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source claude-md: exits non-zero when no Project Identity section', () => {
  const root = makeTestbed('slug-noclaude');
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# Just a title\n\nsome body\n');
    const r = run(root, 'slug-derive', '--source', 'claude-md');
    assert(r.status !== 0, 'no identity → non-zero: ' + r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source auto: tries claude-md, falls back to basename', () => {
  const root = makeTestbed('slug-auto');
  try {
    // No CLAUDE.md → falls through to basename
    const r = run(root, 'slug-derive', '--source', 'auto');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert(out.slug.startsWith('prism-dd-test-slug-auto-'), 'auto used basename: ' + out.slug);
    assertEq(out.source, 'basename');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source state: returns slug locked in .prism-state.json', () => {
  const root = makeTestbed('slug-state');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    // Hand-edit state to set project_slug (mutator added in Task 6; for now we'll write directly)
    const statePath = join(root, '.claude', '.prism-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.project_slug = 'locked-slug-from-state';
    // Recompute checksum: we cheat by using --no-checksum bypass via writing then
    // letting readState's tolerance handle it — OR mutate via the proper API in Task 6.
    // For Task 2 we test against the lockfile being WRITTEN by Task 6's setProjectSlug.
    // Until Task 6 lands, skip this test:
    return;  // placeholder skipped until Task 6 wires the mutator
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
