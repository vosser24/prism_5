#!/usr/bin/env node
// PAYLOAD-CUT-001 (2026-07-14 session-start payload audit,
// docs/prism/2026-07-14-session-start-payload-audit.md) — hooks/prism-
// session-start.mjs. Two independent cuts, both asserted here:
//
//   1. CAPABILITY CATALOG dedup: the "Skills" + "Plugin skills" subsections
//      (near-verbatim duplicate of the native skill listing) are dropped by
//      default; "Agents" + "Tools" (genuinely unique) are kept intact.
//      Kill-switch PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP=1 restores the
//      full pre-cut catalog.
//   2. TASK-RECALL count cap: full-fidelity descriptions capped at N
//      (default 3, override PRISM_TASK_RECALL_MAX), in_progress-first-then-
//      most-recent selection, in_progress tasks NEVER deferred, deferred
//      count NEVER silent (a "+N more open task(s) — call TaskList" line).
//
// Subprocess-only harness, matching the sibling hook tests in this dir.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, copyFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const HOOK = join(HOOKS, 'prism-session-start.mjs');
const CATALOG_LIB_SRC = join(HOOKS, 'lib', 'prism-capability-catalog.mjs');

// The hook resolves the catalog lib relative to the (fake) HOME the test
// gives it — join(H, '.claude', 'hooks', 'lib', 'prism-capability-catalog.mjs')
// — NOT relative to this repo. Catalog-related fixtures must copy the real
// lib in, or the dynamic import silently fails (.catch(() => null)) and the
// whole catalog block becomes a silent no-op.
function installCatalogLib(home) {
  const dir = join(home, '.claude', 'hooks', 'lib');
  mkdirSync(dir, {recursive: true});
  copyFileSync(CATALOG_LIB_SRC, join(dir, 'prism-capability-catalog.mjs'));
}

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
  const home = mkdtempSync(join(tmpdir(), `pc-ss-home-${label}-`));
  const projectDir = mkdtempSync(join(tmpdir(), `pc-ss-proj-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(projectDir, '.claude'), {recursive: true});
  return {home, projectDir};
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. TASK-RECALL count cap
// ═══════════════════════════════════════════════════════════════════════════

function writeOpenTasks(projectDir, tasks) {
  writeFileSync(join(projectDir, '.claude', '.prism-open-tasks.json'), JSON.stringify({
    session_id: 'prior-session', project: projectDir, ts: '2026-07-13T08:00:05.000Z',
    open_tasks: tasks,
  }, null, 2));
}

function mkTask(id, status, extra = {}) {
  return {id: String(id), subject: `Task ${id} subject`, description: `FULL description body for task ${id}.`,
    activeForm: `Working on task ${id}`, status, blockedBy: null, ...extra};
}

await test('default cap (3): 2 in_progress + 4 pending -> in_progress kept whole, top-1 most-recent pending kept, 3 deferred', () => {
  const fx = makeFixture('cap-default');
  try {
    // ids 1,2 in_progress; 3,4,5,6 pending. Most-recent-by-id pending = 6.
    writeOpenTasks(fx.projectDir, [
      mkTask(1, 'in_progress'), mkTask(2, 'in_progress'),
      mkTask(3, 'pending'), mkTask(4, 'pending'), mkTask(5, 'pending'), mkTask(6, 'pending'),
    ]);
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);

    assert(ctx.includes('6 open task(s) carried over'), `header count wrong. Got: ${ctx.slice(0, 200)}`);
    assert(ctx.includes('#1 [in_progress] Task 1 subject — FULL description body for task 1.'), 'in_progress task 1 shown in full');
    assert(ctx.includes('#2 [in_progress] Task 2 subject — FULL description body for task 2.'), 'in_progress task 2 shown in full');
    assert(ctx.includes('#6 [pending] Task 6 subject — FULL description body for task 6.'), 'most-recent pending (id 6) shown in full');
    assert(!ctx.includes('#3 [pending]'), 'task 3 (oldest deferred pending) must NOT appear in full');
    assert(!ctx.includes('#4 [pending]'), 'task 4 must NOT appear in full');
    assert(!ctx.includes('#5 [pending]'), 'task 5 must NOT appear in full');
    assert(ctx.includes('+3 more open tasks — call TaskList'), `expected deferred-count pointer line. Got: ${ctx.slice(0, 600)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('hard invariant: in_progress tasks are NEVER deferred, even when they outnumber the cap', () => {
  const fx = makeFixture('cap-overflow');
  try {
    // 4 in_progress (exceeds default cap of 3) + 2 pending.
    writeOpenTasks(fx.projectDir, [
      mkTask(1, 'in_progress'), mkTask(2, 'in_progress'), mkTask(3, 'in_progress'), mkTask(4, 'in_progress'),
      mkTask(5, 'pending'), mkTask(6, 'pending'),
    ]);
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);

    for (const id of [1, 2, 3, 4]) {
      assert(ctx.includes(`#${id} [in_progress] Task ${id} subject — FULL description body for task ${id}.`),
        `in_progress task #${id} must be shown in full even though there are 4 (cap is 3). Got: ${ctx.slice(0, 800)}`);
    }
    assert(!ctx.includes('#5 [pending]'), 'pending task 5 correctly deferred (never an in_progress task)');
    assert(!ctx.includes('#6 [pending]'), 'pending task 6 correctly deferred (never an in_progress task)');
    assert(ctx.includes('+2 more open tasks — call TaskList'), `expected 2 deferred (the 2 pending tasks). Got: ${ctx.slice(0, 800)}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('PRISM_TASK_RECALL_MAX override widens the cap; singular "task" wording for exactly 1 deferred', () => {
  const fx = makeFixture('cap-override');
  try {
    writeOpenTasks(fx.projectDir, [
      mkTask(1, 'in_progress'), mkTask(2, 'in_progress'),
      mkTask(3, 'pending'), mkTask(4, 'pending'), mkTask(5, 'pending'), mkTask(6, 'pending'),
    ]);
    const r = runHook(fx, {PRISM_TASK_RECALL_MAX: '5'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    // remainingSlots = 5 - 2in_progress = 3 -> pending 6,5,4 kept whole, 3 deferred.
    for (const id of [1, 2, 4, 5, 6]) {
      assert(ctx.includes(`#${id} [`), `task #${id} expected in full set with MAX=5. Got: ${ctx.slice(0, 800)}`);
    }
    assert(!ctx.includes('#3 [pending]'), 'task 3 (lowest-id pending) is the sole deferred task');
    assert(ctx.includes('+1 more open task — call TaskList'), `expected singular wording for exactly 1 deferred. Got: ${ctx.slice(0, 800)}`);
    assert(!ctx.includes('+1 more open tasks —'), 'must not use plural wording for exactly 1 deferred');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('no capping needed (task count <= cap): no pointer line, original "Recall ALL of them" wording preserved', () => {
  const fx = makeFixture('cap-noop');
  try {
    writeOpenTasks(fx.projectDir, [mkTask(1, 'in_progress'), mkTask(2, 'pending')]);
    const r = runHook(fx);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);
    assert(ctx.includes('Recall ALL of them: re-hydrate via TaskCreate'), `unchanged wording expected when nothing is deferred. Got: ${ctx.slice(0, 400)}`);
    assert(!ctx.includes('call TaskList'), 'no deferred-pointer line when everything fits under the cap');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CAPABILITY CATALOG dedup
// ═══════════════════════════════════════════════════════════════════════════

const CATALOG_ROSTER = {
  agents: {
    'unique-agent-alpha': {description: 'A PRISM-specific agent not present in any native listing.', status: 'available'},
  },
  skills: {
    'prism-native-skill': {description: 'A PRISM-native skill, duplicated by the native skill listing.', source: 'prism'},
    'plugin-dup-skill': {description: 'A plugin skill, duplicated by the native skill listing.', source: 'plugin:somepack'},
  },
  tools: {
    'unique-tool-beta': {domains: ['external-cli'], install_status: 'installed', tier: '1'},
  },
};

function writeRoster(home, roster) {
  const dir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'roster.json'), JSON.stringify(roster, null, 2));
}

await test('default: catalog keeps Agents + Tools (unique), drops Skills + Plugin skills (duplicate of native listing)', () => {
  const fx = makeFixture('catalog-default');
  try {
    installCatalogLib(fx.home);
    writeRoster(fx.home, CATALOG_ROSTER);
    // catalog must fire: unset the QUIET_ENV suppression for it specifically.
    const r = runHook(fx, {PRISM_DISABLE_CAPABILITY_CATALOG: '0'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);

    assert(ctx.includes('## Agents'), `Agents section must be present. Got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('- unique-agent-alpha — A PRISM-specific agent not present in any native listing.'),
      `unique agent content must be intact. Got: ${ctx.slice(0, 800)}`);
    assert(ctx.includes('## Tools'), `Tools section must be present. Got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('- unique-tool-beta —'), `unique tool content must be intact. Got: ${ctx.slice(0, 800)}`);

    assert(!ctx.includes('## Skills'), `Skills section must be DROPPED by default. Got: ${ctx.slice(0, 800)}`);
    assert(!ctx.includes('## Plugin skills'), `Plugin skills section must be DROPPED by default. Got: ${ctx.slice(0, 800)}`);
    assert(!ctx.includes('prism-native-skill'), 'duplicate skill content must not leak into the payload');
    assert(!ctx.includes('plugin-dup-skill'), 'duplicate plugin-skill content must not leak into the payload');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('kill-switch PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP=1 restores the full pre-cut catalog', () => {
  const fx = makeFixture('catalog-killswitch');
  try {
    installCatalogLib(fx.home);
    writeRoster(fx.home, CATALOG_ROSTER);
    const r = runHook(fx, {PRISM_DISABLE_CAPABILITY_CATALOG: '0', PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);
    const ctx = additionalContextOf(r);

    assert(ctx.includes('## Agents'), 'Agents section still present under kill-switch');
    assert(ctx.includes('## Tools'), 'Tools section still present under kill-switch');
    assert(ctx.includes('## Skills'), `kill-switch must restore Skills section. Got: ${ctx.slice(0, 800)}`);
    assert(ctx.includes('## Plugin skills'), `kill-switch must restore Plugin skills section. Got: ${ctx.slice(0, 800)}`);
    assert(ctx.includes('prism-native-skill'), 'kill-switch must restore skill content');
    assert(ctx.includes('plugin-dup-skill'), 'kill-switch must restore plugin-skill content');
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

await test('catalog cut measurably shrinks the emitted payload for a skills-heavy roster', () => {
  const fx = makeFixture('catalog-shrink');
  try {
    installCatalogLib(fx.home);
    // A roster with many skills but few agents/tools — mirrors the real
    // audit's finding (skills dominate catalog bytes).
    const bigRoster = {agents: CATALOG_ROSTER.agents, tools: CATALOG_ROSTER.tools, skills: {}};
    for (let i = 0; i < 40; i++) {
      bigRoster.skills[`plugin-skill-${i}`] = {
        description: 'A moderately long plugin skill description that repeats across many entries. '.repeat(2),
        source: 'plugin:pack',
      };
    }
    writeRoster(fx.home, bigRoster);

    const cut = runHook(fx, {PRISM_DISABLE_CAPABILITY_CATALOG: '0'});
    const full = runHook(fx, {PRISM_DISABLE_CAPABILITY_CATALOG: '0', PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP: '1'});
    assert(cut.status === 0 && full.status === 0, 'both runs must exit 0');

    const cutBytes = Buffer.byteLength(additionalContextOf(cut), 'utf-8');
    const fullBytes = Buffer.byteLength(additionalContextOf(full), 'utf-8');
    console.log(`    [bytes] dedup-cut=${cutBytes}B  full=${fullBytes}B  saved=${fullBytes - cutBytes}B`);
    assert(cutBytes < fullBytes, `expected the dedup cut to shrink the payload; cut=${cutBytes} full=${fullBytes}`);
    assert((fullBytes - cutBytes) > 2000, `expected a meaningful (>2000B) reduction for a 40-skill roster; saved=${fullBytes - cutBytes}`);
  } finally {
    rmSync(fx.home, {recursive: true, force: true});
    rmSync(fx.projectDir, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
