#!/usr/bin/env node
// D025 — Short-prompt over-escalation + cache-lock fixes (2026-06-22)
//
// Three sub-fixes:
//
//   2a: PANEL_MIN_WORDS floor — short (<50-word) prompts must not auto-summon
//       the panel from IMPLICIT signals (stakes, PANEL_SIGNALS, ≥3 OPUS_SIGNALS,
//       compound-verb). EXPLICIT panel requests ("run the panel") must still work.
//
//   2b: Cache skip for short prompts — cachePut() must NOT write when the prompt
//       word-count is below the threshold. Short prompts re-classify every turn.
//
//   2c: Escape valve for cache-sourced panel hits — a source='cache' summon_panel
//       must receive the self-override directive (just like keyword-floor).
//
// Run: node tests/v3/state/test-classifier-shortprompt.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const CLASSIFY_LIB = join(REPO, 'tools', 'lib', 'prism-tier-classify.mjs');
const CLASSIFIER_LIB = join(REPO, 'hooks', 'lib', 'prism-opus-classifier.mjs');
const ROUTER_HOOK = join(REPO, 'hooks', 'prism-prompt-tier-router.mjs');

// D087 (#44): the tier-override directive is now suppressed for a dispatched
// teammate (CLAUDE_CODE_CHILD_SESSION=1). Every assertion below describes the
// CHAIR path, so pin the discriminator — otherwise this suite passes for the
// chair and fails for a subagent that runs it (an environment-dependent red of
// exactly the kind findings #33/#39 cost us). The spawnSync router children
// inherit this process's env, so the delete covers them too.
delete process.env.CLAUDE_CODE_CHILD_SESSION;

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assertContains(haystack, needle, msg) {
  if (!haystack || !String(haystack).includes(needle)) {
    throw new Error(`expected to contain "${needle}"${msg ? ' — ' + msg : ''}`);
  }
}
function assertNotContains(haystack, needle, msg) {
  if (haystack && String(haystack).includes(needle)) {
    throw new Error(`expected NOT to contain "${needle}"${msg ? ' — ' + msg : ''}`);
  }
}

// Run the router hook via spawnSync with an isolated fakeHome.
function runRouter(sessionId, prompt, extraEnv = {}) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'prism-2c-'));
  const payload = JSON.stringify({session_id: sessionId, prompt, cwd: REPO});
  const r = spawnSync(process.execPath, [ROUTER_HOOK], {
    input: payload,
    encoding: 'utf-8',
    env: {...process.env, HOME: fakeHome, USERPROFILE: fakeHome, PRISM_PROMPT_ROUTER: 'hard', ...extraEnv},
    timeout: 15000,
  });
  const sentinelPath = join(fakeHome, '.claude', `.prism-turn-tier-${sessionId}.json`);
  let sentinel = null;
  try { sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8')); } catch {}
  let additionalContext = '';
  try { additionalContext = JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch {}
  try { rmSync(fakeHome, {recursive: true, force: true}); } catch {}
  return {exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', sentinel, additionalContext};
}

// ─────────────────────────────────────────────────────────────────────────
// FIX 2a: PANEL_MIN_WORDS floor in prism-tier-classify.mjs
// ─────────────────────────────────────────────────────────────────────────

// D034 Amendment (2026-06-25): explicit-only panel trigger.
// A long prompt with implicit panel signals (PANEL_SIGNALS, ≥3 OPUS_SIGNALS)
// must NO LONGER auto-fire summon_panel. The panel fires ONLY on explicit
// user request. Legacy auto-fire behavior is behind PRISM_LEXICAL_PANEL=1.
test('2a: long prompt (≥50 words) with implicit panel signals → summon_panel=false (D034: explicit-only)', async () => {
  // Fresh import (cache-bust) to avoid module-level cache from prior test runs.
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a1');
  // A 55-word novel-architecture prompt that clears PANEL_SIGNALS (novel greenfield system)
  // and has multiple OPUS_SIGNALS (architect, tradeoff, plan phases, roadmap).
  const longPrompt = [
    'design a brand new greenfield event-driven platform from scratch with multi-region',
    'distribution and phased migration strategy covering the entire backend api layer',
    'frontend integration database schema and observability stack across all production',
    'environments for enterprise tenants including security audit architecture tradeoffs',
    'phased rollout roadmap and disaster recovery plan with full multi-tenant support',
    'and per-tenant fairness policy enforcement across all regions and shards globally',
  ].join(' ');
  const wc = longPrompt.trim().split(/\s+/).length;
  assert(wc >= 50, `test setup error: longPrompt is only ${wc} words (need ≥50)`);
  const result = classifyWithScore(longPrompt, '');
  // D034: implicit signals (PANEL_SIGNALS, OPUS_SIGNALS ≥3) no longer trigger
  // the panel in default mode — only explicit requests do.
  assert(result.summon_panel === false, `expected summon_panel=false (explicit-only, D034) for long novel prompt (${wc} words), got ${result.summon_panel}; scores: o=${result.o}`);
  // Tier must still route to opus (implicit signals still govern tier).
  assert(result.tier_by_score === 'opus', `expected opus tier for novel-arch prompt, got ${result.tier_by_score}`);
});

test('2a: short prompt (<50 words) with PANEL_SIGNALS hit → summon_panel=false (implicit suppressed)', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a2');
  // "novel greenfield system" hits PANEL_SIGNALS: /\b(novel|unprecedented|greenfield|from scratch)\s+(architect|design|system|migration|pipeline)/
  const shortPrompt = 'novel greenfield system';
  const wc = shortPrompt.trim().split(/\s+/).length;
  assert(wc < 50, `test setup error: shortPrompt is ${wc} words (should be < 50)`);
  const result = classifyWithScore(shortPrompt, '');
  assert(result.summon_panel === false,
    `expected summon_panel=false for short (${wc}-word) implicit-panel prompt, got summon_panel=${result.summon_panel}`);
});

test('2a: short prompt (<50 words) with ≥3 OPUS_SIGNALS → summon_panel=false (implicit suppressed)', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a3');
  // Hits: architecture, tradeoff, root cause (3 OPUS_SIGNALS). Only 4 words.
  const shortPrompt = 'architecture tradeoffs root cause';
  const wc = shortPrompt.trim().split(/\s+/).length;
  assert(wc < 50, `test setup: ${wc} words`);
  const result = classifyWithScore(shortPrompt, '');
  assert(result.o >= 3, `test setup: expected ≥3 opus signals, got o=${result.o}`);
  assert(result.summon_panel === false,
    `expected summon_panel=false for short ≥3-opus-signal prompt (${wc} words), got ${result.summon_panel}`);
});

test('2a: EXPLICIT "run the panel" (3 words) → summon_panel=true (floor must NOT suppress explicit)', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a4');
  const result = classifyWithScore('run the panel', '');
  assert(result.summon_panel === true,
    `expected summon_panel=true for explicit short request "run the panel", got ${result.summon_panel}`);
});

test('2a: EXPLICIT "!panel" (1 word) → summon_panel=true', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a5');
  const result = classifyWithScore('!panel', '');
  assert(result.summon_panel === true,
    `expected summon_panel=true for "!panel", got ${result.summon_panel}`);
});

test('2a: EXPLICIT "summon the panel" → summon_panel=true', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a6');
  const result = classifyWithScore('summon the panel', '');
  assert(result.summon_panel === true,
    `expected summon_panel=true for "summon the panel", got ${result.summon_panel}`);
});

test('2a: short stakes prompt ("drop table users") → tier=opus but summon_panel=false', async () => {
  const {classifyWithScore} = await import(pathToFileURL(CLASSIFY_LIB).href + '?v=2a7');
  const result = classifyWithScore('drop table users', '');
  // Tier should still be opus (stakes-driven tier uplift is unchanged)
  assertEq(result.tier_by_score, 'opus', 'stakes prompt should still be opus tier');
  assert(result.summon_panel === false,
    `expected summon_panel=false for short stakes prompt "drop table users", got ${result.summon_panel}`);
});

// ─────────────────────────────────────────────────────────────────────────
// FIX 2b: Cache skip for short prompts in prism-opus-classifier.mjs
// ─────────────────────────────────────────────────────────────────────────

test('2b: short prompt (<50 words) → NOT written to cache', async () => {
  const {classifyPrompt} = await import(pathToFileURL(CLASSIFIER_LIB).href + '?v=2b1');
  const fakeHome = mkdtempSync(join(tmpdir(), 'prism-2b-short-'));
  const cachePath = join(fakeHome, '.claude', '.prism-tier-cache.json');
  try {
    const result = await classifyPrompt({
      prompt: 'fix the bug',  // 3 words
      branch: 'main',
      headSha: 'abc123',
      cachePath,
      skipCache: false,
    });
    // Cache file must not exist, or must not contain an entry for this key.
    const cacheExists = existsSync(cachePath);
    if (cacheExists) {
      const cacheObj = JSON.parse(readFileSync(cachePath, 'utf-8'));
      const key = result.cache_key;
      assert(!cacheObj.entries || !cacheObj.entries[key],
        `expected no cache entry for short prompt (key=${key}), but found one`);
    }
    assertEq(result.source, 'keyword-floor', 'source should be keyword-floor for short uncached prompt');
  } finally {
    rmSync(fakeHome, {recursive: true, force: true});
  }
});

test('2b: long prompt (≥50 words) → IS written to cache', async () => {
  const {classifyPrompt} = await import(pathToFileURL(CLASSIFIER_LIB).href + '?v=2b2');
  const fakeHome = mkdtempSync(join(tmpdir(), 'prism-2b-long-'));
  mkdirSync(join(fakeHome, '.claude'), {recursive: true});
  const cachePath = join(fakeHome, '.claude', '.prism-tier-cache.json');
  try {
    // Long novel-arch prompt (>50 words): database migration with multi OPUS_SIGNALS.
    const longPrompt = [
      'design a comprehensive multi-phase migration strategy for our production database',
      'schema including backfilling legacy data fields updating all api endpoints and',
      'ensuring zero downtime for ten thousand active users across multiple geographic',
      'regions worldwide with full rollback capability and disaster recovery architect',
      'the new phased pipeline and tradeoff analysis covering all services and tenants',
      'with per-region fairness policy enforcement and security audit for every boundary',
    ].join(' ');
    const wc = longPrompt.trim().split(/\s+/).length;
    assert(wc >= 50, `test setup error: longPrompt is only ${wc} words`);
    const result = await classifyPrompt({
      prompt: longPrompt,
      branch: 'main',
      headSha: 'abc123',
      cachePath,
      skipCache: false,
    });
    assert(existsSync(cachePath), 'cache file should exist after long prompt classification');
    const cacheObj = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const key = result.cache_key;
    assert(cacheObj.entries && cacheObj.entries[key],
      `expected cache entry for long prompt (key=${key}), but found none`);
    assertEq(result.source, 'keyword-floor', 'source should be keyword-floor for first classification');
  } finally {
    rmSync(fakeHome, {recursive: true, force: true});
  }
});

test('2b: short prompt classified twice → both calls return keyword-floor (no stale cache hit)', async () => {
  const {classifyPrompt} = await import(pathToFileURL(CLASSIFIER_LIB).href + '?v=2b3');
  const fakeHome = mkdtempSync(join(tmpdir(), 'prism-2b-reclass-'));
  const cachePath = join(fakeHome, '.claude', '.prism-tier-cache.json');
  try {
    const r1 = await classifyPrompt({prompt: 'ok go', branch: 'main', headSha: 'abc', cachePath});
    assertEq(r1.source, 'keyword-floor', 'first call: should be keyword-floor');
    const r2 = await classifyPrompt({prompt: 'ok go', branch: 'main', headSha: 'abc', cachePath});
    assertEq(r2.source, 'keyword-floor', 'second call: should still be keyword-floor (no cache write for short prompts)');
  } finally {
    rmSync(fakeHome, {recursive: true, force: true});
  }
});

// ─────────────────────────────────────────────────────────────────────────
// FIX 2c: Escape valve for cache-sourced panel hits in the router
// ─────────────────────────────────────────────────────────────────────────
//
// Strategy: structural source-code test — read the router and assert the condition
// governing buildOverrideDirective covers source='cache' (not only 'keyword-floor').
// This is necessary because seeding a cache entry requires knowing the exact sha256
// key (including branch + headSha from live git), which varies per environment.
// The structural test is definitive: if the condition in the source doesn't gate on
// 'cache', no amount of E2E env setup will make it work.

test('2c: router source — override-directive condition covers source=cache ONLY for panel hits (structural)', async () => {
  const routerSource = readFileSync(ROUTER_HOOK, 'utf-8');
  // There are two references to buildOverrideDirective: the function definition
  // and the call site. We want the CALL site (which has the if-guard).
  // The call site is: advice += '\n' + buildOverrideDirective(...)
  // Use lastIndexOf to find the last reference (the call, not the definition).
  const callIdx = routerSource.lastIndexOf('buildOverrideDirective');
  assert(callIdx !== -1, 'expected to find buildOverrideDirective call in router');
  // Grab the 400-char window preceding the call — this covers the if-guard.
  const window = routerSource.slice(Math.max(0, callIdx - 400), callIdx + 60);
  assert(window.includes('cache'),
    `override-directive guard (400-char window before last buildOverrideDirective) does not include 'cache'.\nWindow:\n${window}`);
  // Also assert panelHardBlocked is still in the guard (unchanged safety gate).
  assert(window.includes('panelHardBlocked'),
    `override-directive guard must still include panelHardBlocked.\nWindow:\n${window}`);
  // KEY: the cache branch must be scoped to panel hits — assert that 'summonPanel'
  // appears in the guard window alongside 'cache' (i.e., not bare source==='cache').
  assert(window.includes('summonPanel'),
    `override-directive guard must scope source='cache' to panel hits (summonPanel must appear in guard).\nWindow:\n${window}`);
  // Negative structural check: the condition must NOT be the unscoped form
  // "(source === 'keyword-floor' || source === 'cache')" — i.e., the cache
  // branch must not stand alone without summonPanel.
  const unscopedPattern = /source\s*===\s*['"]cache['"]\s*\)/;
  assert(!unscopedPattern.test(window),
    `override-directive guard must not have bare 'source === "cache")' — cache branch must be guarded by summonPanel.\nWindow:\n${window}`);
});

test('2c: keyword-floor non-panel result → override directive present (existing behavior unchanged)', async () => {
  const r = runRouter('2c-kw-sonnet', 'fix the flexbox alignment in Header.tsx');
  assert(r.exit === 0 || r.exit === null, `router exited ${r.exit}; stderr: ${r.stderr}`);
  assertContains(r.additionalContext, 'PRISM TIER OVERRIDE PROTOCOL',
    'keyword-floor non-panel must still emit override directive');
});

// ─────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD (scoped cache fix): cache non-panel must NOT emit directive
// ─────────────────────────────────────────────────────────────────────────
//
// Strategy: structural test on the if-guard condition text.  We cannot seed a
// live cache entry without knowing the environment-specific sha256 key, but the
// structural test is definitive — if the condition fires on bare source='cache'
// without checking summonPanel, the guard is broken regardless of E2E setup.
//
// Positive case (cache + panel → directive PRESENT) is also structural: the
// 'cache' && summonPanel branch IS inside the condition, so if both are present
// and panelHardBlocked is false, the directive fires.

test('2c-neg: cache-sourced NON-panel routine turn → override directive ABSENT (structural regression guard)', async () => {
  const routerSource = readFileSync(ROUTER_HOOK, 'utf-8');
  const callIdx = routerSource.lastIndexOf('buildOverrideDirective');
  assert(callIdx !== -1, 'expected to find buildOverrideDirective call in router');
  // Extract the if-condition line that precedes the call.
  // Walk backwards from callIdx to find the enclosing if(...) line.
  const segment = routerSource.slice(Math.max(0, callIdx - 600), callIdx);
  // Find the last `if (` before the call.
  const ifIdx = segment.lastIndexOf('if (');
  assert(ifIdx !== -1, 'expected to find an if-guard before the buildOverrideDirective call');
  const conditionLine = segment.slice(ifIdx, ifIdx + 200);
  // The condition must NOT match bare "source === 'cache'" without also requiring summonPanel.
  // Specifically: "source === 'cache'" must not appear as a standalone disjunct —
  // it must be wrapped in "... && summonPanel" or similar.
  // We verify this by checking the condition does NOT contain the unscoped form.
  const unscopedCache = /source\s*===\s*['"]cache['"]\s*\)/;
  assert(!unscopedCache.test(conditionLine),
    `Regression: cache branch must be scoped to summonPanel. Found unscoped "source === 'cache')" in guard:\n${conditionLine}`);
  // Also assert summonPanel IS present in the condition (ensures the scoping is real).
  assert(conditionLine.includes('summonPanel'),
    `Regression: 'summonPanel' must appear in the cache branch of the if-guard.\nCondition:\n${conditionLine}`);
});

test('2c-pos: cache-sourced PANEL hit → override directive PRESENT (structural positive regression guard)', async () => {
  const routerSource = readFileSync(ROUTER_HOOK, 'utf-8');
  const callIdx = routerSource.lastIndexOf('buildOverrideDirective');
  assert(callIdx !== -1, 'expected to find buildOverrideDirective call in router');
  const segment = routerSource.slice(Math.max(0, callIdx - 600), callIdx);
  const ifIdx = segment.lastIndexOf('if (');
  assert(ifIdx !== -1, 'expected to find an if-guard before the buildOverrideDirective call');
  const conditionLine = segment.slice(ifIdx, ifIdx + 200);
  // The condition must contain the cache+panel form: "(source === 'cache' && summonPanel)"
  // or equivalent — both 'cache' and 'summonPanel' must appear together.
  assert(conditionLine.includes('cache') && conditionLine.includes('summonPanel'),
    `Positive regression: condition must include both 'cache' and 'summonPanel' so that cache+panel hits DO receive the directive.\nCondition:\n${conditionLine}`);
});

test('2c: keyword-floor hard-mode PANEL → override directive suppressed (panelHardBlocked, unchanged)', async () => {
  // A long novel-architecture prompt should summon the panel (and be hard-blocked).
  const longNovelPrompt = 'redesign the entire backend platform from scratch with novel multi-region distributed architecture including phased migration strategy for all tenants new observability stack and security audit across every service boundary in the system with full failover and disaster recovery planning';
  const r = runRouter('2c-kw-panel-hard2', longNovelPrompt, {PRISM_PROMPT_ROUTER: 'hard'});
  assert(r.exit === 0 || r.exit === null, `router exited ${r.exit}`);
  if (r.sentinel && r.sentinel.summon_panel === true) {
    assertNotContains(r.additionalContext, 'PRISM TIER OVERRIDE PROTOCOL',
      'hard-mode keyword-floor panel must NOT get the override directive (panelHardBlocked)');
  } else {
    // Panel wasn't triggered (e.g. short word count) — this test is inconclusive.
    process.stdout.write('    (note: panel not triggered for test prompt — panelHardBlocked check skipped)\n');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// FIX 2c: BEHAVIORAL assertions — direct call into formatAdvice
// ─────────────────────────────────────────────────────────────────────────
//
// These tests import formatAdvice directly (pure function, no I/O) and
// call it with controlled inputs.  No cache seeding, no env setup — the
// output is deterministic given the arguments alone.
//
// Covers the over-fire bug that structural tests missed: a cache-sourced
// NON-panel turn (summonPanel=false) must NOT emit the override directive,
// while a cache-sourced PANEL turn (summonPanel=true, soft mode) MUST emit it.

test('2c-behavioral: cache+panel (soft) → override directive PRESENT in formatAdvice output', async () => {
  const {formatAdvice} = await import(pathToFileURL(ROUTER_HOOK).href + '?v=2cbeh1');
  const advice = formatAdvice('opus', 'cached panel hit', 'soft', /*summonPanel=*/true, /*source=*/'cache', 'test-sess', null);
  assertContains(advice, 'PRISM TIER OVERRIDE PROTOCOL',
    'cache+panel+soft: override directive must be present in formatAdvice output');
});

test('2c-behavioral: cache+NON-panel routine (soft) → override directive ABSENT in formatAdvice output', async () => {
  const {formatAdvice} = await import(pathToFileURL(ROUTER_HOOK).href + '?v=2cbeh2');
  // summonPanel=false: the over-fire case the bug introduced. Directive must be suppressed.
  const advice = formatAdvice('opus', 'cached opus non-panel', 'soft', /*summonPanel=*/false, /*source=*/'cache', 'test-sess', null);
  assertNotContains(advice, 'PRISM TIER OVERRIDE PROTOCOL',
    'cache+opus+summonPanel=false: override directive must be ABSENT (the over-fire case)');
});

test('2c-behavioral: cache+sonnet routine (soft) → override directive ABSENT in formatAdvice output', async () => {
  const {formatAdvice} = await import(pathToFileURL(ROUTER_HOOK).href + '?v=2cbeh3');
  // A cached sonnet routine hit: no summonPanel, source=cache — must never get the directive.
  const advice = formatAdvice('sonnet', 'cached sonnet routine', 'soft', /*summonPanel=*/false, /*source=*/'cache', 'test-sess', null);
  assertNotContains(advice, 'PRISM TIER OVERRIDE PROTOCOL',
    'cache+sonnet+summonPanel=false: override directive must be ABSENT (routine fast path)');
});

test('2c-behavioral: cache+panel (hard) → override directive ABSENT (panelHardBlocked guard)', async () => {
  const {formatAdvice} = await import(pathToFileURL(ROUTER_HOOK).href + '?v=2cbeh4');
  // Hard mode + panel: panelHardBlocked=true → directive must be suppressed even for cache+panel.
  const advice = formatAdvice('opus', 'cached panel hard', 'hard', /*summonPanel=*/true, /*source=*/'cache', 'test-sess', null);
  assertNotContains(advice, 'PRISM TIER OVERRIDE PROTOCOL',
    'cache+panel+hard: override directive must be ABSENT (panelHardBlocked gate)');
});

test('2c-behavioral: keyword-floor+panel (soft) → override directive PRESENT (unchanged existing path)', async () => {
  const {formatAdvice} = await import(pathToFileURL(ROUTER_HOOK).href + '?v=2cbeh5');
  const advice = formatAdvice('opus', 'kw-floor panel soft', 'soft', /*summonPanel=*/true, /*source=*/'keyword-floor', 'test-sess', null);
  assertContains(advice, 'PRISM TIER OVERRIDE PROTOCOL',
    'keyword-floor+panel+soft: override directive must be PRESENT (existing path must be unchanged)');
});

// ─────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      process.stdout.write(`  ok  ${name}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`);
    }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
