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
import {basename} from 'path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const __hooks = dirname(fileURLToPath(import.meta.url));

export async function run(payload) {
  try {
    if (String(process.env.PRISM_DISABLE_CLEAR_NUDGE || '') === '1') return {exit: 0};

    const input = payload || {};

    // SessionEnd payload carries `reason` ('clear', 'exit', 'logout', etc).
    // Defensive: only fire for explicit /clear, even though the matcher
    // already filters at the harness layer. Belt-and-suspenders.
    if (input.reason && input.reason !== 'clear') return {exit: 0};

    const cwd = input.cwd || process.cwd();
    const {writeFlag} = await import(pathToFileURL(join(__hooks, '..', 'tools', 'lib', 'prism-flag-file.mjs')).href);
    writeFlag('clean-nudge', cwd, {reason: 'clear', session_id: input.session_id || null});
  } catch {}
  return {exit: 0};
}

// Guard: only run as hook when invoked directly, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-clean-nudge-flag.mjs';
if (invokedDirectly) {
  (async () => {
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch {}
    await run(input);
    process.exit(0);
  })();
}
