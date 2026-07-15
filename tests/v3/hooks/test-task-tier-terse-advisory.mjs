#!/usr/bin/env node
// Tests for the C8 "terse task description" SOFT advisory added to
// hooks/prism-task-tier-advisor.mjs (v6.2.0 recall-hardening, contract C8).
//
// Scope: verify the NEW advisory fires on a thin description and does NOT
// fire on a detailed one, WITHOUT disturbing the pre-existing tier
// classification / hard-mode-deny behavior (that behavior is exercised by
// tests/v3/hooks/test-pretooluse-dispatcher.mjs and must stay green).
//
// Runs the advisor as a subprocess (matches the isolation pattern used by
// test-pretooluse-dispatcher.mjs) with an isolated HOME so no real
// .prism-routing.jsonl / DB state is touched.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADVISOR = join(__dirname, '..', '..', '..', 'hooks', 'prism-task-tier-advisor.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// sentinel with an explicit non-opus tier so the fallback classifier path
// (which needs a full repo context) is never exercised in this test.
const SONNET_SENTINEL = {tier: 'sonnet', rationale: 't', source: 't', dispatched: false};
const OPUS_SENTINEL = {tier: 'opus', rationale: 't', source: 't', dispatched: false};

function run(payload, {env = {}, sentinel = null} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-tta-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  if (sentinel) writeFileSync(join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`), JSON.stringify(sentinel));
  try {
    const r = spawnSync(process.execPath, [ADVISOR], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...env},
    });
    return {exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim()};
  } finally { try { rmSync(home, {recursive: true, force: true}); } catch {} }
}

const TERSE_ADVISORY_RE = /task description looks terse/;

await test('thin description (<80 chars, no acceptance criterion) → terse advisory fires', () => {
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's1', tool_input: {subject: 'fix bug', description: 'fix the bug in the parser'}},
    {sentinel: SONNET_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(TERSE_ADVISORY_RE.test(r.stdout), `expected terse advisory in stdout, got: ${r.stdout}`);
});

await test('detailed description (>=80 chars + acceptance criterion + target files) → no terse advisory', () => {
  const detailed = 'Refactor the CSV parser in tools/lib/csv-parser.mjs to stream rows ' +
    'instead of loading the whole file, and update tests/v3/lib/test-csv-parser.mjs. ' +
    'Acceptance criteria: done when the streaming parser produces identical output to ' +
    'the old parser on the fixture in tests/v3/fixtures/sample.csv and peak memory drops below 50MB.';
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's2', tool_input: {subject: 'refactor csv parser', description: detailed}},
    {sentinel: SONNET_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(!TERSE_ADVISORY_RE.test(r.stdout), `did not expect terse advisory, got: ${r.stdout}`);
});

await test('long description but missing acceptance-criterion language → terse advisory still fires', () => {
  const longNoAcceptance = 'This task involves a fairly involved change across several files in the ' +
    'repository related to the parser rewrite, touching many modules and requiring careful review ' +
    'of the surrounding code before any of it can be considered complete by anyone on the team.';
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's3', tool_input: {subject: 'parser rewrite', description: longNoAcceptance}},
    {sentinel: SONNET_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(TERSE_ADVISORY_RE.test(r.stdout), `expected terse advisory (missing acceptance language), got: ${r.stdout}`);
});

await test('advisory is fail-open: never denies, never sets exit 2 (soft mode)', () => {
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's4', tool_input: {subject: 'x', description: 'y'}},
    {sentinel: SONNET_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  let decision;
  try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { decision = undefined; }
  assert(decision !== 'deny', `decision ${decision}`);
});

await test('pre-existing behavior preserved: hard-mode opus deny still fires (advisory does not interfere)', () => {
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's5', tool_input: {subject: 'redesign auth', description: 'short'}},
    {env: {PRISM_TASK_TIER: 'hard'}, sentinel: OPUS_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`); // hook exit is 0; the deny rides in hookSpecificOutput
  let decision;
  try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { decision = undefined; }
  assert(decision === 'deny', `expected deny, got decision=${decision}, stdout=${r.stdout}`);
});

await test('pre-existing behavior preserved: soft-mode sonnet tier nudge still present alongside terse advisory', () => {
  const r = run(
    {tool_name: 'TaskCreate', session_id: 's6', tool_input: {subject: 'small fix', description: 'tiny'}},
    {sentinel: SONNET_SENTINEL},
  );
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(/PRISM TIER task .* sonnet/.test(r.stdout), `expected tier nudge, got: ${r.stdout}`);
  assert(TERSE_ADVISORY_RE.test(r.stdout), `expected terse advisory alongside tier nudge, got: ${r.stdout}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
