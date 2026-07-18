#!/usr/bin/env node
// Task #14 — root-cause fix: extractTaskSnapshot()'s upsert() must stop
// FABRICATING a default value for a field it never observed, and mergeOpenTasks()
// must resolve an unobserved field from the prior pointer generically (no
// FALLBACK_FIELDS allowlist). This is D047's vacuous-signal class: the pre-fix
// code could not tell "observed pending" from "defaulted pending" — same shape,
// two different meanings, collapsed into one value.
//
// MEASURED (task #14, case 4, against the shipped v6.5.0 code): a task
// created + set in_progress + given an activeForm + a blockedBy list in one
// session, then touched by a RENAME-ONLY TaskUpdate (subject only) in a LATER
// session whose transcript never saw the original TaskCreate/TaskUpdates —
//   status      in_progress -> pending     REGRESSED
//   activeForm  'Doing thing 4 actively' -> ''   WIPED
//   blockedBy   ['7','8'] -> null          WIPED
//   subject/description -> correctly preserved (d8bfe698b's fix already covers these)
//
// This file reproduces that exact shape end-to-end using the REAL
// extractTaskSnapshot() + mergeOpenTasks() (not hand-rolled merge-only
// fixtures — that was the self-chosen-denominator gap flagged in task #14:
// tests/v3/hooks/test-session-end-task-snapshot-merge.mjs hand-crafts already
//-collapsed "session snapshot" objects and never exercises the extractor
// that actually produces the defaulting bug).

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const LIB_PATH = join(REPO_ROOT, 'hooks', 'lib', 'prism-task-snapshot.mjs');

const {extractTaskSnapshot, mergeOpenTasks} = await import(pathToFileURL(LIB_PATH).href);

// ── synthetic transcript-line builders (real wire shape) ────────────────────
let tu = 0;
const nextId = () => `tu_${++tu}`;

function taskCreateLines(id, {subject, description, activeForm}) {
  const call = nextId();
  return [
    JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [
      {type: 'tool_use', id: call, name: 'TaskCreate', input: {subject, description, activeForm}},
    ]}}),
    JSON.stringify({type: 'user', message: {role: 'user', content: [
      {type: 'tool_result', tool_use_id: call, content: `Created task #${id}`},
    ]}, toolUseResult: {task: {id, subject}}}),
  ];
}

function taskUpdateLines(id, input, {statusChange = null, updatedFields = Object.keys(input)} = {}) {
  const call = nextId();
  const tur = {success: true, taskId: id, updatedFields};
  if (statusChange) tur.statusChange = statusChange;
  return [
    JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [
      {type: 'tool_use', id: call, name: 'TaskUpdate', input: {taskId: id, ...input}},
    ]}}),
    JSON.stringify({type: 'user', message: {role: 'user', content: [
      {type: 'tool_result', tool_use_id: call, content: `Updated task #${id}`},
    ]}, toolUseResult: tur}),
  ];
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — unit level: extractTaskSnapshot's own output must represent
// "never observed" as an ABSENT key, not a fabricated value.
// ═══════════════════════════════════════════════════════════════════════════

const session1Lines = [
  ...taskCreateLines('501', {subject: 'Investigate flaky CI', description: 'CI flakes ~1/20 runs on the auth suite.', activeForm: 'Investigating flaky CI'}),
  ...taskUpdateLines('501', {status: 'in_progress'}, {statusChange: {from: 'pending', to: 'in_progress'}}),
  ...taskUpdateLines('501', {blockedBy: ['7', '8']}),
];

test('session 1 (full history): task 501 has ALL five fields observed', () => {
  const tasks = extractTaskSnapshot(session1Lines);
  const t = tasks.find(x => x.id === '501');
  assert.ok(t, 'task 501 reconstructed');
  assert.equal(t.subject, 'Investigate flaky CI');
  assert.equal(t.description, 'CI flakes ~1/20 runs on the auth suite.');
  assert.equal(t.activeForm, 'Investigating flaky CI');
  assert.equal(t.status, 'in_progress');
  assert.deepEqual(t.blockedBy, ['7', '8']);
});

const session2Lines = taskUpdateLines('501', {subject: 'Investigate flaky CI (renamed)'});

test('session 2 (rename-only, NO knowledge of the TaskCreate/earlier updates): unobserved fields are ABSENT keys, not fabricated values', () => {
  const tasks = extractTaskSnapshot(session2Lines);
  const t = tasks.find(x => x.id === '501');
  assert.ok(t, 'task 501 reconstructed from the rename-only update alone');
  assert.equal(t.subject, 'Investigate flaky CI (renamed)', 'subject IS observed this scan');
  assert.ok(!('status' in t), 'status must be ABSENT (never observed this scan) — NOT fabricated "pending"');
  assert.ok(!('activeForm' in t), 'activeForm must be ABSENT — NOT fabricated ""');
  assert.ok(!('blockedBy' in t), 'blockedBy must be ABSENT — NOT fabricated null');
  assert.ok(!('description' in t), 'description must be ABSENT — NOT fabricated ""');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — full pipeline: session 1's reconstruction becomes the prior
// pointer; session 2's rename-only touch must PRESERVE status/activeForm/
// blockedBy through mergeOpenTasks(), and correctly update subject. This is
// the literal task #14 "case 4" measured regression, reproduced end-to-end.
// ═══════════════════════════════════════════════════════════════════════════

function candidatesFor(lines) {
  // Mirrors hooks/prism-session-end.mjs's (fixed) candidacy filter: not
  // explicitly closed this session — undefined status passes through.
  return extractTaskSnapshot(lines)
    .filter(t => t.status === undefined || t.status === 'pending' || t.status === 'in_progress');
}

test('CASE 4 (task #14): rename-only TaskUpdate must PRESERVE status/activeForm/blockedBy, not regress/wipe them', () => {
  const session1Candidates = candidatesFor(session1Lines);
  const session1TouchedIds = new Set(extractTaskSnapshot(session1Lines).map(t => String(t.id)));
  // What session 1's own SessionEnd run would have persisted as the pointer.
  const priorOpenTasks = mergeOpenTasks(null, session1Candidates, session1TouchedIds, Date.parse('2026-07-01T00:00:00Z'));
  const priorPayload = {session_id: 'sess-1', project: '/fake/project', ts: '2026-07-01T00:00:00.000Z', open_tasks: priorOpenTasks};

  const t501prior = priorOpenTasks.find(t => t.id === '501');
  assert.ok(t501prior, 'sanity: session 1 correctly persisted task 501 as open');
  assert.equal(t501prior.status, 'in_progress');
  assert.equal(t501prior.activeForm, 'Investigating flaky CI');
  assert.deepEqual(t501prior.blockedBy, ['7', '8']);

  // Session 2: a LATER session, separate transcript, rename-only touch.
  const session2Candidates = candidatesFor(session2Lines);
  const session2TouchedIds = new Set(extractTaskSnapshot(session2Lines).map(t => String(t.id)));
  const merged = mergeOpenTasks(priorPayload, session2Candidates, session2TouchedIds, Date.parse('2026-07-10T00:00:00Z'));

  const t501 = merged.find(t => t.id === '501');
  assert.ok(t501, 'task 501 must survive the merge (not silently dropped)');
  assert.equal(t501.subject, 'Investigate flaky CI (renamed)', "session's fresh rename must win");
  assert.equal(t501.description, 'CI flakes ~1/20 runs on the auth suite.', 'description preserved from prior (unobserved this session) — guards d8bfe698b regression');
  assert.equal(t501.status, 'in_progress', `status must be PRESERVED from prior, not regressed to 'pending' — got ${JSON.stringify(t501.status)}`);
  assert.equal(t501.activeForm, 'Investigating flaky CI', `activeForm must be PRESERVED, not wiped to '' — got ${JSON.stringify(t501.activeForm)}`);
  assert.deepEqual(t501.blockedBy, ['7', '8'], `blockedBy must be PRESERVED, not wiped to null — got ${JSON.stringify(t501.blockedBy)}`);
  assert.ok(t501.carried_from, 'record sourced fields from the prior pointer must be tagged carried_from');
});

test('regression guard: description-ONLY rename update must preserve subject (the other direction of d8bfe698b\'s original fix)', () => {
  const session1Candidates = candidatesFor(session1Lines);
  const session1TouchedIds = new Set(extractTaskSnapshot(session1Lines).map(t => String(t.id)));
  const priorOpenTasks = mergeOpenTasks(null, session1Candidates, session1TouchedIds, Date.parse('2026-07-01T00:00:00Z'));
  const priorPayload = {session_id: 'sess-1', project: '/fake/project', ts: '2026-07-01T00:00:00.000Z', open_tasks: priorOpenTasks};

  const session3Lines = taskUpdateLines('501', {description: 'Root-caused: a shared runner image had a stale DNS cache.'});
  const session3Candidates = candidatesFor(session3Lines);
  const session3TouchedIds = new Set(extractTaskSnapshot(session3Lines).map(t => String(t.id)));
  const merged = mergeOpenTasks(priorPayload, session3Candidates, session3TouchedIds, Date.parse('2026-07-11T00:00:00Z'));

  const t501 = merged.find(t => t.id === '501');
  assert.ok(t501, 'task 501 must survive the merge');
  assert.equal(t501.subject, 'Investigate flaky CI', 'subject preserved from prior (unobserved this session)');
  assert.equal(t501.description, 'Root-caused: a shared runner image had a stale DNS cache.', "session's fresh description must win");
  assert.equal(t501.status, 'in_progress', 'status still preserved');
  assert.equal(t501.activeForm, 'Investigating flaky CI', 'activeForm still preserved');
  assert.deepEqual(t501.blockedBy, ['7', '8'], 'blockedBy still preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — the zombie the pipeline can actually REACH (task #14 F1).
//
// Two distinct shapes, tested separately and honestly:
//   (a) a CORRUPTED prior pointer that still lists a terminal task as "open"
//       (hand-edited / schema-migrated / foreign tool) — step 3 path (a).
//   (b) the REACHABLE shape (F1, verifier PROBE H): the prior pointer OMITS a
//       prior-session-completed task entirely (a completed task is filtered
//       out of open_tasks at write time, so it is genuinely ABSENT), then a
//       later session does a rename-only touch. With NO prior record and NO
//       observed status, fabricating status:'pending' would be an
//       assertion-of-open from zero evidence — D047's vacuous signal at the
//       pipeline's last step. Such a task is UNKNOWN, not open, and must be
//       excluded, not resurrected.
// ═══════════════════════════════════════════════════════════════════════════

test('zombie guard — path (a), CORRUPTED prior: a prior pointer that still lists #99 as open with a terminal status must NOT survive the merge', () => {
  // A completed task is normally ABSENT from open_tasks, so this exact input is
  // only reachable via a hand-edited / schema-migrated / foreign-tool pointer.
  // It exercises step 3's "prior status resolves to terminal" defense-in-depth
  // branch directly — NOT the reachable shape (that is the next test).
  const priorPayload = {
    session_id: 'sess-corrupt', project: '/fake/project', ts: '2026-07-01T00:00:00.000Z',
    open_tasks: [{id: '99', subject: 'Old completed task', description: 'done', activeForm: '', status: 'completed', blockedBy: null}],
  };
  const renameLines = taskUpdateLines('99', {subject: 'renamed'});
  const candidates = candidatesFor(renameLines);
  const touched = new Set(extractTaskSnapshot(renameLines).map(t => String(t.id)));
  const merged = mergeOpenTasks(priorPayload, candidates, touched, Date.parse('2026-07-11T00:00:00Z'));
  assert.ok(!merged.find(t => t.id === '99'), 'a task resolving to a terminal prior status must be dropped, not resurrected');
});

test('REACHABLE zombie — path (b), F1/PROBE H: prior pointer OMITS a prior-session-completed #99; a later rename-only touch must NOT fabricate it back to open', () => {
  // Session A completed #99 → its SessionEnd write filtered #99 out, so the
  // persisted pointer does NOT contain #99 at all (the REACHABLE shape).
  // Session B then does a rename-only TaskUpdate for #99 whose transcript never
  // saw the create — extractTaskSnapshot yields {id:'99', subject:...} with NO
  // status key. With no prior record to source a status from, the merge must
  // treat #99 as UNKNOWN (never-observed), NOT fabricate status:'pending'.
  const priorPayload = {
    session_id: 'sess-A', project: '/fake/project', ts: '2026-07-01T00:00:00.000Z',
    open_tasks: [{id: '1', subject: 'Unrelated still-open task', description: 'd', activeForm: '', status: 'pending', blockedBy: null}],
  };
  const renameLines = taskUpdateLines('99', {subject: 'renamed by a later session'});
  const candidates = candidatesFor(renameLines);
  const touched = new Set(extractTaskSnapshot(renameLines).map(t => String(t.id)));
  const merged = mergeOpenTasks(priorPayload, candidates, touched, Date.parse('2026-07-11T00:00:00Z'));
  const z = merged.find(t => String(t.id) === '99');
  assert.ok(!z,
    `#99 has NO prior record and NO observed status — it is UNKNOWN, not open. ` +
    `Fabricating status:'pending' from zero evidence resurrects it (D047). Got: ${JSON.stringify(z)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — generic prior-fallback (task #14 F2). The prior-fallback must NOT be
// driven by a hardcoded field allowlist (FALLBACK_FIELDS/ALL_FIELDS): a prior
// field outside any such list must still survive an unobserved-field merge.
// ═══════════════════════════════════════════════════════════════════════════

test('generic prior-fallback (F2): a prior field OUTSIDE any schema list must be carried, not dropped by an allowlist', () => {
  // 'priority' is deliberately a field NO FALLBACK_FIELDS/ALL_FIELDS list
  // contains — the merge must carry it from the prior record generically,
  // exactly as it carries status/activeForm/blockedBy.
  const priorPayload = {
    session_id: 'sess-A', project: '/fake/project', ts: '2026-07-01T00:00:00.000Z',
    open_tasks: [{id: '5', subject: 'Task five', description: 'desc', activeForm: 'Doing five', status: 'in_progress', blockedBy: null, priority: 'high'}],
  };
  const renameLines = taskUpdateLines('5', {subject: 'Task five (renamed)'});
  const candidates = candidatesFor(renameLines);
  const touched = new Set(extractTaskSnapshot(renameLines).map(t => String(t.id)));
  const merged = mergeOpenTasks(priorPayload, candidates, touched, Date.parse('2026-07-11T00:00:00Z'));
  const t5 = merged.find(t => String(t.id) === '5');
  assert.ok(t5, 'task 5 survives the merge');
  assert.equal(t5.subject, 'Task five (renamed)', 'session rename wins');
  assert.equal(t5.status, 'in_progress', 'unobserved status falls back to the prior record');
  assert.ok('priority' in t5, "prior-only field 'priority' must be carried generically, not dropped by an allowlist");
  assert.equal(t5.priority, 'high', "prior 'priority' value preserved");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
