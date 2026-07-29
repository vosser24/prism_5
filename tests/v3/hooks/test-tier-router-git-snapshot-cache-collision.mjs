#!/usr/bin/env node
// Task #25 (F17) — gitSnapshot() swallows git-resolution failures, and the
// resulting empty branch/headSha strings feed
// hooks/lib/prism-opus-classifier.mjs's cacheKey(prompt, branch, headSha),
// which is `sha256(prompt|branch|headSha)`. The tier cache itself is a SINGLE
// GLOBAL file (~/.claude/.prism-tier-cache.json — see
// hooks/lib/prism-opus-classifier.mjs DEFAULT_CACHE_PATH), not scoped per
// project/cwd at all — cwd is never part of the key. So when git resolution
// fails (non-repo cwd, git binary unavailable, or a fresh zero-commit repo —
// confirmed all three collapse `git rev-parse` to a non-zero exit, i.e.
// branch='' AND headSha=''), the ONLY thing left distinguishing the cache key
// is the prompt text itself — meaning TWO UNRELATED PROJECTS submitting the
// same prompt text, both with unresolvable git, collide on the IDENTICAL
// cache key and can serve each other's cached classification.
//
// ESTABLISHED BEFORE FIXING (per task #25 instruction — construct the failure,
// observe the ACTUAL cache key, do not reason about it):
//   node -e "gitSnapshot(dirA)" and "gitSnapshot(dirB)" (two distinct mkdtemp
//   non-repo dirs) both produced IDENTICAL {branch:'', headSha:''}.
//   cacheKey('fix the login bug', '', '', false) computed the SAME sha256 for
//   both — a genuine SHARED-KEY collision, not merely a harmless
//   distinct-but-unscoped key. Contrast: cacheKey() with two DIFFERENT real
//   (branch, headSha) pairs produces DISTINCT keys, as expected.
//
// This is NOT a swallowed-telemetry case like hooks/lib/prism-advisory-log.mjs
// (documented fail-open design at :28-29) — that pattern exists so a LOGGING
// failure never blocks a turn. This swallow instead silently degrades a
// CACHE SCOPING KEY used to serve a REAL classification decision across
// requests — a materially different failure class, not the same deliberate
// pattern, and IS a defect.
//
// Fix (surgical, inside gitSnapshot() only — hooks/prism-prompt-tier-router.mjs,
// no change to the shared hooks/lib/prism-opus-classifier.mjs used by other
// guards): when git resolution FAILS (both branch and headSha empty), fall
// back to a cwd-derived pseudo-headSha (`nogit:<sha256(cwd)-prefix>`) so the
// eventual cache key stays scoped to THIS project even when git itself cannot
// be resolved. Never fires when git resolves normally (branch/headSha already
// scope the key correctly in that — overwhelmingly common — case).
//
// Run: node tests/v3/hooks/test-tier-router-git-snapshot-cache-collision.mjs

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n        ' + detail : ''}`); }
}

const ROUTER = pathToFileURL('C:/dev/prism_3/hooks/prism-prompt-tier-router.mjs').href;
const CLASSIFIER = pathToFileURL('C:/dev/prism_3/hooks/lib/prism-opus-classifier.mjs').href;

// gitSnapshot() is exported (alongside formatAdvice/buildOverrideDirective,
// same "Exported for unit testing" pattern) specifically so this test drives
// the REAL function rather than a hand-maintained re-implementation that
// could silently drift from the fix.
const { cacheKey } = await import(CLASSIFIER);
const { gitSnapshot } = await import(ROUTER);

// Two unrelated non-repo directories — real git resolution WILL fail in both
// (confirmed: `git rev-parse --abbrev-ref HEAD` exits non-zero in a dir with
// no .git ancestry reachable, or a fresh zero-commit repo — both collapse to
// the same empty-string signature pre-fix).
const dirA = mkdtempSync(join(tmpdir(), 'prism-f17-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'prism-f17-b-'));

const snapA = gitSnapshot(dirA);
const snapB = gitSnapshot(dirB);

check('git resolution genuinely fails in both scratch dirs (real git rev-parse cannot resolve)', snapA.branch === '' && snapB.branch === '', `snapA=${JSON.stringify(snapA)} snapB=${JSON.stringify(snapB)}`);

const promptText = 'fix the login bug';
const keyA = cacheKey(promptText, snapA.branch, snapA.headSha, false);
const keyB = cacheKey(promptText, snapB.branch, snapB.headSha, false);

// THE REGRESSION GUARD: once F17 is fixed, gitSnapshot() must emit a
// cwd-scoped fallback when git can't resolve, so the classifier's cache_key
// differs across unrelated projects even on identical prompt text. This
// assertion is RED against the ORIGINAL gitSnapshot() (both branch/headSha
// truly empty -> keyA === keyB) and GREEN after the fix.
check('F17 FIX: cache key differs across two unrelated non-repo projects on identical prompt (no cross-project collision)',
  keyA !== keyB,
  `keyA=${keyA} keyB=${keyB} (EQUAL means a genuine cross-project cache collision is still possible)`);

// Positive control: cacheKey() itself behaves correctly when git DOES
// resolve — two different real (branch, headSha) pairs must produce distinct
// keys. This must stay true regardless of the F17 fix (untouched code path).
const keyRepoX = cacheKey(promptText, 'main', 'abc1234', false);
const keyRepoY = cacheKey(promptText, 'main', 'def5678', false);
check('positive control: cacheKey() distinguishes different real (branch, headSha) pairs (unaffected by F17 fix)', keyRepoX !== keyRepoY);

// End-to-end regression: drive the REAL router as a FRESH SUBPROCESS per case
// (the router computes module-level HOME/MODE at import time, so an
// in-process re-import can't re-scope HOME per call — same constraint noted
// in tests/v3/prism-task-notification-panel-suppression.test.mjs's header).
// Each subprocess gets its own scratch HOME + the same prompt text; compare
// the classifier's logged cache_key between runs — the actual observable
// artifact a live session would produce.
import {mkdirSync, readFileSync} from 'node:fs';

function driveRouterSubprocess(cwd, sessionId) {
  const home = mkdtempSync(join(tmpdir(), 'prism-f17-home-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  try {
    const code = `
      import('${ROUTER}').then(async ({run}) => {
        await run({prompt: ${JSON.stringify(promptText)}, session_id: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(cwd)}});
      });
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf-8', timeout: 15000,
      env: {...process.env, HOME: home, USERPROFILE: home},
    });
    if (r.status !== 0) throw new Error(`router subprocess failed: ${r.stderr}`);
    const routingLog = join(home, '.claude', '.prism-routing.jsonl');
    const lines = readFileSync(routingLog, 'utf-8').trim().split('\n').filter(Boolean);
    const routerEvents = lines.map(l => JSON.parse(l)).filter(e => e.event === 'prompt_tier_router');
    return routerEvents[routerEvents.length - 1];
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

const eventA = driveRouterSubprocess(dirA, 'f17-e2e-a');
const eventB = driveRouterSubprocess(dirB, 'f17-e2e-b');
check('F17 FIX (end-to-end): the REAL router logs a DIFFERENT cache_key for the same prompt across two unrelated non-repo projects',
  eventA && eventB && eventA.cache_key !== eventB.cache_key,
  `eventA.cache_key=${eventA && eventA.cache_key} eventB.cache_key=${eventB && eventB.cache_key}`);

rmSync(dirA, {recursive: true, force: true});
rmSync(dirB, {recursive: true, force: true});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
