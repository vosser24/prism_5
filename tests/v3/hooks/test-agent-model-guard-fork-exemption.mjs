#!/usr/bin/env node
// #56/F41 — agent-model-guard: exempt subagent_type:'fork' from the model
// nudge/deny advisory.
//
// WHY: per the Agent tool contract, subagent_type:'fork' ALWAYS runs on the
// caller's model — a `model` override is a documented no-op. The firing
// predicate at hooks/prism-agent-model-guard.mjs (tier==='haiku'/'sonnet' &&
// mult>1) never consulted subagentType (confirmed: grep for "fork" in that
// file returned no matches before this fix), so the guard told the operator
// to add a parameter with no effect on a fork dispatch — alert fatigue, and a
// FALSE COST MODEL if the chair complies believing the fork now runs cheaper.
//
// PAIRED test (mandatory per the finding): the guard must be QUIET on a fork
// dispatch AND STILL FIRE on an equivalent non-fork dispatch with the exact
// same sentinel/prompt shape. The pairing is what stops the fix degenerating
// into "never fire".
//
// Run: node tests/v3/hooks/test-agent-model-guard-fork-exemption.mjs

import {writeFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = join(__dirname, '..', '..', '..', 'hooks', 'prism-agent-model-guard.mjs');
const GUARD_FILE_URL = pathToFileURL(GUARD_PATH).href;

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

function makeTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-fork-exempt-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function plantSentinel(home, sessionId, sentinel) {
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${sessionId}.json`), JSON.stringify(sentinel));
}

async function runGuard(home, payload) {
  const origHome = process.env.HOME;
  const origUP = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const {run} = await import(GUARD_FILE_URL + '?forkexempt=' + Date.now() + Math.random());
    return await run(payload);
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUP !== undefined) process.env.USERPROFILE = origUP; else delete process.env.USERPROFILE;
  }
}

// ─── Case 1: subagent_type:'fork', haiku-tier sentinel, no model -> QUIET ────
await test("fork dispatch: haiku-tier sentinel, no model override -> exit 0, EMPTY stdout (no misleading nudge)", async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fork-case1', {tier: 'haiku'});
    const res = await runGuard(home, {
      tool_name: 'Agent',
      session_id: 'fork-case1',
      tool_input: {subagent_type: 'fork', prompt: 'Summarize the last five messages cheaply.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert((res.stdout || '') === '', `expected empty stdout (quiet on fork), got: ${JSON.stringify(res.stdout)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── Case 2 (PAIRED): identical sentinel/prompt shape, non-fork subagent_type -> STILL FIRES ───
await test("PAIRED: equivalent NON-fork dispatch (general-purpose), same sentinel/prompt -> nudge STILL fires", async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fork-case2', {tier: 'haiku'});
    const res = await runGuard(home, {
      tool_name: 'Agent',
      session_id: 'fork-case2',
      tool_input: {subagent_type: 'general-purpose', prompt: 'Summarize the last five messages cheaply.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert(/MODEL GUARD/.test(res.stdout || ''), `expected a MODEL GUARD nudge in stdout for the non-fork dispatch, got: ${JSON.stringify(res.stdout)}`);
    assert(/haiku/i.test(res.stdout || ''), `expected the nudge to reference haiku tier, got: ${JSON.stringify(res.stdout)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── Case 3: subagent_type:'Fork' (case-insensitive) -> still quiet ──────────
await test("fork dispatch: subagent_type case-insensitive ('Fork') -> still exempted", async () => {
  const home = makeTempHome();
  try {
    plantSentinel(home, 'fork-case3', {tier: 'sonnet'});
    const res = await runGuard(home, {
      tool_name: 'Agent',
      session_id: 'fork-case3',
      tool_input: {subagent_type: 'Fork', prompt: 'Do a substantial implementation task.'},
    });
    assert(res.exit === 0, `expected exit 0, got ${res.exit}`);
    assert((res.stdout || '') === '', `expected empty stdout (quiet on fork, case-insensitive), got: ${JSON.stringify(res.stdout)}`);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
