#!/usr/bin/env node
// Slice 5 (Fix A, panel-53 E1/F1 + E2 size cap) — hooks/prism-session-start.mjs
// TASK-RECALL integrity line + injection size cap.
//
// D042 fire/not-fire pairs over committed pointer fixtures (fixtures/):
//   FIRE  prism-open-tasks-degraded.json  -> "parsed 0/3 structurally" line
//   FIRE  prism-open-tasks-tailtrunc.json -> ", tail truncated" line
//   FIRE  prism-open-tasks-carried.json   -> "(1 carried from prior sessions)" line
//   QUIET prism-open-tasks-healthy.json   -> NO integrity line (self-clearing)
// Size cap (E2 pre-ship gate):
//   prism-open-tasks-longdesc.json -> 5000-char description truncated at the
//     PRISM_TASK_RECALL_DESC_MAXCHARS default (1000) with a loud TaskGet marker;
//     the description tail sentinel must NOT be injected.
//   prism-open-tasks-many.json -> 10 tasks x 2000-char descriptions inject a
//     BOUNDED block: count cap ("+7 more ... call TaskList") + char cap keep
//     total additionalContext under 6000 chars.
//
// Subprocess harness matching tests/v3/hooks/test-session-start-task-recall.mjs.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-start.mjs');
const FIXTURES = join(__dirname, 'fixtures');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

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
  const home = mkdtempSync(join(tmpdir(), `ss-integ-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `ss-integ-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  return {home, projectDir};
}

function writePointerFromFixture(projectDir, fixtureName) {
  const payload = JSON.parse(readFileSync(join(FIXTURES, fixtureName), 'utf-8'));
  writeFileSync(
    join(projectDir, '.claude', '.prism-open-tasks.json'),
    JSON.stringify({...payload, project: projectDir}, null, 2)
  );
  return payload;
}

function runHook({home, projectDir}, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'current-session', cwd: projectDir});
  return spawnSync(process.execPath, [HOOK], {
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

function runFixture(label, fixtureName, extraEnv = {}) {
  const fx = makeFixture(label);
  try {
    writePointerFromFixture(fx.projectDir, fixtureName);
    const r = runHook(fx, extraEnv);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    return additionalContextOf(r);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
}

// ─── 1. FIRE: degraded pointer -> integrity line with parse counts ──────────

await test('degraded pointer -> integrity line "2 open (0 carried ...); parsed 0/3 structurally — ... run TaskList."', () => {
  const ctx = runFixture('degraded', 'prism-open-tasks-degraded.json');
  assert(ctx.includes('<TASK-RECALL priority=high>'), 'TASK-RECALL block present');
  assert(ctx.includes('TASK-RECALL: 2 open (0 carried from prior sessions); parsed 0/3 structurally — if this looks wrong, run TaskList.'),
    `integrity line with counts expected. Got: ${ctx.slice(0, 1200)}`);
});

// ─── 2. FIRE: tail-truncated pointer -> integrity line mentions truncation ──

await test('tail-truncated pointer -> integrity line includes ", tail truncated"', () => {
  const ctx = runFixture('tailtrunc', 'prism-open-tasks-tailtrunc.json');
  assert(ctx.includes('TASK-RECALL: 1 open (0 carried from prior sessions); parsed 2/2 structurally, tail truncated — if this looks wrong, run TaskList.'),
    `tail-truncated integrity line expected. Got: ${ctx.slice(0, 1200)}`);
});

// ─── 3. FIRE: carried_from tasks -> integrity line with carried count ───────

await test('carried_from pointer -> integrity line "2 open (1 carried from prior sessions)"', () => {
  const ctx = runFixture('carried', 'prism-open-tasks-carried.json');
  assert(ctx.includes('TASK-RECALL: 2 open (1 carried from prior sessions); parsed 3/3 structurally — if this looks wrong, run TaskList.'),
    `carried-count integrity line expected. Got: ${ctx.slice(0, 1200)}`);
});

// ─── 4. QUIET: healthy pointer -> NO integrity line (self-clearing) ─────────

await test('healthy pointer -> TASK-RECALL block present but NO integrity line', () => {
  const ctx = runFixture('healthy', 'prism-open-tasks-healthy.json');
  assert(ctx.includes('<TASK-RECALL priority=high>'), 'TASK-RECALL block still present');
  assert(!ctx.includes('if this looks wrong'), `integrity line must self-clear on a healthy pointer. Got: ${ctx.slice(0, 1200)}`);
});

// ─── 5. SIZE CAP: long description truncated LOUDLY at the default cap ──────

await test('5000-char description -> truncated at 1000 chars with "run TaskGet #1" marker; tail sentinel absent', () => {
  const ctx = runFixture('longdesc', 'prism-open-tasks-longdesc.json');
  assert(ctx.includes('#1 [in_progress] Huge task — START-'), 'task line present with description head');
  assert(ctx.includes('[truncated 4000 more chars — run TaskGet #1 for the full description]'),
    `loud truncation marker expected. Got: ${ctx.slice(0, 1600)}`);
  assert(!ctx.includes('-ZZZEND'), 'the description tail must NOT be injected');
});

// ─── 6. SIZE CAP: many-task payload injects a bounded string ────────────────

await test('10 tasks x 2000-char descriptions -> "+7 more" pointer line and total additionalContext < 6000 chars', () => {
  const ctx = runFixture('many', 'prism-open-tasks-many.json');
  assert(ctx.includes('+7 more open tasks — call TaskList'), `count-cap pointer line expected. Got: ${ctx.slice(0, 800)}`);
  assert(ctx.includes('run TaskGet #'), 'char-cap truncation marker present on shown tasks');
  assert(ctx.length < 6000, `total injection bounded: expected < 6000 chars, got ${ctx.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
