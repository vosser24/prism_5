#!/usr/bin/env node
// R1 #57 (D042) — pending-written mock/synthetic marker regression test.
//
// F3 validation (docs/prism/lessons/2026-07-20-session.md L4/L3;
// tasks/workspace/f3-validation-verdict.md) found /prism-health Step 2's
// live-fire grep cannot distinguish a mock/synthetic `pending-written` line
// from a genuine one — a same-day mock fire flipped the verdict to a false
// GREEN with zero real fires. The fix stamps each `pending-written` line
// with `session_id` + a `mock` boolean (additive fields only).
//
// This test proves the marker is deterministic:
//   1. PRISM_OOB_TEST_MOCK_SDK=1 fire -> mock:true
//   2. synthetic/test-labeled session_id, no mock env vars -> mock:true
//   3. genuine fire (ordinary session_id, no mock env vars) -> mock:false
//
// Isolated under a temp HOME throughout (never touches the real ~/.claude)
// — this is the exact isolation gap that leaked `session_id:
// "synthetic-fix1-test"` into the REAL ~/.claude/.prism-routing.jsonl
// during F3 validation. Any test exercising this hook MUST override
// HOME + USERPROFILE to a mkdtemp dir before the hook process starts.
import {writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';

const REPO = process.cwd();
const HOOK = join(REPO, 'hooks', 'prism-phase-1-5-oob.mjs');

let pass = 0;
let total = 0;

// Set up sandbox HOME — never the real ~/.claude.
const sandboxHome = mkdtempSync(join(tmpdir(), 'prism-oob-mockmarker-test-'));
const sandboxClaude = join(sandboxHome, '.claude');

process.on('exit', () => {
  try { rmSync(sandboxHome, {recursive: true, force: true}); } catch {}
});
mkdirSync(sandboxClaude, {recursive: true});

// Fixture roster.json: 'code-reviewer' tagged requires_phase_1_5:true (async
// mode) — mirrors the sibling OOB tests' fixture exactly.
mkdirSync(join(sandboxClaude, 'skills', 'prism-plan', 'references'), {recursive: true});
writeFileSync(join(sandboxClaude, 'skills', 'prism-plan', 'references', 'roster.json'), JSON.stringify({
  schema_version: '4.4.0',
  agents: {
    'code-reviewer': {requires_phase_1_5: true, requires_phase_1_5_block: false},
  },
}));

// A nonexistent binary path — used for tests 2/3 so the async-spawned
// reviewer worker fails fast on ENOENT instead of attempting a real
// `claude -p` call (or hanging) in the background. The pending-written log
// line is written BEFORE this spawn, so the assertion is unaffected.
const noSuchClaudeBin = join(sandboxHome, 'no-such-claude-binary');

function runHook(input, env = {}) {
  const baseEnv = {...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome};
  // Defensively strip ambient mock env vars so tests 2/3 (which do not pass
  // them) get a clean "genuine fire" environment regardless of what the
  // outer test-runner process happens to have set.
  delete baseEnv.PRISM_OOB_TEST_MOCK_SDK;
  delete baseEnv.PRISM_PHASE_1_5_MOCK_VERDICT;
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {...baseEnv, ...env},
    timeout: 10000,
  });
  return {status: res.status, stdout: res.stdout, stderr: res.stderr};
}

function lastPendingWrittenLine() {
  const p = join(sandboxClaude, '.prism-routing.jsonl');
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'phase_1_5_oob' && o.action === 'pending-written');
  return lines.length ? lines[lines.length - 1] : null;
}

// --- Test 1: PRISM_OOB_TEST_MOCK_SDK=1 fire -> mock:true, session_id logged.
total++;
{
  const r = runHook({
    agent_name: 'code-reviewer',
    session_id: 'sess-real-looking-1',
    output: 'The code is fast and secure. Tests pass on all inputs.',
    task_brief: 'review PR 1',
  }, {PRISM_OOB_TEST_MOCK_SDK: '1'});
  const line = lastPendingWrittenLine();
  if (r.status === 0 && line && line.mock === true && line.session_id === 'sess-real-looking-1') {
    pass++;
  } else {
    console.log(`FAIL mock-sdk-env: status=${r.status} line=${JSON.stringify(line)} stderr=${r.stderr}`);
  }
}

// --- Test 2: synthetic/test-labeled session_id, NO mock env vars -> mock:true.
total++;
{
  const r = runHook({
    agent_name: 'code-reviewer',
    session_id: 'synthetic-fix1-test',
    output: 'The code is fast and secure. Tests pass on all inputs.',
    task_brief: 'synthetic phase-1.5 corroboration test',
  }, {PRISM_CLAUDE_BIN: noSuchClaudeBin});
  const line = lastPendingWrittenLine();
  if (r.status === 0 && line && line.mock === true && line.session_id === 'synthetic-fix1-test') {
    pass++;
  } else {
    console.log(`FAIL synthetic-session: status=${r.status} line=${JSON.stringify(line)} stderr=${r.stderr}`);
  }
}

// --- Test 3: genuine fire — ordinary session_id, no mock env vars -> mock:false.
total++;
{
  const r = runHook({
    agent_name: 'code-reviewer',
    session_id: 'sess-genuine-42',
    output: 'The code is fast and secure. Tests pass on all inputs.',
    task_brief: 'review PR 99',
  }, {PRISM_CLAUDE_BIN: noSuchClaudeBin});
  const line = lastPendingWrittenLine();
  if (r.status === 0 && line && line.mock === false && line.session_id === 'sess-genuine-42') {
    pass++;
  } else {
    console.log(`FAIL genuine-fire: status=${r.status} line=${JSON.stringify(line)} stderr=${r.stderr}`);
  }
}

console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
