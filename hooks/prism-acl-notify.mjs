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

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(HOME, '.claude');
const DIGEST_PATH = join(CLAUDE_DIR, '.prism-acl-digest.json');

try {
  // Read digest
  if (!existsSync(DIGEST_PATH)) {
    process.exit(0);
  }

  let digest;
  try { digest = JSON.parse(readFileSync(DIGEST_PATH, 'utf-8')); }
  catch { process.exit(0); }

  const created = Array.isArray(digest.created) ? digest.created.filter(Boolean) : [];
  const upgraded = Array.isArray(digest.upgraded) ? digest.upgraded.filter(Boolean) : [];

  if (created.length === 0 && upgraded.length === 0) {
    process.exit(0);
  }

  // Build notice line
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

  // Emit via hookSpecificOutput.additionalContext (non-blocking, SessionStart)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: notice,
    },
  }));

  // Clear/rotate digest (reset to empty)
  writeFileSync(DIGEST_PATH, JSON.stringify({ created: [], upgraded: [] }, null, 2), 'utf-8');

} catch {}

process.exit(0);
