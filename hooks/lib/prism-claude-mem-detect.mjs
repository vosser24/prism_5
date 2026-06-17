// hooks/lib/prism-claude-mem-detect.mjs
// v5.1 — detect whether claude-mem (thedotmack/claude-mem) is installed.
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

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// Returns true when claude-mem appears installed for the given home dir.
// Accepts an explicit home for testability; defaults to HOME/USERPROFILE.
export function claudeMemInstalled(home = process.env.HOME || process.env.USERPROFILE) {
  if (!home) return false;
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
