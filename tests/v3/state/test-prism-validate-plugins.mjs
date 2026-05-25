#!/usr/bin/env node
// Tests for tools/prism-validate-plugins.mjs (Phase C).
// Drives the helper as a subprocess against ephemeral testbeds, mocking
// `claude plugin list --json` via the PRISM_PLUGIN_LIST_FIXTURE env var.
//
// Run: node tests/v3/state/test-prism-validate-plugins.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-validate-plugins.mjs');

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
  const root = mkdtempSync(join(tmpdir(), `prism-vp-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

function writeFixture(root, obj) {
  const path = join(root, 'fixture.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

function run(cwd, args, fixturePath) {
  const env = {...process.env};
  if (fixturePath) env.PRISM_PLUGIN_LIST_FIXTURE = fixturePath;
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {
    encoding: 'utf8',
    env,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-vp-nogit-'));
  try {
    const r = run(dir, ['audit']);
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('audit: empty plugin list → no findings, exit 0', () => {
  const root = makeTestbed('empty');
  try {
    const fixturePath = writeFixture(root, {plugins: []});
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.findings, []);
    assertEq(out.plugins_audited, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: detects broken hook command (file does not exist)', () => {
  const root = makeTestbed('hook');
  try {
    const fixturePath = writeFixture(root, {
      plugins: [{
        name: 'sample',
        version: '1.0.0',
        hooks: [
          {event: 'PostToolUse', command: 'bash /nonexistent/path/to/hook.sh'},
        ],
      }],
    });
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 1, 'broken_hook is error-level → exit 1 ' + r.stderr);
    const out = JSON.parse(r.stdout);
    const broken = out.findings.filter(f => f.type === 'broken_hook');
    assertEq(broken.length, 1, 'one broken_hook finding: ' + JSON.stringify(out));
    assertEq(broken[0].level, 'error');
    assert(/nonexistent/.test(broken[0].message), broken[0].message);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: ignores hook commands without a file argument (raw shell commands)', () => {
  const root = makeTestbed('rawcmd');
  try {
    const fixturePath = writeFixture(root, {
      plugins: [{
        name: 'sample',
        version: '1.0.0',
        hooks: [
          {event: 'SessionEnd', command: 'echo done'},  // no file path
        ],
      }],
    });
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0);
    const out = JSON.parse(r.stdout);
    assertEq(out.findings.filter(f => f.type === 'broken_hook').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: detects skill name conflict across plugins', () => {
  const root = makeTestbed('skillconflict');
  try {
    const fixturePath = writeFixture(root, {
      plugins: [
        {name: 'plugin-a', version: '1.0', skills: [{name: 'shared'}, {name: 'unique-a'}]},
        {name: 'plugin-b', version: '2.0', skills: [{name: 'shared'}, {name: 'unique-b'}]},
      ],
    });
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const conflicts = out.findings.filter(f => f.type === 'skill_conflict');
    assertEq(conflicts.length, 1, 'one skill_conflict: ' + JSON.stringify(out.findings));
    assertEq(conflicts[0].level, 'warn');
    assert(/shared/.test(conflicts[0].message), conflicts[0].message);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: detects missing plugin manifest (path field set but file gone)', () => {
  const root = makeTestbed('manifest');
  try {
    const fixturePath = writeFixture(root, {
      plugins: [{
        name: 'sample',
        version: '1.0.0',
        path: '/nonexistent/plugin/dir',
      }],
    });
    const r = run(root, ['audit', '--json'], fixturePath);
    const out = JSON.parse(r.stdout);
    const missing = out.findings.filter(f => f.type === 'missing_manifest');
    assertEq(missing.length, 1, 'one missing_manifest: ' + JSON.stringify(out.findings));
    assertEq(missing[0].level, 'error');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: plugin with valid manifest dir → no missing_manifest finding', () => {
  const root = makeTestbed('manifestok');
  try {
    const pluginDir = join(root, 'plugin-real');
    mkdirSync(pluginDir, {recursive: true});
    writeFileSync(join(pluginDir, 'manifest.json'), '{}');
    const fixturePath = writeFixture(root, {
      plugins: [{name: 'sample', version: '1.0.0', path: pluginDir}],
    });
    const r = run(root, ['audit', '--json'], fixturePath);
    const out = JSON.parse(r.stdout);
    assertEq(out.findings.filter(f => f.type === 'missing_manifest').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: malformed fixture JSON → exit 8 with error', () => {
  const root = makeTestbed('malformed');
  try {
    const fixturePath = join(root, 'bad.json');
    writeFileSync(fixturePath, 'this is not json');
    const r = run(root, ['audit'], fixturePath);
    assertEq(r.status, 8);
    assert(/JSON/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: human-readable output by default (no --json)', () => {
  const root = makeTestbed('human');
  try {
    const fixturePath = writeFixture(root, {plugins: []});
    const r = run(root, ['audit'], fixturePath);
    assertEq(r.status, 0);
    // Should not be raw JSON
    assert(!r.stdout.trim().startsWith('{'), 'human output: ' + r.stdout);
    assert(/plugin/i.test(r.stdout), r.stdout);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: non-zero finding exit code when findings include error level', () => {
  const root = makeTestbed('exit');
  try {
    const fixturePath = writeFixture(root, {
      plugins: [{name: 's', version: '1', path: '/does/not/exist'}],
    });
    const r = run(root, ['audit'], fixturePath);
    // Exit code policy: 0 = clean, 1 = findings present at error level, 2 = guard
    assertEq(r.status, 1, 'errors present → exit 1');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
