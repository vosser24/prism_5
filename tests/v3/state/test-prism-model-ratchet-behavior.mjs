#!/usr/bin/env node
// v4.4 Layer C — verdict-log-driven ratchet behavior test
import {writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, appendFileSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {spawnSync} from 'child_process';

const REPO = process.cwd();
const TOOL = join(REPO, 'tools', 'prism-roster.mjs');

let pass = 0;
let total = 0;

const sandboxHome = mkdtempSync(join(tmpdir(), 'prism-ratchet-test-'));
const claudeDir = join(sandboxHome, '.claude');
const rosterDir = join(claudeDir, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, {recursive: true});

// Seed roster with @code-reviewer (no pending_upgrade)
const initialRoster = {
  schema_version: '4.4.0',
  agents: {
    'code-reviewer': {
      requires_phase_1_5: true,
      pending_upgrade: false,
      corrections_since_last_upgrade: 0,
    },
    'pristine-agent': {
      requires_phase_1_5: true,
      pending_upgrade: false,
      corrections_since_last_upgrade: 0,
    },
  },
};
writeFileSync(join(rosterDir, 'roster.json'), JSON.stringify(initialRoster, null, 2));

// Seed verdict log with 10 dispatches for @code-reviewer:
// - 4 of 10 dispatches with un_cited=5/5 claims (all uncited)
// - 6 of 10 dispatches with un_cited=0/5 claims (all evidenced)
// - Total claims: 50; un_cited: 20 → UN-CITED rate 40% → ratchet flips.
const verdictLog = join(claudeDir, '.prism-phase-1-5-verdicts.jsonl');
for (let i = 0; i < 10; i++) {
  const summary = i < 4
    ? {total: 5, evidenced: 0, un_cited: 5, rejected: 0}
    : {total: 5, evidenced: 5, un_cited: 0, rejected: 0};
  appendFileSync(verdictLog, JSON.stringify({
    sha: 'sha' + i,
    session_id: 'sess-' + i,
    specialist_name: '@code-reviewer',
    summary,
    completed_at: new Date(Date.now() - i * 86400000).toISOString(),
  }) + '\n');
}
// Seed 10 pristine dispatches for @pristine-agent (0% UN-CITED → ratchet should NOT flip)
for (let i = 0; i < 10; i++) {
  appendFileSync(verdictLog, JSON.stringify({
    sha: 'pris' + i,
    session_id: 'pses-' + i,
    specialist_name: '@pristine-agent',
    summary: {total: 5, evidenced: 5, un_cited: 0, rejected: 0},
    completed_at: new Date().toISOString(),
  }) + '\n');
}

const res = spawnSync('node', [TOOL, '--apply-ratchet'], {
  encoding: 'utf-8',
  env: {...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome},
  timeout: 10000,
});

// Test 1: exit 0
total++;
if (res.status === 0) pass++;
else console.log(`FAIL: --apply-ratchet exited ${res.status}: ${res.stderr}`);

// Test 2: @code-reviewer flagged pending_upgrade=true
// 4 of 10 dispatches with un_cited=5, rest with un_cited=0 → 4*5=20 un_cited / 50 total = 40% → flips.
total++;
const updated = JSON.parse(readFileSync(join(rosterDir, 'roster.json'), 'utf-8'));
if (updated.agents['code-reviewer'].pending_upgrade === true) pass++;
else console.log(`FAIL: @code-reviewer pending_upgrade not flipped (UN-CITED rate not over threshold or ratchet didn't fire)`);

// Test 3: @pristine-agent NOT flagged
total++;
if (updated.agents['pristine-agent'].pending_upgrade === false) pass++;
else console.log(`FAIL: @pristine-agent incorrectly flagged pending_upgrade=true`);

rmSync(sandboxHome, {recursive: true, force: true});
console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
