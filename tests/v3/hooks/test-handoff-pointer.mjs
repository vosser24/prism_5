#!/usr/bin/env node
// Task #31 — deterministic resume pointer + staleness stamp for the
// /prism-clean Step 4b session-handoff doc.
//
// Asserts:
//   1. hooks/prism-handoff-pointer.mjs (PostToolUse) records the pointer as a
//      side-effect of the handoff Write itself: path + real `git rev-parse
//      HEAD` sha into <cwd>/.claude/.prism-latest-handoff.json. No second
//      manual step exists — the write IS the trigger.
//   2. A non-handoff Write does NOT create the pointer; the off-switch env
//      (PRISM_DISABLE_HANDOFF_POINTER=1) suppresses it.
//   3. hooks/prism-session-start.mjs surfaces a fresh pointer as
//      <HANDOFF-RECALL ...> with [CURRENT] when HEAD matches the stamp.
//   4. After HEAD moves (2 commits), the same pointer surfaces as
//      [STALE — 2 commits behind HEAD].
//   5. Fail-open: pointer present but the handoff doc deleted from disk →
//      no HANDOFF-RECALL block, exit 0. Non-git cwd → pointer written with
//      git_sha null, surfaced without any CURRENT/STALE tag.
//
// Subprocess/direct-import harness matching tests/v3/hooks/test-sha-stamp-
// handoff.mjs.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const START_HOOK = join(HOOKS, 'prism-session-start.mjs');
const {run: pointerRun} = await import(pathToFileURL(join(HOOKS, 'prism-handoff-pointer.mjs')).href);

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

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

function makeFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `hop-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `hop-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, 'docs', 'prism', 'plans'), {recursive: true});
  return {home, projectDir};
}

function writeHandoffDoc(projectDir, rel = 'docs/prism/plans/2026-07-16-SESSION-HANDOFF.md') {
  const abs = join(projectDir, rel);
  writeFileSync(abs, '# Session handoff\n\n1. resume the thing\n');
  return {rel, abs};
}

// PostToolUse payload as the dispatcher hands it to run()
function writePayload(projectDir, filePath, sessionId = 'sess-hop') {
  return {tool_name: 'Write', tool_input: {file_path: filePath}, cwd: projectDir, session_id: sessionId};
}

function runStartHook({home, projectDir}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'current-session', cwd: projectDir});
  return spawnSync(process.execPath, [START_HOOK], {
    input: payload, encoding: 'utf-8', timeout: 10000, cwd: projectDir,
    env: {...process.env, HOME: home, USERPROFILE: home, ...QUIET_ENV, ...extraEnv},
  });
}
function additionalContextOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return ''; }
  return (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}
const pointerPathOf = (projectDir) => join(projectDir, '.claude', '.prism-latest-handoff.json');

// ─── 1. write path records pointer + real HEAD sha, deterministically ──────

await test('pointer hook: handoff Write records path + real HEAD sha (side-effect, no second step)', async () => {
  const fx = makeFixture('record');
  try {
    const sha = initGitRepo(fx.projectDir);
    const {abs, rel} = writeHandoffDoc(fx.projectDir);
    const r = await pointerRun(writePayload(fx.projectDir, abs));
    assert(r.exit === 0, `exit ${r.exit}`);
    assert(r.stdout.includes('latest-handoff pointer recorded'), `stdout: ${r.stdout}`);
    assert(existsSync(pointerPathOf(fx.projectDir)), 'pointer sidecar written');
    const p = JSON.parse(readFileSync(pointerPathOf(fx.projectDir), 'utf-8'));
    assert(p.path === rel.replace(/\\/g, '/'), `path stored project-relative: ${p.path}`);
    assert(p.git_sha === sha, `git_sha (${p.git_sha}) === real HEAD (${sha})`);
    assert(p.session_id === 'sess-hop', 'session_id carried');
    assert(typeof p.ts === 'string' && p.ts.length > 0, 'ts stamped');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('pointer hook: non-handoff Write is a no-op; off-switch suppresses', async () => {
  const fx = makeFixture('noop');
  try {
    initGitRepo(fx.projectDir);
    const other = join(fx.projectDir, 'docs', 'prism', 'plans', 'not-a-handoff.md');
    writeFileSync(other, 'x');
    let r = await pointerRun(writePayload(fx.projectDir, other));
    assert(r.exit === 0 && !existsSync(pointerPathOf(fx.projectDir)), 'no pointer for non-handoff basename');

    const {abs} = writeHandoffDoc(fx.projectDir);
    process.env.PRISM_DISABLE_HANDOFF_POINTER = '1';
    try { r = await pointerRun(writePayload(fx.projectDir, abs)); }
    finally { delete process.env.PRISM_DISABLE_HANDOFF_POINTER; }
    assert(r.exit === 0 && !existsSync(pointerPathOf(fx.projectDir)), 'off-switch: no pointer written');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 2. SessionStart surfaces fresh pointer as [CURRENT] ───────────────────

await test('SessionStart: fresh pointer (sha == HEAD) -> HANDOFF-RECALL with [CURRENT]', async () => {
  const fx = makeFixture('current');
  try {
    initGitRepo(fx.projectDir);
    const {abs, rel} = writeHandoffDoc(fx.projectDir);
    await pointerRun(writePayload(fx.projectDir, abs));
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<HANDOFF-RECALL priority=high>'), `HANDOFF-RECALL missing. Got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes(rel.replace(/\\/g, '/')), `handoff path surfaced. Got: ${ctx.slice(0, 400)}`);
    const block = ctx.slice(ctx.indexOf('<HANDOFF-RECALL'), ctx.indexOf('</HANDOFF-RECALL>'));
    assert(block.includes('[CURRENT]') && !block.includes('STALE'), `expected [CURRENT], got: ${block}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 3. HEAD moves -> [STALE — N commits behind HEAD] ──────────────────────

await test('SessionStart: HEAD moved 2 commits -> HANDOFF-RECALL [STALE — 2 commits behind HEAD]', async () => {
  const fx = makeFixture('stale');
  try {
    initGitRepo(fx.projectDir);
    const {abs} = writeHandoffDoc(fx.projectDir);
    await pointerRun(writePayload(fx.projectDir, abs));
    commitEmpty(fx.projectDir, 'second commit');
    commitEmpty(fx.projectDir, 'third commit');
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<HANDOFF-RECALL priority=high>'), `HANDOFF-RECALL missing. Got: ${ctx.slice(0, 400)}`);
    const block = ctx.slice(ctx.indexOf('<HANDOFF-RECALL'), ctx.indexOf('</HANDOFF-RECALL>'));
    assert(block.includes('[STALE — 2 commits behind HEAD]'), `expected exact STALE tag, got: ${block}`);
    assert(!block.includes('[CURRENT]'), `must not be CURRENT: ${block}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 4. fail-open paths ─────────────────────────────────────────────────────

await test('SessionStart: pointer present but handoff doc DELETED -> no HANDOFF-RECALL, exit 0', async () => {
  const fx = makeFixture('deleted');
  try {
    initGitRepo(fx.projectDir);
    const {abs} = writeHandoffDoc(fx.projectDir);
    await pointerRun(writePayload(fx.projectDir, abs));
    unlinkSync(abs);
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    assert(!additionalContextOf(r).includes('HANDOFF-RECALL'), 'no block for a vanished doc');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('non-git cwd: pointer written with git_sha null; surfaced with no CURRENT/STALE tag', async () => {
  const fx = makeFixture('nongit');
  try {
    // projectDir deliberately never git-init'd
    const {abs} = writeHandoffDoc(fx.projectDir);
    const rr = await pointerRun(writePayload(fx.projectDir, abs));
    assert(rr.exit === 0, `pointer run exit ${rr.exit}`);
    const p = JSON.parse(readFileSync(pointerPathOf(fx.projectDir), 'utf-8'));
    assert(p.git_sha === null, `git_sha null for non-git cwd, got ${JSON.stringify(p.git_sha)}`);
    const r = runStartHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('<HANDOFF-RECALL priority=high>'), `block still surfaced. Got: ${ctx.slice(0, 400)}`);
    const block = ctx.slice(ctx.indexOf('<HANDOFF-RECALL'), ctx.indexOf('</HANDOFF-RECALL>'));
    assert(!block.includes('[CURRENT]') && !block.includes('STALE'), `no staleness tag without a sha: ${block}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
