#!/usr/bin/env node
// Regression: the hook turn-counter must NOT clobber the bootstrap state file.
// Run: node tests/v3/state/test-prism-turn-state-collision.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// UAT finding (v5.1.x): prism-session-start.mjs full-overwrote project-local
// `.claude/.prism-state.json` with `{turns:0, session_start}` on every session
// start, and prism-hook.mjs incremented `turns`/`recent_suggestions` in that
// same file — clobbering the BOOTSTRAP state machine (schema_version, phases,
// project_slug, …) that tools/lib/prism-state.mjs owns. That broke
// /prism-deep-dive --refresh, /prism-sync, /prism-doctor across session
// restarts. The turn-counter now lives in a dedicated `.prism-turn-state.json`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const SESSION_START = join(REPO, 'hooks', 'prism-session-start.mjs');
const HOOK = join(REPO, 'hooks', 'prism-hook.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

// A realistic bootstrap state file (the schema tools/lib/prism-state.mjs owns).
function seedBootstrapState(projDir) {
  const claude = join(projDir, '.claude');
  mkdirSync(claude, { recursive: true });
  const state = {
    schema_version: 2,
    prism_version: '5.1.2',
    project_name: 'test-collision',
    initialized_at: '2026-06-03T00:00:00.000Z',
    last_run: '2026-06-03T00:00:00.000Z',
    last_sync_at: null,
    next_sync_recommended: null,
    phases: { 'project-master': { completed_at: '2026-06-03T00:00:00.000Z', meta: { slug: 'test-collision' } } },
    last_command: null,
    phase_failures: [],
    checksum: null,
  };
  writeFileSync(join(claude, '.prism-state.json'), JSON.stringify(state, null, 2));
  return join(claude, '.prism-state.json');
}

function makeHomes() {
  const home = mkdtempSync(join(tmpdir(), 'prism-coll-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'prism-coll-proj-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return { home, proj };
}

test('session-start does NOT clobber the bootstrap .prism-state.json', () => {
  const { home, proj } = makeHomes();
  try {
    const statePath = seedBootstrapState(proj);
    const r = spawnSync(process.execPath, [SESSION_START], {
      cwd: proj, encoding: 'utf-8', input: JSON.stringify({ cwd: proj }),
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 12000,
    });
    assert(r.status === 0, `session-start exit ${r.status}: ${r.stderr}`);
    const after = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert(after.schema_version === 2, 'bootstrap state was clobbered (schema_version lost)');
    assert(after.project_name === 'test-collision', 'bootstrap state was clobbered (project_name lost)');
    assert(after.phases && after.phases['project-master'], 'bootstrap phases lost');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('session-start writes the turn counter to .prism-turn-state.json', () => {
  const { home, proj } = makeHomes();
  try {
    seedBootstrapState(proj);
    const r = spawnSync(process.execPath, [SESSION_START], {
      cwd: proj, encoding: 'utf-8', input: JSON.stringify({ cwd: proj }),
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 12000,
    });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    const turnPath = join(proj, '.claude', '.prism-turn-state.json');
    assert(existsSync(turnPath), '.prism-turn-state.json not created by session-start');
    const t = JSON.parse(readFileSync(turnPath, 'utf-8'));
    assert(typeof t.turns === 'number', 'turn-state missing turns');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('prism-hook (UserPromptSubmit) does NOT clobber bootstrap state, writes turn-state', () => {
  const { home, proj } = makeHomes();
  try {
    const statePath = seedBootstrapState(proj);
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: proj, encoding: 'utf-8',
      input: JSON.stringify({ prompt: 'hello there', session_id: 'coll-test-1' }),
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 12000,
    });
    assert(r.status === 0, `hook exit ${r.status}: ${r.stderr}`);
    const after = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert(after.schema_version === 2, 'bootstrap state clobbered by prism-hook (schema_version lost)');
    assert(after.project_name === 'test-collision', 'bootstrap state clobbered by prism-hook');
    assert(!('turns' in after), 'prism-hook polluted bootstrap state with a turns field');
    const turnPath = join(proj, '.claude', '.prism-turn-state.json');
    assert(existsSync(turnPath), '.prism-turn-state.json not created by prism-hook');
    const t = JSON.parse(readFileSync(turnPath, 'utf-8'));
    assert(t.turns >= 1, 'turn-state turns not incremented');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

// ── v5.3.1: standing parallel-batch reminder in SessionStart context ──────────
test('session-start emits the standing parallel-batch reminder by default', () => {
  const { home, proj } = makeHomes();
  try {
    const r = spawnSync(process.execPath, [SESSION_START], {
      cwd: proj, encoding: 'utf-8', input: JSON.stringify({ cwd: proj }),
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 12000,
    });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    let ctx = ''; try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
    assert(/dispatch them as MULTIPLE Agent/.test(ctx), 'parallel-batch reminder missing from default SessionStart context');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('PRISM_DISABLE_PARALLEL_REMINDER=1 suppresses the standing reminder', () => {
  const { home, proj } = makeHomes();
  try {
    const r = spawnSync(process.execPath, [SESSION_START], {
      cwd: proj, encoding: 'utf-8', input: JSON.stringify({ cwd: proj }),
      env: { ...process.env, HOME: home, USERPROFILE: home, PRISM_DISABLE_PARALLEL_REMINDER: '1' }, timeout: 12000,
    });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    let ctx = ''; try { ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
    assert(!/dispatch them as MULTIPLE Agent/.test(ctx || ''), 'reminder should be suppressed by PRISM_DISABLE_PARALLEL_REMINDER=1');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

process.stdout.write(`tests passed: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
