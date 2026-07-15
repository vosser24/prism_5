#!/usr/bin/env node
// CLI end-to-end verification harness for the nested-dispatch fix.
//
// Exercises the REAL dispatcher subprocess exactly as Claude Code does:
// spawns `node hooks/prism-pretooluse-dispatcher.mjs`, feeds a JSON
// PreToolUse payload on stdin, and inspects stdout + exit code. This proves
// the two new guards (nested-CLI warn/hard-deny in
// prism-parent-dispatch-guard.mjs, and the anti-nesting prompt injection in
// prism-anti-nesting-inject.mjs) fire on the real wire path — not just via
// unit-level `import` + direct `run()` calls.
//
// Usage: node tests/v3/verify-nested-dispatch-fix.mjs

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const DISPATCHER = join('hooks', 'prism-pretooluse-dispatcher.mjs');

// Unique per-run session id. hooks/prism-dispatch-dedup-guard.mjs keys its
// in-flight ledger file by session_id
// (~/.claude/.prism-inflight-dispatches-<sessionId>.json, 12-min TTL). This
// harness never emits a SubagentStop event (it only drives PreToolUse), so any
// ledger entry it creates stays OPEN until the TTL sweep. Reusing a fixed
// session_id like 'cli-verify' across separate runs of this script within that
// 12-min window means the SECOND run's scenario C/D dispatch collides with the
// FIRST run's still-open entry (same subagent_type+description+prompt
// signature) and the dedup guard denies it before anti-nesting-inject ever
// runs. Scoping the session id to this process/run makes every run start with
// a fresh, never-before-seen ledger file, independent of prior runs.
const RUN_SESSION_ID = `cli-verify-${process.pid}-${Date.now()}`;

function runDispatcher(payload, envOverrides = {}) {
  const result = spawnSync('node', [DISPATCHER], {
    cwd: REPO_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: {...process.env, ...envOverrides},
  });
  return result;
}

const scenarios = [];

function scenario(name, fn) {
  scenarios.push({name, fn});
}

scenario('A — nested-CLI warn (default)', () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: {command: 'claude -p "investigate the DB"'},
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload);
  const stdout = r.stdout || '';
  const checks = [
    {desc: 'exit 0', pass: r.status === 0},
    {desc: "stdout contains 'NESTED-CLI GUARD'", pass: stdout.includes('NESTED-CLI GUARD')},
  ];
  return {r, checks};
});

scenario('B — nested-CLI hard deny', () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: {command: 'claude -p "investigate the DB"'},
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload, {PRISM_NESTED_CLI_GUARD: 'hard'});
  const stdout = r.stdout || '';
  const checks = [
    {desc: 'exit 2', pass: r.status === 2},
    {desc: 'stdout contains \'permissionDecision":"deny"\'', pass: stdout.includes('permissionDecision":"deny"')},
    {desc: "stdout contains 'NESTED-CLI GUARD'", pass: stdout.includes('NESTED-CLI GUARD')},
  ];
  return {r, checks};
});

scenario('C — anti-nesting injection on Agent dispatch', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'general-purpose',
      model: 'sonnet',
      prompt: 'Investigate price history overlap in the Dedecomp DB.',
    },
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload);
  const stdout = r.stdout || '';
  const checks = [];
  checks.push({desc: 'exit 0', pass: r.status === 0});
  let parsed = null;
  let parseErr = null;
  try { parsed = JSON.parse(stdout); } catch (e) { parseErr = e; }
  checks.push({desc: 'stdout parses as JSON', pass: !!parsed, detail: parseErr ? String(parseErr) : ''});
  const updatedInput = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput;
  const newPrompt = updatedInput && updatedInput.prompt;
  checks.push({desc: 'hookSpecificOutput.updatedInput.prompt exists', pass: typeof newPrompt === 'string'});
  checks.push({
    desc: "prompt STARTS WITH 'Investigate price history overlap'",
    pass: typeof newPrompt === 'string' && newPrompt.startsWith('Investigate price history overlap'),
  });
  checks.push({
    desc: "prompt CONTAINS 'MAIN-LOOP-ONLY'",
    pass: typeof newPrompt === 'string' && newPrompt.includes('MAIN-LOOP-ONLY'),
  });
  checks.push({
    desc: "prompt CONTAINS 'MUST NOT spawn'",
    pass: typeof newPrompt === 'string' && newPrompt.includes('MUST NOT spawn'),
  });
  checks.push({
    desc: "prompt CONTAINS dispatch-preamble tag (sibling composition survives the merge)",
    pass: typeof newPrompt === 'string' && newPrompt.includes('[PRISM dispatch-preamble]'),
  });
  checks.push({
    desc: "prompt CONTAINS 'WRITE YOUR OUTPUT TO DISK'",
    pass: typeof newPrompt === 'string' && newPrompt.includes('WRITE YOUR OUTPUT TO DISK'),
  });
  return {r, checks};
});

scenario('D — injection is idempotent (already has both clause sets)', () => {
  // The Agent route now carries TWO independent clause-injecting hooks
  // (prism-anti-nesting-inject.mjs and prism-dispatch-preamble.mjs — see
  // hooks/prism-pretooluse-dispatcher.mjs ROUTES.Agent). Idempotency is
  // per-hook: each only skips re-injection when ITS OWN doctrine phrases are
  // already present. This fixture prompt carries phrases matching BOTH
  // hooks' PRESENT_RE so the whole dispatch is genuinely a no-op for both,
  // not just the older single-hook case this scenario originally covered.
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'general-purpose',
      model: 'sonnet',
      prompt: 'Do X. Note: dispatch is main-loop-only; do not spawn children. '
        + 'Also: reproduce before you fix, and report artifacts, not counters or prose.',
    },
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload);
  const stdout = r.stdout || '';
  const checks = [];
  checks.push({desc: 'exit 0', pass: r.status === 0});
  let parsed = null;
  let parseErr = null;
  let parseOk = true;
  if (stdout.trim() === '') {
    parsed = null; // no output at all is fine — nothing to parse
  } else {
    try { parsed = JSON.parse(stdout); } catch (e) { parseErr = e; parseOk = false; }
  }
  checks.push({desc: 'stdout is empty OR parses as JSON', pass: parseOk, detail: parseErr ? String(parseErr) : ''});
  // BUG FIX: when stdout is empty, `parsed` is `null` (set explicitly above),
  // NOT `undefined`. The old code did
  // `const updatedInput = parsed && parsed.hookSpecificOutput && ...` which,
  // for `parsed === null`, short-circuits to `null` (not `undefined`) — so the
  // old `typeof updatedInput === 'undefined'` check FAILED even on the
  // legitimately-idempotent empty-stdout case. Use an explicit ternary and
  // accept both null and undefined as "no re-injection".
  const updatedInput = parsed
    ? (parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput)
    : undefined;
  checks.push({
    desc: 'hookSpecificOutput.updatedInput is null/undefined (idempotent — no re-injection)',
    pass: updatedInput == null,
  });
  return {r, checks};
});

scenario('E — normal Bash not touched', () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: {command: 'ls -la'},
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload);
  const stdout = r.stdout || '';
  const checks = [
    {desc: "stdout does NOT contain 'NESTED-CLI GUARD'", pass: !stdout.includes('NESTED-CLI GUARD')},
  ];
  return {r, checks};
});

scenario('F — plain claude mention without -p does not fire', () => {
  const payload = {
    tool_name: 'Bash',
    tool_input: {command: 'echo "use claude interactively"'},
    session_id: RUN_SESSION_ID,
  };
  const r = runDispatcher(payload);
  const stdout = r.stdout || '';
  const checks = [
    {desc: "stdout does NOT contain 'NESTED-CLI GUARD'", pass: !stdout.includes('NESTED-CLI GUARD')},
  ];
  return {r, checks};
});

function trimStdout(s) {
  const t = (s || '').trim();
  return t === '' ? '(empty)' : t;
}

let failCount = 0;
const lines = [];
lines.push('='.repeat(78));
lines.push('PRISM nested-dispatch fix — CLI end-to-end verification');
lines.push(`repo root: ${REPO_ROOT}`);
lines.push(`dispatcher: ${DISPATCHER}`);
lines.push('='.repeat(78));

for (const {name, fn} of scenarios) {
  let outcome;
  let threw = null;
  try {
    outcome = fn();
  } catch (e) {
    threw = e;
  }
  lines.push('');
  lines.push('-'.repeat(78));
  lines.push(`Scenario ${name}`);
  if (threw) {
    failCount += 1;
    lines.push(`  EXIT: (harness threw before spawn returned)`);
    lines.push(`  RESULT: FAIL (exception: ${threw && threw.stack ? threw.stack : threw})`);
    continue;
  }
  const {r, checks} = outcome;
  const allPass = checks.every(c => c.pass);
  if (!allPass) failCount += 1;
  lines.push(`  exit code: ${r.status}`);
  if (r.error) lines.push(`  spawn error: ${r.error}`);
  if (r.stderr && r.stderr.trim()) lines.push(`  stderr: ${r.stderr.trim()}`);
  for (const c of checks) {
    lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.desc}${c.detail ? ` (${c.detail})` : ''}`);
  }
  lines.push(`  RESULT: ${allPass ? 'PASS' : 'FAIL'}`);
  lines.push('  raw stdout:');
  lines.push('  ' + trimStdout(r.stdout).split('\n').join('\n  '));
}

lines.push('');
lines.push('='.repeat(78));
if (failCount === 0) {
  lines.push('ALL PASS');
} else {
  lines.push(`${failCount} FAILED`);
}
lines.push('='.repeat(78));

console.log(lines.join('\n'));

process.exit(failCount === 0 ? 0 : 1);
