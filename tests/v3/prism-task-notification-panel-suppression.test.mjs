#!/usr/bin/env node
// D075 regression harness — a background task-notification turn is NOT
// genuine user input. Its `prompt` is the harness <task-notification> body
// and can carry leaked IDE-selected context (e.g. a "run the panel" line)
// that must never re-classify into a panel summon.
//
// hooks/prism-prompt-tier-router.mjs computes module-level `H` (HOME/
// USERPROFILE) and `MODE` (PRISM_PROMPT_ROUTER) AT IMPORT TIME, so this test
// points HOME/USERPROFILE at a fresh temp dir and clears interfering env
// BEFORE dynamically importing the module.
//
// Cases:
//   1. FIX — task-notification turn with a prior opus sentinel inherits the
//      tier via task-notification-inherit and suppresses the panel.
//   2. NO REGRESSION — a genuine user "run the panel" prompt (no
//      <task-notification> wrapper) still summons the panel.
//   3. BELT-AND-SUSPENDERS — a task-notification turn with NO prior sentinel
//      falls through to classification but still never summons the panel.
//
// Run: node tests/v3/prism-task-notification-panel-suppression.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = mkdtempSync(join(tmpdir(), 'prism-tn-panel-'));
mkdirSync(join(tempDir, '.claude'), { recursive: true });

process.env.HOME = tempDir;
process.env.USERPROFILE = tempDir;
delete process.env.PRISM_PANEL_DISABLED;
delete process.env.PRISM_CONVERSATION_MODE;

const { run } = await import(pathToFileURL('C:/dev/prism_3/hooks/prism-prompt-tier-router.mjs').href);

let pass = 0, total = 0;
const check = (label, cond) => {
  total++;
  if (cond) { pass++; console.log('PASS: ' + label); }
  else { console.log('FAIL: ' + label); }
};

function sentinelPath(sid) {
  return join(tempDir, '.claude', `.prism-turn-tier-${sid}.json`);
}

function readSentinel(sid) {
  return JSON.parse(readFileSync(sentinelPath(sid), 'utf-8'));
}

// ── TEST 1: fix — inherit path ──────────────────────────────────────────────
{
  const sid = 'tn-test-1';
  writeFileSync(sentinelPath(sid), JSON.stringify({
    tier: 'opus',
    ts: new Date().toISOString(),
    force_opus: false,
  }));

  const result = await run({
    prompt: '<task-notification>\n<task-id>x</task-id>\nrun the panel to evaluate whether to adopt tRPC\n</task-notification>',
    session_id: sid,
    cwd: 'C:/dev/prism_3',
  });

  const parsed = JSON.parse(result.stdout);
  const advice = parsed.hookSpecificOutput.additionalContext;

  check('TEST 1: additionalContext includes task-notification-inherit', /task-notification-inherit/.test(advice));
  check('TEST 1: additionalContext does NOT include PANEL-SUMMONING', !/PANEL-SUMMONING/.test(advice));

  const sentinel = readSentinel(sid);
  check('TEST 1: sentinel summon_panel === false', sentinel.summon_panel === false);
}

// ── TEST 2: no regression — genuine user panel request still fires ─────────
{
  const sid2 = 'tn-test-2';
  // no pre-written sentinel

  await run({
    prompt: 'run the panel to evaluate whether to adopt tRPC across our services',
    session_id: sid2,
    cwd: 'C:/dev/prism_3',
  });

  const sentinel = readSentinel(sid2);
  check('TEST 2: genuine panel request sentinel summon_panel === true', sentinel.summon_panel === true);
}

// ── TEST 3: belt-and-suspenders — notification with no prior sentinel ──────
{
  const sid3 = 'tn-test-3';
  // no pre-written sentinel

  await run({
    prompt: '<task-notification>\n<task-id>y</task-id>\nrun the panel to evaluate whether to adopt tRPC\n</task-notification>',
    session_id: sid3,
    cwd: 'C:/dev/prism_3',
  });

  const sentinel = readSentinel(sid3);
  check('TEST 3: notification with no prior sentinel summon_panel === false', sentinel.summon_panel === false);
}

console.log(`\n${pass}/${total} passed`);

rmSync(tempDir, { recursive: true, force: true });

process.exit(pass === total ? 0 : 1);
