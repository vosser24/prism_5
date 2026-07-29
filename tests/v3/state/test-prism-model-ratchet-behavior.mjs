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

// Register cleanup that runs regardless of how the process exits
let sandboxHome2 = null;
process.on('exit', () => {
  try { rmSync(sandboxHome, {recursive: true, force: true}); } catch {}
  if (sandboxHome2) { try { rmSync(sandboxHome2, {recursive: true, force: true}); } catch {} }
});

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

// Test 4: agent with < MIN_DISPATCHES dispatches at 100% UN-CITED → must NOT flip
// Seed 5 dispatches for @sparse-agent (all UN-CITED 100%); ratchet should skip due to MIN_DISPATCHES=10
total++;
sandboxHome2 = mkdtempSync(join(tmpdir(), 'prism-ratchet-test2-'));
const claudeDir2 = join(sandboxHome2, '.claude');
const rosterDir2 = join(claudeDir2, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir2, {recursive: true});
writeFileSync(join(rosterDir2, 'roster.json'), JSON.stringify({
  schema_version: '4.4.0',
  agents: {
    'sparse-agent': {
      requires_phase_1_5: true,
      pending_upgrade: false,
      corrections_since_last_upgrade: 0,
    },
  },
}, null, 2));
const verdictLog2 = join(claudeDir2, '.prism-phase-1-5-verdicts.jsonl');
for (let i = 0; i < 5; i++) {
  appendFileSync(verdictLog2, JSON.stringify({
    sha: 'sparse' + i,
    session_id: 'ses-' + i,
    specialist_name: '@sparse-agent',
    summary: {total: 5, evidenced: 0, un_cited: 5, rejected: 0},
    completed_at: new Date().toISOString(),
  }) + '\n');
}
const res2 = spawnSync('node', [TOOL, '--apply-ratchet'], {
  encoding: 'utf-8',
  env: {...process.env, HOME: sandboxHome2, USERPROFILE: sandboxHome2},
  timeout: 10000,
});
const sparseRoster = JSON.parse(readFileSync(join(rosterDir2, 'roster.json'), 'utf-8'));
if (sparseRoster.agents['sparse-agent'].pending_upgrade === false) {
  pass++;
} else {
  console.log(`FAIL: @sparse-agent flipped despite < MIN_DISPATCHES (was 5 dispatches, threshold is 10)`);
}

// Test 5: already-flagged agent must NOT be re-logged or have last_updated touched on re-ratchet
total++;
// In the first sandbox (from Tests 1-3), @code-reviewer is already pending_upgrade=true.
// Capture roster's current state, re-run ratchet, confirm no observable change.
const rosterBefore = readFileSync(join(rosterDir, 'roster.json'), 'utf-8');
const res3 = spawnSync('node', [TOOL, '--apply-ratchet'], {
  encoding: 'utf-8',
  env: {...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome},
  timeout: 10000,
});
const rosterAfter = readFileSync(join(rosterDir, 'roster.json'), 'utf-8');
// stdout should NOT mention @code-reviewer being newly flagged
if (rosterBefore === rosterAfter && !res3.stdout.includes('Flagged @code-reviewer')) {
  pass++;
} else {
  console.log(`FAIL: re-running --apply-ratchet on already-flagged agent caused changes or duplicate log`);
}

// Test 6: --clear-pending-upgrade clears pending_upgrade and resets status
total++;
{
  const sandboxHome3 = mkdtempSync(join(tmpdir(), 'prism-ratchet-test3-'));
  process.on('exit', () => { try { rmSync(sandboxHome3, {recursive: true, force: true}); } catch {} });
  const rosterDir3 = join(sandboxHome3, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rosterDir3, {recursive: true});
  writeFileSync(join(rosterDir3, 'roster.json'), JSON.stringify({
    schema_version: '4.4.0',
    agents: {
      'x': {pending_upgrade: true, status: 'upgrade_needed', default_model: 'sonnet'},
    },
  }, null, 2));
  const r6 = spawnSync('node', [TOOL, '--clear-pending-upgrade', '@x'], {
    encoding: 'utf-8',
    env: {...process.env, HOME: sandboxHome3, USERPROFILE: sandboxHome3},
    timeout: 10000,
  });
  if (r6.status !== 0) {
    console.log(`FAIL T6: --clear-pending-upgrade exited ${r6.status}: ${r6.stderr}`);
  } else {
    const cleared = JSON.parse(readFileSync(join(rosterDir3, 'roster.json'), 'utf-8'));
    if (cleared.agents['x'].pending_upgrade === false && cleared.agents['x'].status === 'active') {
      pass++;
    } else {
      console.log(`FAIL T6: expected pending_upgrade=false status=active, got pending_upgrade=${cleared.agents['x'].pending_upgrade} status=${cleared.agents['x'].status}`);
    }
  }
}

// Test 7: --set-model sets default_model
total++;
{
  const sandboxHome4 = mkdtempSync(join(tmpdir(), 'prism-ratchet-test4-'));
  process.on('exit', () => { try { rmSync(sandboxHome4, {recursive: true, force: true}); } catch {} });
  const rosterDir4 = join(sandboxHome4, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rosterDir4, {recursive: true});
  writeFileSync(join(rosterDir4, 'roster.json'), JSON.stringify({
    schema_version: '4.4.0',
    agents: {
      'x': {pending_upgrade: true, status: 'upgrade_needed', default_model: 'sonnet'},
    },
  }, null, 2));
  const r7 = spawnSync('node', [TOOL, '--set-model', '@x', 'opus'], {
    encoding: 'utf-8',
    env: {...process.env, HOME: sandboxHome4, USERPROFILE: sandboxHome4},
    timeout: 10000,
  });
  if (r7.status !== 0) {
    console.log(`FAIL T7: --set-model exited ${r7.status}: ${r7.stderr}`);
  } else {
    const setted = JSON.parse(readFileSync(join(rosterDir4, 'roster.json'), 'utf-8'));
    if (setted.agents['x'].default_model === 'opus') {
      pass++;
    } else {
      console.log(`FAIL T7: expected default_model=opus, got ${setted.agents['x'].default_model}`);
    }
  }
}

// Test 8: --set-model with invalid model exits 2
total++;
{
  const sandboxHome5 = mkdtempSync(join(tmpdir(), 'prism-ratchet-test5-'));
  process.on('exit', () => { try { rmSync(sandboxHome5, {recursive: true, force: true}); } catch {} });
  const rosterDir5 = join(sandboxHome5, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rosterDir5, {recursive: true});
  writeFileSync(join(rosterDir5, 'roster.json'), JSON.stringify({
    schema_version: '4.4.0',
    agents: {
      'x': {pending_upgrade: false, default_model: 'sonnet'},
    },
  }, null, 2));
  const r8 = spawnSync('node', [TOOL, '--set-model', '@x', 'gpt4'], {
    encoding: 'utf-8',
    env: {...process.env, HOME: sandboxHome5, USERPROFILE: sandboxHome5},
    timeout: 10000,
  });
  if (r8.status === 2) {
    pass++;
  } else {
    console.log(`FAIL T8: expected exit 2 for invalid model, got ${r8.status}`);
  }
}

// Test 9: manifest_owned agent must NOT be flagged despite high UN-CITED rate
total++;
{
  const sh = mkdtempSync(join(tmpdir(), 'prism-ratchet-test9-'));
  process.on('exit', () => { try { rmSync(sh, {recursive: true, force: true}); } catch {} });
  const rDir = join(sh, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rDir, {recursive: true});
  writeFileSync(join(rDir, 'roster.json'), JSON.stringify({
    schema_version: '4.4.0',
    agents: {
      'manifest-agent': { pending_upgrade: false, manifest_owned: true, corrections_since_last_upgrade: 0 },
    },
  }, null, 2));
  const vl = join(sh, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  for (let i = 0; i < 10; i++) {
    appendFileSync(vl, JSON.stringify({
      sha: 'm' + i, session_id: 'ms-' + i, specialist_name: '@manifest-agent',
      summary: {total: 5, evidenced: 0, un_cited: 5, rejected: 0}, completed_at: new Date().toISOString(),
    }) + '\n');
  }
  const r9 = spawnSync('node', [TOOL, '--apply-ratchet'], {
    encoding: 'utf-8', env: {...process.env, HOME: sh, USERPROFILE: sh}, timeout: 10000,
  });
  const r9roster = JSON.parse(readFileSync(join(rDir, 'roster.json'), 'utf-8'));
  if (r9.status === 0 && r9roster.agents['manifest-agent'].pending_upgrade === false) {
    pass++;
  } else {
    console.log(`FAIL T9: manifest_owned agent flagged despite guard (status=${r9.status}, pending_upgrade=${r9roster.agents['manifest-agent'].pending_upgrade})`);
  }
}

// Test 10: flat-file-owned agent (agents/<name>.md exists) must NOT be flagged
total++;
{
  const sh = mkdtempSync(join(tmpdir(), 'prism-ratchet-test10-'));
  process.on('exit', () => { try { rmSync(sh, {recursive: true, force: true}); } catch {} });
  const rDir = join(sh, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rDir, {recursive: true});
  writeFileSync(join(rDir, 'roster.json'), JSON.stringify({
    schema_version: '4.4.0',
    agents: {
      'flat-agent': { pending_upgrade: false, corrections_since_last_upgrade: 0 },
    },
  }, null, 2));
  // Seed the FLAT agent file that marks it owned-outside-ACL.
  const agDir = join(sh, '.claude', 'agents');
  mkdirSync(agDir, {recursive: true});
  writeFileSync(join(agDir, 'flat-agent.md'), '---\nname: flat-agent\ndescription: x\n---\n', 'utf-8');
  const vl = join(sh, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  for (let i = 0; i < 10; i++) {
    appendFileSync(vl, JSON.stringify({
      sha: 'f' + i, session_id: 'fs-' + i, specialist_name: '@flat-agent',
      summary: {total: 5, evidenced: 0, un_cited: 5, rejected: 0}, completed_at: new Date().toISOString(),
    }) + '\n');
  }
  const r10 = spawnSync('node', [TOOL, '--apply-ratchet'], {
    encoding: 'utf-8', env: {...process.env, HOME: sh, USERPROFILE: sh}, timeout: 10000,
  });
  const r10roster = JSON.parse(readFileSync(join(rDir, 'roster.json'), 'utf-8'));
  if (r10.status === 0 && r10roster.agents['flat-agent'].pending_upgrade === false) {
    pass++;
  } else {
    console.log(`FAIL T10: flat-file-owned agent flagged despite guard (status=${r10.status}, pending_upgrade=${r10roster.agents['flat-agent'].pending_upgrade})`);
  }
}

console.log(`tests passed: ${pass}/${total}`);
if (pass !== total) process.exit(1);
