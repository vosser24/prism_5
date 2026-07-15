#!/usr/bin/env node
// C9 (recall-hardening v6.2.0) — hooks/prism-session-end.mjs Task API snapshot (C5).
//
// Feeds a synthetic transcript JSONL containing real-shape TaskCreate/TaskUpdate
// tool_use + tool_result events (schema verified against a captured transcript —
// tests/v3/bench/item6/results/A/rep1/sess4/stream.jsonl:61-71) and asserts:
//   1. the sidecar ~/.claude/.prism-sessions/<id>.tasks.json schema
//      {session_id, project, ts, open_tasks:[{id, subject, description,
//       activeForm, status, blockedBy}]} — open = pending | in_progress only.
//   2. the project-local pointer <cwd>/.claude/.prism-open-tasks.json carries
//      the SAME payload.
//   3. the `## Open tasks (carryover)` section in the Stop-hook session .md
//      lists ONLY non-completed tasks, with the FULL untruncated description.
//   4. PRISM_DISABLE_TASK_SNAPSHOT=1 suppresses all three outputs.
//   5. a transcript with zero Task events is a graceful no-op (no sidecar,
//      no pointer, no "## Open tasks" section).
//
// Module does NOT export run() — pure top-level script wired to the Stop
// hook event. Subprocess-only, matching tests/v3/hooks/test-session-start-
// async-audit.mjs's harness pattern.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-end.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const LONG_DESC_1 =
  'Create backend/middleware/rateLimiter.js exporting a token-bucket limiter ' +
  'keyed by req.ip (100 req/min, burst 20). Wire it into server.js ahead of ' +
  'all /api routes. Acceptance: hitting any /api endpoint 101 times within ' +
  '60s from the same IP returns HTTP 429 with a Retry-After header on the ' +
  '101st request; requests under the limit are unaffected; node --check ' +
  'passes on server.js and the new middleware file.';

const LONG_DESC_2 =
  'Write integration tests (tests/integration/rate-limit.test.mjs) covering: ' +
  'under-limit passthrough, over-limit 429 with Retry-After, and limiter ' +
  'reset after the window elapses. Acceptance: `node --test` passes with ' +
  'zero failures and the new file is the only test file touched.';

function buildTranscript(sessionId) {
  const lines = [];
  const push = (obj) => lines.push(JSON.stringify(obj));

  // Task #1: created, then updated to in_progress (remains OPEN).
  push({
    type: 'assistant',
    message: {model: 'claude-opus-4-8', role: 'assistant', content: [
      {type: 'tool_use', id: 'toolu_task1_create', name: 'TaskCreate',
       input: {subject: 'Add rate limiting to API endpoints', description: LONG_DESC_1,
               activeForm: 'Implementing rate limiting', blockedBy: []}},
    ]},
    parent_tool_use_id: null, session_id: sessionId, timestamp: '2026-07-13T08:00:00.000Z',
  });
  push({
    type: 'user',
    message: {role: 'user', content: [
      {tool_use_id: 'toolu_task1_create', type: 'tool_result', content: 'Task #1 created successfully: Add rate limiting to API endpoints'},
    ]},
    tool_use_result: {task: {id: '1', subject: 'Add rate limiting to API endpoints'}},
    session_id: sessionId, timestamp: '2026-07-13T08:00:01.000Z',
  });

  // Task #2: created, then updated to completed (must NOT appear in open_tasks).
  push({
    type: 'assistant',
    message: {model: 'claude-opus-4-8', role: 'assistant', content: [
      {type: 'tool_use', id: 'toolu_task2_create', name: 'TaskCreate',
       input: {subject: 'Write integration tests', description: LONG_DESC_2,
               activeForm: 'Writing integration tests'}},
    ]},
    parent_tool_use_id: null, session_id: sessionId, timestamp: '2026-07-13T08:00:02.000Z',
  });
  push({
    type: 'user',
    message: {role: 'user', content: [
      {tool_use_id: 'toolu_task2_create', type: 'tool_result', content: 'Task #2 created successfully: Write integration tests'},
    ]},
    tool_use_result: {task: {id: '2', subject: 'Write integration tests'}},
    session_id: sessionId, timestamp: '2026-07-13T08:00:03.000Z',
  });

  push({
    type: 'assistant',
    message: {model: 'claude-opus-4-8', role: 'assistant', content: [
      {type: 'tool_use', id: 'toolu_task1_update', name: 'TaskUpdate', input: {taskId: '1', status: 'in_progress'}},
    ]},
    parent_tool_use_id: null, session_id: sessionId, timestamp: '2026-07-13T08:00:04.000Z',
  });
  push({
    type: 'user',
    message: {role: 'user', content: [
      {tool_use_id: 'toolu_task1_update', type: 'tool_result', content: 'Updated task #1 status'},
    ]},
    tool_use_result: {success: true, taskId: '1', updatedFields: ['status'], statusChange: {from: 'pending', to: 'in_progress'}},
    session_id: sessionId, timestamp: '2026-07-13T08:00:05.000Z',
  });

  push({
    type: 'assistant',
    message: {model: 'claude-opus-4-8', role: 'assistant', content: [
      {type: 'tool_use', id: 'toolu_task2_update', name: 'TaskUpdate', input: {taskId: '2', status: 'completed'}},
    ]},
    parent_tool_use_id: null, session_id: sessionId, timestamp: '2026-07-13T08:00:06.000Z',
  });
  push({
    type: 'user',
    message: {role: 'user', content: [
      {tool_use_id: 'toolu_task2_update', type: 'tool_result', content: 'Updated task #2 status'},
    ]},
    tool_use_result: {success: true, taskId: '2', updatedFields: ['status'], statusChange: {from: 'in_progress', to: 'completed'}},
    session_id: sessionId, timestamp: '2026-07-13T08:00:07.000Z',
  });

  return lines.join('\n') + '\n';
}

function setupFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `se-tsnap-home-${label}-`));
  const cwd = mkdtempSync(join(tmpdir(), `se-tsnap-cwd-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sessionId = `sess-${label}-${Date.now()}`;
  const transcriptPath = join(home, `${sessionId}.transcript.jsonl`);
  writeFileSync(transcriptPath, buildTranscript(sessionId));
  return {home, cwd, sessionId, transcriptPath};
}

function runHook({home, cwd, sessionId, transcriptPath}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: sessionId, transcript_path: transcriptPath, cwd});
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {...process.env, HOME: home, USERPROFILE: home, ...extraEnv},
  });
}

// ─── 1. Sidecar schema + project pointer + md section ───────────────────────

await test('sidecar .tasks.json has correct schema, containing only open (non-completed) tasks', () => {
  const fx = setupFixture('sidecar');
  try {
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.tasks.json`);
    assert(existsSync(sidecarPath), `sidecar missing: ${sidecarPath}`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));

    assert(sidecar.session_id === fx.sessionId, 'session_id matches');
    assert(typeof sidecar.project === 'string' && sidecar.project.length > 0, 'project is a non-empty string');
    assert(typeof sidecar.ts === 'string' && !Number.isNaN(Date.parse(sidecar.ts)), 'ts is a parseable ISO string');
    assert(Array.isArray(sidecar.open_tasks), 'open_tasks is an array');
    assert(sidecar.open_tasks.length === 1, `expected exactly 1 open task (task #2 is completed), got ${sidecar.open_tasks.length}`);

    const t1 = sidecar.open_tasks[0];
    assert(t1.id === '1', `open task id === "1", got ${JSON.stringify(t1.id)}`);
    assert(t1.subject === 'Add rate limiting to API endpoints', 'subject preserved');
    assert(t1.description === LONG_DESC_1, 'description preserved FULL and untruncated');
    assert(t1.activeForm === 'Implementing rate limiting', 'activeForm preserved');
    assert(t1.status === 'in_progress', `status reflects the TaskUpdate statusChange.to, got ${t1.status}`);
    assert('blockedBy' in t1, 'blockedBy key present (even if null/empty)');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

await test('project-local pointer <cwd>/.claude/.prism-open-tasks.json carries the SAME payload', () => {
  const fx = setupFixture('pointer');
  try {
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.tasks.json`);
    const pointerPath = join(fx.cwd, '.claude', '.prism-open-tasks.json');
    assert(existsSync(pointerPath), `project pointer missing: ${pointerPath}`);

    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    assert(JSON.stringify(pointer.open_tasks) === JSON.stringify(sidecar.open_tasks), 'pointer.open_tasks === sidecar.open_tasks');
    assert(pointer.session_id === sidecar.session_id, 'pointer.session_id === sidecar.session_id');
    assert(pointer.project === sidecar.project, 'pointer.project === sidecar.project');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

await test('Stop-hook session .md gets a "## Open tasks (carryover)" section listing only non-completed tasks with FULL description', () => {
  const fx = setupFixture('md');
  try {
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const mdPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.md`);
    assert(existsSync(mdPath), `session md missing: ${mdPath}`);
    const md = readFileSync(mdPath, 'utf-8');

    assert(md.includes('## Open tasks (carryover)'), 'md contains the Open tasks section header');
    assert(md.includes('Add rate limiting to API endpoints'), 'md mentions the open task subject');
    assert(md.includes(LONG_DESC_1), 'md contains the FULL, untruncated description for the open task');
    assert(!md.includes('Write integration tests'), 'md does NOT list the completed task (#2) under Open tasks');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── 2. Off-switch ────────────────────────────────────────────────────────

await test('PRISM_DISABLE_TASK_SNAPSHOT=1 suppresses sidecar, pointer, and md section entirely', () => {
  const fx = setupFixture('offswitch');
  try {
    const r = runHook(fx, {PRISM_DISABLE_TASK_SNAPSHOT: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.tasks.json`);
    const pointerPath = join(fx.cwd, '.claude', '.prism-open-tasks.json');
    assert(!existsSync(sidecarPath), 'sidecar must NOT be written when disabled');
    assert(!existsSync(pointerPath), 'project pointer must NOT be written when disabled');

    const mdPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.md`);
    assert(existsSync(mdPath), 'the base session md must still be written (Stop hook itself is unaffected)');
    const md = readFileSync(mdPath, 'utf-8');
    assert(!md.includes('## Open tasks (carryover)'), 'md must NOT contain the Open tasks section when disabled');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── 3. Graceful no-op — zero Task events ────────────────────────────────

await test('a transcript with zero Task events is a graceful no-op (no sidecar, no pointer, no section)', () => {
  const home = mkdtempSync(join(tmpdir(), 'se-tsnap-home-noop-'));
  const cwd = mkdtempSync(join(tmpdir(), 'se-tsnap-cwd-noop-'));
  const sessionId = `sess-noop-${Date.now()}`;
  const transcriptPath = join(home, `${sessionId}.transcript.jsonl`);
  try {
    mkdirSync(join(home, '.claude'), {recursive: true});
    const lines = [
      JSON.stringify({type: 'user', message: {role: 'user', content: 'just a normal prompt, no tasks'}, timestamp: '2026-07-13T08:00:00.000Z'}),
      JSON.stringify({type: 'assistant', message: {model: 'claude-opus-4-8', role: 'assistant', content: [{type: 'text', text: 'done'}]}, timestamp: '2026-07-13T08:00:01.000Z'}),
    ];
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const r = runHook({home, cwd, sessionId, transcriptPath});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(home, '.claude', '.prism-sessions', `${sessionId}.tasks.json`);
    const pointerPath = join(cwd, '.claude', '.prism-open-tasks.json');
    assert(!existsSync(sidecarPath), 'no sidecar when there are zero Task events');
    assert(!existsSync(pointerPath), 'no project pointer when there are zero Task events');

    const mdPath = join(home, '.claude', '.prism-sessions', `${sessionId}.md`);
    assert(existsSync(mdPath), 'base session md is still written');
    const md = readFileSync(mdPath, 'utf-8');
    assert(!md.includes('## Open tasks (carryover)'), 'no Open tasks section when there are zero Task events');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
