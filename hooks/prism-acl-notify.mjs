#!/usr/bin/env node
// hooks/prism-acl-notify.mjs — ACL SessionStart notifier (v1.0)
//
// Reads the ACL digest (.prism-acl-digest.json). If it contains created or
// upgraded capability names, emits exactly ONE non-blocking notice line via
// hookSpecificOutput.additionalContext, then clears/rotates the digest.
// If no digest exists or it is empty, emits nothing.
//
// Output format (one line per SessionStart with entries):
//   "PRISM learned: +skill monitoring-builder; +skill uptime-builder"
//   or "PRISM learned: upgraded greek-seo v1→v2"
//   or combined.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prismHome } from './lib/prism-home.mjs';

// ── getNotice(home) — read the ACL digest, build the learn-notice, clear it ──
// Exported so prism-session-start.mjs can fold the notice into its aggregated
// SessionStart additionalContext (single node process), instead of wiring a
// second SessionStart hook. `home` is passed explicitly so the caller's resolved
// HOME is honored (direct-script path reads it from env). Returns the notice
// string, or null when there is nothing to report. Side effect: rotates/clears
// the digest to empty once its entries have been picked up.
// (v5.9.4: integrated into session-start — it was deployed but previously
//  UNWIRED, so "PRISM learned:" never surfaced at session start.)
export function getNotice(home) {
  const claudeDir = join(home, '.claude');
  const digestPath = join(claudeDir, '.prism-acl-digest.json');

  if (!existsSync(digestPath)) return null;

  let digest;
  try { digest = JSON.parse(readFileSync(digestPath, 'utf-8')); }
  catch { return null; }

  const created = Array.isArray(digest.created) ? digest.created.filter(Boolean) : [];
  const upgraded = Array.isArray(digest.upgraded) ? digest.upgraded.filter(Boolean) : [];

  if (created.length === 0 && upgraded.length === 0) return null;

  const parts = [];
  for (const name of created) {
    parts.push(`+skill ${name}`);
  }
  for (const item of upgraded) {
    // item may be a string name or {name, from, to}
    if (typeof item === 'string') {
      parts.push(`upgraded ${item}`);
    } else if (item && item.name) {
      const range = item.from && item.to ? ` v${item.from}→v${item.to}` : '';
      parts.push(`upgraded ${item.name}${range}`);
    }
  }

  const notice = `PRISM learned: ${parts.join('; ')}`;

  // Clear/rotate digest (reset to empty) now that entries are picked up.
  try { writeFileSync(digestPath, JSON.stringify({ created: [], upgraded: [] }, null, 2), 'utf-8'); } catch {}

  return notice;
}

// ── Self-exec guard: run directly as a SessionStart hook script ──────────────
// When imported by session-start this is false, so getNotice() is called instead.
const isMainModule = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMainModule) {
  try {
    const home = prismHome();
    const notice = getNotice(home);
    if (notice) {
      // Emit via hookSpecificOutput.additionalContext (non-blocking, SessionStart)
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: notice,
        },
      }));
    }
  } catch {}
  process.exit(0);
}
