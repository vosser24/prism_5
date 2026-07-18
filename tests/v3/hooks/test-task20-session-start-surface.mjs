#!/usr/bin/env node
// Task #20 Defect A/B SURFACE leg (hooks/prism-session-start.mjs TASK-RECALL).
//
// The SHA-STAMP staleness check tags a pointer [CURRENT] whenever git_sha ===
// HEAD — a repo-position signal. D047: [CURRENT] then collapses "repo fresh"
// and "rows never re-observed" into one green. Asserts:
//   1. A pointer at HEAD carrying carried_unverified rows -> the top tag is NOT
//      a naked [CURRENT]; it distinguishes ("repo CURRENT · M of N carried,
//      unverified since prior session") AND a CARRIED-UNVERIFIED line fires.
//   2. A pointer whose meta.id_collisions is non-empty -> an ID-COLLISION line
//      fires naming the reused id.
//   3. CONTROL: a pointer at HEAD with NO carried_unverified rows -> the naked
//      [CURRENT] tag is preserved (back-compat with test-sha-stamp-handoff).
//
// Subprocess + real-git harness, mirroring tests/v3/hooks/test-sha-stamp-handoff.mjs.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const START_HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-session-start.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const QUIET_ENV = {
  PRISM_DISABLE_FRESHNESS_SWEEP: '1', PRISM_DISABLE_PARALLEL_REMINDER: '1',
  PRISM_DISABLE_CLAUDE_MEM_GUARD: '1', PRISM_DISABLE_ACL_NOTIFY: '1',
  PRISM_DISABLE_CAPABILITY_CATALOG: '1', PRISM_DISABLE_MEMORY_INJECT: '1',
  PRISM_DISABLE_KNOWLEDGE_DELTA: '1', PRISM_DISABLE_MEMORY_HEAL: '1',
};

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
function makeFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `t20-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `t20-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  return {home, projectDir};
}
function writePointer(projectDir, payload) {
  writeFileSync(join(projectDir, '.claude', '.prism-open-tasks.json'), JSON.stringify(payload, null, 2));
}
function runStart({home, projectDir}, extraEnv = {}) {
  const input = JSON.stringify({session_id: 'current-session', cwd: projectDir});
  return spawnSync(process.execPath, [START_HOOK], {
    input, encoding: 'utf-8', timeout: 10000, cwd: projectDir,
    env: {...process.env, HOME: home, USERPROFILE: home, ...QUIET_ENV, ...extraEnv},
  });
}
function ctxOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let p; try { p = JSON.parse(r.stdout); } catch { return ''; }
  return (p && p.hookSpecificOutput && p.hookSpecificOutput.additionalContext) || '';
}

// ── 1. carried_unverified rows at HEAD -> qualified tag + CARRIED-UNVERIFIED ──
await test('carried_unverified rows at HEAD -> tag distinguishes (NOT naked [CURRENT]) + CARRIED-UNVERIFIED line', () => {
  const fx = makeFixture('cu');
  try {
    const sha = initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, {
      session_id: 'b93efee4', ts: '2026-07-17T15:47:12.500Z', git_sha: sha,
      open_tasks: [
        {id: '44', subject: 'real 44', description: 'd44', activeForm: '', status: 'in_progress',
         blockedBy: null, carried_from: {session: '7fa44bcc', ts: '2026-07-17T09:09:50.031Z'}, carried_unverified: true},
        {id: '20', subject: 'observed this session', description: 'd20', activeForm: '', status: 'in_progress', blockedBy: null},
      ],
    });
    const ctx = ctxOf(runStart(fx));
    assert(ctx.includes('<TASK-RECALL priority=high>'), `TASK-RECALL block missing. Got: ${ctx.slice(0, 300)}`);
    assert(!ctx.includes(' [CURRENT]'), `naked [CURRENT] must NOT appear when rows are carried-unverified. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('repo CURRENT · 1 of 2 carried, unverified'),
      `qualified staleness tag expected. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('CARRIED-UNVERIFIED: 1 of 2'),
      `CARRIED-UNVERIFIED line expected. Got: ${ctx.slice(0, 800)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ── 2. meta.id_collisions -> ID-COLLISION line ──────────────────────────────
await test('pointer meta.id_collisions -> ID-COLLISION warning line names the reused id', () => {
  const fx = makeFixture('col');
  try {
    const sha = initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, {
      session_id: 'b93efee4', ts: '2026-07-17T15:47:12.500Z', git_sha: sha,
      meta: {structured_hits: 1, id_collisions: [
        {id: '19', prior_session: '1927f358', prior_subject: 'PHASE 4 — soft-first advisories', session_subject: 'knowledge-index parseSingleFile bug'},
      ]},
      open_tasks: [
        {id: '19', subject: 'knowledge-index parseSingleFile bug', description: 'd', activeForm: '', status: 'in_progress', blockedBy: null},
      ],
    });
    const ctx = ctxOf(runStart(fx));
    assert(ctx.includes('ID-COLLISION'), `ID-COLLISION line expected. Got: ${ctx.slice(0, 800)}`);
    assert(ctx.includes('#19'), `ID-COLLISION line must name the reused id. Got: ${ctx.slice(0, 800)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ── 3. CONTROL: no carried_unverified -> naked [CURRENT] preserved ───────────
await test('CONTROL: pointer at HEAD with NO carried_unverified -> naked [CURRENT] preserved', () => {
  const fx = makeFixture('ctrl');
  try {
    const sha = initGitRepo(fx.projectDir);
    writePointer(fx.projectDir, {
      session_id: 'prior', ts: '2026-07-13T08:00:05.000Z', git_sha: sha,
      open_tasks: [
        {id: '1', subject: 'Sample', description: 'A task.', activeForm: '', status: 'pending', blockedBy: null},
      ],
    });
    const ctx = ctxOf(runStart(fx));
    assert(ctx.includes('[CURRENT]'), `naked [CURRENT] must be preserved. Got: ${ctx.slice(0, 400)}`);
    assert(!ctx.includes('CARRIED-UNVERIFIED'), `no CARRIED-UNVERIFIED line without carried_unverified rows. Got: ${ctx.slice(0, 400)}`);
    assert(!ctx.includes('ID-COLLISION'), `no ID-COLLISION line without collisions. Got: ${ctx.slice(0, 400)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
