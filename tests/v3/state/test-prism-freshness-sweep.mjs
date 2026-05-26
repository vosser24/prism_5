#!/usr/bin/env node
// Tests for v4.1 Phase B — SessionStart daily freshness sweep.
//
// Covers hooks/lib/prism-freshness-sweep.mjs and the session-start
// integration. Each test uses an ephemeral $HOME stubbed to look like
// a real ~/.claude tree.
//
// Run: node tests/v3/state/test-prism-freshness-sweep.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SWEEP_REPO = join(REPO_ROOT, 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const SESSION_START = join(REPO_ROOT, 'hooks', 'prism-session-start.mjs');
const FLAG_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-flag-file.mjs');

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
function assertContains(haystack, needle, msg) {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(`expected to contain "${needle}", got ${JSON.stringify(haystack)}${msg ? ' — ' + msg : ''}`);
  }
}

// Build an ephemeral ~/.claude tree at the given temp home and copy
// the sweep helper + flag helper into the expected locations so the
// session-start hook can import them.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-freshness-home-'));
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools', 'lib'), {recursive: true});
  mkdirSync(join(home, '.claude', 'skills', 'prism-plan', 'references'), {recursive: true});
  mkdirSync(join(home, '.claude', 'plugins'), {recursive: true});
  writeFileSync(
    join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs'),
    readFileSync(SWEEP_REPO, 'utf-8'),
  );
  writeFileSync(
    join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs'),
    readFileSync(FLAG_HELPER_REPO, 'utf-8'),
  );
  return home;
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function touch(path, content = '') {
  writeFileSync(path, content);
}

function backdateMs(path, ageDays) {
  const t = (Date.now() - ageDays * 86400000) / 1000;
  utimesSync(path, t, t);
}

async function importSweep(home) {
  const url = pathToFileURL(join(home, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs')).href;
  return import(url);
}

function runSessionStart(home, cwd) {
  const env = {...process.env, HOME: home, USERPROFILE: home};
  const r = spawnSync(process.execPath, [SESSION_START], {
    cwd: cwd || home,
    encoding: 'utf-8',
    input: JSON.stringify({cwd: cwd || home}),
    env,
    timeout: 10000,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ─────────────────────────────── tests ──────────────────────────────────

test('sweep: empty tree yields no notices, writes initial snapshot', async () => {
  const home = makeHome();
  try {
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home: join(home, '.claude').replace(/[/\\]\.claude$/, '')});
    // The helper joins HOME + '.claude/...' internally, so we pass the
    // parent of .claude. makeHome() returned exactly that path.
    assertEq(r.skipped, false);
    assertEq(r.notices.length, 0);
    const snap = JSON.parse(readFileSync(join(home, '.claude', '.prism-freshness-last.json'), 'utf-8'));
    assert(typeof snap.ts === 'number', 'snapshot has ts');
    assertEq(snap.plugin_dirs, []);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('sweep: throttle respected when prior snapshot < 24h old', async () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: Date.now() - 60 * 60 * 1000,  // 1h ago
      plugin_dirs: [],
      tools_registry_mtime: null,
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assertEq(r.skipped, true);
    assertEq(r.notices.length, 0);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('sweep: force bypasses throttle', async () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: Date.now() - 60 * 60 * 1000,
      plugin_dirs: [],
      tools_registry_mtime: null,
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home, force: true});
    assertEq(r.skipped, false);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q1 plugin drift: new plugin appears → nudges /prism-index', async () => {
  const home = makeHome();
  try {
    // Pre-seed snapshot with empty plugins
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: Date.now() - 48 * 60 * 60 * 1000,  // expired
      plugin_dirs: [],
      tools_registry_mtime: null,
    });
    mkdirSync(join(home, '.claude', 'plugins', 'new-plugin'), {recursive: true});
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assertEq(r.skipped, false);
    const pluginNotice = r.notices.find((n) => /plugin set changed/i.test(n));
    assert(pluginNotice, 'expected plugin-drift notice; got: ' + JSON.stringify(r.notices));
    assertContains(pluginNotice, '/prism-index');
    assertContains(pluginNotice, 'new-plugin');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q1 plugin drift: no notice when plugin set unchanged', async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.claude', 'plugins', 'stable'), {recursive: true});
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: Date.now() - 48 * 60 * 60 * 1000,
      plugin_dirs: ['stable'],
      tools_registry_mtime: null,
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assert(!r.notices.some((n) => /plugin set/i.test(n)), 'no plugin notice');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q6a update-log age: stale last_check → nudges /prism-update', async () => {
  const home = makeHome();
  try {
    const lastCheck = new Date(Date.now() - 30 * 86400000).toISOString();  // 30d old
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json'), {
      last_check: lastCheck,
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    const n = r.notices.find((x) => /update-log/i.test(x));
    assert(n, 'expected update-log notice; got: ' + JSON.stringify(r.notices));
    assertContains(n, '/prism-update');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q6a update-log age: fresh last_check → no nudge', async () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json'), {
      last_check: new Date().toISOString(),
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assert(!r.notices.some((n) => /update-log/i.test(n)));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q6b CLAUDE.md staleness: mtime > 60d → nudges /prism-discover', async () => {
  const home = makeHome();
  try {
    const mdPath = join(home, '.claude', 'CLAUDE.md');
    touch(mdPath, '# CLAUDE.md\n');
    backdateMs(mdPath, 90);  // 90d old
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    const n = r.notices.find((x) => /CLAUDE\.md/i.test(x));
    assert(n, 'expected CLAUDE.md notice; got: ' + JSON.stringify(r.notices));
    assertContains(n, '/prism-discover');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q5 stale agents: agent unused 120d → nudges /prism-retire', async () => {
  const home = makeHome();
  try {
    const stale = new Date(Date.now() - 120 * 86400000).toISOString();
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json'), {
      schema_version: '3.1.0',
      agents: {
        'old-agent': {
          last_used: stale,
          status: 'available',
        },
        'fresh-agent': {
          last_used: new Date().toISOString(),
          status: 'available',
        },
      },
      _schema_example_agent: {ignored: true},
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    const n = r.notices.find((x) => /unused/i.test(x));
    assert(n, 'expected stale-agent notice; got: ' + JSON.stringify(r.notices));
    assertContains(n, '@old-agent');
    assert(!n.includes('@fresh-agent'), 'fresh agent should not be listed');
    assertContains(n, '/prism-retire');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q5 stale agents: underscore-prefixed schema-example keys ignored', async () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json'), {
      agents: {
        '_schema_example_agent': {
          last_used: new Date(Date.now() - 365 * 86400000).toISOString(),
        },
      },
    });
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assert(!r.notices.some((n) => /unused/i.test(n)), 'schema example must not trigger');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q11 tools-registry rotation: mtime advances → nudges /prism-recommend', async () => {
  const home = makeHome();
  try {
    const regPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'tools-registry.md');
    touch(regPath, '# tools-registry\n');
    // Pre-seed snapshot with an earlier mtime
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: Date.now() - 48 * 60 * 60 * 1000,
      plugin_dirs: [],
      tools_registry_mtime: Date.now() - 7 * 86400000,  // 7d earlier
    });
    // Update mtime to "now"
    const now = Date.now() / 1000;
    utimesSync(regPath, now, now);
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    const n = r.notices.find((x) => /tools-registry/i.test(x));
    assert(n, 'expected tools-registry notice; got: ' + JSON.stringify(r.notices));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('Q11 tools-registry rotation: no notice when mtime unchanged', async () => {
  const home = makeHome();
  try {
    const regPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'tools-registry.md');
    touch(regPath, '# tools-registry\n');
    const mtime = Date.now();
    writeJson(join(home, '.claude', '.prism-freshness-last.json'), {
      ts: mtime - 48 * 60 * 60 * 1000,
      plugin_dirs: [],
      tools_registry_mtime: mtime,  // matches the actual mtime we'll set
    });
    utimesSync(regPath, mtime / 1000, mtime / 1000);
    const {runFreshnessSweep} = await importSweep(home);
    const r = runFreshnessSweep({home});
    assert(!r.notices.some((n) => /tools-registry/i.test(n)));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: invokes sweep and surfaces notices in stdout', () => {
  const home = makeHome();
  try {
    // Seed conditions that will trigger Q6a (stale update-log)
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json'), {
      last_check: new Date(Date.now() - 60 * 86400000).toISOString(),
    });
    const r = runSessionStart(home);
    assertEq(r.status, 0, r.stderr);
    assertContains(r.stdout, '/prism-update', 'expected sweep notice in session-start stdout');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('session-start: off-switch PRISM_DISABLE_FRESHNESS_SWEEP suppresses sweep', () => {
  const home = makeHome();
  try {
    writeJson(join(home, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json'), {
      last_check: new Date(Date.now() - 60 * 86400000).toISOString(),
    });
    const env = {...process.env, HOME: home, USERPROFILE: home, PRISM_DISABLE_FRESHNESS_SWEEP: '1'};
    const r = spawnSync(process.execPath, [SESSION_START], {
      cwd: home, encoding: 'utf-8', input: '{}', env, timeout: 10000,
    });
    assertEq(r.status, 0);
    assert(!/prism-update/i.test(r.stdout || ''), 'sweep should be suppressed when off-switch set');
    // Snapshot file should NOT exist either (sweep didn't run).
    assert(!existsSync(join(home, '.claude', '.prism-freshness-last.json')), 'no snapshot when off-switch set');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
