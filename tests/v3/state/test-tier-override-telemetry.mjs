#!/usr/bin/env node
// option (c) tier-override telemetry — mechanical, hermetic test.
//
// Verifies the additive, fail-open telemetry write in
// hooks/prism-prompt-tier-router.mjs: before the sentinel is overwritten each
// turn, the router records a `tier_override_outcome` event capturing whether
// the conversation model overrode the tier on the PREVIOUS turn. This makes the
// override RATE measurable without changing any routing/classification logic.
//
// Also exercises the reducer in tools/prism-telemetry-aggregate.mjs which
// computes override_rate (per-session + overall) from a synthetic log.
//
// Hermetic: a fresh temp HOME per run; the router is spawned as a subprocess
// (as it runs in production) against that HOME so the routing log + sentinels
// are fully isolated. No network. Dep-free.
//
// Run: node tests/v3/state/test-tier-override-telemetry.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const ROUTER_HOOK = join(REPO, 'hooks', 'prism-prompt-tier-router.mjs');
const AGG_TOOL = join(REPO, 'tools', 'prism-telemetry-aggregate.mjs');

let pass = 0, fail = 0;
function ok(name) { pass++; process.stdout.write(`  PASS ${name}\n`); }
function bad(name, msg) { fail++; process.stdout.write(`  FAIL ${name}\n        ${msg}\n`); }
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(name, e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Fresh isolated HOME for the whole file.
const fakeHome = mkdtempSync(join(tmpdir(), 'prism-override-tel-'));
function sentinelPath(sid) { return join(fakeHome, '.claude', `.prism-turn-tier-${sid}.json`); }
function routingLogPath() { return join(fakeHome, '.claude', '.prism-routing.jsonl'); }

function readRoutingLog() {
  const p = routingLogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function overrideOutcomesFor(sid) {
  return readRoutingLog().filter(e => e.event === 'tier_override_outcome' && e.session_id === sid);
}

// Spawn the router as production does. Same fakeHome persists the routing log
// + sentinels across calls. PRISM_CONVERSATION_MODE unset (default routing).
function runRouter(sid, prompt, extraEnv = {}) {
  const payload = JSON.stringify({session_id: sid, prompt, cwd: REPO});
  const r = spawnSync(process.execPath, [ROUTER_HOOK], {
    input: payload, encoding: 'utf-8',
    env: {...process.env, HOME: fakeHome, USERPROFILE: fakeHome, PRISM_PROMPT_ROUTER: 'hard', ...extraEnv},
    timeout: 20000,
  });
  let sentinel = null;
  try { sentinel = JSON.parse(readFileSync(sentinelPath(sid), 'utf-8')); } catch {}
  return {exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', sentinel};
}
function writeSentinel(sid, obj) {
  mkdirSync(dirname(sentinelPath(sid)), {recursive: true});
  writeFileSync(sentinelPath(sid), JSON.stringify(obj, null, 2));
}

const KWFLOOR_PROMPT = 'fix the flexbox alignment in Header.tsx';

try {
  // ── Case 1: turn 1 on a keyword-floor prompt → sentinel source:'keyword-floor'
  check('case1: turn-1 keyword-floor prompt writes sentinel with source=keyword-floor', () => {
    const sid = 't-case1';
    const r = runRouter(sid, KWFLOOR_PROMPT);
    assert(r.exit === 0 || r.exit === null, `router exited ${r.exit}; stderr: ${r.stderr}`);
    assert(r.sentinel, 'expected a sentinel to be written');
    assert(r.sentinel.source === 'keyword-floor',
      `expected sentinel.source='keyword-floor', got '${r.sentinel && r.sentinel.source}'`);
    // Turn 1 has no prior sentinel → NO tier_override_outcome should exist yet.
    assert(overrideOutcomesFor(sid).length === 0,
      `turn-1 fresh session must not emit tier_override_outcome, got ${overrideOutcomesFor(sid).length}`);
  });

  // ── Case 2+3: model override between turns → was_override:true captured
  check('case3: model-override sentinel → turn-2 logs tier_override_outcome was_override:true', () => {
    const sid = 't-override';
    // Turn 1: normal keyword-floor turn writes a sentinel.
    const r1 = runRouter(sid, KWFLOOR_PROMPT);
    assert(r1.exit === 0 || r1.exit === null, `turn-1 exited ${r1.exit}`);
    // Case 2: simulate the conversation model overriding the tier as its first
    // action — overwrite the sentinel with source:'conversation-model-override'.
    writeSentinel(sid, {
      tier: 'opus',
      source: 'conversation-model-override',
      ts: new Date().toISOString(),
      summon_panel: false,
      rationale: 'model corrected keyword-floor',
    });
    // Turn 2: router runs → telemetry fires BEFORE the sentinel is overwritten.
    const r2 = runRouter(sid, 'now add a dark-mode toggle to the settings page');
    assert(r2.exit === 0 || r2.exit === null, `turn-2 exited ${r2.exit}`);
    const outcomes = overrideOutcomesFor(sid);
    assert(outcomes.length === 1, `expected exactly 1 tier_override_outcome, got ${outcomes.length}`);
    const o = outcomes[0];
    assert(o.was_override === true, `expected was_override=true, got ${o.was_override}`);
    assert(o.prev_source === 'conversation-model-override',
      `expected prev_source='conversation-model-override', got '${o.prev_source}'`);
    assert(o.prev_tier === 'opus', `expected prev_tier='opus', got '${o.prev_tier}'`);
  });

  // ── Case 4: no override between turns → was_override:false
  check('case4: no override between turns → tier_override_outcome was_override:false', () => {
    const sid = 't-nooverride';
    const r1 = runRouter(sid, KWFLOOR_PROMPT);
    assert(r1.exit === 0 || r1.exit === null, `turn-1 exited ${r1.exit}`);
    assert(r1.sentinel && r1.sentinel.source === 'keyword-floor',
      `turn-1 sentinel source expected keyword-floor, got '${r1.sentinel && r1.sentinel.source}'`);
    // Turn 2 without overwriting the sentinel — the prior source is keyword-floor.
    const r2 = runRouter(sid, 'also tweak the padding on the footer links');
    assert(r2.exit === 0 || r2.exit === null, `turn-2 exited ${r2.exit}`);
    const outcomes = overrideOutcomesFor(sid);
    assert(outcomes.length === 1, `expected exactly 1 tier_override_outcome, got ${outcomes.length}`);
    const o = outcomes[0];
    assert(o.was_override === false, `expected was_override=false, got ${o.was_override}`);
    assert(o.prev_source === 'keyword-floor', `expected prev_source='keyword-floor', got '${o.prev_source}'`);
  });

  // ── Case 5: fail-open — malformed/absent prior sentinel must not throw, and
  //           routing must still produce a sentinel.
  check('case5a: absent prior sentinel → no throw, sentinel still produced', () => {
    const sid = 't-fresh-failopen';
    const r = runRouter(sid, KWFLOOR_PROMPT);
    assert(r.exit === 0 || r.exit === null, `router exited ${r.exit}; stderr: ${r.stderr}`);
    assert(r.sentinel, 'routing must still produce a sentinel with no prior sentinel');
    assert(overrideOutcomesFor(sid).length === 0, 'no prior sentinel → no outcome event');
  });

  check('case5b: malformed prior sentinel → no throw, routing still produces a sentinel', () => {
    const sid = 't-malformed';
    // Write garbage where the sentinel lives → readSentinel returns null (caught).
    mkdirSync(dirname(sentinelPath(sid)), {recursive: true});
    writeFileSync(sentinelPath(sid), '{ this is not valid json ]');
    const r = runRouter(sid, KWFLOOR_PROMPT);
    assert(r.exit === 0 || r.exit === null, `router exited ${r.exit}; stderr: ${r.stderr}`);
    assert(r.sentinel, 'routing must still produce a valid sentinel despite a malformed prior sentinel');
    assert(r.sentinel.source === 'keyword-floor',
      `expected fresh classification source keyword-floor, got '${r.sentinel && r.sentinel.source}'`);
    // Malformed prior → readSentinel null → prevSentinel falsy → no outcome event.
    assert(overrideOutcomesFor(sid).length === 0,
      `malformed prior sentinel must not emit an outcome event, got ${overrideOutcomesFor(sid).length}`);
  });

  // ── Reducer: override_rate computes from a synthetic log ──────────────────
  check('reducer: override_rate (overall + per-session) computes from synthetic log', () => {
    const rHome = mkdtempSync(join(tmpdir(), 'prism-override-agg-'));
    mkdirSync(join(rHome, '.claude'), {recursive: true});
    const log = join(rHome, '.claude', '.prism-routing.jsonl');
    // Session A: 4 keyword-floor turns, 1 real override → rate 0.25
    // Session B: 2 keyword-floor turns, 0 overrides → rate 0
    const lines = [
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:00Z', session_id: 'A', tier: 'sonnet', source: 'keyword-floor'},
      {event: 'tier_override_outcome', ts: '2026-07-06T00:00:01Z', session_id: 'A', prev_tier: 'opus', prev_source: 'conversation-model-override', was_override: true},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:02Z', session_id: 'A', tier: 'sonnet', source: 'keyword-floor'},
      {event: 'tier_override_outcome', ts: '2026-07-06T00:00:03Z', session_id: 'A', prev_tier: 'sonnet', prev_source: 'keyword-floor', was_override: false},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:04Z', session_id: 'A', tier: 'haiku', source: 'keyword-floor'},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:05Z', session_id: 'A', tier: 'opus', source: 'allowlist'},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:06Z', session_id: 'A', tier: 'sonnet', source: 'keyword-floor'},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:07Z', session_id: 'B', tier: 'sonnet', source: 'keyword-floor'},
      {event: 'prompt_tier_router', ts: '2026-07-06T00:00:08Z', session_id: 'B', tier: 'haiku', source: 'keyword-floor'},
    ].map(o => JSON.stringify(o)).join('\n') + '\n';
    writeFileSync(log, lines);
    const r = spawnSync(process.execPath, [AGG_TOOL, '--dry-run', '--force', '--home', rHome], {
      encoding: 'utf-8', timeout: 20000,
    });
    assert(r.status === 0, `aggregate exited ${r.status}; stderr: ${r.stderr}`);
    const rollup = JSON.parse(r.stdout);
    const orr = rollup.override_rate;
    assert(orr, 'rollup must contain override_rate');
    assert(orr.keyword_floor_turns === 6, `expected 6 keyword_floor_turns, got ${orr.keyword_floor_turns}`);
    assert(orr.overrides_observed === 1, `expected 1 override observed, got ${orr.overrides_observed}`);
    assert(Math.abs(orr.overall - (1 / 6)) < 1e-9, `expected overall ${1 / 6}, got ${orr.overall}`);
    assert(orr.per_session.A, 'expected per_session.A');
    assert(orr.per_session.A.keyword_floor_turns === 4, `A keyword_floor_turns expected 4, got ${orr.per_session.A.keyword_floor_turns}`);
    assert(Math.abs(orr.per_session.A.override_rate - 0.25) < 1e-9, `A rate expected 0.25, got ${orr.per_session.A.override_rate}`);
    assert(orr.per_session.B.keyword_floor_turns === 2, `B keyword_floor_turns expected 2, got ${orr.per_session.B.keyword_floor_turns}`);
    assert(orr.per_session.B.override_rate === 0, `B rate expected 0, got ${orr.per_session.B.override_rate}`);
    rmSync(rHome, {recursive: true, force: true});
  });

  check('reducer: empty/no keyword-floor turns → override_rate.overall stays null (no divide-by-zero)', () => {
    const rHome = mkdtempSync(join(tmpdir(), 'prism-override-agg-empty-'));
    mkdirSync(join(rHome, '.claude'), {recursive: true});
    const log = join(rHome, '.claude', '.prism-routing.jsonl');
    writeFileSync(log, JSON.stringify({event: 'prompt_tier_router', ts: '2026-07-06T00:00:00Z', session_id: 'A', tier: 'opus', source: 'allowlist'}) + '\n');
    const r = spawnSync(process.execPath, [AGG_TOOL, '--dry-run', '--force', '--home', rHome], {encoding: 'utf-8', timeout: 20000});
    assert(r.status === 0, `aggregate exited ${r.status}; stderr: ${r.stderr}`);
    const rollup = JSON.parse(r.stdout);
    assert(rollup.override_rate.overall === null, `expected overall=null with no keyword-floor turns, got ${rollup.override_rate.overall}`);
    rmSync(rHome, {recursive: true, force: true});
  });

} finally {
  try { rmSync(fakeHome, {recursive: true, force: true}); } catch {}
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
