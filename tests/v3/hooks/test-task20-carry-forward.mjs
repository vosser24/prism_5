#!/usr/bin/env node
// Task #20 — carry-forward defects A + B (hooks/lib/prism-task-snapshot.mjs).
//
// DEFECT A (SURFACE, not drop): a prior-pointer open task the session did NOT
// touch is carried forward (correct — it may be legitimately open across many
// sessions). The bug is it survives INDISTINGUISHABLY from a re-observed row.
// Fix: step-1 carries tag `carried_unverified: true`; a re-observed (touched)
// row must NOT be tagged (and must not inherit a stale marker from prior).
//
// DEFECT B (DETECT + FLAG, not namespace): task ids are per-session scoped;
// two sessions can reuse one id for different tasks. Fix: when a prior CARRIED
// cross-session row shares an id with a session-observed row whose subject
// CONFLICTS, record it on the optional `meta.id_collisions` out-param —
// WITHOUT changing merge behavior (so #14's rename back-fill stays intact).
//
// Do-not-regress: #44/#53/#55/#56 (real carried tasks) STILL survive the merge.
//
// Direct-import unit harness (no subprocess) — matches
// tests/v3/hooks/test-task-snapshot-observed-fields.mjs.

import {strict as assert} from 'node:assert';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(HERE, '..', '..', '..', 'hooks', 'lib', 'prism-task-snapshot.mjs');
const {mergeOpenTasks} = await import(pathToFileURL(LIB_PATH).href);

const DAY = 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
}

// ── DEFECT A ────────────────────────────────────────────────────────────────

test('A1: a carried-forward (untouched) row is tagged carried_unverified:true', () => {
  const priorTs = Date.parse('2026-07-10T00:00:00Z');
  const prior = {
    session_id: 'sess-A', ts: '2026-07-10T00:00:00Z',
    open_tasks: [
      {id: '44', subject: 'real open task 44', description: 'd44', activeForm: '', status: 'in_progress', blockedBy: null},
    ],
  };
  // Session B touches only #14; #44 is carried forward untouched.
  const sessionB = [{id: '14', subject: 't14', description: 'd14', activeForm: '', status: 'in_progress', blockedBy: null}];
  const merged = mergeOpenTasks(prior, sessionB, new Set(['14']), priorTs + 1 * DAY);
  const t44 = merged.find(t => String(t.id) === '44');
  assert.ok(t44, '#44 must survive (carried forward)');
  assert.equal(t44.carried_unverified, true,
    '#44 carried-untouched MUST be tagged carried_unverified:true (distinguishes from re-observed)');
  const t14 = merged.find(t => String(t.id) === '14');
  assert.ok(!t14.carried_unverified,
    'a re-observed (touched) row must NOT be tagged carried_unverified');
});

test('A2: re-observing a carried_unverified row CLEARS the marker (not inherited from prior)', () => {
  const priorTs = Date.parse('2026-07-10T00:00:00Z');
  // Prior pointer already carries #44 as carried_unverified (from an earlier carry).
  const prior = {
    session_id: 'sess-B', ts: '2026-07-10T00:00:00Z',
    open_tasks: [
      {id: '44', subject: 'real open task 44', description: 'd44', activeForm: '', status: 'in_progress',
       blockedBy: null, carried_from: {session: 'sess-A', ts: '2026-07-09T00:00:00Z'}, carried_unverified: true},
    ],
  };
  // Session C now actually observes/touches #44 (status-only touch → subject absent).
  const sessionC = [{id: '44', activeForm: '', status: 'in_progress', blockedBy: null}];
  const merged = mergeOpenTasks(prior, sessionC, new Set(['44']), priorTs + 1 * DAY);
  const t44 = merged.find(t => String(t.id) === '44');
  assert.ok(t44, '#44 must survive');
  assert.ok(!t44.carried_unverified,
    'a re-observed row must NOT inherit the prior carried_unverified marker');
  // #14 do-not-regress companion: prior subject/description still back-filled.
  assert.equal(t44.subject, 'real open task 44', 'rename/status-only touch still back-fills prior subject (#14 preserved)');
  assert.equal(t44.description, 'd44', 'still back-fills prior description (#14 preserved)');
});

test('A3 (do-not-regress): #44/#53/#55/#56 all survive the merge with statuses', () => {
  const priorTs = Date.parse('2026-07-17T09:09:50Z');
  const prior = {
    session_id: '7fa44bcc', ts: '2026-07-17T09:09:50.031Z',
    open_tasks: [
      {id: '44', subject: 's44', description: 'd44', activeForm: '', status: 'in_progress', blockedBy: null},
      {id: '53', subject: 's53', description: 'd53', activeForm: '', status: 'in_progress', blockedBy: null},
      {id: '55', subject: 's55', description: 'd55', activeForm: '', status: 'in_progress', blockedBy: null},
      {id: '56', subject: 's56', description: 'd56', activeForm: '', status: 'pending', blockedBy: null},
    ],
  };
  // Session touches only #14/#16 — none of the four.
  const session = [
    {id: '14', subject: 't14', description: 'd', activeForm: '', status: 'in_progress', blockedBy: null},
    {id: '16', subject: 't16', description: 'd', activeForm: '', status: 'in_progress', blockedBy: null},
  ];
  const merged = mergeOpenTasks(prior, session, new Set(['14', '16']), priorTs + 1 * DAY);
  for (const [id, st] of [['44', 'in_progress'], ['53', 'in_progress'], ['55', 'in_progress'], ['56', 'pending']]) {
    const t = merged.find(x => String(x.id) === id);
    assert.ok(t, `#${id} must survive the merge`);
    assert.equal(t.status, st, `#${id} status preserved as ${st}`);
    assert.equal(t.carried_unverified, true, `#${id} correctly labeled carried_unverified`);
  }
});

// ── DEFECT B ────────────────────────────────────────────────────────────────

test('B1: cross-session id reuse (conflicting subject) is flagged on meta.id_collisions', () => {
  const priorTs = Date.parse('2026-07-14T00:00:00Z');
  // Prior pointer carried #19 from session A ("PHASE 4 advisories").
  const prior = {
    session_id: 'carrier', ts: '2026-07-14T00:00:00Z',
    open_tasks: [
      {id: '19', subject: 'PHASE 4 — soft-first advisories', description: 'phase4 desc', activeForm: '',
       status: 'in_progress', blockedBy: null, carried_from: {session: '1927f358', ts: '2026-07-14T00:00:00Z'}},
    ],
  };
  // Session B independently observes #19 as a DIFFERENT task.
  const sessionB = [{id: '19', subject: 'knowledge-index parseSingleFile bug', description: 'ki desc',
                     activeForm: '', status: 'in_progress', blockedBy: null}];
  const meta = {};
  const merged = mergeOpenTasks(prior, sessionB, new Set(['19']), priorTs + 1 * DAY, 14, meta);
  assert.ok(Array.isArray(meta.id_collisions) && meta.id_collisions.length === 1,
    `expected 1 id_collision recorded, got ${JSON.stringify(meta.id_collisions)}`);
  const c = meta.id_collisions[0];
  assert.equal(c.id, '19', 'collision id === 19');
  assert.equal(c.prior_session, '1927f358', 'records the prior session');
  assert.ok(/PHASE 4/.test(c.prior_subject) && /knowledge-index/.test(c.session_subject),
    'records both subjects for human disambiguation');
  // Behavior UNCHANGED: session #19 still wins (merge not suppressed).
  const t19 = merged.find(t => String(t.id) === '19');
  assert.equal(t19.subject, 'knowledge-index parseSingleFile bug', 'session record still wins (merge preserved)');
});

test('B2: NO false collision flag on a normal status-only continuation (no observed subject conflict)', () => {
  const priorTs = Date.parse('2026-07-14T00:00:00Z');
  const prior = {
    session_id: 'carrier', ts: '2026-07-14T00:00:00Z',
    open_tasks: [
      {id: '19', subject: 'same task', description: 'd', activeForm: '', status: 'pending', blockedBy: null,
       carried_from: {session: 'sess-A', ts: '2026-07-14T00:00:00Z'}},
    ],
  };
  // Session observes #19 status-only (subject absent) — must NOT be flagged.
  const session = [{id: '19', activeForm: '', status: 'in_progress', blockedBy: null}];
  const meta = {};
  mergeOpenTasks(prior, session, new Set(['19']), priorTs + 1 * DAY, 14, meta);
  assert.ok(!meta.id_collisions || meta.id_collisions.length === 0,
    `status-only continuation must NOT flag a collision, got ${JSON.stringify(meta.id_collisions)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
