#!/usr/bin/env node
// PRISM SessionEnd[matcher=clear] flag-writer (v4.1 Phase A — D005 Phase F bundle).
//
// Writes ~/.claude/.prism-flags/clean-nudge__<project-key>.json when the
// session ended via /clear. The SessionStart hook on the next session
// reads + clears the flag and emits the actual nudge text via
// additionalContext (which SessionEnd cannot do per D005's verified
// per-event decision-control matrix).
//
// Off-switch: PRISM_DISABLE_CLEAR_NUDGE=1 → write nothing.
//
// Fail-open: any error exits 0 silently — never blocks session-end.

import {readFileSync} from 'fs';

try {
  if (String(process.env.PRISM_DISABLE_CLEAR_NUDGE || '') === '1') process.exit(0);

  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch {}

  // SessionEnd payload carries `reason` ('clear', 'exit', 'logout', etc).
  // Defensive: only fire for explicit /clear, even though the matcher
  // already filters at the harness layer. Belt-and-suspenders.
  if (input.reason && input.reason !== 'clear') process.exit(0);

  const cwd = input.cwd || process.cwd();
  const {writeFlag} = await import('../tools/lib/prism-flag-file.mjs');
  writeFlag('clean-nudge', cwd, {reason: 'clear', session_id: input.session_id || null});
} catch {}
process.exit(0);
