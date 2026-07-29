#!/usr/bin/env node
// PRISM SessionEnd git-clean nudge writer (v4.1 Phase A Q3).
//
// On session end, if the project's git working tree is dirty
// (uncommitted modifications, untracked files), write a flag so the
// next SessionStart can nudge the user about lost work. Mirrors the
// D005 Phase F flag-file architecture.
//
// SessionEnd does NOT support additionalContext per D005's verified
// matrix, so we use a side-effect (flag write) + SessionStart pickup.
//
// Off-switch: PRISM_DISABLE_GIT_CLEAN_NUDGE=1 → write nothing.
// Non-git projects are silently skipped (git status returns non-zero).
//
// Fail-open: any error exits 0 silently.

import {readFileSync} from 'fs';
import {spawnSync} from 'child_process';
import {basename} from 'path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const __hooks = dirname(fileURLToPath(import.meta.url));

export async function run(payload) {
  try {
    if (String(process.env.PRISM_DISABLE_GIT_CLEAN_NUDGE || '') === '1') return {exit: 0};

    const input = payload || {};

    // Skip when SessionEnd reason is 'clear' — the clean-nudge-flag hook
    // already covers that path with a more specific nudge.
    if (input.reason === 'clear') return {exit: 0};

    const cwd = input.cwd || process.cwd();

    const res = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    if (res.status !== 0) return {exit: 0};  // not a git repo, or git unavailable

    const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return {exit: 0};  // clean tree — no nudge

    const sample = lines.slice(0, 5).map((l) => l.trim().slice(0, 80));

    const {writeFlag} = await import(pathToFileURL(join(__hooks, '..', 'tools', 'lib', 'prism-flag-file.mjs')).href);
    writeFlag('git-dirty', cwd, {
      count: lines.length,
      sample,
      session_id: input.session_id || null,
    });
  } catch {}
  return {exit: 0};
}

// Guard: only run as hook when invoked directly, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-git-clean-nudge.mjs';
if (invokedDirectly) {
  (async () => {
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch {}
    await run(input);
    process.exit(0);
  })();
}
