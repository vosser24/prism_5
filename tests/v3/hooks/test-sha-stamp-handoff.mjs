#!/usr/bin/env node
// SHA-STAMP-001 (recall-hardening v6.2.0, Task #2) — git HEAD sha stamping
// on handoff artifacts (hooks/prism-session-end.mjs) + staleness labeling on
// resume (hooks/prism-session-start.mjs's TASK-RECALL block, C6).
//
// Asserts:
//   1. hooks/prism-session-end.mjs stamps the real `git rev-parse HEAD` sha
//      into the task-snapshot sidecar AND the project-local open-tasks
//      pointer (git_sha field), when cwd is a real git repo.
//   2. hooks/prism-session-end.mjs degrades gracefully (git_sha: null, no
//      crash, exit 0) when cwd is NOT a git repo.
//   3. hooks/prism-session-start.mjs labels a pointer stamped at current
//      HEAD as [CURRENT].
//   4. hooks/prism-session-start.mjs labels a pointer stamped at an OLDER
//      sha as [STALE — N commit(s) behind HEAD], with a correct count.
//   5. hooks/prism-session-start.mjs degrades gracefully — no throw, exit 0,
//      no CURRENT/STALE tag — when the pointer has no git_sha (older
//      pointer shape) and separately when cwd is not a git repo at all.
//
// Subprocess-only harness, matching tests/v3/hooks/test-session-start-task-
// recall.mjs and tests/v3/hooks/test-session-end-task-snapshot.mjs.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const END_HOOK = join(HOOKS, 'prism-session-end.mjs');
const START_HOOK = join(HOOKS, 'prism-session-start.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// ─── git repo fixture helpers ────────────────────────────────────────────

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], {encoding: 'utf-8', timeout: 5000});
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function initGitRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-q', '-m', 'initial commit']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function commitEmpty(dir, msg) {
  git(dir, ['commit', '--allow-empty', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// ─── SessionEnd transcript fixture (one open task) ───────────────────────

function buildTranscript(sessionId) {
  const lines = [];
  const push = (obj) => lines.push(JSON.stringify(obj));
  push({
    type: 'assistant',
    message: {model: 'claude-opus-4-8', role: 'assistant', content: [
      {type: 'tool_use', id: 'toolu_create', name: 'TaskCreate',
       input: {subject: 'Sample open task', description: 'A task that stays open through SessionEnd.',
               activeForm: 'Working on sample task'}},
    ]},
    parent_tool_use_id: null, session_id: sessionId, timestamp: '2026-07-13T08:00:00.000Z',
  });
  push({
    type: 'user',
    message: {role: 'user', content: [
      {tool_use_id: 'toolu_create', type: 'tool_result', content: 'Task #1 created successfully: Sample open task'},
    ]},
    tool_use_result: {task: {id: '1', subject: 'Sample open task'}},
    session_id: sessionId, timestamp: '2026-07-13T08:00:01.000Z',
  });
  return lines.join('\n') + '\n';
}

function setupEndFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `sha-se-home-${label}-`));
  const cwd = mkdtempSync(join(tmpdir(), `sha-se-cwd-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sessionId = `sess-${label}-${Date.now()}`;
  const transcriptPath = join(home, `${sessionId}.transcript.jsonl`);
  writeFileSync(transcriptPath, buildTranscript(sessionId));
  return {home, cwd, sessionId, transcriptPath};
}

function runEndHook({home, cwd, sessionId, transcriptPath}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: sessionId, transcript_path: transcriptPath, cwd});
  return spawnSync(process.execPath, [END_HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    env: {...process.env, HOME: home, USERPROFILE: home, ...extraEnv},
  });
}

// ─── SessionStart pointer fixture ─────────────────────────────────────────

const QUIET_ENV = {
  PRISM_DISABLE_FRESHNESS_SWEEP: '1',
  PRISM_DISABLE_PARALLEL_REMINDER: '1',
  PRISM_DISABLE_CLAUDE_MEM_GUARD: '1',
  PRISM_DISABLE_ACL_NOTIFY: '1',
  PRISM_DISABLE_CAPABILITY_CATALOG: '1',
  PRISM_DISABLE_MEMORY_INJECT: '1',
  PRISM_DISABLE_KNOWLEDGE_DELTA: '1',
  PRISM_DISABLE_MEMORY_HEAL: '1',
};

function makeStartFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `sha-ss-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `sha-ss-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  return {home, projectDir};
}

function writePointer(projectDir, gitSha) {
  const payload = {
    session_id: 'prior-session',
    project: projectDir,
    ts: '2026-07-13T08:00:05.000Z',
    git_sha: gitSha, // omit key entirely by passing undefined + JSON.stringify drops it
    open_tasks: [
      {id: '1', subject: 'Sample open task', description: 'A task that stays open.',
       activeForm: 'Working on sample task', status: 'pending', blockedBy: null},
    ],
  };
  writeFileSync(join(projectDir, '.claude', '.prism-open-tasks.json'), JSON.stringify(payload, null, 2));
}

function runStartHook({home, projectDir}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'current-session', cwd: projectDir});
  return spawnSync(process.execPath, [START_HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    cwd: projectDir,
    env: {...process.env, HOME: home, USERPROFILE: home, ...QUIET_ENV, ...extraEnv},
  });
}

function additionalContextOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return ''; }
  return (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

// ─── 1. SessionEnd stamps the real HEAD sha into sidecar + pointer ────────

await test('SessionEnd (git cwd): sidecar + project pointer git_sha === real `git rev-parse HEAD`', () => {
  const fx = setupEndFixture('git');
  try {
    const realSha = initGitRepo(fx.cwd);
    const r = runEndHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.tasks.json`);
    const pointerPath = join(fx.cwd, '.claude', '.prism-open-tasks.json');
    assert(existsSync(sidecarPath), 'sidecar written');
    assert(existsSync(pointerPath), 'project pointer written');

    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    assert(sidecar.git_sha === realSha, `sidecar.git_sha (${sidecar.git_sha}) === real HEAD (${realSha})`);
    assert(pointer.git_sha === realSha, `pointer.git_sha (${pointer.git_sha}) === real HEAD (${realSha})`);

    const mdPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.md`);
    const md = readFileSync(mdPath, 'utf-8');
    assert(md.includes(`- **Git HEAD:** ${realSha}`), 'session .md header carries the same sha');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

await test('SessionEnd (non-git cwd): degrades gracefully — git_sha null, no crash, exit 0', () => {
  const fx = setupEndFixture('nongit');
  try {
    const r = runEndHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const sidecarPath = join(fx.home, '.claude', '.prism-sessions', `${fx.sessionId}.tasks.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
    assert(sidecar.git_sha === null, `git_sha is null for a non-git cwd, got ${JSON.stringify(sidecar.git_sha)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.cwd, {recursive: true, force: true});
  }
});

// ─── 2. SessionStart: (a) CURRENT ─────────────────────────────────────────

await test('SessionStart: pointer stamped at current HEAD -> [CURRENT]', () => {
  const fx = makeStartFixture('current');
  try {
    const sha = initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, sha);
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<TASK-RECALL priority=high>'), `TASK-RECALL block missing. Got: ${ctx.slice(0, 300)}`);
    assert(ctx.includes('[CURRENT]'), `expected [CURRENT] tag. Got: ${ctx.slice(0, 400)}`);
    assert(!ctx.includes('STALE'), `must not be labeled STALE when sha matches HEAD. Got: ${ctx.slice(0, 400)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 3. SessionStart: (b) STALE with commit distance ──────────────────────

await test('SessionStart: pointer stamped at an OLDER sha -> [STALE — N commit(s) behind HEAD]', () => {
  const fx = makeStartFixture('stale');
  try {
    const oldSha = initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, oldSha);
    commitEmpty(fx.projectDir, 'second commit');
    commitEmpty(fx.projectDir, 'third commit'); // HEAD is now 2 commits ahead of oldSha

    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<TASK-RECALL priority=high>'), `TASK-RECALL block missing. Got: ${ctx.slice(0, 300)}`);
    assert(ctx.includes('[STALE — 2 commits behind HEAD]'), `expected exact STALE+count tag. Got: ${ctx.slice(0, 400)}`);
    assert(!ctx.includes('[CURRENT]'), `must not be labeled CURRENT when sha differs. Got: ${ctx.slice(0, 400)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 4. SessionStart: (c) fail-open degradation ────────────────────────────

await test('SessionStart: pointer with NO git_sha (older shape) -> no CURRENT/STALE tag, no crash', () => {
  const fx = makeStartFixture('nosha');
  try {
    initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, undefined); // JSON.stringify drops the key entirely
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<TASK-RECALL priority=high>'), `TASK-RECALL block still emitted. Got: ${ctx.slice(0, 300)}`);
    assert(!ctx.includes('[CURRENT]') && !ctx.includes('STALE'), `no staleness tag without a stamped sha. Got: ${ctx.slice(0, 400)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('SessionStart: pointer HAS a git_sha but cwd is NOT a git repo -> fail-open, no crash', () => {
  const fx = makeStartFixture('missinggit');
  try {
    // projectDir is deliberately never git-init'd.
    writePointer(fx.projectDir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<TASK-RECALL priority=high>'), `TASK-RECALL block still emitted. Got: ${ctx.slice(0, 300)}`);
    assert(!ctx.includes('[CURRENT]') && !ctx.includes('STALE'), `no staleness tag when current HEAD is unresolvable. Got: ${ctx.slice(0, 400)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
