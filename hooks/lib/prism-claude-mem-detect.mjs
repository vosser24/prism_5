// hooks/lib/prism-claude-mem-detect.mjs
// v5.2 — detect whether claude-mem (thedotmack/claude-mem) is installed.
//
// claude-mem is an OPTIONAL ambient-memory tier that captures sessions
// continuously and re-injects context at SessionStart. When it is present,
// PRISM's own memory-save nudge STANDS DOWN: claude-mem already captures
// continuously AND registers its own UserPromptSubmit hook, so PRISM's nudge
// would be a duplicate injector + redundant "save before /clear" reminder.
//
// Canonical signal: the `~/.claude-mem/` data dir — created on install and
// stable across both install paths (`npx claude-mem install` and the plugin
// marketplace). A hooks-string check in settings.json is a fragile corroborating
// signal (the plugin system may not write a literal "claude-mem" command there),
// and a PATH/binary check is unreliable on Windows/AppLocker — so the directory
// is the primary check.
//
// v5.2 (2026-07-16): a user can DISABLE the claude-mem plugin (`/plugin disable`
// or unchecking it) without uninstalling it — the ~/.claude-mem/ data dir and
// the plugin cache both survive on disk. That left claude-mem "installed" by
// the checks above even when the user turned it off, so PRISM kept probing the
// dead worker port and firing the fallback-unhealthy nudge every session. The
// real enable/disable flag is `~/.claude/settings.json` → `enabledPlugins`,
// keyed `"<plugin>@<publisher>"` → boolean (NOT `installed_plugins.json`, which
// has no enabled field at all — {scope, installPath, version, installedAt,
// lastUpdated, gitCommitSha} only). `claudeMemPluginDisabled()` reads that map;
// an explicit `false` for any `claude-mem@*` key means "treat as absent"
// everywhere. Fail-open: any read/parse error → not disabled (preserves prior
// behavior, so a genuinely enabled-but-unhealthy install still alerts).

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// True when the user has explicitly disabled a claude-mem plugin entry via
// `enabledPlugins` in settings.json. Dep-free, fail-open (any error → false,
// i.e. "not disabled" — so absence of a readable settings.json never masks a
// real installed-and-unhealthy claude-mem).
export function claudeMemPluginDisabled(home = process.env.HOME || process.env.USERPROFILE) {
  if (!home) return false;
  try {
    const raw = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    const enabledPlugins = settings && settings.enabledPlugins;
    if (!enabledPlugins || typeof enabledPlugins !== 'object') return false;
    for (const key of Object.keys(enabledPlugins)) {
      if (key.startsWith('claude-mem@') && enabledPlugins[key] === false) return true;
    }
    return false;
  } catch {
    return false; // no/unreadable/malformed settings.json — behave as before
  }
}

// Returns true when claude-mem appears installed for the given home dir.
// Accepts an explicit home for testability; defaults to HOME/USERPROFILE.
export function claudeMemInstalled(home = process.env.HOME || process.env.USERPROFILE) {
  if (!home) return false;
  // A user-disabled plugin is treated as absent everywhere, regardless of
  // leftover on-disk artifacts (data dir, plugin cache) — see v5.2 note above.
  if (claudeMemPluginDisabled(home)) return false;
  // Primary: the ~/.claude-mem/ data dir (created on install).
  if (existsSync(join(home, '.claude-mem'))) return true;
  // Corroborating: a hook command referencing claude-mem in settings.json.
  try {
    if (/claude-mem/.test(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))) return true;
  } catch { /* no settings.json — fall through */ }
  return false;
}

// Health probe (sync, side-effect-free): claude-mem's worker writes a
// consecutive-failure counter to ~/.claude-mem/state/hook-failures.json.
// Healthy <=> file exists AND consecutiveFailures === 0. A missing/parse-error
// file is treated as UNHEALTHY (fail toward re-enabling PRISM's native nudge),
// so a never-started or crashed worker never silently disables auto-recall.
export function claudeMemHealthy(home) {
  try {
    const p = join(home, '.claude-mem', 'state', 'hook-failures.json');
    if (!existsSync(p)) return false;
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    return Number(j.consecutiveFailures || 0) === 0;
  } catch { return false; }
}
