#!/usr/bin/env node
// C9 (recall-hardening v6.2.0) — hooks/prism-session-start.mjs TASK-RECALL (C6).
//
// Given a project-local pointer (<cwd>/.claude/.prism-open-tasks.json, the
// exact payload shape SessionEnd's C5 snapshot writes), asserts SessionStart
// injects a `<TASK-RECALL priority=high>` additionalContext block containing
// the re-hydrate-via-TaskCreate directive and one line per open task, and
// that PRISM_DISABLE_TASK_RECALL=1 suppresses it.
//
// Module does NOT export run() — pure top-level script. Subprocess harness,
// matching tests/v3/hooks/test-session-start-async-audit.mjs's pattern. The
// hook reads its OWN project root via process.cwd() (not the JSON `cwd`
// field), so the child process's cwd exec-option is what actually matters —
// verified against hooks/prism-session-start.mjs's turn-state-counter block
// (`const cwd = process.cwd();`).

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync} from 'node:fs';
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
// (close to) only the TASK-RECALL block under test — reduces test fragility
// against unrelated notices, without needing those features present at all.
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

const OPEN_TASKS_PAYLOAD = {
  session_id: 'prior-session-abc123',
  project: 'placeholder', // overwritten per-fixture with the real project dir
  ts: '2026-07-13T08:00:05.000Z',
  open_tasks: [
    {
      id: '1',
      subject: 'Add rate limiting to API endpoints',
      description:
        'Create backend/middleware/rateLimiter.js exporting a token-bucket ' +
        'limiter keyed by req.ip (100 req/min, burst 20). Acceptance: 101st ' +
        'request within 60s from the same IP returns HTTP 429.',
      activeForm: 'Implementing rate limiting',
      status: 'in_progress',
      blockedBy: null,
    },
    {
      id: '3',
      subject: 'Document the rate limiter in README',
      description: 'Add a "Rate limiting" section to README.md covering the ' +
        'default limits and how to override them via env vars.',
      activeForm: 'Documenting rate limiter',
      status: 'pending',
      blockedBy: ['1'],
    },
  ],
};

function makeFixture(label) {
  const home = mkdtempSync(join(tmpdir(), `ss-recall-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ss-recall-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  return {home, projectDir};
}

function writePointer(projectDir, payload) {
  writeFileSync(
    join(projectDir, '.claude', '.prism-open-tasks.json'),
    JSON.stringify({...payload, project: projectDir}, null, 2)
  );
}

function runHook({home, projectDir}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'current-session', cwd: projectDir});
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    cwd: projectDir, // the hook reads process.cwd(), not the JSON field — must match
    env: {...process.env, HOME: home, USERPROFILE: home, ...QUIET_ENV, ...extraEnv},
  });
}

function additionalContextOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return ''; }
  return (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

// ─── 1. TASK-RECALL block is emitted with the re-hydrate directive ─────────

await test('pointer with open tasks -> <TASK-RECALL priority=high> block with re-hydrate directive + all tasks listed', () => {
  const fx = makeFixture('emit');
  try {
    writePointer(fx.projectDir, OPEN_TASKS_PAYLOAD);
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = additionalContextOf(r);
    assert(ctx.includes('<TASK-RECALL priority=high>'), `additionalContext missing TASK-RECALL open tag. Got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('</TASK-RECALL>'), 'additionalContext missing TASK-RECALL close tag');
    assert(ctx.includes('2 open task(s)'), `expected "2 open task(s)" count, got: ${ctx.slice(0, 300)}`);
    assert(ctx.includes('2026-07-13T08:00:05.000Z'), 'includes the carried-over ts');
    assert(ctx.includes('re-hydrate via TaskCreate'), 'includes the re-hydrate-via-TaskCreate directive');
    assert(ctx.includes('preserving each FULL description'), 'includes the full-description-preservation directive');
    assert(ctx.includes('reconcile against current repo state'), 'includes the reconcile-against-repo directive');

    // Every task rendered as "#id [status] subject — description".
    assert(ctx.includes('#1 [in_progress] Add rate limiting to API endpoints — Create backend/middleware/rateLimiter.js'),
      `task #1 line not rendered as expected. Got: ${ctx}`);
    assert(ctx.includes('#3 [pending] Document the rate limiter in README — Add a "Rate limiting" section'),
      `task #3 line not rendered as expected. Got: ${ctx}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 2. Off-switch ──────────────────────────────────────────────────────────

await test('PRISM_DISABLE_TASK_RECALL=1 suppresses the TASK-RECALL block', () => {
  const fx = makeFixture('offswitch');
  try {
    writePointer(fx.projectDir, OPEN_TASKS_PAYLOAD);
    const r = runHook(fx, {PRISM_DISABLE_TASK_RECALL: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = additionalContextOf(r);
    assert(!ctx.includes('TASK-RECALL'), `TASK-RECALL must not appear when disabled. Got: ${ctx.slice(0, 300)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 3. No pointer file -> no block, no crash ──────────────────────────────

await test('no pointer file present -> no TASK-RECALL block, hook still exits 0', () => {
  const fx = makeFixture('missing');
  try {
    // Deliberately do NOT write .prism-open-tasks.json.
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(!ctx.includes('TASK-RECALL'), 'no TASK-RECALL block when the pointer file is absent');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 4. Empty open_tasks array -> no block ─────────────────────────────────

await test('pointer present but open_tasks is empty -> no TASK-RECALL block', () => {
  const fx = makeFixture('empty');
  try {
    writePointer(fx.projectDir, {...OPEN_TASKS_PAYLOAD, open_tasks: []});
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(!ctx.includes('TASK-RECALL'), 'no TASK-RECALL block when open_tasks is empty');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ─── 5. Malformed pointer JSON -> fail-open, no crash ──────────────────────

await test('malformed pointer JSON -> fail-open (no crash, no TASK-RECALL, exit 0)', () => {
  const fx = makeFixture('malformed');
  try {
    writeFileSync(join(fx.projectDir, '.claude', '.prism-open-tasks.json'), '{ this is not valid json');
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(!ctx.includes('TASK-RECALL'), 'no TASK-RECALL block from malformed pointer JSON');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
