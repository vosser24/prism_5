#!/usr/bin/env node
// Task #25 (F18) — self_chair reads the PRE-suppression classification.summon_panel
// instead of the POST-suppression sentinel.summon_panel.
//
// hooks/prism-prompt-tier-router.mjs computes module-level HOME/MODE at
// import time, so this test points HOME/USERPROFILE at a fresh temp dir
// BEFORE dynamically importing the module (same constraint documented in
// tests/v3/prism-task-notification-panel-suppression.test.mjs).
//
// REPRODUCED CONCRETELY (per task #25 instruction) before any fix: driving
// the router with a `<task-notification>` prompt whose body contains explicit
// panel-summoning language, with an active project-master configured, DOES
// set self_chair:true on the persisted sentinel — the mechanism claim in the
// filed finding is TRUE. BUT the claimed CONSEQUENCE ("defeats the D075
// suppression") does NOT materialize on THAT turn: verified that (a) the
// additionalContext advice text does NOT contain "PANEL-SUMMONING", (b)
// hooks/prism-parent-dispatch-guard.mjs's panel gate
// (`isPanelTurn = sentinel.tier === 'opus' && sentinel.summon_panel === true`,
// :530) evaluates false and never even inspects self_chair for this turn, and
// (c) the panel-latch arm at hooks/prism-prompt-tier-router.mjs:522 is
// independently gated on `sentinel.summon_panel === true`. Every consumer of
// self_chair happens to also re-check the POST-suppression summon_panel
// before self_chair's value has any effect — so today this is a LATENT,
// currently-INERT inconsistency (self_chair:true persisted alongside
// summon_panel:false — a self-contradictory on-disk state), not a live
// exploit. Fixed anyway (cheap, surgical, removes a landmine for any FUTURE
// consumer that reads self_chair without also re-checking summon_panel, and
// makes the persisted sentinel internally consistent).
//
// SECOND MANIFESTATION FOUND WHILE READING (same root cause, not separately
// filed): the PRISM_PANEL_DISABLED suppression block ran AFTER the self_chair
// assignment in the original code, so self_chair could equally be
// wrongly-set under PRISM_PANEL_DISABLED, for the identical reason. The fix
// (reordering self_chair to run after BOTH suppression blocks) closes this
// too, verified below.
//
// Run: node tests/v3/hooks/test-tier-router-self-chair-post-suppression.mjs

import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const tempDir = mkdtempSync(join(tmpdir(), 'prism-f18-'));
mkdirSync(join(tempDir, '.claude'), {recursive: true});

process.env.HOME = tempDir;
process.env.USERPROFILE = tempDir;
delete process.env.PRISM_CONVERSATION_MODE;

const {run} = await import(pathToFileURL('C:/dev/prism_3/hooks/prism-prompt-tier-router.mjs').href);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n        ' + detail : ''}`); }
}

function sentinelPath(sid) { return join(tempDir, '.claude', `.prism-turn-tier-${sid}.json`); }
function readSentinel(sid) { return JSON.parse(readFileSync(sentinelPath(sid), 'utf-8')); }

// A fake project-master cwd (detectActiveMaster reads <cwd>/.claude/settings.json
// `agent:` field — mirrors this repo's own real setup, which chairs via
// master-prism-3).
const masterCwd = mkdtempSync(join(tmpdir(), 'prism-f18-cwd-'));
mkdirSync(join(masterCwd, '.claude'), {recursive: true});
writeFileSync(join(masterCwd, '.claude', 'settings.json'), JSON.stringify({agent: 'master-test-x'}));

// ── CASE 1 (F18 FIX): task-notification, no prior sentinel, explicit
// panel-summoning language leaked into the notification body, active master
// configured. D075 must suppress summon_panel; self_chair must NOT be set on
// a turn where the panel was suppressed. ─────────────────────────────────────
{
  const sid = 'f18-case1-task-notification';
  delete process.env.PRISM_PANEL_DISABLED;
  await run({
    prompt: '<task-notification>\n<task-id>x</task-id>\nsummon the panel to evaluate a novel distributed-systems architecture migration\n</task-notification>',
    session_id: sid,
    cwd: masterCwd,
  });
  const s = readSentinel(sid);
  check('CASE 1: summon_panel correctly suppressed (D075)', s.summon_panel === false, `sentinel=${JSON.stringify(s)}`);
  check('CASE 1 (F18 FIX): self_chair must NOT be set when summon_panel was suppressed', s.self_chair !== true, `sentinel=${JSON.stringify(s)}`);
}

// ── CASE 2 (F18 FIX, second manifestation): genuine explicit panel prompt
// (NOT a task-notification), active master configured, but
// PRISM_PANEL_DISABLED=1. The Arm-B kill-switch must suppress summon_panel;
// self_chair must NOT be set on a turn where the panel was disabled. ────────
{
  const sid = 'f18-case2-panel-disabled';
  process.env.PRISM_PANEL_DISABLED = '1';
  await run({
    prompt: 'summon the panel to evaluate a novel distributed-systems architecture migration across every service boundary',
    session_id: sid,
    cwd: masterCwd,
  });
  delete process.env.PRISM_PANEL_DISABLED;
  const s = readSentinel(sid);
  check('CASE 2: summon_panel correctly suppressed (PRISM_PANEL_DISABLED)', s.summon_panel === false, `sentinel=${JSON.stringify(s)}`);
  check('CASE 2 (F18 FIX): self_chair must NOT be set when the panel was disabled', s.self_chair !== true, `sentinel=${JSON.stringify(s)}`);
}

// ── CASE 3 (PAIRED NEGATIVE CONTROL, acceptance criterion #4): a genuine
// user explicit panel request on a NORMAL (non-task-notification,
// panel-not-disabled) turn, active master configured, MUST STILL self-chair
// correctly. This must hold BEFORE and AFTER the fix — a fix that defeats
// legitimate panel summoning is worse than the bug. ─────────────────────────
{
  const sid = 'f18-case3-legit-panel';
  delete process.env.PRISM_PANEL_DISABLED;
  await run({
    prompt: 'summon the panel to evaluate a novel distributed-systems architecture migration across every service boundary',
    session_id: sid,
    cwd: masterCwd,
  });
  const s = readSentinel(sid);
  check('CASE 3: genuine panel request sets summon_panel=true', s.summon_panel === true, `sentinel=${JSON.stringify(s)}`);
  check('CASE 3 (NEGATIVE CONTROL — must still work): self_chair IS set on a genuine, non-suppressed panel turn with an active master', s.self_chair === true, `sentinel=${JSON.stringify(s)}`);
  check('CASE 3: active_master recorded correctly', s.active_master === 'master-test-x', `sentinel=${JSON.stringify(s)}`);
}

// ── CASE 4 (existing negative control, unaffected by this fix): no active
// master configured -> self_chair must never be set, panel or not. ─────────
{
  const sid = 'f18-case4-no-master';
  const noMasterCwd = mkdtempSync(join(tmpdir(), 'prism-f18-nomaster-'));
  await run({
    prompt: 'summon the panel to evaluate a novel distributed-systems architecture migration across every service boundary',
    session_id: sid,
    cwd: noMasterCwd,
  });
  const s = readSentinel(sid);
  check('CASE 4: no active master -> self_chair never set (unaffected by fix)', !s.self_chair, `sentinel=${JSON.stringify(s)}`);
  rmSync(noMasterCwd, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);

rmSync(tempDir, {recursive: true, force: true});
rmSync(masterCwd, {recursive: true, force: true});

process.exit(fail ? 1 : 0);
