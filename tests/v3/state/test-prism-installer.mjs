#!/usr/bin/env node
// v4.4 installer — behavior test suite (TDD, written before implementation)
//
// Covers all 11 required test cases:
//  1. detect on empty sandbox HOME → no install
//  2. detect on partial install → partial state
//  3. install to clean sandbox → all manifest files present, hooks merged, exit 0
//  4. install with old PRISM → backup created, old files removed, new in place
//  5. install preserves roster.json user agents
//  6. install preserves prism-policy.json
//  7. install preserves .prism-routing.jsonl
//  8. install --dry-run → no filesystem changes
//  9. uninstall → PRISM files removed, hooks stripped
// 10. verify after install → exit 0; after break → exit 1
// 11. JSON merge idempotency: install twice → no duplicate hook entries

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync,
  mkdirSync, cpSync, readdirSync, statSync,
} from 'fs';
import {join, resolve} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const INSTALLER = join(REPO, 'tools', 'prism-installer.mjs');
const MANIFEST = join(REPO, 'tools', 'install-manifest.json');

let pass = 0;
let total = 0;

function ok(label, cond) {
  total++;
  if (cond) {
    pass++;
  } else {
    console.log(`FAIL: ${label}`);
  }
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    env: {...process.env, ...env},
    encoding: 'utf8',
    timeout: 30000,
  });
  return result;
}

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'prism-install-test-'));
  return dir;
}

function seedPartialInstall(home) {
  // Plant 3 PRISM hook files (simulates partial prior install)
  const hooksDir = join(home, '.claude', 'hooks');
  mkdirSync(hooksDir, {recursive: true});
  writeFileSync(join(hooksDir, 'prism-safety.mjs'), '// old prism-safety\n');
  writeFileSync(join(hooksDir, 'prism-hook.mjs'), '// old prism-hook\n');
  writeFileSync(join(hooksDir, 'prism-session-start.mjs'), '// old prism-session-start\n');
}

function seedSettings(home, hooks) {
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  const settings = {hooks: hooks || {}};
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

function seedRoster(home, extraAgents) {
  const skillsDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(skillsDir, {recursive: true});
  const roster = {
    schema_version: '3.1.0',
    version: '3.1.0',
    agents: {
      'user-agent': {name: 'user-agent', model: 'sonnet', domain: 'custom'},
      ...extraAgents,
    },
    skills: [],
    tools: [],
    mcps: [],
    index_meta: {last_indexed: '2026-01-01T00:00:00Z'},
    domain_groups: {},
  };
  writeFileSync(join(skillsDir, 'roster.json'), JSON.stringify(roster, null, 2));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function snapshotFiles(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  function walk(d) {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.set(full, st.mtimeMs);
    }
  }
  walk(dir);
  return out;
}

// ─── Test 1: detect on empty sandbox HOME → no install ───────────────────────
{
  const home = makeSandbox();
  const r = run(['detect'], {HOME: home, USERPROFILE: home});
  let detected;
  try { detected = JSON.parse(r.stdout); } catch { detected = null; }
  ok('T1: detect exits 0 on empty HOME', r.status === 0);
  ok('T1: detect returns JSON on empty HOME', detected !== null);
  ok('T1: detect.installed=false on empty HOME', detected && detected.installed === false);
  ok('T1: detect.hooks_registered=0 on empty HOME', detected && detected.hooks_registered === 0);
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 2: detect on partial install → partial state ───────────────────────
{
  const home = makeSandbox();
  seedPartialInstall(home);
  const r = run(['detect'], {HOME: home, USERPROFILE: home});
  let detected;
  try { detected = JSON.parse(r.stdout); } catch { detected = null; }
  ok('T2: detect exits 0 on partial install', r.status === 0);
  // partial install: files are present, so installed=true; partial=true because hooks aren't wired in settings
  ok('T2: detect.installed=true on partial (files present)', detected && detected.installed === true);
  ok('T2: detect.partial=true and hooks_registered=0 on partial', detected && detected.partial === true && detected.hooks_registered === 0);
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 3: install to clean sandbox ────────────────────────────────────────
{
  const home = makeSandbox();
  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T3: install exits 0 on clean sandbox', r.status === 0);

  // Check a sample of files from the manifest
  const manifest = readJson(MANIFEST);
  const sampleFiles = manifest.files.slice(0, 5);
  for (const f of sampleFiles) {
    ok(`T3: file installed: ${f.dst}`, existsSync(join(home, '.claude', f.dst)));
  }

  // Check skills directories
  ok('T3: skills/master-orchestrator installed', existsSync(join(home, '.claude', 'skills', 'master-orchestrator', 'SKILL.md')));
  ok('T3: skills/prism-plan installed', existsSync(join(home, '.claude', 'skills', 'prism-plan', 'SKILL.md')));

  // Check settings.json has at least one PRISM hook
  const settings = readJson(join(home, '.claude', 'settings.json'));
  const hasHooks = settings && settings.hooks && Object.keys(settings.hooks).length > 0;
  ok('T3: settings.json has PRISM hooks after install', hasHooks);
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 4: install with old PRISM → backup + clean upgrade ─────────────────
{
  const home = makeSandbox();
  seedPartialInstall(home);
  // Seed a settings.json with an old PRISM hook
  seedSettings(home, {
    SessionStart: [{hooks: [{type: 'command', command: 'bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-session-start.mjs'}]}],
    UserPromptSubmit: [{matcher: '', hooks: [{type: 'command', command: 'bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-hook.mjs'}]}],
  });

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T4: install exits 0 with old PRISM present', r.status === 0);

  // Check backup was created
  const claudeDir = join(home, '.claude');
  const backups = readdirSync(claudeDir).filter(e => e.startsWith('.prism-install-backup-'));
  ok('T4: backup directory created', backups.length > 0);

  // Check old files removed + new files in place
  ok('T4: new prism-safety.mjs is from repo (not old stub)',
    existsSync(join(claudeDir, 'hooks', 'prism-safety.mjs')) &&
    !readFileSync(join(claudeDir, 'hooks', 'prism-safety.mjs'), 'utf8').startsWith('// old'));

  rmSync(home, {recursive: true, force: true});
}

// ─── Test 5: install preserves roster.json user agents ───────────────────────
{
  const home = makeSandbox();
  seedRoster(home, {'second-user-agent': {name: 'second-user-agent', model: 'haiku', domain: 'test'}});

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T5: install exits 0 with existing roster', r.status === 0);

  const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  const roster = readJson(rosterPath);
  ok('T5: user-agent preserved in roster', roster && roster.agents && 'user-agent' in roster.agents);
  ok('T5: second-user-agent preserved in roster', roster && roster.agents && 'second-user-agent' in roster.agents);
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 6: install preserves prism-policy.json ─────────────────────────────
{
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  const policyPath = join(claudeDir, 'prism-policy.json');
  writeFileSync(policyPath, JSON.stringify({telemetry: {opt_in: true}, model_guard: 'soft'}, null, 2));

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T6: install exits 0 with policy present', r.status === 0);
  ok('T6: prism-policy.json still exists after install', existsSync(policyPath));
  const policy = readJson(policyPath);
  ok('T6: policy content preserved', policy && policy.model_guard === 'soft');
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 7: install preserves .prism-routing.jsonl ──────────────────────────
{
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  const logPath = join(claudeDir, '.prism-routing.jsonl');
  writeFileSync(logPath, '{"event":"test","ts":"2026-01-01T00:00:00Z"}\n');

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T7: install exits 0 with routing log present', r.status === 0);
  ok('T7: .prism-routing.jsonl preserved', existsSync(logPath));
  ok('T7: routing log content unchanged', readFileSync(logPath, 'utf8').includes('"event":"test"'));
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 8: install --dry-run → no filesystem changes ───────────────────────
{
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});

  const before = snapshotFiles(claudeDir);
  const r = run(['install', '--dry-run'], {HOME: home, USERPROFILE: home});
  const after = snapshotFiles(claudeDir);

  ok('T8: dry-run exits 0', r.status === 0);
  ok('T8: dry-run produced no new files', before.size === after.size);
  ok('T8: dry-run output mentions dry-run', r.stdout.toLowerCase().includes('dry') || r.stderr.toLowerCase().includes('dry'));
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 9: uninstall → PRISM files removed, hooks stripped ─────────────────
{
  const home = makeSandbox();
  // First install
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});

  // Verify installed
  const claudeDir = join(home, '.claude');
  ok('T9: safety hook exists before uninstall', existsSync(join(claudeDir, 'hooks', 'prism-safety.mjs')));

  // Now uninstall
  const r = run(['uninstall', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('T9: uninstall exits 0', r.status === 0);
  ok('T9: prism-safety.mjs removed after uninstall', !existsSync(join(claudeDir, 'hooks', 'prism-safety.mjs')));
  ok('T9: prism-hook.mjs removed after uninstall', !existsSync(join(claudeDir, 'hooks', 'prism-hook.mjs')));

  // Settings should have no PRISM hooks
  const settings = readJson(join(claudeDir, 'settings.json'));
  let hasPrismHook = false;
  if (settings && settings.hooks) {
    for (const evHooks of Object.values(settings.hooks)) {
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (h.command && h.command.includes('prism-')) hasPrismHook = true;
        }
      }
    }
  }
  ok('T9: no PRISM hooks in settings after uninstall', !hasPrismHook);
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 10: verify after install → pass; after break → fail ────────────────
{
  const home = makeSandbox();
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});

  const rPass = run(['verify'], {HOME: home, USERPROFILE: home});
  ok('T10: verify exits 0 after clean install', rPass.status === 0);
  ok('T10: verify reports PASS', rPass.stdout.includes('PASS') || rPass.stdout.includes('pass'));

  // Break: remove a manifest file
  const claudeDir = join(home, '.claude');
  const victim = join(claudeDir, 'hooks', 'prism-safety.mjs');
  rmSync(victim, {force: true});

  const rFail = run(['verify'], {HOME: home, USERPROFILE: home});
  ok('T10: verify exits 1 after break', rFail.status === 1);
  ok('T10: verify reports missing file', rFail.stdout.includes('prism-safety') || rFail.stderr.includes('prism-safety'));
  rmSync(home, {recursive: true, force: true});
}

// ─── Test 11: JSON merge idempotency — no duplicate hooks after 2 installs ───
{
  const home = makeSandbox();
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});

  const settings = readJson(join(home, '.claude', 'settings.json'));
  let maxDupes = 0;
  if (settings && settings.hooks) {
    for (const [, evHooks] of Object.entries(settings.hooks)) {
      const cmds = [];
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (h.command) cmds.push(h.command);
        }
      }
      // Count duplicates
      const seen = new Set();
      for (const c of cmds) {
        if (seen.has(c)) maxDupes++;
        seen.add(c);
      }
    }
  }
  ok('T11: no duplicate hook commands after 2 installs', maxDupes === 0);
  rmSync(home, {recursive: true, force: true});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
