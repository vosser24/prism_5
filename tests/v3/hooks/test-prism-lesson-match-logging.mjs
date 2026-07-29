#!/usr/bin/env node
// Task #45 item 1c (D083 defect #3) — hooks/prism-lesson-match.mjs emitted NO
// routing-log record on any path, so a "matched nothing" turn was structurally
// indistinguishable from the hook never running at all. This test pins the
// fix: every run() invocation that actually evaluates a prompt against a
// loaded keyword map must append one record to .prism-routing.jsonl via the
// shared logAdvisory() helper (hooks/lib/prism-advisory-log.mjs) — including,
// and especially, the no-match path.
//
// Isolation: HOME/USERPROFILE point at a mkdtemp dir (logAdvisory resolves
// home lazily via prismHome() at call time, per hooks/lib/prism-home.mjs), so
// this test never touches the operator's real ~/.claude/.prism-routing.jsonl.
// Pattern follows tests/v3/hooks/test-panel-name-guard.mjs and
// tests/v3/test-audit-runner-home-isolation.mjs.
//
// Cases:
//   1. MATCH             — a prompt that clears threshold+anchor emits a
//                          record with match:true and the matched ref present.
//   2. NO-MATCH          — a prompt with zero overlap ALSO emits a record,
//                          with match:false and an empty matched list. This
//                          is the non-vacuous case that motivated the item.
//   3. INDEX-UNAVAILABLE — a missing/empty keyword map is a FAULT ("recall
//                          could not run"), not a healthy no-match ("recall
//                          ran and found nothing relevant"). Per team-lead
//                          ruling it must emit a record with a distinct
//                          shape (status:'index_unavailable', NO match key
//                          at all) so it can never be conflated with case 2
//                          by a naive match:false count. Run via a spawned
//                          subprocess (not dynamic import) because
//                          loadKeywordMap() caches the map at module-singleton
//                          scope for the process lifetime — case 1/2 already
//                          populate that cache from the fixture map, so this
//                          case needs its own fresh process to observe a
//                          genuinely unloaded index.
//
// Run: node tests/v3/hooks/test-prism-lesson-match-logging.mjs

import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-lesson-match.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-lesson-match-log-home-'));
const PROJECT = mkdtempSync(join(tmpdir(), 'prism-lesson-match-log-proj-'));
const prevHome = process.env.HOME, prevProfile = process.env.USERPROFILE;
const prevDisable = process.env.PRISM_DISABLE_LESSON_MATCH;

function routingLogPath() {
  return join(HOME, '.claude', '.prism-routing.jsonl');
}

function routingLogRecords() {
  const p = routingLogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

// Single-entry fixture keyword map. With exactly one corpus entry, any shared
// token is definitionally corpus-DF<=1, so the D053 anchor gate is satisfied
// without touching threshold/anchor logic (out of scope per D083).
function writeFixtureMap() {
  const dir = join(PROJECT, '.claude', 'references');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.knowledge-keyword-map.json'), JSON.stringify({
    version: 1,
    entries: [{
      ref: 'D999',
      type: 'adjudication',
      title: 'D999 — Fixture Entry',
      relPath: 'docs/prism/adjudications/D999-fixture.md',
      rule: 'Fixture rule text for the logging test.',
      status: 'Locked',
      tokens: ['zzzqux', 'fixturewidget'],
      triggers: [],
    }],
  }));
}

try {
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.PRISM_DISABLE_LESSON_MATCH;
  writeFixtureMap();
  mkdirSync(join(HOME, '.claude'), {recursive: true});

  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.run === 'function', 'lesson-match must export run');

  await test('MATCH: a prompt that clears threshold+anchor emits a lesson_match record with match:true', async () => {
    const res = await mod.run({
      session_id: 'log-match',
      prompt: 'zzzqux fixturewidget',
      cwd: PROJECT,
    });
    assert(res.exit === 0, 'matching run must still exit 0');
    const recs = routingLogRecords().filter(r => r.session_id === 'log-match');
    assert(recs.length >= 1, 'a routing-log record must exist for the matching invocation');
    const rec = recs[recs.length - 1];
    assert(rec.event === 'lesson_match', `event must be lesson_match, got ${rec.event}`);
    assert(rec.match === true, 'match invocation must record match:true');
    assert(Array.isArray(rec.matched) && rec.matched.includes('D999'), 'matched refs must include D999');
  });

  await test('NO-MATCH: a prompt with zero overlap ALSO emits a lesson_match record, with match:false (the case that matters)', async () => {
    const res = await mod.run({
      session_id: 'log-nomatch',
      prompt: 'completely unrelated words about something else entirely',
      cwd: PROJECT,
    });
    assert(res.exit === 0, 'no-match run must still exit 0');
    assert(res.stdout === '', 'no-match run must not inject anything');
    const recs = routingLogRecords().filter(r => r.session_id === 'log-nomatch');
    assert(recs.length >= 1, 'a routing-log record must exist EVEN when nothing matched — this is the whole point of the item');
    const rec = recs[recs.length - 1];
    assert(rec.event === 'lesson_match', `event must be lesson_match, got ${rec.event}`);
    assert(rec.match === false, 'no-match invocation must record match:false');
    assert(Array.isArray(rec.matched) && rec.matched.length === 0, 'no-match invocation must record an empty matched list');
  });

  await test('INDEX-UNAVAILABLE: a missing keyword index emits a distinguishable fault record, NOT a match:false record', async () => {
    const emptyProject = mkdtempSync(join(tmpdir(), 'prism-lesson-match-log-noindex-'));
    try {
      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({session_id: 'log-noindex', prompt: 'zzzqux fixturewidget', cwd: emptyProject}),
        encoding: 'utf-8',
        env: {...process.env, HOME, USERPROFILE: HOME},
      });
      assert(res.status === 0, `spawned hook must exit 0, got ${res.status} / stderr: ${res.stderr}`);
      const recs = routingLogRecords().filter(r => r.session_id === 'log-noindex');
      assert(recs.length >= 1, 'a routing-log record must exist when the keyword index is unavailable — silence here is the same class of bug as no logging at all');
      const rec = recs[recs.length - 1];
      assert(rec.event === 'lesson_match', `event must be lesson_match, got ${rec.event}`);
      assert(rec.status === 'index_unavailable', `status must be index_unavailable, got ${rec.status}`);
      assert(!('match' in rec), 'index-unavailable record must NOT carry a match key — a fault must never be absorbed into a match:false count');
    } finally {
      rmSync(emptyProject, {recursive: true, force: true});
    }
  });
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  if (prevDisable === undefined) delete process.env.PRISM_DISABLE_LESSON_MATCH; else process.env.PRISM_DISABLE_LESSON_MATCH = prevDisable;
  rmSync(HOME, {recursive: true, force: true});
  rmSync(PROJECT, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
