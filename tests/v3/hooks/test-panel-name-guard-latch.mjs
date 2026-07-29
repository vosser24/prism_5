#!/usr/bin/env node
// F7 Phase 1 — panel-active LATCH regression test.
//
// Reproduces the exact production gap: a self-chaired panel summons on turn N
// (sentinel summon_panel:true), but the master dispatches its named seats on
// the POST-APPROVAL turn N+1 where the sentinel has reset to summon_panel:false
// (the 06:53 opus/summon=false → 06:55 named software-architecture-expert
// dispatch observed 2026-07-24). Before the fix the name-guard read
// summon_panel:false and silently no-op'd — `panel_name_guard` never fired in
// prod. The latch (hooks/lib/prism-panel-latch.mjs) makes it fire on turn N+1.
//
// Assertions:
//   A. FIRES     — latch live + sentinel summon_panel:false + name present
//                  (the cross-turn gap) → advisory + routing record trigger=latch
//   B. QUIET     — latch live + summon_panel:false + NO name → no advisory
//   C. REGRESSION— NO latch + summon_panel:false + name present → no advisory
//                  (genuine non-panel dispatch unaffected)
//   D. QUIET     — latch EXPIRED (until_ts in past) + name present → no advisory
//                  (TTL is the deterministic clear)
//   E. WIRED     — tier-router.run() on an explicit /panel prompt with an active
//                  project-master WRITES the latch file (producer proven, not
//                  just the reader)

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const NAME_GUARD = join(ROOT, 'hooks', 'prism-panel-name-guard.mjs');
const LATCH_LIB = join(ROOT, 'hooks', 'lib', 'prism-panel-latch.mjs');
const TIER_ROUTER = join(ROOT, 'hooks', 'prism-prompt-tier-router.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-panel-latch-home-'));
const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE;
const prevDisable = process.env.PRISM_DISABLE_PANEL_NAME_GUARD;
const prevPanelDisabled = process.env.PRISM_PANEL_DISABLED;
const prevRouter = process.env.PRISM_PROMPT_ROUTER;

function sentinelPath(sessionId) {
  return join(HOME, '.claude', `.prism-turn-tier-${sessionId}.json`);
}
function writeSentinel(sessionId, obj) {
  const p = sentinelPath(sessionId);
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, JSON.stringify(obj));
}
function routingLogPath() { return join(HOME, '.claude', '.prism-routing.jsonl'); }
function routingRecords(event, sessionId) {
  const p = routingLogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.event === event && r.session_id === sessionId);
}
function extractContext(res) {
  if (!res || !res.stdout) return '';
  try { return (JSON.parse(res.stdout).hookSpecificOutput || {}).additionalContext || ''; }
  catch { return ''; }
}

try {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.PRISM_DISABLE_PANEL_NAME_GUARD;
  delete process.env.PRISM_PANEL_DISABLED;
  process.env.PRISM_PROMPT_ROUTER = 'hard';

  const guard = await import(pathToFileURL(NAME_GUARD).href);
  const latch = await import(pathToFileURL(LATCH_LIB).href);
  assert(typeof guard.run === 'function', 'name-guard must export run');
  assert(typeof latch.writePanelLatch === 'function', 'latch lib must export writePanelLatch');

  await test('A FIRES: latch live + summon_panel:false + name -> advisory + trigger=latch', async () => {
    const sessionId = 's-latch-fires';
    // Faithful reproduction: the post-approval turn's sentinel says summon=false.
    writeSentinel(sessionId, {tier: 'opus', summon_panel: false});
    latch.writePanelLatch(sessionId, {active_master: 'master-x'});  // armed on the earlier summon turn
    const res = await guard.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat', prompt: 'be the vertical seat'},
    });
    assert(res.exit === 0, 'never blocks');
    const ctx = extractContext(res);
    assert(/PRISM PANEL NAME-GUARD/.test(ctx), 'emits the D062 advisory across turns');
    assert(ctx.includes("name:'arch-seat'"), 'names the offending name');
    const recs = routingRecords('panel_name_guard', sessionId);
    assert(recs.length === 1, 'logs exactly one panel_name_guard record');
    assert(recs[0].trigger === 'latch', 'records trigger=latch');
  });

  await test('B QUIET: latch live + summon_panel:false + NO name -> no advisory', async () => {
    const sessionId = 's-latch-noname';
    writeSentinel(sessionId, {tier: 'opus', summon_panel: false});
    latch.writePanelLatch(sessionId);
    const res = await guard.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'software-architecture-expert', prompt: 'nameless seat'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'nameless dispatch is the correct pattern -> quiet');
    assert(routingRecords('panel_name_guard', sessionId).length === 0, 'no log when nameless');
  });

  await test('C REGRESSION: no latch + summon_panel:false + name -> no advisory', async () => {
    const sessionId = 's-nolatch';
    writeSentinel(sessionId, {tier: 'sonnet', summon_panel: false});
    // Deliberately NO latch armed for this session.
    const res = await guard.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'general-purpose', name: 'worker-1', prompt: 'fix the typo'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'genuine non-panel named dispatch stays quiet');
    assert(routingRecords('panel_name_guard', sessionId).length === 0, 'no log on non-panel dispatch');
  });

  await test('D QUIET: expired latch + name -> no advisory (TTL is the deterministic clear)', async () => {
    const sessionId = 's-expired';
    writeSentinel(sessionId, {tier: 'opus', summon_panel: false});
    // Write an expired latch directly (until_ts in the past).
    const p = latch.panelLatchPath(sessionId);
    mkdirSync(dirname(p), {recursive: true});
    writeFileSync(p, JSON.stringify({
      session_id: sessionId,
      opened_ts: new Date(Date.now() - 3600_000).toISOString(),
      until_ts: new Date(Date.now() - 60_000).toISOString(),
    }));
    assert(latch.isPanelLatchLive(sessionId) === false, 'expired latch must read as not-live');
    const res = await guard.run({
      tool_name: 'Agent',
      session_id: sessionId,
      tool_input: {subagent_type: 'software-architecture-expert', name: 'arch-seat', prompt: 'late dispatch'},
    });
    assert(res.exit === 0, 'exit 0');
    assert(extractContext(res) === '', 'expired latch -> quiet');
    assert(routingRecords('panel_name_guard', sessionId).length === 0, 'no log once latch expired');
  });

  await test('E WIRED: tier-router writes the latch on an explicit /panel + active master', async () => {
    // Fresh cwd with a project-master so detectActiveMaster() returns master-*.
    const cwd = mkdtempSync(join(tmpdir(), 'prism-latch-cwd-'));
    mkdirSync(join(cwd, '.claude'), {recursive: true});
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({agent: 'master-testproj'}));

    const router = await import(pathToFileURL(TIER_ROUTER).href);
    assert(typeof router.run === 'function', 'tier-router must export run');
    const sessionId = 's-router-wire';
    const res = await router.run({
      prompt: '/panel should we raise the ingest throughput ceiling',
      session_id: sessionId,
      cwd,
    });
    assert(res.exit === 0, 'router exit 0');
    // Sentinel must reflect an opus panel-summon turn (precondition for the latch).
    const sent = JSON.parse(readFileSync(sentinelPath(sessionId), 'utf-8'));
    assert(sent.tier === 'opus', `expected opus tier, got ${sent.tier}`);
    assert(sent.summon_panel === true, 'expected summon_panel:true on /panel turn');
    assert(sent.self_chair === true, 'expected self_chair on active-master panel turn');
    // The latch file must now exist and be live.
    assert(existsSync(latch.panelLatchPath(sessionId)), 'tier-router must WRITE the latch file');
    assert(latch.isPanelLatchLive(sessionId) === true, 'written latch must be live');
    rmSync(cwd, {recursive: true, force: true});
  });
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  if (prevDisable === undefined) delete process.env.PRISM_DISABLE_PANEL_NAME_GUARD; else process.env.PRISM_DISABLE_PANEL_NAME_GUARD = prevDisable;
  if (prevPanelDisabled === undefined) delete process.env.PRISM_PANEL_DISABLED; else process.env.PRISM_PANEL_DISABLED = prevPanelDisabled;
  if (prevRouter === undefined) delete process.env.PRISM_PROMPT_ROUTER; else process.env.PRISM_PROMPT_ROUTER = prevRouter;
  rmSync(HOME, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
