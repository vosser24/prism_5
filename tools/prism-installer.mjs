#!/usr/bin/env node
// PRISM Installer v4.4.0
//
// Subcommands:
//   detect   — print JSON of current install state, no changes (exit 0 always)
//   install  — full install/upgrade. Idempotent.
//   uninstall — reverse the install
//   verify   — check every manifest file is present + hooks wired (exit 0 ok, 1 fail)
//   --help   — usage
//
// Common flags:
//   --home <path>   sandbox HOME override (mirrors prism-telemetry-aggregate.mjs)
//   --src  <path>   source repo override (default: derived from import.meta.url)
//   --dry-run       (install only) simulate, no filesystem changes
//   --no-backup     (install only) skip backup step
//   --quiet         suppress progress output
//
// Fail-loud: any unrecoverable error exits non-zero with a clear message.
// Fail-safe: --dry-run, lock-file, atomic writes (tempfile+rename).
//
// Memory honored:
//   [[feedback-windows-spawnsync-url-path]] — fileURLToPath for import.meta.url paths
//   [[feedback-windows-cli-test-args]]      — no >32KB inline args; not applicable here
//   [[feedback-default-flip-prose-sweep]]   — all doc surfaces updated in separate commits

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  unlinkSync, readdirSync, statSync, chmodSync, cpSync, rmSync, lstatSync,
} from 'fs';
import {join, dirname, resolve, basename} from 'path';
import {tmpdir, homedir} from 'os';
import {fileURLToPath} from 'url';
import {createHash} from 'crypto';

// ─── Path resolution ──────────────────────────────────────────────────────────
// [[feedback-windows-spawnsync-url-path]]: always use fileURLToPath, never new URL().pathname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI args ────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const [subcommand, ...restArgs] = rawArgs;

function parseFlags(args) {
  const flags = {
    home: null,
    src: null,
    dryRun: false,
    noBackup: false,
    quiet: false,
    restoreBackup: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--home') flags.home = args[++i];
    else if (a === '--src') flags.src = args[++i];
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-backup') flags.noBackup = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--restore-backup') flags.restoreBackup = args[++i];
  }
  return flags;
}

const flags = parseFlags(restArgs);

// ─── Paths ───────────────────────────────────────────────────────────────────
const HOME = flags.home || process.env.HOME || process.env.USERPROFILE || homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const REPO_ROOT = flags.src || resolve(__dirname, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'tools', 'install-manifest.json');
const LOCK_PATH = join(CLAUDE_DIR, '.prism-install.lock');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(...args) {
  if (!flags.quiet) console.log(...args);
}

function die(msg, code = 1) {
  console.error(`[prism-installer] ERROR: ${msg}`);
  process.exit(code);
}

function atomicWrite(path, content) {
  const tmp = path + '.prism-tmp-' + createHash('sha256').update(path + Date.now()).digest('hex').slice(0, 8);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch {
    // Fallback: direct write
    try { writeFileSync(path, content); } catch (e) {
      // Clean up tmp if it exists
      try { unlinkSync(tmp); } catch {}
      throw e;
    }
    try { unlinkSync(tmp); } catch {}
  }
}

function ensureDir(dir, dryRun = false) {
  if (!dryRun && !existsSync(dir)) mkdirSync(dir, {recursive: true});
}

function safeUnlink(path) {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      unlinkSync(path);
      return true;
    }
    // Read-only files on Windows: chmod first
    try { chmodSync(path, 0o644); } catch {}
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) die(`manifest not found at ${MANIFEST_PATH}`);
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
  catch (e) { die(`manifest JSON invalid: ${e.message}`); }
}

function loadSettingsFragment(manifest) {
  const fragPath = join(REPO_ROOT, manifest.settings_fragment);
  if (!existsSync(fragPath)) die(`settings.fragment.json not found at ${fragPath}`);
  try { return JSON.parse(readFileSync(fragPath, 'utf8')); }
  catch (e) { die(`settings.fragment.json JSON invalid: ${e.message}`); }
}

function readSettings() {
  const path = join(CLAUDE_DIR, 'settings.json');
  if (!existsSync(path)) return {_fresh: true};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    // Detect line number for error message
    const raw = (() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })();
    const lineNum = raw.split('\n').findIndex((_, i) => {
      try { JSON.parse(raw.split('\n').slice(0, i + 1).join('\n')); return false; }
      catch { return true; }
    });
    die(`settings.json appears malformed at line ~${lineNum + 1}; refusing to proceed (no changes made). Inspect or fix the file manually, then re-run.`, 2);
  }
}

// Check if a hook command is a PRISM hook (by name pattern)
function isPrismHookCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('prism-exec.sh') && cmd.includes('prism-');
}

// ─── Lock file ───────────────────────────────────────────────────────────────
function acquireLock(dryRun) {
  if (dryRun) return;
  ensureDir(CLAUDE_DIR);
  if (existsSync(LOCK_PATH)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
      const age = Date.now() - new Date(lockData.ts).getTime();
      if (age < 60000) {
        die(`Another install is in progress (lock ${age}ms old). Wait 60s or delete ${LOCK_PATH}.`);
      }
      console.warn(`[prism-installer] Stale lock found (${Math.round(age / 1000)}s old); proceeding with warning.`);
    } catch { /* stale/corrupt lock, proceed */ }
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ts: new Date().toISOString(), pid: process.pid}));
}

function releaseLock(dryRun) {
  if (dryRun) return;
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ─── detect ──────────────────────────────────────────────────────────────────
function detect() {
  const manifest = (() => {
    try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch { return null; }
  })();

  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  let settings = null;
  let settingsMalformed = false;
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch { settingsMalformed = true; }
  }

  // Count PRISM hook registrations in settings.json
  let hooksRegistered = 0;
  if (settings && settings.hooks) {
    for (const evHooks of Object.values(settings.hooks)) {
      if (!Array.isArray(evHooks)) continue;
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (isPrismHookCommand(h.command)) hooksRegistered++;
        }
      }
    }
  }

  // Count PRISM files present in ~/.claude
  let filesFound = 0;
  if (manifest) {
    for (const f of manifest.files) {
      if (existsSync(join(CLAUDE_DIR, f.dst))) filesFound++;
    }
  }

  // Check roster
  const rosterPath = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json');
  let rosterVersion = null;
  if (existsSync(rosterPath)) {
    try {
      const r = JSON.parse(readFileSync(rosterPath, 'utf8'));
      rosterVersion = r.schema_version || r.version || 'unknown';
    } catch {}
  }

  // Installed if ≥1 file present OR ≥1 hook registered
  const installed = filesFound > 0 || hooksRegistered > 0;
  // Partial if some files/hooks present but not all
  const totalFiles = manifest ? manifest.files.length : 0;
  const partial = installed && (filesFound < totalFiles || hooksRegistered === 0);

  const result = {
    installed,
    partial,
    files_found: filesFound,
    files_total: totalFiles,
    hooks_registered: hooksRegistered,
    roster_version: rosterVersion,
    settings_malformed: settingsMalformed,
    prism_version: manifest ? manifest.prism_version : null,
    claude_dir: CLAUDE_DIR,
  };

  console.log(JSON.stringify(result, null, 2));
  // detect always exits 0
}

// ─── Backup ──────────────────────────────────────────────────────────────────
function makeBackup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir = join(CLAUDE_DIR, `.prism-install-backup-${ts}`);
  mkdirSync(backupDir, {recursive: true});

  const candidates = [
    join(CLAUDE_DIR, 'settings.json'),
    join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json'),
    join(CLAUDE_DIR, 'prism-policy.json'),
  ];
  for (const src of candidates) {
    if (existsSync(src)) {
      const rel = src.slice(CLAUDE_DIR.length + 1);
      const dst = join(backupDir, rel);
      mkdirSync(dirname(dst), {recursive: true});
      try { cpSync(src, dst); } catch {}
    }
  }
  return backupDir;
}

// ─── Remove old PRISM files (upgrade cleanup) ─────────────────────────────────
function globPattern(base, pattern) {
  // Simple glob: supports '*' wildcard in filename only; trailing '/' means directory
  if (pattern.endsWith('/') || !pattern.includes('*')) {
    // Directory or exact match
    const full = join(base, pattern.replace(/\/$/, ''));
    if (existsSync(full)) return [full];
    return [];
  }
  const dir = join(base, dirname(pattern));
  const filePattern = basename(pattern);
  const regex = new RegExp('^' + filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(name => regex.test(name))
      .map(name => join(dir, name));
  } catch { return []; }
}

function removeOldPrismFiles(manifest, dryRun) {
  const removed = [];
  for (const pattern of manifest.remove_on_upgrade_patterns) {
    const matches = globPattern(CLAUDE_DIR, pattern);
    for (const target of matches) {
      try {
        const st = lstatSync(target);
        if (st.isDirectory()) {
          if (!dryRun) rmSync(target, {recursive: true, force: true});
          removed.push(target + '/');
        } else {
          if (!dryRun) safeUnlink(target);
          removed.push(target);
        }
      } catch {}
    }
  }
  return removed;
}

// ─── Settings merge ──────────────────────────────────────────────────────────
function mergeSettings(existing, fragment, dryRun) {
  // Deep merge: for each event in fragment.hooks, ensure PRISM entries exist exactly once
  const merged = JSON.parse(JSON.stringify(existing)); // deep clone
  delete merged._fresh; // remove internal marker

  // Merge env
  if (fragment.env) {
    merged.env = merged.env || {};
    Object.assign(merged.env, fragment.env);
  }

  // Merge statusLine (overwrite if PRISM-managed)
  if (fragment.statusLine) {
    merged.statusLine = fragment.statusLine;
  }

  // Merge hooks
  merged.hooks = merged.hooks || {};
  for (const [event, fragGroups] of Object.entries(fragment.hooks || {})) {
    if (!merged.hooks[event]) {
      merged.hooks[event] = [];
    }
    for (const fragGroup of fragGroups) {
      // A fragment group contributes one or more hook entries
      for (const fragHook of (fragGroup.hooks || [])) {
        if (!isPrismHookCommand(fragHook.command)) continue;

        // Check if this exact command already exists in any group for this event
        let found = false;
        for (const existingGroup of merged.hooks[event]) {
          for (const existingHook of (existingGroup.hooks || [])) {
            if (existingHook.command === fragHook.command) { found = true; break; }
          }
          if (found) break;
        }
        if (!found) {
          // Add new group containing this hook
          const newGroup = {hooks: [{type: fragHook.type, command: fragHook.command}]};
          if (fragGroup.matcher !== undefined) newGroup.matcher = fragGroup.matcher;
          merged.hooks[event].push(newGroup);
        }
      }
    }
  }

  return merged;
}

function stripPrismHooks(settings) {
  // Remove all PRISM hook entries from settings.json
  const stripped = JSON.parse(JSON.stringify(settings));
  if (!stripped.hooks) return stripped;
  for (const [event, evHooks] of Object.entries(stripped.hooks)) {
    stripped.hooks[event] = evHooks
      .map(group => {
        const filtered = (group.hooks || []).filter(h => !isPrismHookCommand(h.command));
        if (filtered.length === 0) return null;
        return {...group, hooks: filtered};
      })
      .filter(Boolean);
    if (stripped.hooks[event].length === 0) delete stripped.hooks[event];
  }
  return stripped;
}

// ─── Roster merge ─────────────────────────────────────────────────────────────
// Preserve user-managed sections; overwrite PRISM-shipped sections
function mergeRoster(existingRoster, shippedRoster) {
  if (!existingRoster) return shippedRoster;
  // Preserve user-managed data
  const merged = JSON.parse(JSON.stringify(shippedRoster));
  // Sections to preserve from existing (user-managed)
  for (const key of ['agents', 'skills', 'tools', 'mcps', 'index_meta', 'domain_groups']) {
    if (existingRoster[key] !== undefined) {
      merged[key] = existingRoster[key];
    }
  }
  // Merge in new schema fields (version etc. come from shipped)
  return merged;
}

// ─── Copy files per manifest ──────────────────────────────────────────────────
function copyFiles(manifest, dryRun) {
  const installed = [];
  for (const f of manifest.files) {
    const src = join(REPO_ROOT, f.src);
    const dst = join(CLAUDE_DIR, f.dst);
    if (!existsSync(src)) {
      console.warn(`[prism-installer] WARNING: source file missing: ${src}`);
      continue;
    }
    if (!dryRun) {
      ensureDir(dirname(dst));
      cpSync(src, dst);
      // chmod +x on Unix for executable files
      if (f.executable && process.platform !== 'win32') {
        try { chmodSync(dst, 0o755); } catch {}
      }
    }
    installed.push(f.dst);
  }
  return installed;
}

function copyDirectories(manifest, dryRun) {
  const installed = [];
  for (const d of manifest.directories) {
    const src = join(REPO_ROOT, d.src);
    const dst = join(CLAUDE_DIR, d.dst);
    if (!existsSync(src)) {
      console.warn(`[prism-installer] WARNING: source directory missing: ${src}`);
      continue;
    }
    // Preserve specified files before overwriting
    const preserved = {};
    if (!dryRun) {
      for (const pf of (d.preserve_files || [])) {
        const pfPath = join(dst, pf);
        if (existsSync(pfPath)) {
          try { preserved[pf] = readFileSync(pfPath, 'utf8'); } catch {}
        }
      }
      ensureDir(dst);
      cpSync(src, dst, {recursive: true, force: true});
      // Restore preserved files
      for (const [pf, content] of Object.entries(preserved)) {
        const pfPath = join(dst, pf);
        mkdirSync(dirname(pfPath), {recursive: true});
        writeFileSync(pfPath, content);
      }
    }
    installed.push(d.dst + '/');
  }
  return installed;
}

// ─── install ─────────────────────────────────────────────────────────────────
async function install() {
  const manifest = loadManifest();
  const fragment = loadSettingsFragment(manifest);

  acquireLock(flags.dryRun);
  try {
    // Step 1: detect current state
    const settingsPath = join(CLAUDE_DIR, 'settings.json');
    const rosterPath = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json');
    const shippedRosterPath = join(REPO_ROOT, 'skills', 'prism-plan', 'references', 'roster.json');

    let existingSettings = readSettings();
    const hasExistingInstall = existsSync(join(CLAUDE_DIR, 'hooks', 'prism-safety.mjs')) ||
      existsSync(join(CLAUDE_DIR, 'hooks', 'prism-hook.mjs'));

    // Step 2: backup
    let backupDir = null;
    if (!flags.noBackup && !flags.dryRun) {
      ensureDir(CLAUDE_DIR);
      backupDir = makeBackup();
      log(`[prism-installer] Backup created: ${backupDir}`);
    }

    // Load existing roster (before removing files)
    let existingRoster = null;
    if (existsSync(rosterPath)) {
      try { existingRoster = JSON.parse(readFileSync(rosterPath, 'utf8')); }
      catch {
        console.warn(`[prism-installer] WARNING: existing roster.json is malformed; backup made; will write fresh roster.`);
        if (!flags.dryRun && backupDir) {
          try { cpSync(rosterPath, join(backupDir, 'skills', 'prism-plan', 'references', 'roster.json.corrupt')); } catch {}
        }
      }
    }

    // Step 3: strip old PRISM hook entries from settings
    if (!flags.dryRun) {
      existingSettings = stripPrismHooks(existingSettings);
    }

    // Step 4: remove old PRISM files (by manifest patterns)
    if (hasExistingInstall) {
      const removed = removeOldPrismFiles(manifest, flags.dryRun);
      if (removed.length > 0) log(`[prism-installer] Removed ${removed.length} old PRISM file(s).`);
    }

    // Step 5: copy new files
    ensureDir(CLAUDE_DIR, flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'hooks'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'hooks', 'lib'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'tools'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'tools', 'lib'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'agents'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'commands'), flags.dryRun);
    ensureDir(join(CLAUDE_DIR, 'skills'), flags.dryRun);

    const installedFiles = copyFiles(manifest, flags.dryRun);
    const installedDirs = copyDirectories(manifest, flags.dryRun);
    log(`[prism-installer] Installed ${installedFiles.length} file(s), ${installedDirs.length} directory(ies).`);

    // Step 6: preserve + merge roster
    if (!flags.dryRun) {
      let shippedRoster = null;
      if (existsSync(shippedRosterPath)) {
        try { shippedRoster = JSON.parse(readFileSync(shippedRosterPath, 'utf8')); } catch {}
      }
      // After copyDirectories, the roster from the installed dir is already in place.
      // Now re-merge to restore user agents.
      if (existingRoster && shippedRoster) {
        const mergedRoster = mergeRoster(existingRoster, shippedRoster);
        const installedRosterPath = rosterPath;
        ensureDir(dirname(installedRosterPath));
        atomicWrite(installedRosterPath, JSON.stringify(mergedRoster, null, 2));
        log(`[prism-installer] Preserved ${Object.keys(existingRoster.agents || {}).length} user agent(s) in roster.`);
      }
    }

    // Step 7: merge settings.json
    if (!flags.dryRun) {
      const mergedSettings = mergeSettings(existingSettings, fragment, flags.dryRun);
      ensureDir(CLAUDE_DIR);
      atomicWrite(settingsPath, JSON.stringify(mergedSettings, null, 2));
      log(`[prism-installer] settings.json merged.`);
    }

    // Step 8: chmod +x .mjs on Unix (already done in copyFiles)
    // (handled per-file in copyFiles)

    // Step 9: verify
    if (!flags.dryRun) {
      const verifyResult = runVerifyInner(manifest);
      if (!verifyResult.allPass) {
        console.warn(`[prism-installer] WARNING: post-install verify found ${verifyResult.failures.length} issue(s):`);
        for (const f of verifyResult.failures) console.warn(`  - ${f}`);
      } else {
        log(`[prism-installer] Verify: all checks passed.`);
      }
    }

    // Step 10: summary
    if (flags.dryRun) {
      log(`[prism-installer] DRY-RUN complete. No changes made.`);
      log(`[prism-installer] Would install ${manifest.files.length} files + ${manifest.directories.length} directories.`);
    } else {
      log(`[prism-installer] PRISM ${manifest.prism_version} install complete.`);
      if (backupDir) log(`[prism-installer] Backup: ${backupDir}`);
    }

  } finally {
    releaseLock(flags.dryRun);
  }
}

// ─── uninstall ────────────────────────────────────────────────────────────────
async function uninstall() {
  const manifest = loadManifest();

  acquireLock(flags.dryRun);
  try {
    // Optional: restore backup
    if (flags.restoreBackup) {
      const backupDir = resolve(flags.restoreBackup);
      if (!existsSync(backupDir)) die(`backup directory not found: ${backupDir}`);
      const settingsBak = join(backupDir, 'settings.json');
      const rosterBak = join(backupDir, 'skills', 'prism-plan', 'references', 'roster.json');
      if (existsSync(settingsBak)) cpSync(settingsBak, join(CLAUDE_DIR, 'settings.json'));
      if (existsSync(rosterBak)) {
        mkdirSync(join(CLAUDE_DIR, 'skills', 'prism-plan', 'references'), {recursive: true});
        cpSync(rosterBak, join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json'));
      }
      log(`[prism-installer] Restored from backup: ${backupDir}`);
    }

    // Remove all PRISM files
    const removed = removeOldPrismFiles(manifest, flags.dryRun);
    log(`[prism-installer] Removed ${removed.length} PRISM file(s)/dir(s).`);

    // Strip PRISM hooks from settings.json
    const settingsPath = join(CLAUDE_DIR, 'settings.json');
    if (existsSync(settingsPath) && !flags.dryRun) {
      const existing = readSettings();
      const stripped = stripPrismHooks(existing);
      atomicWrite(settingsPath, JSON.stringify(stripped, null, 2));
      log(`[prism-installer] Stripped PRISM hooks from settings.json.`);
    }

    // State files are always preserved — we never delete .prism-*.jsonl, prism-policy.json, etc.
    // To fully clean, manually delete ~/.claude/.prism-* files after uninstall.
    if (!flags.dryRun) {
      log(`[prism-installer] State files preserved (prism-policy.json, .prism-*.jsonl, etc.). To fully clean, manually delete ~/.claude/.prism-* files.`);
    }

    log(`[prism-installer] Uninstall complete.`);

  } finally {
    releaseLock(flags.dryRun);
  }
}

// ─── verify (inner, reusable) ─────────────────────────────────────────────────
function runVerifyInner(manifest) {
  const failures = [];
  const checks = [];

  // Check each file in manifest
  for (const f of manifest.files) {
    const dst = join(CLAUDE_DIR, f.dst);
    const exists = existsSync(dst);
    checks.push({label: `file: ${f.dst}`, pass: exists});
    if (!exists) failures.push(`MISSING: ${f.dst}`);
  }

  // Check each directory in manifest
  for (const d of manifest.directories) {
    const skillMd = join(CLAUDE_DIR, d.dst, 'SKILL.md');
    const exists = existsSync(skillMd);
    checks.push({label: `dir: ${d.dst}/SKILL.md`, pass: exists});
    if (!exists) failures.push(`MISSING: ${d.dst}/SKILL.md`);
  }

  // Check settings.json parses
  const settingsPath = join(CLAUDE_DIR, 'settings.json');
  let settingsOk = false;
  let settingsData = null;
  if (existsSync(settingsPath)) {
    try { settingsData = JSON.parse(readFileSync(settingsPath, 'utf8')); settingsOk = true; }
    catch { failures.push('MALFORMED: settings.json'); }
  } else {
    failures.push('MISSING: settings.json');
  }
  checks.push({label: 'settings.json parses', pass: settingsOk});

  // Check settings.json contains PRISM hooks
  let hooksPresent = 0;
  if (settingsData && settingsData.hooks) {
    for (const evHooks of Object.values(settingsData.hooks)) {
      for (const group of evHooks) {
        for (const h of (group.hooks || [])) {
          if (isPrismHookCommand(h.command)) hooksPresent++;
        }
      }
    }
  }
  const hasHooks = hooksPresent > 0;
  checks.push({label: 'settings.json has PRISM hooks', pass: hasHooks});
  if (!hasHooks) failures.push('NO PRISM HOOKS: settings.json has no registered PRISM hooks');

  // Check roster.json parses
  const rosterPath = join(CLAUDE_DIR, 'skills', 'prism-plan', 'references', 'roster.json');
  if (existsSync(rosterPath)) {
    let rosterOk = false;
    try { JSON.parse(readFileSync(rosterPath, 'utf8')); rosterOk = true; }
    catch { failures.push('MALFORMED: skills/prism-plan/references/roster.json'); }
    checks.push({label: 'roster.json parses', pass: rosterOk});
  }

  return {checks, failures, allPass: failures.length === 0};
}

// ─── verify (subcommand) ──────────────────────────────────────────────────────
function verify() {
  const manifest = loadManifest();
  const result = runVerifyInner(manifest);

  for (const c of result.checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}: ${c.label}`);
  }

  if (result.allPass) {
    log(`\nAll checks passed. PRISM install verified.`);
    process.exit(0);
  } else {
    console.log(`\nFailed checks:`);
    for (const f of result.failures) console.log(`  ${f}`);
    process.exit(1);
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────
function help() {
  console.log(`
PRISM Installer v4.4.0

Usage:
  node tools/prism-installer.mjs <subcommand> [flags]

Subcommands:
  detect               Print JSON of current install state (no changes, exit 0 always)
  install              Full install/upgrade. Idempotent.
  uninstall            Remove PRISM files and hooks
  verify               Check all manifest files are present and hooks are wired
  --help               Show this help

Common flags:
  --home <path>        Override HOME directory (for testing/sandbox)
  --src  <path>        Override source repo root (default: derived from installer location)
  --quiet              Suppress progress output

install flags:
  --dry-run            Simulate install; print what would happen, no changes
  --no-backup          Skip backup of existing settings/roster

uninstall flags:
  --restore-backup <path>  Restore settings/roster from a backup directory
  --quiet              Suppress progress output
  (State files — .prism-*.jsonl, prism-policy.json, etc. — are always preserved.
   To fully clean, manually delete ~/.claude/.prism-* files after uninstall.)

Examples:
  node tools/prism-installer.mjs install
  node tools/prism-installer.mjs install --dry-run
  node tools/prism-installer.mjs install --home /tmp/sandbox
  node tools/prism-installer.mjs verify
  node tools/prism-installer.mjs uninstall --restore-backup ~/.claude/.prism-install-backup-2026-05-27_12-00-00
  node tools/prism-installer.mjs detect

Exit codes:
  0   Success (or detect, which always exits 0)
  1   Verify failed / general error
  2   settings.json malformed (refused to proceed)
`.trim());
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!subcommand || subcommand === '--help' || subcommand === 'help' || subcommand === '-h') {
    help();
    process.exit(0);
  }

  switch (subcommand) {
    case 'detect':
      detect();
      break;
    case 'install':
      await install();
      break;
    case 'uninstall':
      await uninstall();
      break;
    case 'verify':
      verify();
      break;
    default:
      console.error(`[prism-installer] Unknown subcommand: ${subcommand}`);
      help();
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`[prism-installer] Fatal error: ${e.message}`);
  process.exit(1);
});
