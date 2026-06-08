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

// ─── Test M3: non-PRISM hook preservation (regression for C1 statusLine fix) ──
// Seeds a sandbox settings.json with one PRISM hook PLUS one non-PRISM hook.
// After install, the non-PRISM hook must still be present.
{
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});

  // Seed settings with: one non-PRISM PreToolUse hook + one PRISM hook
  const seedSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{type: 'command', command: 'bash some-other-tool.sh'}],
        },
        {
          hooks: [{type: 'command', command: 'bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-hook.mjs'}],
        },
      ],
    },
  };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(seedSettings, null, 2));

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('TM3: install exits 0 with mixed hooks in seed settings', r.status === 0);

  const settings = readJson(join(claudeDir, 'settings.json'));
  // Check non-PRISM hook is still present
  let hasNonPrismHook = false;
  let hasPrismHook = false;
  if (settings && settings.hooks) {
    for (const evHooks of Object.values(settings.hooks)) {
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (h.command && h.command.includes('some-other-tool.sh')) hasNonPrismHook = true;
          if (h.command && h.command.includes('prism-exec')) hasPrismHook = true;
        }
      }
    }
  }
  ok('TM3: non-PRISM hook (some-other-tool.sh) preserved after install', hasNonPrismHook);
  ok('TM3: PRISM hooks also present after install', hasPrismHook);

  // v5.3.3: the prepush-review hook's `if` conditional-spawn field must survive
  // mergeSettings (regression guard for the per-hook key-drop at installer:471).
  let prepushIf = null;
  if (settings && settings.hooks) {
    for (const evHooks of Object.values(settings.hooks)) {
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (h.command && h.command.includes('prism-prepush-review')) prepushIf = h.if ?? null;
        }
      }
    }
  }
  ok('TM3: prepush-review `if` (Bash(git *)) preserved through mergeSettings (v5.3.3)', prepushIf === 'Bash(git *)');

  // Also verify statusLine preservation (C1 regression test)
  const settingsWithStatusLine = {
    statusLine: {type: 'command', command: 'bash my-custom-statusline.sh'},
    hooks: {},
  };
  const home2 = makeSandbox();
  const claudeDir2 = join(home2, '.claude');
  mkdirSync(claudeDir2, {recursive: true});
  writeFileSync(join(claudeDir2, 'settings.json'), JSON.stringify(settingsWithStatusLine, null, 2));
  run(['install', '--quiet'], {HOME: home2, USERPROFILE: home2});
  const settings2 = readJson(join(claudeDir2, 'settings.json'));
  const statusLinePreserved = settings2 && settings2.statusLine &&
    settings2.statusLine.command && settings2.statusLine.command.includes('my-custom-statusline');
  ok('TM3: user custom statusLine preserved (C1 regression)', statusLinePreserved);
  rmSync(home2, {recursive: true, force: true});

  rmSync(home, {recursive: true, force: true});
}

// ─────────────────────────────────────────────────────────────────────────────
// v4.5: I4/I5/I6/I7 installer additions
// ─────────────────────────────────────────────────────────────────────────────

// I7 --target flag — basic detect against empty .claude/
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  const r = run(['detect', '--target', targetClaude]);
  ok('I7: detect --target empty dir exits 0', r.status === 0);
  // detect prints JSON — parse it and check claude_dir
  let detectJson = null;
  try { detectJson = JSON.parse(r.stdout); } catch {}
  ok('I7: detect --target stdout is valid JSON', detectJson !== null);
  ok('I7: detect --target claude_dir matches', detectJson && detectJson.claude_dir && detectJson.claude_dir.includes(targetClaude.split(/[\\/]/).pop()));
  ok('I7: detect --target reports installed:false', detectJson && detectJson.installed === false);
  rmSync(sandbox, {recursive: true, force: true});
}

// I7 --target with nonexistent dir errors with code 2
{
  const r = run(['detect', '--target', '/does/not/exist-xyzzy-prism-test']);
  ok('I7: --target nonexistent exits 2', r.status === 2);
  ok('I7: --target nonexistent stderr mentions --target', (r.stderr || '').toLowerCase().includes('target'));
}

// I7 --home and --target mutually exclusive
{
  const sandbox = makeSandbox();
  const r = run(['detect', '--home', sandbox, '--target', join(sandbox, '.claude')]);
  ok('I7: --home + --target mutually exclusive exits 2', r.status === 2);
  rmSync(sandbox, {recursive: true, force: true});
}

// H3 --target rewrites hook commands to the install dir's absolute path
{
  const sandbox = makeSandbox();
  const target = join(sandbox, '.claude');
  mkdirSync(target, {recursive: true});
  const r = run(['install', '--target', target, '--quiet']);
  ok('H3: --target install exits 0', r.status === 0);
  const settingsPath = join(target, 'settings.json');
  if (existsSync(settingsPath)) {
    const cmds = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks || {});
    ok('H3: --target rewrites hook commands to the target, not ~/.claude',
      cmds.includes(target.replace(/\\/g, '/')) && !/~\/\.claude\/hooks\/prism-/.test(cmds));
  } else {
    ok('H3: --target rewrites hook commands (settings.json missing)', false);
  }
  rmSync(sandbox, {recursive: true, force: true});
}

// H3 (R3): default/--home installs keep the canonical ~/.claude prefix (no rewrite)
{
  const home = makeSandbox();
  mkdirSync(join(home, '.claude'), {recursive: true});
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  const settingsPath = join(home, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const cmds = JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks || {});
    ok('H3: --home install keeps ~/.claude hook commands (R3, no rewrite)',
      /~\/\.claude\/hooks\/prism-/.test(cmds) && !cmds.includes(join(home, '.claude').replace(/\\/g, '/')));
  } else {
    ok('H3: --home install keeps ~/.claude hook commands (settings.json missing)', false);
  }
  rmSync(home, {recursive: true, force: true});
}

// I6 update --dry-run on empty target → "no existing install"
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  const r = run(['update', '--target', targetClaude, '--dry-run']);
  ok('I6: update --dry-run empty exits 0', r.status === 0);
  const combined = (r.stdout || '') + (r.stderr || '');
  ok('I6: update --dry-run mentions "no existing install" or "fresh install"', /no existing install|fresh install/i.test(combined));
  ok('I6: update --dry-run mentions "would install"', /would install/i.test(combined));
  rmSync(sandbox, {recursive: true, force: true});
}

// I6 update on already-current install → "Already at vX; nothing to do."
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  // Seed install
  const r1 = run(['install', '--target', targetClaude, '--quiet']);
  ok('I6: seed install exits 0', r1.status === 0);
  ok('I6: seed install wrote .prism-version', existsSync(join(targetClaude, '.prism-version')));
  // Now update
  const r2 = run(['update', '--target', targetClaude]);
  ok('I6: update on current install exits 0', r2.status === 0);
  const combined2 = (r2.stdout || '') + (r2.stderr || '');
  ok('I6: update on current emits "Already at"', /already at/i.test(combined2));
  rmSync(sandbox, {recursive: true, force: true});
}

// I6 update with missing .prism-version marker → "version unknown"
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  run(['install', '--target', targetClaude, '--quiet']);
  // Delete the marker
  rmSync(join(targetClaude, '.prism-version'), {force: true});
  const r = run(['update', '--target', targetClaude, '--dry-run']);
  ok('I6: update with missing marker exits 0', r.status === 0);
  const combined = (r.stdout || '') + (r.stderr || '');
  ok('I6: update with missing marker mentions "unknown"', /unknown/i.test(combined));
  rmSync(sandbox, {recursive: true, force: true});
}

// I4 --purge-state --yes removes state files
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  // Seed install + state files
  run(['install', '--target', targetClaude, '--quiet']);
  writeFileSync(join(targetClaude, 'MEMORY.md'), 'test memory');
  writeFileSync(join(targetClaude, '.prism-routing.jsonl'), '{"t":1}');
  writeFileSync(join(targetClaude, 'prism-policy.json'), '{"p":1}');
  // Uninstall WITHOUT --purge-state → state preserved
  run(['uninstall', '--target', targetClaude, '--quiet']);
  ok('I4: uninstall (no purge) preserves MEMORY.md', existsSync(join(targetClaude, 'MEMORY.md')));
  ok('I4: uninstall (no purge) preserves .prism-routing.jsonl', existsSync(join(targetClaude, '.prism-routing.jsonl')));
  ok('I4: uninstall (no purge) preserves prism-policy.json', existsSync(join(targetClaude, 'prism-policy.json')));

  // Re-install then uninstall WITH --purge-state --yes
  run(['install', '--target', targetClaude, '--quiet']);
  writeFileSync(join(targetClaude, 'MEMORY.md'), 'test memory 2');
  writeFileSync(join(targetClaude, '.prism-routing.jsonl'), '{"t":2}');
  const r = run(['uninstall', '--target', targetClaude, '--purge-state', '--yes', '--quiet']);
  ok('I4: uninstall --purge-state --yes exits 0', r.status === 0);
  ok('I4: --purge-state removed MEMORY.md', !existsSync(join(targetClaude, 'MEMORY.md')));
  ok('I4: --purge-state removed .prism-routing.jsonl', !existsSync(join(targetClaude, '.prism-routing.jsonl')));
  ok('I4: --purge-state removed prism-policy.json', !existsSync(join(targetClaude, 'prism-policy.json')));

  rmSync(sandbox, {recursive: true, force: true});
}

// I5 expanded backup captures shipped dirs + user state
{
  const sandbox = makeSandbox();
  const targetClaude = join(sandbox, '.claude');
  mkdirSync(targetClaude, {recursive: true});
  // First install (no prior install to back up, so no backup expected)
  run(['install', '--target', targetClaude, '--quiet']);
  // Add user state
  writeFileSync(join(targetClaude, 'MEMORY.md'), 'memory');
  writeFileSync(join(targetClaude, '.prism-routing.jsonl'), '{"r":1}');
  // Second install → backup of prior install + user state
  const r = run(['install', '--target', targetClaude, '--quiet']);
  ok('I5: re-install exits 0', r.status === 0);
  const backups = readdirSync(targetClaude).filter(d => d.startsWith('.prism-install-backup-')).sort();
  ok('I5: backup directory created', backups.length > 0);
  if (backups.length > 0) {
    // Use the LAST (most recent) backup — first install also creates one (empty)
    const backupDir = join(targetClaude, backups[backups.length - 1]);
    ok('I5: backup contains settings.json', existsSync(join(backupDir, 'settings.json')));
    ok('I5: backup contains agents/ dir', existsSync(join(backupDir, 'agents')));
    ok('I5: backup contains hooks/ dir', existsSync(join(backupDir, 'hooks')));
    ok('I5: backup contains tools/ dir', existsSync(join(backupDir, 'tools')));
    ok('I5: backup contains commands/ dir', existsSync(join(backupDir, 'commands')));
    ok('I5: backup contains skills/prism-plan/', existsSync(join(backupDir, 'skills', 'prism-plan')));
    ok('I5: backup contains MEMORY.md', existsSync(join(backupDir, 'MEMORY.md')));
    ok('I5: backup contains .prism-routing.jsonl', existsSync(join(backupDir, '.prism-routing.jsonl')));
    // backup-metadata.json should list >3 files
    const meta = readJson(join(backupDir, 'backup-metadata.json'));
    ok('I5: backup-metadata.json present', meta !== null);
    ok('I5: files_backed_up count > 3', meta && Array.isArray(meta.files_backed_up) && meta.files_backed_up.length > 3);
  }
  rmSync(sandbox, {recursive: true, force: true});
}

// ─────────────────────────────────────────────────────────────────────────────
// v4.5 regression tests: F1 + F5 + F8
// ─────────────────────────────────────────────────────────────────────────────

// v4.5 regression: F1 — malformed roster.json under --target should give recovery instructions, not crash
{
  const sandbox = makeSandbox();
  const claudeDir = join(sandbox, '.claude');
  const rosterDir = join(claudeDir, 'skills', 'prism-plan', 'references');
  mkdirSync(rosterDir, {recursive: true});
  writeFileSync(join(rosterDir, 'roster.json'), '{ invalid json');
  const r = run(['install', '--target', claudeDir, '--quiet']);
  ok('F1: malformed roster + --target exits non-zero', r.status !== 0);
  ok('F1: malformed roster + --target does NOT crash with HOME ReferenceError',
     !((r.stderr || '') + (r.stdout || '')).includes('HOME is not defined'));
  ok('F1: malformed roster error mentions roster.json',
     ((r.stderr || '') + (r.stdout || '')).includes('roster.json'));
  rmSync(sandbox, {recursive: true, force: true});
}

// v5.4.1: installer BOM auto-strip — a BOM-prefixed roster.json must NOT abort
// install/update. PowerShell Set-Content/Out-File default to UTF-8 *with* BOM, so
// a roster rewritten by a Bash/PowerShell path can carry a leading U+FEFF; the
// installer strips it before JSON.parse so the merge still preserves user agents.
{
  const home = makeSandbox();
  const skillsDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(skillsDir, {recursive: true});
  const roster = {
    schema_version: '3.1.0', version: '3.1.0',
    agents: {'bom-user-agent': {name: 'bom-user-agent', model: 'sonnet', domain: 'custom'}},
    skills: [], tools: [], mcps: [], index_meta: {last_indexed: '2026-01-01T00:00:00Z'}, domain_groups: {},
  };
  // Leading UTF-8 BOM (U+FEFF) — exactly what PowerShell's default writers emit.
  writeFileSync(join(skillsDir, 'roster.json'), '﻿' + JSON.stringify(roster, null, 2));

  const r = run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  ok('BOM1: install exits 0 with a BOM-prefixed roster (stripped, not aborted)', r.status === 0);
  const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  const merged = readJson(rosterPath);
  ok('BOM1: user agent preserved through BOM-roster merge', merged && merged.agents && 'bom-user-agent' in merged.agents);
  const raw = existsSync(rosterPath) ? readFileSync(rosterPath, 'utf8') : '';
  ok('BOM1: rewritten roster is BOM-free (clean UTF-8)', raw.charCodeAt(0) !== 0xFEFF);
  rmSync(home, {recursive: true, force: true});
}

// v4.5 regression: F5 — update on already-current version must not create a backup dir
{
  const sandbox = makeSandbox();
  const claudeDir = join(sandbox, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  run(['install', '--target', claudeDir, '--quiet']);
  // Count backups after install (install always creates one)
  const before = readdirSync(claudeDir).filter(d => d.startsWith('.prism-install-backup-')).length;
  // Update with matching version → "Already at vX" — no backup, no writes
  const r = run(['update', '--target', claudeDir, '--quiet']);
  ok('F5: update no-op exits 0', r.status === 0);
  const after = readdirSync(claudeDir).filter(d => d.startsWith('.prism-install-backup-')).length;
  ok('F5: update no-op does not create new backup', before === after);
  rmSync(sandbox, {recursive: true, force: true});
}

// v4.5 regression: F8 — --purge-state --quiet without --yes must fail fast, not hang on hidden prompt
{
  const sandbox = makeSandbox();
  const claudeDir = join(sandbox, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  run(['install', '--target', claudeDir, '--quiet']);
  // No --yes, --quiet — should fail with exit 2, not hang
  const r = run(['uninstall', '--target', claudeDir, '--purge-state', '--quiet']);
  ok('F8: --purge-state --quiet without --yes exits 2', r.status === 2);
  ok('F8: --purge-state --quiet without --yes stderr explains', /requires --yes/i.test(r.stderr || ''));
  rmSync(sandbox, {recursive: true, force: true});
}

// ─── I3: aligned completion summary banner ──────────────────────────────────
{
  const home = makeSandbox();
  const r = run(['install'], {HOME: home, USERPROFILE: home});  // no --quiet: want the summary
  ok('I3: summary has aligned "Target" label', /\n\s+Target\s+:\s/.test(r.stdout));
  ok('I3: summary has aligned "Files" label', /\n\s+Files\s+:\s/.test(r.stdout));
  ok('I3: summary prints the (long) target path verbatim', r.stdout.includes(join(home, '.claude')));
  rmSync(home, {recursive: true, force: true});
}

// ─── I8: local install/upgrade telemetry, opt-in ────────────────────────────
{
  // Default: no consent → nothing written.
  const home = makeSandbox();
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  const logPath = join(home, '.claude', '.prism-routing.jsonl');
  const wrote = existsSync(logPath) && readFileSync(logPath, 'utf8').includes('install_outcome');
  ok('I8: no telemetry without opt-in (default off)', !wrote);
  rmSync(home, {recursive: true, force: true});
}
{
  // Opt-in via prism-policy.json telemetry.opt_in → install_outcome appended.
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  writeFileSync(join(claudeDir, 'prism-policy.json'), JSON.stringify({telemetry: {opt_in: true}}));
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home});
  const logPath = join(home, '.claude', '.prism-routing.jsonl');
  ok('I8: routing log exists after opt-in install', existsSync(logPath));
  const recs = (existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : [])
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const rec = recs.find((e) => e.event === 'install_outcome');
  ok('I8: install_outcome event written on opt-in', !!rec);
  ok('I8: event records success + action=install', !!rec && rec.result === 'success' && rec.action === 'install');
  ok('I8: event carries prism_version', !!rec && typeof rec.prism_version === 'string');
  rmSync(home, {recursive: true, force: true});
}
{
  // Industry-standard opt-out (DISABLE_TELEMETRY) overrides policy opt-in.
  const home = makeSandbox();
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  writeFileSync(join(claudeDir, 'prism-policy.json'), JSON.stringify({telemetry: {opt_in: true}}));
  run(['install', '--quiet'], {HOME: home, USERPROFILE: home, DISABLE_TELEMETRY: '1'});
  const logPath = join(home, '.claude', '.prism-routing.jsonl');
  const wrote = existsSync(logPath) && readFileSync(logPath, 'utf8').includes('install_outcome');
  ok('I8: DISABLE_TELEMETRY opt-out honored despite policy opt-in', !wrote);
  rmSync(home, {recursive: true, force: true});
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
