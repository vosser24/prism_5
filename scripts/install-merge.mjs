#!/usr/bin/env node
// PRISM install merger (v2.7.3)
//
// Replaces the inline `node -e "..."` approach in INSTALL.md §4. The inline
// form hit three escape-handling traps on Windows+git-bash during the v2.7.2
// install:
//   1. Template-literal \\ got flattened by git-bash before reaching node
//   2. JSON.stringify double-escaped backslashes
//   3. Two retries before the String.fromCharCode(92) + plain-concat form
//      landed correctly
//
// Putting the merge logic in a source-controlled file removes all three.
// Claude runs one command in INSTALL.md §4:
//   node scripts/install-merge.mjs
//
// What this does:
//   §4a — OS-aware hook-command rewrite (Windows only).
//         `bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/<X>.mjs`
//         becomes
//         `cmd /c "%USERPROFILE%\.claude\hooks\lib\prism-exec.cmd" "%USERPROFILE%\.claude\hooks\<X>.mjs"`
//   §4b — Stale-entry prune. Removes pre-2.3 raw-node hook entries from
//         the user's existing settings.json (these are the source of the
//         /bin/sh: node: not found spew). Matches both prism-*.mjs and
//         atlas-*.mjs shapes, POSIX and Windows path forms.
//   §4c — Deep-merge settings.fragment.json into settings.json:
//         - env: shallow merge (fragment wins on key conflict)
//         - hooks: per-event append, only if no existing entry has the
//           same command string
//         - statusLine: set only if user hasn't configured one
//         - permissions / enabledPlugins / other top-level keys: untouched
//
// Reads: settings.fragment.json from the repo root (the cwd this script
//        runs from).
// Writes: ~/.claude/settings.json.
//
// Exits 0 on success. Prints a summary (pruned count, merged count, etc.)
// that INSTALL.md §8 consumes for the final report.
//
// Safe to re-run: idempotent. Running it twice with no intervening changes
// to the fragment is a no-op (merged entries already exist with matching
// command strings; prune patterns won't match the new wrapper form).

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {homedir, platform} from 'node:os';
import {join, dirname, resolve} from 'node:path';

const HOME = homedir();
const IS_WIN = platform() === 'win32';
const SETTINGS_PATH = join(HOME, '.claude', 'settings.json');
const BACKSLASH = String.fromCharCode(92);  // bypasses shell escape mangling
const QUOTE = String.fromCharCode(34);

function log(msg) {
  process.stdout.write(msg + '\n');
}

function loadFragment() {
  const fragmentPath = resolve(process.cwd(), 'settings.fragment.json');
  if (!existsSync(fragmentPath)) {
    console.error(`FATAL: settings.fragment.json not found at ${fragmentPath}`);
    console.error('Run this script from the PRISM repo root.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(fragmentPath, 'utf-8'));
}

function loadExisting() {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`FATAL: ${SETTINGS_PATH} is not valid JSON: ${err.message}`);
    console.error('Restore from ~/.claude/backups/pre-prism-* manually.');
    process.exit(1);
  }
}

// Rewrite a POSIX hook command to its Windows-cmd form.
// Input:  bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/X.mjs
// Output: cmd /c "%USERPROFILE%\.claude\hooks\lib\prism-exec.cmd" "%USERPROFILE%\.claude\hooks\X.mjs"
function rewriteToWindows(cmd) {
  if (!IS_WIN) return cmd;
  const m = cmd.match(/^bash\s+~\/\.claude\/hooks\/lib\/prism-exec\.sh\s+(.+)$/);
  if (!m) return cmd;  // Not a prism-exec wrapper; leave alone (e.g., statusline).
  let hookPath = m[1].trim();
  if (hookPath.startsWith('~/')) {
    hookPath =
      '%USERPROFILE%' + BACKSLASH + hookPath.slice(2).split('/').join(BACKSLASH);
  }
  const wrapperPath =
    '%USERPROFILE%' +
    BACKSLASH + '.claude' +
    BACKSLASH + 'hooks' +
    BACKSLASH + 'lib' +
    BACKSLASH + 'prism-exec.cmd';
  return 'cmd /c ' + QUOTE + wrapperPath + QUOTE + ' ' + QUOTE + hookPath + QUOTE;
}

function applyWindowsRewrite(fragment) {
  if (!IS_WIN || !fragment.hooks) return fragment;
  const copy = JSON.parse(JSON.stringify(fragment));
  for (const evt of Object.keys(copy.hooks)) {
    for (const group of copy.hooks[evt]) {
      if (!Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (h.type === 'command' && typeof h.command === 'string') {
          h.command = rewriteToWindows(h.command);
        }
      }
    }
  }
  return copy;
}

// Stale-entry patterns (§4b). Match any existing hook entry that uses the
// pre-2.3 raw-node invocation. Covers POSIX and Windows path forms, plus
// the legacy atlas-* naming from pre-2.4.
function buildStalePatterns() {
  const patterns = [
    // POSIX prism-*.mjs raw-node
    /^node\s+~\/\.claude\/hooks\/prism-[A-Za-z0-9._-]+\.mjs/,
    // POSIX atlas-*.mjs raw-node (pre-2.4)
    /^node\s+~\/\.claude\/hooks\/atlas-[A-Za-z0-9._-]+\.mjs/,
    // Legacy atlas-exec.sh wrapper (pre-2.4)
    /^bash\s+~\/\.claude\/hooks\/lib\/atlas-exec\.sh(\s|$)/,
  ];
  // Windows-path forms. Build regex at runtime so backslashes are literal
  // characters in the source string, not escape sequences that need
  // double-escaping in a regex literal.
  const winPrismPrefix =
    '^node\\s+%USERPROFILE%' + BACKSLASH + BACKSLASH +
    '\\.claude' + BACKSLASH + BACKSLASH +
    'hooks' + BACKSLASH + BACKSLASH +
    'prism-[A-Za-z0-9._-]+\\.mjs';
  const winAtlasPrefix =
    '^node\\s+%USERPROFILE%' + BACKSLASH + BACKSLASH +
    '\\.claude' + BACKSLASH + BACKSLASH +
    'hooks' + BACKSLASH + BACKSLASH +
    'atlas-[A-Za-z0-9._-]+\\.mjs';
  patterns.push(new RegExp(winPrismPrefix, 'i'));
  patterns.push(new RegExp(winAtlasPrefix, 'i'));
  return patterns;
}

function pruneStale(existing, stalePatterns) {
  if (!existing.hooks) return 0;
  let pruned = 0;
  for (const evt of Object.keys(existing.hooks)) {
    const groups = existing.hooks[evt];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(h => {
        if (!h || typeof h.command !== 'string') return true;
        for (const rx of stalePatterns) {
          if (rx.test(h.command)) return false;
        }
        return true;
      });
      pruned += before - group.hooks.length;
    }
    // Drop groups that became empty after pruning.
    existing.hooks[evt] = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
  }
  return pruned;
}

function mergeHooks(existing, fragment) {
  existing.hooks = existing.hooks || {};
  let added = 0;
  for (const evt of Object.keys(fragment.hooks || {})) {
    existing.hooks[evt] = existing.hooks[evt] || [];
    for (const fragGroup of fragment.hooks[evt]) {
      for (const fragHook of (fragGroup.hooks || [])) {
        const fragCmd = fragHook.command;
        if (typeof fragCmd !== 'string') continue;
        // Check whether any existing group/hook has the same command string.
        let alreadyPresent = false;
        for (const g of existing.hooks[evt]) {
          for (const h of (g.hooks || [])) {
            if (h && h.command === fragCmd) {
              alreadyPresent = true;
              break;
            }
          }
          if (alreadyPresent) break;
        }
        if (alreadyPresent) continue;
        const newGroup = { hooks: [fragHook] };
        if (fragGroup.matcher !== undefined) newGroup.matcher = fragGroup.matcher;
        existing.hooks[evt].push(newGroup);
        added++;
      }
    }
  }
  return added;
}

function main() {
  log(`PRISM install merger (v2.7.3) — platform=${platform()}`);
  log(`Reading fragment from: ${resolve(process.cwd(), 'settings.fragment.json')}`);
  log(`Writing settings to:   ${SETTINGS_PATH}`);

  const fragmentRaw = loadFragment();
  const existing = loadExisting();

  // §4a — Windows rewrite (no-op on POSIX).
  const fragment = applyWindowsRewrite(fragmentRaw);
  if (IS_WIN) {
    log('§4a: fragment hook commands rewritten to cmd /c "%USERPROFILE%\\..." form');
  } else {
    log('§4a: skipped (non-Windows platform)');
  }

  // §4b — Prune stale pre-2.3 raw-node entries + legacy atlas-* entries.
  const stale = buildStalePatterns();
  const prunedCount = pruneStale(existing, stale);
  log(`§4b: pruned ${prunedCount} stale hook entry/entries from existing settings.json`);

  // §4c — Deep merge.
  existing.env = Object.assign({}, existing.env || {}, fragment.env || {});
  const envKeys = Object.keys(existing.env || {}).length;

  const addedCount = mergeHooks(existing, fragment);
  log(`§4c: merged ${addedCount} new hook entry/entries (skipped duplicates by command-string match)`);

  // statusLine: set only if user doesn't already have one.
  if (!existing.statusLine && fragment.statusLine) {
    existing.statusLine = fragment.statusLine;
    log('§4c: statusLine set from fragment (no existing user value)');
  } else if (existing.statusLine) {
    log('§4c: statusLine preserved (existing user value detected, not overwritten)');
  }

  // Write back.
  writeFileSync(SETTINGS_PATH, JSON.stringify(existing, null, 2));

  // Summary (INSTALL.md §8 greps these).
  log('');
  log('=== MERGE SUMMARY ===');
  log(`PRUNED_COUNT=${prunedCount}`);
  log(`MERGED_NEW_HOOK_ENTRIES=${addedCount}`);
  log(`ENV_KEYS=${envKeys}`);
  log(`STATUSLINE_PRESERVED=${!!existing.statusLine}`);
  log(`TOTAL_TOP_LEVEL_KEYS=${Object.keys(existing).length}`);
  log('Merge complete.');
}

main();
