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

// ------------------------------ real CLI schema (regression) ------------------------------
// `claude plugin list --json` emits a TOP-LEVEL ARRAY of
//   {id, version, scope, enabled, installPath, installedAt, lastUpdated, mcpServers}
// — NOT {plugins:[{name, path, hooks, skills}]}. The list output exposes
// neither hooks nor skills, so those checks must read the plugin's on-disk
// layout (.claude-plugin/plugin.json + hooks/hooks.json + skills/*/).

test('audit: real CLI top-level array is audited (regression — was 0)', () => {
  const root = makeTestbed('toparray');
  try {
    const pdir = join(root, 'p1');
    mkdirSync(pdir, {recursive: true});
    const fixturePath = writeFixture(root, [
      {id: 'plugin-a@mkt', version: '1.0', installPath: pdir, enabled: true},
      {id: 'plugin-b@mkt', version: '1.0', installPath: pdir, enabled: true},
    ]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.plugins_audited, 2, 'top-level array must be audited, not 0');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: top-level array maps installPath + id (missing_manifest)', () => {
  const root = makeTestbed('installpath');
  try {
    const fixturePath = writeFixture(root, [
      {id: 'gone@mkt', version: '1', installPath: join(root, 'nope-dir')},
    ]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 1, 'missing installPath is error → exit 1: ' + r.stderr);
    const out = JSON.parse(r.stdout);
    const mm = out.findings.filter(f => f.type === 'missing_manifest');
    assertEq(mm.length, 1, JSON.stringify(out.findings));
    assertEq(mm[0].plugin, 'gone@mkt', 'plugin name should come from id');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: disk-backed broken_hook detects missing file via hooks/hooks.json', () => {
  const root = makeTestbed('diskhook');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, 'hooks'), {recursive: true});
    writeFileSync(join(pdir, 'hooks', 'hooks.json'), JSON.stringify({
      PreToolUse: [{hooks: [{type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/ghost.mjs"'}]}],
    }));
    const fixturePath = writeFixture(root, [{id: 'p@mkt', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 1, r.stderr);
    const bh = JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook');
    assertEq(bh.length, 1, 'one broken_hook for ghost.mjs: ' + r.stdout);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: disk-backed broken_hook does NOT flag an existing hook file (no false positive)', () => {
  const root = makeTestbed('diskhookok');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, 'hooks'), {recursive: true});
    writeFileSync(join(pdir, 'hooks', 'real.mjs'), '// hook');
    writeFileSync(join(pdir, 'hooks', 'hooks.json'), JSON.stringify({
      PostToolUse: [{hooks: [{type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/real.mjs"'}]}],
    }));
    const fixturePath = writeFixture(root, [{id: 'p@mkt', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stderr);
    assertEq(JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: broken_hook skips commands with unresolvable env vars (conservative)', () => {
  const root = makeTestbed('unresolv');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, 'hooks'), {recursive: true});
    writeFileSync(join(pdir, 'hooks', 'hooks.json'), JSON.stringify({
      PreToolUse: [{hooks: [{type: 'command', command: 'node "${TOTALLY_UNKNOWN_VAR_XYZ}/x.mjs"'}]}],
    }));
    const fixturePath = writeFixture(root, [{id: 'p@mkt', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, 'unresolvable var → skipped, not flagged: ' + r.stderr);
    assertEq(JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: disk-backed skill_conflict across plugins via skills/*/ dirs', () => {
  const root = makeTestbed('diskskill');
  try {
    const a = join(root, 'pa'), b = join(root, 'pb');
    mkdirSync(join(a, 'skills', 'shared'), {recursive: true});
    mkdirSync(join(a, 'skills', 'only-a'), {recursive: true});
    mkdirSync(join(b, 'skills', 'shared'), {recursive: true});
    const fixturePath = writeFixture(root, [
      {id: 'pa@mkt', installPath: a},
      {id: 'pb@mkt', installPath: b},
    ]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stderr);
    const sc = JSON.parse(r.stdout).findings.filter(f => f.type === 'skill_conflict');
    assertEq(sc.length, 1, JSON.stringify(sc));
    assert(/shared/.test(sc[0].message), sc[0].message);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: disk-backed broken_hook from .claude-plugin/plugin.json hooks', () => {
  const root = makeTestbed('manifesthook');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, '.claude-plugin'), {recursive: true});
    writeFileSync(join(pdir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'p', version: '1',
      hooks: {Stop: [{hooks: [{type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/missing.mjs"'}]}]},
    }));
    const fixturePath = writeFixture(root, [{id: 'p@mkt', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 1, r.stderr);
    assertEq(JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook').length, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// Conservative false-positive guards (D004 risk register #5). Real plugins
// (e.g. claude-mem) ship inline shell-script hooks with embedded globs — these
// have no single target file and MUST NOT be flagged as broken.

test('audit: broken_hook does NOT flag inline shell-script hooks (claude-mem repro)', () => {
  const root = makeTestbed('inlinescript');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, 'hooks'), {recursive: true});
    writeFileSync(join(pdir, 'hooks', 'hooks.json'), JSON.stringify({
      SessionStart: [{hooks: [{type: 'command',
        command: '_C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; ls -dt "$HOME/.codex/plugins/cache/claude-mem"/[0-9]*/ 2>/dev/null; exec node "$_P/scripts/mcp-server.cjs"'}]}],
    }));
    const fixturePath = writeFixture(root, [{id: 'claude-mem@x', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, 'inline script hook must not be flagged: ' + r.stdout + r.stderr);
    assertEq(JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('audit: broken_hook does NOT flag glob-pattern path candidates', () => {
  const root = makeTestbed('globpath');
  try {
    const pdir = join(root, 'plug');
    mkdirSync(join(pdir, 'hooks'), {recursive: true});
    writeFileSync(join(pdir, 'hooks', 'hooks.json'), JSON.stringify({
      Stop: [{hooks: [{type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/v*.mjs"'}]}],
    }));
    const fixturePath = writeFixture(root, [{id: 'p@mkt', installPath: pdir}]);
    const r = run(root, ['audit', '--json'], fixturePath);
    assertEq(r.status, 0, r.stdout + r.stderr);
    assertEq(JSON.parse(r.stdout).findings.filter(f => f.type === 'broken_hook').length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
