#!/usr/bin/env node
// v5.3.1 — the tier router must remind the main loop to BATCH independent
// subtasks on everyday dispatch turns (haiku/sonnet). Only the main loop can
// fan out, and it only parallelises Agent() calls that arrive in ONE message —
// so the default per-turn single dispatch silently serialises parallelisable
// work. The router now appends a PARALLEL batch note to haiku + sonnet advice.
//
// Run: node tests/v3/state/test-prism-parallel-fanout.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(__dirname, '..', '..', '..', 'hooks', 'prism-prompt-tier-router.mjs');

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) pass++; else console.log('FAIL: ' + l); };

// Drive the router as Claude Code does: UserPromptSubmit payload over stdin.
// Returns the full stdout (advice is carried in hookSpecificOutput.additionalContext;
// matching raw stdout is robust to the exact JSON envelope).
function route(prompt) {
  const home = mkdtempSync(join(tmpdir(), 'prism-fanout-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  try {
    const r = spawnSync(process.execPath, [ROUTER], {
      input: JSON.stringify({ prompt, session_id: 'fanout-test' }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 12000,
    });
    return (r.stdout || '') + (r.stderr || '');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// haiku-tier everyday work → dispatch advice + PARALLEL batch note.
{
  const out = route('list all files in the repo');
  check('haiku turn emits the PARALLEL batch note', /PARALLEL:/.test(out) && /MULTIPLE Agent\(\) tool_use blocks in ONE message/.test(out));
}

// sonnet-tier routine implementation → dispatch advice + PARALLEL batch note.
{
  const out = route('add unit tests for the parser module');
  check('sonnet turn emits the PARALLEL batch note', /PARALLEL:/.test(out) && /wall-clock = max/.test(out));
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
