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
import {basename, dirname, join} from 'node:path';
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

// D046 finding #3 (Fix): the near-miss path writes to the ledger via
// logAdvisory(), which resolves ~/.claude through prismHome() — HOME/
// USERPROFILE read AT CALL TIME (hooks/lib/prism-home.mjs's own doc
// comment: "lets tests flip HOME between calls"). pointerRun() is called
// DIRECTLY (in-process import, not a subprocess with an env override like
// runStartHook below), so every call that could hit the near-miss branch
// must flip HOME/USERPROFILE to the fixture's sandboxed home first, or it
// silently writes into the real machine's ~/.claude/.prism-routing.jsonl.
async function pointerRunSandboxed(fx, payload) {
  const prevHome = process.env.HOME, prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fx.home;
  process.env.USERPROFILE = fx.home;
  try {
    return await pointerRun(payload);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}
const ledgerPathOf = (home) => join(home, '.claude', '.prism-routing.jsonl');
function readLedgerLines(home) {
  const p = ledgerPathOf(home);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
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
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
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

await test('pointer hook: a basename with no "handoff" mention at all is a true no-op (no pointer, no ledger)', async () => {
  const fx = makeFixture('noop');
  try {
    initGitRepo(fx.projectDir);
    const other = join(fx.projectDir, 'docs', 'prism', 'plans', 'readme.md');
    writeFileSync(other, 'x');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, other));
    assert(r.exit === 0 && r.stdout === '' && !existsSync(pointerPathOf(fx.projectDir)), 'no pointer, no message, for a basename with no handoff mention');
    assert(readLedgerLines(fx.home).length === 0, 'no ledger entry either — this is a true negative, not a near-miss');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('pointer hook: off-switch suppresses even a canonical handoff Write', async () => {
  const fx = makeFixture('offswitch');
  try {
    initGitRepo(fx.projectDir);
    const {abs} = writeHandoffDoc(fx.projectDir);
    process.env.PRISM_DISABLE_HANDOFF_POINTER = '1';
    let r;
    try { r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs)); }
    finally { delete process.env.PRISM_DISABLE_HANDOFF_POINTER; }
    assert(r.exit === 0 && !existsSync(pointerPathOf(fx.projectDir)), 'off-switch: no pointer written');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── D046 finding #3 (Fix) — broadened regex, near-miss, fixture exclusion ──

await test('pointer hook: a REAL previously-missed handoff slug now gets a pointer (the D046 #3 fix, reproducing the field bug)', async () => {
  const fx = makeFixture('broadened-win');
  try {
    initGitRepo(fx.projectDir);
    // Mirrors an actual file in this repo's own docs/prism/plans/ corpus —
    // the old canonical-only regex (`SESSION-HANDOFF` exactly) missed this
    // shape; reproduced against the live hook before this fix (see report).
    const {abs, rel} = writeHandoffDoc(fx.projectDir, 'docs/prism/plans/2026-06-04-distribution-fixes-handoff.md');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0 && r.stdout.includes('latest-handoff pointer recorded'), `stdout: ${r.stdout}`);
    assert(existsSync(pointerPathOf(fx.projectDir)), 'pointer sidecar written for the non-canonical slug');
    const p = JSON.parse(readFileSync(pointerPathOf(fx.projectDir), 'utf-8'));
    assert(p.path === rel.replace(/\\/g, '/'), `path recorded: ${p.path}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('pointer hook: near-miss — a handoff-shaped basename with NO date prefix gets NO pointer, but a ledger line + stdout note', async () => {
  const fx = makeFixture('near-miss');
  try {
    initGitRepo(fx.projectDir);
    // Mirrors two REAL files in this repo: docs/prism/HANDOFF-5.7.3-... and
    // HANDOFF-5.7.4-...md — version-numbered, predate the YYYY-MM-DD
    // convention, and are NOT caught even by the broadened regex. This is
    // the residual class the near-miss signal exists to surface.
    const rel = 'docs/prism/HANDOFF-5.7.3-dispatch-memory-concurrency.md';
    const abs = join(fx.projectDir, rel);
    writeFileSync(abs, '# some real content\n');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0, `exit ${r.exit}`);
    assert(!existsSync(pointerPathOf(fx.projectDir)), 'no pointer written for a near-miss');
    assert(r.stdout.includes('NOT RECORDED') && r.stdout.includes(basename(abs)), `near-miss stdout note: ${r.stdout}`);
    const lines = readLedgerLines(fx.home);
    assert(lines.length === 1, `exactly one ledger line, got ${lines.length}`);
    assert(lines[0].event === 'handoff_pointer_near_miss', `ledger event: ${JSON.stringify(lines[0])}`);
    assert(lines[0].basename === basename(abs), `ledger basename: ${JSON.stringify(lines[0])}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('pointer hook: near-miss also fires for a handoff-mentioning basename that lacks a date prefix entirely (not-a-handoff.md)', async () => {
  const fx = makeFixture('near-miss-lowercase');
  try {
    initGitRepo(fx.projectDir);
    const rel = 'docs/prism/plans/not-a-handoff.md';
    const abs = join(fx.projectDir, rel);
    writeFileSync(abs, 'x');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0 && !existsSync(pointerPathOf(fx.projectDir)), 'no pointer for this near-miss either');
    assert(r.stdout.includes('NOT RECORDED'), `stdout: ${r.stdout}`);
    const lines = readLedgerLines(fx.home);
    assert(lines.length === 1 && lines[0].event === 'handoff_pointer_near_miss', `ledger: ${JSON.stringify(lines)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('pointer hook: fixture-path exclusion — a COTEST-marked basename is fully silent (no pointer, no ledger, no message)', async () => {
  const fx = makeFixture('fixture-exclusion');
  try {
    initGitRepo(fx.projectDir);
    const rel = 'docs/prism/plans/2026-07-17-COTEST-SESSION-HANDOFF.md';
    const abs = join(fx.projectDir, rel);
    writeFileSync(abs, 'fixture content, not a real handoff');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0 && r.stdout === '', `COTEST fixture must be fully silent, got stdout: ${r.stdout}`);
    assert(!existsSync(pointerPathOf(fx.projectDir)), 'no pointer for a COTEST fixture');
    assert(readLedgerLines(fx.home).length === 0, 'no ledger entry for a COTEST fixture — matches the anti-cry-wolf discipline');
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
    await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
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
    await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
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
    await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
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
    const rr = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
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

// ─── Task #16 fix — near-miss check upstream of DOCS_PRISM_RE path gate ────
// D047 vacuous-signal class: previously, a handoff-shaped file OUTSIDE
// docs/prism/ hit the path gate first and returned 'no' — NOT EVEN a
// near-miss. The near-miss ledger, the safety net for exactly this shape,
// could not see it because it sat downstream of the same gate it was meant
// to audit. This section proves: (a) an out-of-scope handoff-shaped file
// now DOES hit the near-miss ledger; (b) in-scope canonical pointer-write
// behavior is BYTE-IDENTICAL to before this fix (regression guard); (c) the
// out-of-scope file never becomes a pointer-write target — detection only,
// zero blast radius on what PRISM actually tracks or which handoff a
// session resumes.

await test('#16 (a): a handoff-shaped file OUTSIDE docs/prism/ (tasks/HANDOFF_foo.md) now hits the near-miss ledger', async () => {
  const fx = makeFixture('outofscope-nearmiss');
  try {
    initGitRepo(fx.projectDir);
    mkdirSync(join(fx.projectDir, 'tasks'), {recursive: true});
    const rel = 'tasks/HANDOFF_foo.md';
    const abs = join(fx.projectDir, rel);
    writeFileSync(abs, '# a real external-project handoff, not under docs/prism/\n');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0, `exit ${r.exit}`);
    assert(r.stdout.includes('NOT RECORDED') && r.stdout.includes(basename(abs)), `near-miss stdout note expected, got: ${r.stdout}`);
    const lines = readLedgerLines(fx.home);
    assert(lines.length === 1, `exactly one ledger line, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert(lines[0].event === 'handoff_pointer_near_miss', `ledger event: ${JSON.stringify(lines[0])}`);
    assert(lines[0].basename === basename(abs), `ledger basename: ${JSON.stringify(lines[0])}`);
    assert(lines[0].path === abs, `ledger records the full out-of-scope path: ${JSON.stringify(lines[0])}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('#16 (c): the out-of-scope near-miss NEVER becomes a pointer-write target', async () => {
  const fx = makeFixture('outofscope-nopointer');
  try {
    initGitRepo(fx.projectDir);
    mkdirSync(join(fx.projectDir, 'tasks'), {recursive: true});
    const abs = join(fx.projectDir, 'tasks', 'HANDOFF_bar.md');
    writeFileSync(abs, 'x');
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs));
    assert(r.exit === 0, `exit ${r.exit}`);
    assert(!existsSync(pointerPathOf(fx.projectDir)), 'no pointer sidecar written for an out-of-scope file — detection only, zero blast radius on pointer-write behavior');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('#16 (b) REGRESSION GUARD: in-scope canonical pointer-write is BYTE-IDENTICAL to pre-fix behavior', async () => {
  const fx = makeFixture('regression-guard');
  try {
    const sha = initGitRepo(fx.projectDir);
    const {abs, rel} = writeHandoffDoc(fx.projectDir);
    const r = await pointerRunSandboxed(fx, writePayload(fx.projectDir, abs, 'sess-regression'));
    assert(r.exit === 0 && r.stdout.includes('latest-handoff pointer recorded'), `stdout: ${r.stdout}`);
    const p = JSON.parse(readFileSync(pointerPathOf(fx.projectDir), 'utf-8'));
    // Same fields, same values as pre-fix (mirrors test 1 above): project-
    // relative path, real HEAD sha, carried session_id, stamped ts. Also
    // asserts no new/removed fields snuck into the pointer shape.
    assert(p.path === rel.replace(/\\/g, '/'), `path unchanged: ${p.path}`);
    assert(p.git_sha === sha, `git_sha unchanged: ${p.git_sha}`);
    assert(p.session_id === 'sess-regression', `session_id unchanged: ${p.session_id}`);
    assert(typeof p.ts === 'string' && p.ts.length > 0, 'ts still stamped');
    assert(Object.keys(p).sort().join(',') === 'git_sha,path,session_id,ts', `pointer shape unchanged (no new/removed fields): ${Object.keys(p).sort().join(',')}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
