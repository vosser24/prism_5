#!/usr/bin/env node
// RED→GREEN test for hooks/prism-panel-name-guard.mjs (F1 mechanical layer,
// D062). Drives run() directly against a temp HOME so the sentinel-file seam
// matches the sibling harness (tests/v3/state/test-panel-seat-sourcing-inject.mjs):
// HOME/USERPROFILE are pointed at a mkdtemp dir BEFORE importing the guard
// module, since prism-home.mjs's prismHome() re-reads env at call time (not
// captured at module load) — this lets each test flip the sentinel file
// between assertions without re-importing.
//
// Assertions:
//   1. FIRES  — summon_panel:true + Agent input WITH name        → advisory + routing record
//   2. QUIET  — summon_panel:true + Agent input WITHOUT name     → no advisory
//   3. QUIET  — summon_panel:false + name present                → no advisory
//   4. QUIET  — PRISM_DISABLE_PANEL_NAME_GUARD=1                 → no advisory
//   5. FAIL-OPEN — no sentinel file at all                       → exit 0, no throw

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-panel-name-guard.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-panel-name-guard-home-'));
const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE;
const prevDisable = process.env.PRISM_DISABLE_PANEL_NAME_GUARD;

function sentinelPath(sessionId) {
  return join(HOME, '.claude', `.prism-turn-tier-${sessionId}.json`);
}

function writeSentinel(sessionId, obj) {
  const p = sentinelPath(sessionId);
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, JSON.stringify(obj));
}

function routingLogPath() {
  return join(HOME, '.claude', '.prism-routing.jsonl');
}

function routingLogHasEvent(event, sessionId) {
  const p = routingLogPath();
  if (!existsSync(p)) return false;
  const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
  return lines.some((l) => {
    try {
      const rec = JSON.parse(l);
      return rec.event === event && rec.session_id === sessionId;
    } catch { return false; }
  });
}

function extractContext(res) {
  if (!res || !res.stdout) return '';
  try {
    const json = JSON.parse(res.stdout);
    return (json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || '';
  } catch { return ''; }
}

try {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.PRISM_DISABLE_PANEL_NAME_GUARD;

  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.run === 'function', 'guard must export run');

  await test('FIRES: summon_panel:true + name present -> advisory + routing record', async () => {
    const sessionId = 's-fires';
    writeSentinel(sessionId, {tier: 'opus', summon_panel: true});
    const res = await mod.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'general-purpose', name: 'seat-alpha', prompt: 'be the security expert'},
    });
    assert(res.exit === 0, 'must never block (exit 0)');
    const ctx = extractContext(res);
    assert(/PRISM PANEL NAME-GUARD/.test(ctx), 'must emit the D062 advisory');
    assert(/D062/.test(ctx), 'must cite D062');
    assert(ctx.includes("name:'seat-alpha'"), 'must name the offending name: value');
    assert(/idle_notification/.test(ctx), 'must explain the payload-free idle_notification mechanism');
    assert(routingLogHasEvent('panel_name_guard', sessionId), 'must append a panel_name_guard routing-log record');
  });

  await test('QUIET: summon_panel:true + Agent input WITHOUT name -> no advisory', async () => {
    const sessionId = 's-no-name';
    writeSentinel(sessionId, {tier: 'opus', summon_panel: true});
    const res = await mod.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'general-purpose', prompt: 'be the security expert'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'must NOT emit any advisory when name is absent');
    assert(!routingLogHasEvent('panel_name_guard', sessionId), 'must NOT log when name is absent');
  });

  await test('QUIET: summon_panel:false + name present -> no advisory', async () => {
    const sessionId = 's-no-panel';
    writeSentinel(sessionId, {tier: 'sonnet', summon_panel: false});
    const res = await mod.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'general-purpose', name: 'worker-1', prompt: 'fix the typo'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'must NOT emit any advisory on a non-panel turn');
    assert(!routingLogHasEvent('panel_name_guard', sessionId), 'must NOT log on a non-panel turn');
  });

  await test('QUIET: PRISM_DISABLE_PANEL_NAME_GUARD=1 -> no advisory even when it would otherwise fire', async () => {
    const sessionId = 's-disabled';
    writeSentinel(sessionId, {tier: 'opus', summon_panel: true});
    process.env.PRISM_DISABLE_PANEL_NAME_GUARD = '1';
    try {
      const res = await mod.run({
        tool_name: 'Agent',
        session_id: sessionId,
        tool_input: {subagent_type: 'general-purpose', name: 'seat-beta', prompt: 'be the performance expert'},
      });
      assert(res.exit === 0, 'exit 0');
      assert(extractContext(res) === '', 'must NOT emit any advisory while disabled');
      assert(!routingLogHasEvent('panel_name_guard', sessionId), 'must NOT log while disabled');
    } finally {
      delete process.env.PRISM_DISABLE_PANEL_NAME_GUARD;
    }
  });

  await test('FAIL-OPEN: no sentinel file at all -> exit 0, no throw', async () => {
    const sessionId = 's-no-sentinel-' + Math.random().toString(36).slice(2);
    // Deliberately do NOT write a sentinel file for this session_id.
    let res;
    let threw = false;
    try {
      res = await mod.run({
        tool_name: 'Agent',
        session_id: sessionId,
        tool_input: {subagent_type: 'general-purpose', name: 'seat-gamma', prompt: 'be the cost expert'},
      });
    } catch {
      threw = true;
    }
    assert(!threw, 'must never throw when the sentinel is missing');
    assert(res && res.exit === 0, 'exit 0 fail-open');
    assert(extractContext(res) === '', 'must NOT emit any advisory when there is no sentinel');
  });

  await test('QUIET: non-Agent tool_name -> pass-through untouched', async () => {
    const res = await mod.run({tool_name: 'Bash', session_id: 's-bash', tool_input: {command: 'ls'}});
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'must not emit anything for a non-Agent tool');
  });
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  if (prevDisable === undefined) delete process.env.PRISM_DISABLE_PANEL_NAME_GUARD; else process.env.PRISM_DISABLE_PANEL_NAME_GUARD = prevDisable;
  rmSync(HOME, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
