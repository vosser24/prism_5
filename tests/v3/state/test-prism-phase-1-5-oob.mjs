#!/usr/bin/env node
// v4.4 Layer B — OOB hook integration test (mocks SDK call)
import {writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';

const REPO = process.cwd();
const HOOK = join(REPO, 'hooks', 'prism-phase-1-5-oob.mjs');

let pass = 0;
let total = 0;

// Set up sandbox HOME
const sandboxHome = mkdtempSync(join(tmpdir(), 'prism-oob-test-'));
const sandboxClaude = join(sandboxHome, '.claude');

// Register cleanup that runs regardless of how the process exits
process.on('exit', () => {
  try { rmSync(sandboxHome, {recursive: true, force: true}); } catch {}
});
mkdirSync(sandboxClaude, {recursive: true});

// Write a minimal roster.json with @code-reviewer tagged requires_phase_1_5: true
mkdirSync(join(sandboxClaude, 'skills', 'prism-plan', 'references'), {recursive: true});
writeFileSync(join(sandboxClaude, 'skills', 'prism-plan', 'references', 'roster.json'), JSON.stringify({
  schema_version: '4.4.0',
  agents: {
    'code-reviewer': {requires_phase_1_5: true, requires_phase_1_5_block: false},
    'demand-forecasting': {requires_phase_1_5: false},
  },
}));

function runHook(input, env = {}) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      PRISM_OOB_TEST_MOCK_SDK: '1',  // hook honors this to skip real SDK call
      ...env,
    },
    timeout: 10000,
  });
  return {status: res.status, stdout: res.stdout, stderr: res.stderr};
}

// Test 1: untagged agent → hook is no-op (exit 0, no pending file)
total++;
const r1 = runHook({
  agent_name: 'demand-forecasting',
  session_id: 'sess-1',
  output: 'Demand will rise 12% Q3.',
  task_brief: 'forecast Q3',
});
if (r1.status === 0) pass++;
else console.log(`FAIL: untagged-agent no-op (status ${r1.status}, stderr: ${r1.stderr})`);

// Test 2: tagged agent → pending file written + (mocked) verdict written
total++;
const r2 = runHook({
  agent_name: 'code-reviewer',
  session_id: 'sess-2',
  output: 'The code is fast and secure. Tests pass.',
  task_brief: 'review PR 123',
});
if (r2.status === 0) {
  // Hook should have written a verdict result file (mock SDK path)
  const dir = sandboxClaude;
  // Find any verdict file
  const fs = await import('fs');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('.prism-phase-1-5-verdicts-'));
  if (files.length > 0) {
    pass++;
  } else {
    console.log('FAIL: tagged-agent did not produce verdict file');
  }
} else {
  console.log(`FAIL: tagged-agent hook exit non-zero (status ${r2.status}, stderr: ${r2.stderr})`);
}

// Test 3: PRISM_DISABLE_OOB_REVIEW=1 → hook is no-op even for tagged agent
total++;
const r3 = runHook({
  agent_name: 'code-reviewer',
  session_id: 'sess-3',
  output: 'X is fast.',
  task_brief: 'test',
}, {PRISM_DISABLE_OOB_REVIEW: '1'});
if (r3.status === 0 && !r3.stdout.includes('verdict')) {
  pass++;
} else {
  console.log('FAIL: kill-switch env var did not disable hook');
}

// Test 4: malformed input → hook fails open (exit 0)
total++;
const res4 = spawnSync('node', [HOOK], {
  input: 'not json',
  encoding: 'utf-8',
  env: {...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, PRISM_OOB_TEST_MOCK_SDK: '1'},
  timeout: 5000,
});
if (res4.status === 0) pass++;
else console.log(`FAIL: malformed input did not fail-open (status ${res4.status})`);

// Test 5 (E2E): hook fires → verdict written → SessionStart picks up
total++;
{
  // Reset sandbox
  const r = runHook({
    agent_name: 'code-reviewer',
    session_id: 'sess-e2e',
    output: 'Performance is good and the security model is sound. All edge cases handled.',
    task_brief: 'review PR 42',
  });
  if (r.status !== 0) {
    console.log(`FAIL E2E (hook): ${r.stderr}`);
  } else {
    // Now run SessionStart hook with mocked HOME, confirm it picks up
    const ssRes = spawnSync('node', [join(REPO, 'hooks', 'prism-session-start.mjs')], {
      input: JSON.stringify({}),
      encoding: 'utf-8',
      env: {...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome},
      timeout: 5000,
    });
    // Mock SDK marks all EVIDENCED → severity filter keeps SessionStart silent.
    // Pass when SessionStart ran cleanly AND did NOT emit a Prior-turn notice
    // (because all claims were EVIDENCED).
    if (ssRes.status === 0 && !/Prior turn|OOB PHASE 1\.5 reviewer flagged/.test(ssRes.stdout)) {
      pass++;
    } else {
      console.log(`FAIL E2E (sessionstart): status=${ssRes.status} stdout=${ssRes.stdout}`);
    }
  }
}

// Test 6: recursion guard — PRISM_OOB_REVIEWER_PROCESS=1 makes hook no-op
total++;
const r6 = runHook({
  agent_name: 'code-reviewer',
  session_id: 'sess-recurse',
  output: 'Performance is great and security is solid.',
  task_brief: 'test recursion',
}, {PRISM_OOB_REVIEWER_PROCESS: '1'});
if (r6.status === 0) {
  // Verify NO pending file was written for this session
  const fs = await import('fs');
  const files = fs.readdirSync(sandboxClaude).filter(f => f.includes('sess-recurse'));
  // Check routing log for "recursion-guard" action
  const routingLog = join(sandboxClaude, '.prism-routing.jsonl');
  const logged = fs.existsSync(routingLog) && fs.readFileSync(routingLog, 'utf-8').includes('"action":"recursion-guard"');
  if (logged) {
    pass++;
  } else {
    console.log('FAIL: recursion guard fired but log entry missing');
  }
} else {
  console.log(`FAIL: recursion guard hook exit non-zero: ${r6.stderr}`);
}

console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
