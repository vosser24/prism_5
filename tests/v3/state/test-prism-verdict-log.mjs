#!/usr/bin/env node
// v4.4 Layer B — verdict-flag lib behavior test
import {readFileSync, existsSync, mkdtempSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {pathToFileURL} from 'url';

const REPO = process.cwd();
const LIB = join(REPO, 'tools', 'lib', 'prism-verdict-flag.mjs');

let pass = 0;
let total = 0;

async function run() {
  // Set up sandbox HOME
  const sandboxHome = mkdtempSync(join(tmpdir(), 'prism-verdict-test-'));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;

  const mod = await import(pathToFileURL(LIB).href);

  // Test 1: writePending returns a path under sandbox HOME
  total++;
  const sha = 'abc123def456';
  const pendingPath = mod.writePending(sha, {
    session_id: 'sess-1',
    specialist_name: '@claude-master',
    task_brief: 'test',
    specialist_output: 'output',
    phase_0d_challenges: [],
    extracted_claims: [],
    block_master: false,
  });
  if (pendingPath && pendingPath.includes('.prism-phase-1-5-pending-' + sha)) {
    pass++;
  } else {
    console.log('FAIL: writePending did not return expected path');
  }

  // Test 2: readPending round-trips the payload
  total++;
  const payload = mod.readPending(sha);
  if (payload && payload.specialist_name === '@claude-master' && payload.sha === sha) {
    pass++;
  } else {
    console.log('FAIL: readPending did not round-trip payload');
  }

  // Test 3: writeVerdict writes result + appends to log
  total++;
  mod.writeVerdict('1-5', sha, {
    specialist_name: '@claude-master',
    reviewer_model: 'claude-sonnet-4-6',
    verdicts: [{claim_id: 'c1', class: 'correctness', verdict: 'EVIDENCED', taxonomy_row: 'Correctness', evidence_required: '', reasoning: 'cited test'}],
    challenges_addressed: [],
    summary: {total: 1, evidenced: 1, un_cited: 0, rejected: 0},
    reviewer_latency_ms: 100,
  });
  const resultPath = join(sandboxHome, '.claude', `.prism-phase-1-5-verdicts-${sha}.json`);
  const logPath = join(sandboxHome, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  if (existsSync(resultPath) && existsSync(logPath)) {
    pass++;
  } else {
    console.log('FAIL: writeVerdict did not create result file + log entry');
  }

  // Test 4: readVerdict returns the written result
  total++;
  const verdict = mod.readVerdict(sha);
  if (verdict && verdict.summary && verdict.summary.evidenced === 1) {
    pass++;
  } else {
    console.log('FAIL: readVerdict did not return expected result');
  }

  // Test 5: clearPending removes the pending file
  total++;
  mod.clearPending(sha);
  if (!existsSync(join(sandboxHome, '.claude', `.prism-phase-1-5-pending-${sha}.json`))) {
    pass++;
  } else {
    console.log('FAIL: clearPending did not remove pending file');
  }

  // Test 6: listPendingVerdicts returns all pending SHAs
  total++;
  mod.writePending('aabbccdd', {session_id: 'sess-2', specialist_name: '@code-reviewer', task_brief: '', specialist_output: '', phase_0d_challenges: [], extracted_claims: [], block_master: false});
  mod.writePending('def01234', {session_id: 'sess-3', specialist_name: '@security-architect', task_brief: '', specialist_output: '', phase_0d_challenges: [], extracted_claims: [], block_master: false});
  const pending = mod.listPendingVerdicts();
  if (pending.length === 2 && pending.includes('aabbccdd') && pending.includes('def01234')) {
    pass++;
  } else {
    console.log(`FAIL: listPendingVerdicts returned ${pending.length} (expected 2)`);
  }

  // Test 7: readVerdict on missing SHA returns null (fail-open contract)
  total++;
  const missing = mod.readVerdict('aaaaaaaa');  // valid hex SHA, no file
  if (missing === null) pass++;
  else console.log('FAIL: readVerdict on missing SHA did not return null');

  // Test 8: clearVerdict removes the result file
  total++;
  mod.clearVerdict(sha);  // 'abc123def456' from Test 1-5
  if (!existsSync(join(sandboxHome, '.claude', `.prism-phase-1-5-verdicts-${sha}.json`))) {
    pass++;
  } else {
    console.log('FAIL: clearVerdict did not remove result file');
  }

  // Test 9: listCompletedVerdicts returns previously written verdict SHAs (before clear; re-write one to test)
  total++;
  mod.writeVerdict('1-5', 'bbbbbbbb', {
    session_id: 'sess-c',
    specialist_name: '@code-reviewer',
    reviewer_model: 'claude-sonnet-4-6',
    verdicts: [],
    challenges_addressed: [],
    summary: {total: 0, evidenced: 0, un_cited: 0, rejected: 0},
    reviewer_latency_ms: 50,
  });
  const completed = mod.listCompletedVerdicts();
  if (completed.includes('bbbbbbbb')) pass++;
  else console.log(`FAIL: listCompletedVerdicts did not include written SHA: ${completed}`);

  // Test 10: readVerdictLog returns multiple entries in append order
  total++;
  const logEntries = mod.readVerdictLog();
  // Tests 3 and 9 each wrote a verdict — log should have at least 2 entries
  if (Array.isArray(logEntries) && logEntries.length >= 2 && logEntries.every(e => e.sha && e.summary)) {
    pass++;
  } else {
    console.log(`FAIL: readVerdictLog did not return expected entries (got ${logEntries.length})`);
  }

  // Cleanup
  rmSync(sandboxHome, {recursive: true, force: true});

  console.log(`tests passed: ${pass}/${total}`);
  if (pass !== total) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
