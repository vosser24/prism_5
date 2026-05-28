#!/usr/bin/env node
// PRISM Installer v4.5.0
//
// Subcommands:
//   detect   — print JSON of current install state, no changes (exit 0 always)
//   install  — full install/upgrade. Idempotent.
//   update   — detect → (idempotency check) → backup → install; respects --dry-run
//   uninstall — reverse the install
//   verify   — check every manifest file is present + hooks wired (exit 0 ok, 1 fail)
//   --help   — usage
//
// Common flags:
//   --home <path>   sandbox HOME override (mirrors prism-telemetry-aggregate.mjs)
//   --target <dir>  point directly at a .claude/ directory (mutually exclusive with --home)
//   --src  <path>   source repo override (default: derived from import.meta.url)
//   --dry-run       (install only) simulate, no filesystem changes
//   --no-backup     (install only) skip backup step
//   --quiet         suppress progress output
//   --purge-state   (uninstall only) wipe state files; --yes skip confirm
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
import {spawnSync} from 'child_process';
import { withRosterLock } from './lib/prism-roster-lock.mjs';

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
    target: null,
    src: null,
    dryRun: false,
    noBackup: false,
    quiet: false,
    restoreBackup: null,
    purgeState: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--home') flags.home = args[++i];
    else if (a === '--target') flags.target = args[++i];
    else if (a === '--src') flags.src = args[++i];
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-backup') flags.noBackup = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--restore-backup') flags.restoreBackup = args[++i];
    else if (a === '--purge-state') flags.purgeState = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
  }
  return flags;
}

const flags = parseFlags(restArgs);

// ─── Paths ───────────────────────────────────────────────────────────────────
if (flags.home && flags.target) {
  console.error('[prism-installer] ERROR: --home and --target are mutually exclusive');
  process.exit(2);
}
let CLAUDE_DIR;
if (flags.target) {
  const abs = resolve(flags.target);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    console.error(`[prism-installer] ERROR: --target does not exist or is not a directory: ${abs}`);
    process.exit(2);
  }
  CLAUDE_DIR = abs;
} else {
  const HOME = flags.home || process.env.HOME || process.env.USERPROFILE || homedir();
  CLAUDE_DIR = join(HOME, '.claude');
}
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
  } catch (renameErr) {
    try { unlinkSync(tmp); } catch {}
    const err = new Error(`atomicWrite failed for ${path}: ${renameErr.message}`);
    err.code = 'ATOMIC_WRITE_FAILED';
    throw err;
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

function readLineFromStdin() {
  try {
    const buf = readFileSync(0, 'utf-8');  // 0 = stdin fd
    const line = buf.split(/\r?\n/)[0] ?? '';
    return line.trim();
  } catch {
    return '';  // stdin closed / EOF → treat as no
  }
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
    die(`settings.json appears malformed (${e.message}); refusing to proceed (no changes made). Inspect or fix the file manually, then re-run.`, 2);
  }
}

// Check if a hook command is a PRISM hook (by name pattern)
function isPrismHookCommand(cmd) {
  return typeof cmd === 'string' &&
    (cmd.includes('prism-exec.sh') || cmd.includes('prism-exec.cmd')) &&
    cmd.includes('prism-');
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
    } catch (parseErr) {
      console.warn(`WARNING: lock file at ${LOCK_PATH} is corrupt; treating as stale and proceeding.`);
      // proceed
    }
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ts: new Date().toISOString(), pid: process.pid}));
}

function releaseLock(dryRun) {
  if (dryRun) return;
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ─── detect ──────────────────────────────────────────────────────────────────
function detectInternal() {
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

  return {
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
}

function detect() {
  const result = detectInternal();
  console.log(JSON.stringify(result, null, 2));
  // detect always exits 0
}

// ─── Backup ──────────────────────────────────────────────────────────────────
function getSourceRepoSha() {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: REPO_ROOT, encoding: 'utf-8'});
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {}
  return 'unknown';
}

function getInstalledPrismVersion() {
  try {
    const pluginJson = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
    if (existsSync(pluginJson)) {
      const p = JSON.parse(readFileSync(pluginJson, 'utf-8'));
      if (p.version) return p.version;
    }
  } catch {}
  return 'unknown';
}

function makeBackup() {
  const timestamp = new Date().toISOString();
  const ts = timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupDir = join(CLAUDE_DIR, `.prism-install-backup-${ts}`);
  mkdirSync(backupDir, {recursive: true});

  // Load manifest once
  const manifest = (() => {
    try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')); } catch { return null; }
  })();
  if (!manifest) die('failed to load install-manifest.json for backup');

  // Build the union of paths to back up (relative to CLAUDE_DIR)
  const filePaths = (manifest.files || []).map(f => f.dst);
  const dirPaths = (manifest.directories || []).map(d => d.dst);
  const extraPaths = manifest.backup_paths || [];

  const backupFailures = [];
  const filesBackedUp = [];

  // Helper: copy one path (file or dir) preserving relative structure
  const backupOne = (relPath) => {
    const src = join(CLAUDE_DIR, relPath);
    if (!existsSync(src)) return;
    const dst = join(backupDir, relPath);
    mkdirSync(dirname(dst), {recursive: true});
    try {
      const st = lstatSync(src);
      if (st.isDirectory()) {
        cpSync(src, dst, {recursive: true});
      } else {
        cpSync(src, dst);
      }
      filesBackedUp.push(relPath);
    } catch (e) {
      backupFailures.push({file: relPath, error: e.message});
    }
  };

  for (const p of filePaths) backupOne(p);
  for (const p of dirPaths) backupOne(p);
  for (const p of extraPaths) backupOne(p);

  if (backupFailures.length > 0) {
    console.warn(`[prism-installer] WARNING: ${backupFailures.length} file(s) failed to back up:`);
    for (const f of backupFailures) console.warn(`  - ${f.file}: ${f.error}`);
    // Existing settings.json refusal logic — keep it
    if (backupFailures.some(f => f.file === 'settings.json')) {
      die(`settings.json backup failed; refusing to proceed (pass --no-backup to override).`, 3);
    }
  }

  // I1: backup-metadata.json — update files_backed_up to the real list
  const metadata = {
    timestamp,
    installed_prism_version: getInstalledPrismVersion(),
    installer_version: manifest.prism_version,
    source_repo_sha: getSourceRepoSha(),
    files_backed_up: filesBackedUp,   // now the actual list, not the legacy 3
    recovery_note: 'To rollback hook/tool code: git checkout <source_repo_sha> in your PRISM clone and re-run install.',
  };
  try {
    writeFileSync(join(backupDir, 'backup-metadata.json'), JSON.stringify(metadata, null, 2));
  } catch {}

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

  // Merge statusLine: only set if no existing statusLine (user's custom statusline preserved)
  if (fragment.statusLine && !merged.statusLine) {
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
// Merge agents at per-agent level so new shipped agents are added and user agents preserved
function mergeAgentsMaps(shippedAgents, existingAgents) {
  const result = {};
  const allKeys = new Set([
    ...Object.keys(shippedAgents || {}),
    ...Object.keys(existingAgents || {}),
  ]);
  for (const key of allKeys) {
    if (key.startsWith('_')) continue;  // schema example entries handled separately
    if (existingAgents && existingAgents[key]) {
      result[key] = existingAgents[key];  // user state preserved
    } else if (shippedAgents && shippedAgents[key]) {
      result[key] = shippedAgents[key];  // new shipped agent
    }
  }
  return result;
}

// Preserve user-managed sections; overwrite PRISM-shipped sections
function mergeRoster(existingRoster, shippedRoster) {
  if (!existingRoster) return shippedRoster;
  // Preserve user-managed data
  const merged = JSON.parse(JSON.stringify(shippedRoster));
  // agents: per-agent merge so new shipped agents aren't stripped on upgrade
  merged.agents = mergeAgentsMaps(shippedRoster.agents, existingRoster.agents);
  // Other user-managed sections: whole-section preserve (populated by /prism-index)
  for (const key of ['skills', 'tools', 'mcps', 'index_meta', 'domain_groups']) {
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
        // C3: escalate to blocking abort instead of silently wiping user agent data
        const corruptBackupPath = backupDir
          ? join(backupDir, 'skills', 'prism-plan', 'references', 'roster.json.corrupt')
          : rosterPath + '.corrupt';
        if (!flags.dryRun && backupDir) {
          try { cpSync(rosterPath, corruptBackupPath); } catch {}
        }
        const invocation = flags.target
          ? `node tools/prism-installer.mjs install --target ${flags.target}`
          : flags.home
          ? `node tools/prism-installer.mjs install --home ${flags.home}`
          : `node tools/prism-installer.mjs install`;
        die([
          'roster.json at ' + rosterPath + ' is malformed; refusing to overwrite.',
          'Inspect the file (backup at ' + corruptBackupPath + ') and either:',
          '  - fix the JSON syntax + re-run install',
          '  - rename the file to roster.json.broken to start fresh:',
          '    mv ' + rosterPath + ' ' + rosterPath + '.broken && ' + invocation,
          'NEVER auto-wipe agent data without explicit user confirmation.',
        ].join('\n'), 2);
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
      // Now re-merge to restore user agents, protected by the roster lock.
      if (existingRoster && shippedRoster) {
        await withRosterLock(rosterPath, async () => {
          const mergedRoster = mergeRoster(existingRoster, shippedRoster);
          const installedRosterPath = rosterPath;
          ensureDir(dirname(installedRosterPath));
          atomicWrite(installedRosterPath, JSON.stringify(mergedRoster, null, 2));
        });
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

    // Step 10: write version marker + summary
    if (flags.dryRun) {
      log(`[prism-installer] DRY-RUN complete. No changes made.`);
      log(`[prism-installer] Would install ${manifest.files.length} files + ${manifest.directories.length} directories.`);
    } else {
      atomicWrite(join(CLAUDE_DIR, '.prism-version'), manifest.prism_version);
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

    // Remove version marker
    if (!flags.dryRun) {
      safeUnlink(join(CLAUDE_DIR, '.prism-version'));
    }

    // State files are preserved by default — .prism-*.jsonl, prism-policy.json, etc.
    // Pass --purge-state to remove them.
    if (!flags.purgeState && !flags.dryRun) {
      log(`[prism-installer] State files preserved (prism-policy.json, .prism-*.jsonl, etc.). Use --purge-state to remove them.`);
    }

    if (flags.purgeState) {
      if (!flags.yes) {
        if (flags.quiet) {
          console.error('[uninstall] --purge-state requires --yes when --quiet');
          process.exit(2);
        }
        // Interactive confirm
        process.stdout.write('[uninstall] --purge-state will DELETE: roster.json, MEMORY.md, .prism-routing.jsonl, .prism-spend.jsonl, .prism-phase-1-5-verdicts.jsonl, .prism-telemetry-rollup.json, prism-policy.json, .prism-flags/, .prism-task-*/. Continue? [y/N] ');
        const answer = readLineFromStdin();
        if (answer.toLowerCase() !== 'y') {
          log('[uninstall] --purge-state aborted by user; state preserved.');
          return;
        }
      }
      // Purge: build full list from manifest user_state_paths_preserved + extras
      // Note: globPattern(base, pattern) treats patterns ending with '/' as exact dir matches,
      // not as globs. We strip trailing '/' before calling it so '.prism-task-*/' correctly
      // hits the wildcard branch (and '.prism-flags/' hits the exact-dir branch).
      const preserved = manifest.user_state_paths_preserved || [];
      const extras = ['MEMORY.md', 'skills/prism-plan/references/roster.json'];
      const purgeList = [...preserved, ...extras];
      let purged = 0;
      for (const pattern of purgeList) {
        if (flags.dryRun) {
          log(`[uninstall] --dry-run: would purge ${pattern}`);
          continue;
        }
        // Strip trailing '/' before passing to globPattern so the wildcard branch is reached
        // for patterns like '.prism-task-*/' — globPattern's directory branch does a literal
        // existsSync and would never match a glob with '*' in the name.
        const strippedPattern = pattern.replace(/\/$/, '');
        const matches = globPattern(CLAUDE_DIR, strippedPattern);
        if (matches.length === 0 && !strippedPattern.includes('*')) {
          // Non-glob file/dir that doesn't exist — skip silently
          continue;
        }
        for (const m of matches) {
          try {
            const st = lstatSync(m);
            if (st.isDirectory()) {
              rmSync(m, {recursive: true, force: true});
            } else {
              safeUnlink(m);
            }
            const rel = m.replace(CLAUDE_DIR + '/', '').replace(CLAUDE_DIR + '\\', '');
            log(`[uninstall] purged: ${rel}`);
            purged++;
          } catch {}
        }
      }
      log(`[uninstall] --purge-state removed ${purged} state item(s).`);
    }

    log(`[prism-installer] Uninstall complete.`);

  } finally {
    releaseLock(flags.dryRun);
  }
}

// ─── update ───────────────────────────────────────────────────────────────────
async function runUpdate() {
  // Step 1: read manifest for shipped version
  const manifest = loadManifest();
  const shippedVersion = manifest.prism_version;

  // Step 2: detect current install state (without printing to stdout)
  const detection = detectInternal();

  // Step 3: read installed version from marker file
  const versionMarkerPath = join(CLAUDE_DIR, '.prism-version');
  let installedVersion = 'unknown';
  if (existsSync(versionMarkerPath)) {
    try {
      installedVersion = readFileSync(versionMarkerPath, 'utf8').trim();
    } catch {
      installedVersion = 'unknown';
    }
  }

  // Step 4: decide
  if (!detection.installed) {
    log(`[update] no existing install at ${CLAUDE_DIR}; running fresh install.`);
    if (flags.dryRun) {
      log(`[update] --dry-run: would install v${shippedVersion}.`);
      return 0;
    }
    await install();
    return 0;
  } else if (installedVersion === shippedVersion) {
    log(`[update] Already at v${shippedVersion}; nothing to do.`);
    return 0;
  } else {
    // mismatch or unknown
    if (installedVersion === 'unknown') {
      log(`[update] installed version unknown (no .prism-version marker); upgrading to v${shippedVersion}.`);
    } else {
      log(`[update] Upgrading from v${installedVersion} → v${shippedVersion}.`);
    }
    if (flags.dryRun) {
      log(`[update] --dry-run: would back up and install.`);
      return 0;
    }
    await install();
    return 0;
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
PRISM Installer v4.5.0

Usage:
  node tools/prism-installer.mjs <subcommand> [flags]

Subcommands:
  detect               Print JSON of current install state (no changes, exit 0 always)
  install              Full install/upgrade. Idempotent.
  update               detect → idempotency check → backup → install; respects --dry-run
  uninstall            Remove PRISM files and hooks
  verify               Check all manifest files are present and hooks are wired
  --help               Show this help

Common flags:
  --home <path>        Override HOME directory (for testing/sandbox)
  --target <dir>       Point directly at a .claude/ directory (mutually exclusive with --home)
  --src  <path>        Override source repo root (default: derived from installer location)
  --quiet              Suppress progress output

install / update flags:
  --dry-run            Simulate install/update; print what would happen, no changes
  --no-backup          Skip backup of existing settings/roster

uninstall flags:
  --restore-backup <path>  Restore settings/roster from a backup directory
  --purge-state        Also delete preserved state files (roster.json, MEMORY.md,
                       .prism-*.jsonl, prism-policy.json, .prism-flags/, .prism-task-*/)
  --yes / -y           Skip confirmation prompt for --purge-state
  --quiet              Suppress progress output
  (State files — .prism-*.jsonl, prism-policy.json, etc. — are preserved by default.
   Pass --purge-state to remove them; add --yes to skip the confirmation prompt.)

Examples:
  node tools/prism-installer.mjs install
  node tools/prism-installer.mjs install --dry-run
  node tools/prism-installer.mjs install --home /tmp/sandbox
  node tools/prism-installer.mjs install --target /path/to/.claude
  node tools/prism-installer.mjs update
  node tools/prism-installer.mjs update --dry-run
  node tools/prism-installer.mjs update --target /path/to/.claude
  node tools/prism-installer.mjs verify
  node tools/prism-installer.mjs uninstall --restore-backup ~/.claude/.prism-install-backup-2026-05-27_12-00-00
  node tools/prism-installer.mjs uninstall --purge-state --yes
  node tools/prism-installer.mjs detect

Exit codes:
  0   Success (or detect, which always exits 0)
  1   Verify failed / general error
  2   Usage error / settings.json malformed (refused to proceed)
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
    case 'update':
      process.exit(await runUpdate());
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
