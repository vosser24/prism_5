#!/usr/bin/env node
// PRISM PreCompact flag-writer (v4.1 Phase A — D005 Phase F bundle).
//
// Writes ~/.claude/.prism-flags/clean-nudge__<project-key>.json when
// PreCompact fires (context summarization about to happen). Reuses the
// same flag name as the SessionEnd[clear] writer because the nudge text
// is the same — "consider /prism-clean to archive lessons first." The
// payload's `reason` field disambiguates ('clear' vs 'precompact').
//
// PreCompact only supports top-level `decision: block`, not
// `additionalContext` (D005's verified matrix). This hook exits 0
// (allows compaction to proceed) and writes the side-effect flag.
// SessionStart on the next session emits the nudge.
//
// Off-switch: PRISM_DISABLE_PRECOMPACT_NUDGE=1 → write nothing.

import {readFileSync} from 'fs';

try {
  if (String(process.env.PRISM_DISABLE_PRECOMPACT_NUDGE || '') === '1') process.exit(0);

  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch {}

  const cwd = input.cwd || process.cwd();
  const {writeFlag} = await import('../tools/lib/prism-flag-file.mjs');
  writeFlag('clean-nudge', cwd, {reason: 'precompact', session_id: input.session_id || null});
} catch {}
process.exit(0);
