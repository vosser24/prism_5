#!/usr/bin/env node
// D042 both-paths test for Finding 1c (merge-not-overwrite) — panel-53.
//
// PROBLEM
//   .claude/.prism-open-tasks.json is a CROSS-SESSION carryover pointer, but was
//   wholesale-overwritten from THIS session's snapshot only — so a task open but
//   untouched this session was silently dropped (BUG-5). 1c merges by task id.
//
// D042 TRIO (deterministic — nowMs is injected per case, no wall-clock reliance):
//   (a) carry-forward — prior pointer has #100 open (recent), session opens #200
//       and doesn't touch #100:
//         CURRENT overwrite => {200} only  (RED: #100 dropped)
//         FIXED merge       => {100(carried_from), 200}  (GREEN)
//   (b) age-cap — same #100 but nowMs is 24 days after its carried_from.ts:
//         FIXED merge drops #100 (zombie) => {200}
//   (c) completed-this-session — session reconstructed #100 (touched) but did not
//       leave it open:
//         FIXED merge does NOT carry #100 => {}
//
// WINDOW-BOUNDARY regression (data-loss bug found post-1c, this session):
//   (d) #100's TaskCreate lies OUTSIDE the scanned transcript window — this
//       session only ever issued a TaskUpdate on it (status-only is the common
//       trigger, but any long-lived task whose creation scrolled out of the
//       window hits this same path). extractTaskSnapshot() then reconstructs
//       #100 with subject/description defaulted to '' (never observed).
//         RECORD-WISE "session wins" (pre-fix) => subject/description BLANKED,
//           TASK-RECALL renders "(no subject) — (no description)" even though
//           the prior pointer had real values.
//         FIELD-WISE fix => subject/description fall back to the prior
//           pointer's populated values; status stays the session's fresh
//           value; record is tagged carried_from (fields were sourced from
//           the prior record, so the provenance tag applies).
//   (e) sanity companion to (d) — when the session DID observe a real subject/
//       description this session (e.g. it saw the TaskCreate, or issued a
//       TaskUpdate with a new subject), the session's own value must win over
//       the prior's, and no carried_from tag is applied.
//
// Slice 6 (Fix A): mergeOpenTasks now lives in the shared lib
// hooks/lib/prism-task-snapshot.mjs (importable directly — no data-URL slicing
// needed). The loader keeps the anti-divergence guarantee the old verbatim
// source-slice gave us by asserting the hook actually imports that lib.

import {readFileSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const HOOK_PATH = join(REPO_ROOT, 'hooks', 'prism-session-end.mjs');
const LIB_PATH = join(REPO_ROOT, 'hooks', 'lib', 'prism-task-snapshot.mjs');
const PRIOR_FIXTURE = join(HERE, 'fixtures', 'prism-open-tasks-prior.json');

async function loadMerge() {
  // Anti-divergence guard: the code under test must be the code the hook runs.
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8');
  assert.ok(hookSrc.includes("from './lib/prism-task-snapshot.mjs'"),
    'hook no longer imports the shared task-snapshot lib — tool/hook divergence risk');
  assert.ok(!hookSrc.includes('function mergeOpenTasks'),
    'hook still defines a local mergeOpenTasks — shadowing the shared lib');
  const mod = await import(pathToFileURL(LIB_PATH).href);
  assert.ok(typeof mod.mergeOpenTasks === 'function',
    'mergeOpenTasks not exported by the shared lib — 1c not implemented?');
  return mod.mergeOpenTasks;
}

const ids = (arr) => arr.map(t => String(t.id)).sort((a, b) => Number(a) - Number(b));
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  assert.ok(existsSync(PRIOR_FIXTURE), `fixture missing: ${PRIOR_FIXTURE}`);
  const mergeOpenTasks = await loadMerge();
  const prior = JSON.parse(readFileSync(PRIOR_FIXTURE, 'utf-8')); // #100 open, ts 2026-07-01
  const priorTs = Date.parse(prior.ts);
  const sessionB = [{id: '200', subject: 'this-session open task', description: '', activeForm: '', status: 'pending', blockedBy: null}];

  // ── (a) carry-forward ────────────────────────────────────────────────────
  const overwrite = ids(sessionB); // what the CURRENT wholesale write would persist
  console.log(`[a overwrite/current] open=${JSON.stringify(overwrite)}  <- #100 dropped (RED)`);
  assert.deepEqual(overwrite, ['200'], 'sanity: current overwrite persists only this session');

  const mergedA = mergeOpenTasks(prior, sessionB, new Set(['200']), priorTs + 1 * DAY);
  console.log(`[a merge/fixed]        open=${JSON.stringify(ids(mergedA))}`);
  assert.deepEqual(ids(mergedA), ['100', '200'], '(a) merge must carry #100 forward alongside #200');
  const carried = mergedA.find(t => String(t.id) === '100');
  assert.ok(carried.carried_from && carried.carried_from.session === 'sess-prior-001' && carried.carried_from.ts === prior.ts,
    '(a) carried #100 must be tagged carried_from = {session, ts} of the prior pointer');
  assert.ok(!mergedA.find(t => String(t.id) === '200').carried_from,
    '(a) this-session #200 must NOT carry a carried_from tag');

  // ── (b) age-cap (24 days > 14) ───────────────────────────────────────────
  const mergedB = mergeOpenTasks(prior, sessionB, new Set(['200']), priorTs + 24 * DAY);
  console.log(`[b age-cap 24d]        open=${JSON.stringify(ids(mergedB))}  <- #100 dropped (zombie)`);
  assert.deepEqual(ids(mergedB), ['200'], '(b) carried #100 older than 14d must be dropped');

  // ── (c) completed-this-session ───────────────────────────────────────────
  // session reconstructed #100 (touched) but did not leave it open (completed).
  const mergedC = mergeOpenTasks(prior, [], new Set(['100']), priorTs + 1 * DAY);
  console.log(`[c completed]          open=${JSON.stringify(ids(mergedC))}  <- #100 NOT carried`);
  assert.deepEqual(ids(mergedC), [], '(c) #100 completed this session must NOT be carried forward');

  // ── (d) window-boundary — #100's TaskCreate outside the scanned window ──
  // Session touched #100 (e.g. a status-only TaskUpdate) but never observed
  // its TaskCreate. Task #14 root-cause fix: extractTaskSnapshot() now
  // represents "never observed" as an ABSENT key, not a fabricated ''
  // (verified directly in tests/v3/hooks/test-task-snapshot-observed-fields.mjs
  // against the real extractor) — so subject/description are OMITTED here
  // entirely, matching what the fixed extractor actually produces (this
  // fixture used to set them to '' as a stand-in for "unobserved", which
  // mergeOpenTasks() no longer treats as the unobserved signal — see the
  // key-presence merge in hooks/lib/prism-task-snapshot.mjs). Prior pointer
  // has #100 with real subject/description populated (from the fixture).
  const sessionD = [{id: '100', activeForm: '', status: 'in_progress', blockedBy: null}];
  const mergedD = mergeOpenTasks(prior, sessionD, new Set(['100']), priorTs + 1 * DAY);
  const t100d = mergedD.find(t => String(t.id) === '100');
  console.log(`[d window-boundary]    subject=${JSON.stringify(t100d && t100d.subject)} description=${JSON.stringify(t100d && t100d.description)} status=${t100d && t100d.status}`);
  assert.ok(t100d, '(d) #100 must survive the merge');
  assert.equal(t100d.subject, prior.open_tasks[0].subject, '(d) unobserved empty subject must fall back to the prior populated value — not be blanked');
  assert.equal(t100d.description, prior.open_tasks[0].description, '(d) unobserved empty description must fall back to the prior populated value — not be blanked');
  assert.equal(t100d.status, 'in_progress', "(d) status must stay the SESSION's fresh value (session IS authoritative about status)");
  assert.ok(t100d.carried_from && t100d.carried_from.session === 'sess-prior-001', '(d) record sourced fields from the prior pointer must be tagged carried_from');

  // ── (e) sanity companion — session DID observe a real subject this session,
  // its own (different) value must win over the prior's, no carried_from tag.
  const sessionE = [{id: '100', subject: 'renamed this session', description: 'new description this session', activeForm: 'doing it', status: 'in_progress', blockedBy: null}];
  const mergedE = mergeOpenTasks(prior, sessionE, new Set(['100']), priorTs + 1 * DAY);
  const t100e = mergedE.find(t => String(t.id) === '100');
  console.log(`[e session-observed]   subject=${JSON.stringify(t100e && t100e.subject)} carried_from=${JSON.stringify(t100e && t100e.carried_from)}`);
  assert.equal(t100e.subject, 'renamed this session', "(e) session's own observed subject must win over the prior's");
  assert.equal(t100e.description, 'new description this session', "(e) session's own observed description must win over the prior's");
  assert.ok(!t100e.carried_from, '(e) a fully session-observed record must NOT be tagged carried_from');

  // fail-open sanity: null/garbage existing => this session's opens only.
  assert.deepEqual(ids(mergeOpenTasks(null, sessionB, new Set(['200']), Date.now())), ['200'], 'fail-open: null existing => session opens');
  assert.deepEqual(ids(mergeOpenTasks({open_tasks: 'garbage'}, sessionB, new Set(['200']), Date.now())), ['200'], 'fail-open: garbage existing => session opens');

  console.log('GREEN — 1c merge carries untouched prior opens, age-caps zombies, drops completed-this-session, field-wise fallback recovers unobserved subject/description across the window boundary without clobbering session-observed values, fail-open intact.');
}

main().catch((err) => {
  console.error('\nRED — ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
