#!/usr/bin/env node
// Tests for v4.3 Phase B — /prism-uninstall-cleanup.
//
// Covers tools/prism-uninstall-cleanup.mjs:
//   - backfill safety (missing installed_via treated as "manual")
//   - plugin-only filter (only "plugin" entries selected)
//   - zero-state idempotency
//   - removal correctness (files + dirs + roster entry)
//   - atomic-write exit state (no .tmp lingers)
//   - env-detection smoke (CLAUDE_PLUGIN_ROOT → "plugin")
//
// Each test uses an ephemeral $HOME so writes don't touch the real
// ~/.claude/. The env-detection smoke spawns `bash`; if bash is not
// on PATH (some Windows CI runners) the test logs a skip instead of
// failing — the contract being pinned is portable, the test surface
// just doesn't apply.
//
// Run: node tests/v3/state/test-prism-uninstall-cleanup.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'prism-uninstall-cleanup.mjs');

let pass = 0, fail = 0, skip = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    if (e && e.skip) { skip++; process.stdout.write(`  skip ${name}  (${e.message})\n`); }
    else { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assertContains(s, n, msg) {
  if (!s || !s.includes(n)) throw new Error(`expected to contain "${n}", got ${JSON.stringify(s)}${msg ? ' — ' + msg : ''}`);
}
function skipTest(msg) { const e = new Error(msg); e.skip = true; throw e; }

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-uninstall-home-'));
  const claude = join(home, '.claude');
  mkdirSync(claude, {recursive: true});
  mkdirSync(join(claude, 'agents'), {recursive: true});
  mkdirSync(join(claude, 'skills', 'prism-plan', 'references'), {recursive: true});
  return home;
}

function writeRoster(home, agents) {
  const path = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  const data = {
    schema_version: '2.9.0',
    index_meta: {last_indexed: null},
    agents,
    skills: {}, tools: {}, mcps: {}
  };
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function readRoster(home) {
  const path = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function makeAgent(home, name, installed_via /* string|undefined */) {
  const claude = join(home, '.claude');
  const dir = join(claude, 'agents', name);
  const flat = join(claude, 'agents', name + '.md');
  mkdirSync(dir, {recursive: true});
  mkdirSync(join(dir, 'references'), {recursive: true});
  writeFileSync(join(dir, 'agent.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  writeFileSync(join(dir, 'references', 'core-expertise.md'), '# stub\n');
  writeFileSync(flat, `---\nname: ${name}\n---\n# ${name}\n`);
  const entry = {name, source: 'agent-factory', model: 'sonnet'};
  if (installed_via !== undefined) entry.installed_via = installed_via;
  return entry;
}

function runTool(home, ...args) {
  const r = spawnSync(process.execPath, [TOOL, '--home', home, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: {...process.env, HOME: home, USERPROFILE: home},
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ─── tests ───────────────────────────────────────────────────────────

test('backfill-safety: entries without installed_via are not removable', () => {
  const home = makeHome();
  try {
    const a = makeAgent(home, 'legacy-one', undefined);
    const b = makeAgent(home, 'legacy-two', undefined);
    writeRoster(home, {[a.name]: a, [b.name]: b});
    const r = runTool(home, '--dry-run');
    assertEq(r.status, 0);
    assertContains(r.stdout, 'Nothing to clean up');
    // Roster + agent files all still on disk.
    assert(existsSync(join(home, '.claude', 'agents', 'legacy-one')));
    assert(existsSync(join(home, '.claude', 'agents', 'legacy-one.md')));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('plugin-only-filter: only installed_via=plugin entries are listed', () => {
  const home = makeHome();
  try {
    const a = makeAgent(home, 'plugin-one', 'plugin');
    const b = makeAgent(home, 'manual-one', 'manual');
    const c = makeAgent(home, 'legacy-one', undefined);
    writeRoster(home, {[a.name]: a, [b.name]: b, [c.name]: c});
    const r = runTool(home, '--dry-run');
    assertEq(r.status, 0);
    assertContains(r.stdout, 'plugin-one');
    assert(!r.stdout.includes('manual-one'), 'manual entry should not appear');
    assert(!r.stdout.includes('legacy-one'), 'legacy entry should not appear');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('zero-state: empty roster.agents exits 0 with "Nothing to clean up"', () => {
  const home = makeHome();
  try {
    writeRoster(home, {});
    const r = runTool(home, '--dry-run');
    assertEq(r.status, 0);
    assertContains(r.stdout, 'Nothing to clean up');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('removal-correctness: --mode=remove-all wipes plugin agent + roster, leaves manual intact', () => {
  const home = makeHome();
  try {
    const a = makeAgent(home, 'plugin-target', 'plugin');
    const b = makeAgent(home, 'manual-keeper', 'manual');
    writeRoster(home, {[a.name]: a, [b.name]: b});
    const r = runTool(home, '--mode=remove-all');
    assertEq(r.status, 0);

    // Plugin-tagged: all three artifacts gone.
    assert(!existsSync(join(home, '.claude', 'agents', 'plugin-target')), 'plugin agent dir should be gone');
    assert(!existsSync(join(home, '.claude', 'agents', 'plugin-target.md')), 'plugin agent flat file should be gone');
    const rosterAfter = readRoster(home);
    assert(!rosterAfter.agents['plugin-target'], 'plugin entry should be gone from roster');

    // Manual: all three artifacts intact.
    assert(existsSync(join(home, '.claude', 'agents', 'manual-keeper')), 'manual agent dir should remain');
    assert(existsSync(join(home, '.claude', 'agents', 'manual-keeper.md')), 'manual agent flat file should remain');
    assert(rosterAfter.agents['manual-keeper'], 'manual entry should remain in roster');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('atomic-write: --mode=remove-all leaves no .tmp file behind', () => {
  const home = makeHome();
  try {
    const a = makeAgent(home, 'plugin-target', 'plugin');
    writeRoster(home, {[a.name]: a});
    const r = runTool(home, '--mode=remove-all');
    assertEq(r.status, 0);

    const refsDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
    const leftover = readdirSync(refsDir).filter(n => n.endsWith('.tmp'));
    assertEq(leftover, [], 'no .tmp files should remain after a clean run');
    // Roster parses.
    const after = readRoster(home);
    assertEq(typeof after.agents, 'object');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('env-detection-smoke: bash one-liner from agent-factory prose returns plugin vs manual', () => {
  const oneLiner = '[ -n "$CLAUDE_PLUGIN_ROOT" ] && echo plugin || echo manual';
  let bashOk;
  try {
    bashOk = spawnSync('bash', ['-c', 'echo ok'], {encoding: 'utf-8', timeout: 3000});
  } catch (e) { bashOk = {status: 1}; }
  if (!bashOk || bashOk.status !== 0) skipTest('bash not on PATH');

  const withVar = spawnSync('bash', ['-c', oneLiner], {
    encoding: 'utf-8',
    env: {...process.env, CLAUDE_PLUGIN_ROOT: '/tmp/anywhere'},
  });
  assertEq(withVar.stdout.trim(), 'plugin');

  const withoutVar = {...process.env};
  delete withoutVar.CLAUDE_PLUGIN_ROOT;
  const without = spawnSync('bash', ['-c', oneLiner], {
    encoding: 'utf-8',
    env: withoutVar,
  });
  assertEq(without.stdout.trim(), 'manual');
});

process.stdout.write(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}\n`);
process.exit(fail ? 1 : 0);
