#!/usr/bin/env node
// T7 (Option A: SHA-stamp + SessionStart reminder) — hooks/prism-session-start.mjs
// DEPLOY DRIFT block (SHA-STAMP-003).
//
// "Committed to the repo" != "deployed to ~/.claude": only
// `node tools/prism-installer.mjs install` copies files into the live hook
// set. This asserts SessionStart injects a "DEPLOY DRIFT (T7)" one-liner
// ONLY when <HOME>/.claude/.prism-installed-sha.json's stamped sha is a
// real ANCESTOR of the current repo HEAD (i.e. the repo has moved ahead of
// what was last deployed), that PRISM_DISABLE_DEPLOY_DRIFT=1 suppresses it,
// and that the two fail-open paths (no stamp file; stamp sha === HEAD) stay
// silent.
//
// This block's logic (getGitHeadSha/getCommitDistance) shells out to real
// git — the existing TASK-RECALL/HANDOFF-RECALL harness never exercises
// that path because its fixture project dirs are plain tmpdirs, not git
// repos. Rather than stub git (the existing harness has no stubbing
// mechanism to match), this file gives the hook a REAL, throwaway git repo
// as cwd so getGitHeadSha/getCommitDistance run against real, known commits.
//
// Module does NOT export run() — pure top-level script, subprocess harness,
// matching tests/v3/hooks/test-session-start-task-recall.mjs's pattern.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-start.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Quiet every other SessionStart notice source so additionalContext contains
// (close to) only the DEPLOY DRIFT block under test.
const QUIET_ENV = {
  PRISM_DISABLE_FRESHNESS_SWEEP: '1',
  PRISM_DISABLE_PARALLEL_REMINDER: '1',
  PRISM_DISABLE_ACL_NOTIFY: '1',
  PRISM_DISABLE_CAPABILITY_CATALOG: '1',
  PRISM_DISABLE_MEMORY_INJECT: '1',
  PRISM_DISABLE_KNOWLEDGE_DELTA: '1',
  PRISM_DISABLE_MEMORY_HEAL: '1',
  PRISM_DISABLE_TASK_RECALL: '1',
  PRISM_DISABLE_HANDOFF_RECALL: '1',
};

function git(cwd, args) {
  const r = spawnSync('git', args, {cwd, encoding: 'utf-8', timeout: 10000});
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
  }
  return (r.stdout || '').trim();
}

// Builds a throwaway git repo with two commits, returns {repoDir, sha1, sha2}
// where sha1 is an ANCESTOR of sha2 (=HEAD).
function makeRepoFixture(label) {
  const repoDir = mkdtempSync(join(tmpdir(), `ss-drift-repo-${label}-`));
  mkdirSync(join(repoDir, '.claude'), {recursive: true});
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'a.txt'), 'one\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'c1']);
  const sha1 = git(repoDir, ['rev-parse', 'HEAD']);
  writeFileSync(join(repoDir, 'b.txt'), 'two\n');
  git(repoDir, ['add', 'b.txt']);
  git(repoDir, ['commit', '-q', '-m', 'c2']);
  const sha2 = git(repoDir, ['rev-parse', 'HEAD']);
  return {repoDir, sha1, sha2};
}

function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `ss-drift-home-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function writeStamp(home, sha, ts) {
  writeFileSync(
    join(home, '.claude', '.prism-installed-sha.json'),
    JSON.stringify({sha, ts: ts || new Date().toISOString(), prism_version: 'test'}, null, 2)
  );
}

function runHook({home, repoDir}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'current-session', cwd: repoDir});
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 15000,
    cwd: repoDir, // the hook reads process.cwd(), not the JSON field — must match
    env: {...process.env, HOME: home, USERPROFILE: home, ...QUIET_ENV, ...extraEnv},
  });
}

function additionalContextOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return ''; }
  return (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

// ─── (a) stamp.sha is an ancestor of HEAD -> "N commit(s) ahead" reminder ──

await test('stamp.sha ancestor of HEAD -> DEPLOY DRIFT reminder with commit count', () => {
  const {repoDir, sha1} = makeRepoFixture('ancestor');
  const home = makeHome('ancestor');
  try {
    writeStamp(home, sha1, '2026-07-20T10:00:00.000Z');
    const r = runHook({home, repoDir});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = additionalContextOf(r);
    assert(ctx.includes('DEPLOY DRIFT (T7)'), `expected DEPLOY DRIFT notice. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('1 commit ahead') || ctx.includes('1 commits ahead'),
      `expected a "1 commit ahead" count. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('2026-07-20T10:00:00.000Z'), 'includes the stamped install ts');
    assert(ctx.includes('node tools/prism-installer.mjs install'), 'names the fix command');
  } finally {
    rmSync(repoDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── (b) stamp.sha === HEAD -> no reminder ──────────────────────────────────

await test('stamp.sha === HEAD -> no DEPLOY DRIFT reminder', () => {
  const {repoDir, sha2} = makeRepoFixture('insync');
  const home = makeHome('insync');
  try {
    writeStamp(home, sha2);
    const r = runHook({home, repoDir});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = additionalContextOf(r);
    assert(!ctx.includes('DEPLOY DRIFT'), `no DEPLOY DRIFT notice expected when in sync. Got: ${ctx.slice(0, 500)}`);
  } finally {
    rmSync(repoDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── (c) no stamp file -> no reminder, no crash ─────────────────────────────

await test('no stamp file present -> no DEPLOY DRIFT reminder, hook still exits 0', () => {
  const {repoDir} = makeRepoFixture('nostamp');
  const home = makeHome('nostamp');
  try {
    // Deliberately do NOT write .prism-installed-sha.json.
    const r = runHook({home, repoDir});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(!ctx.includes('DEPLOY DRIFT'), 'no DEPLOY DRIFT notice when the stamp file is absent');
  } finally {
    rmSync(repoDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── (d) PRISM_DISABLE_DEPLOY_DRIFT=1 -> suppressed even with real drift ───

await test('PRISM_DISABLE_DEPLOY_DRIFT=1 suppresses the reminder even when drift exists', () => {
  const {repoDir, sha1} = makeRepoFixture('offswitch');
  const home = makeHome('offswitch');
  try {
    writeStamp(home, sha1);
    const r = runHook({home, repoDir}, {PRISM_DISABLE_DEPLOY_DRIFT: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(!ctx.includes('DEPLOY DRIFT'), `DEPLOY DRIFT must not appear when disabled. Got: ${ctx.slice(0, 300)}`);
  } finally {
    rmSync(repoDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

// ─── (e) bonus: indeterminate relationship -> softer "verify with" message ─

await test('stamp.sha not an ancestor/descendant relationship the tool can resolve -> softer indeterminate message', () => {
  const {repoDir} = makeRepoFixture('indeterminate');
  const home = makeHome('indeterminate');
  try {
    // A well-formed but entirely fabricated sha: not present in this repo at
    // all, so getCommitDistance's rev-list call fails -> dist === null.
    const fakeSha = 'deadbeef' + '0'.repeat(32);
    writeStamp(home, fakeSha);
    const r = runHook({home, repoDir});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('DEPLOY DRIFT (T7)'), `expected a DEPLOY DRIFT notice. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('indeterminate'), `expected the softer indeterminate message. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('node tools/prism-installer.mjs verify'), 'names the verify command, not install');
    assert(!/\d+ commits? ahead/.test(ctx), 'must NOT claim a commit count it does not have');
  } finally {
    rmSync(repoDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
