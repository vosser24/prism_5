#!/usr/bin/env node
// Unit tests for tools/lib/prism-state.mjs
// Run: node tests/v3/state/test-prism-state.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// No external test runner — keeps Phase 1 deliverable self-contained.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  MAX_PHASE_FAILURES,
  PHASES,
  PHASE_STATUSES,
  PRISM_VERSION,
  SCHEMA_VERSION,
  computeChecksum,
  createInitialState,
  getStatePath,
  isPhaseCompleted,
  markPhaseCompleted,
  markPhaseFailed,
  markPhaseStarted,
  migrateV1ToV2,
  nowIso,
  readState,
  setLastCommand,
  setProjectSlug,
  setSyncStamps,
  synthesizeFromFilesystem,
  validateState,
  verifyChecksum,
  writeStateAtomic,
} from '../../../tools/lib/prism-state.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('  ok  ' + name + '\n');
  } catch (e) {
    failed++;
    failures.push({name, error: e});
    process.stdout.write('  FAIL ' + name + '\n        ' + (e.stack || e.message || e) + '\n');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('assertion failed: ' + (msg || ''));
}
function assertEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error('expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a) + (msg ? ' — ' + msg : ''));
  }
}

function makeTmpRoot(label) {
  return mkdtempSync(join(tmpdir(), `prism-state-test-${label}-`));
}

// ------------------------------------------------------------ schema basics

test('createInitialState produces valid object', () => {
  const s = createInitialState('proj');
  assertEq(s.schema_version, SCHEMA_VERSION);
  assertEq(s.prism_version, PRISM_VERSION);
  assertEq(s.project_name, 'proj');
  assertEq(s.last_sync_at, null);
  assertEq(s.next_sync_recommended, null);
  assertEq(s.last_command, null);
  assertEq(s.phase_failures, []);
  for (const p of PHASES) {
    assert(s.phases[p], `phase ${p} present`);
    assertEq(s.phases[p].completed_at, null);
  }
});

test('validateState passes on initial state', () => {
  const s = createInitialState('proj');
  const v = validateState(s);
  assert(v.ok, v.errors.join(';'));
});

test('validateState catches schema_version=0', () => {
  const s = createInitialState('proj');
  s.schema_version = 0;
  const v = validateState(s);
  assert(!v.ok);
});

test('validateState catches non-ISO date', () => {
  const s = createInitialState('proj');
  s.initialized_at = '2026-05-06 12:00:00';
  const v = validateState(s);
  assert(!v.ok);
});

test('validateState catches missing phase', () => {
  const s = createInitialState('proj');
  delete s.phases.discovery;
  const v = validateState(s);
  assert(!v.ok);
});

test('validateState catches phase_failures over cap', () => {
  const s = createInitialState('proj');
  s.phase_failures = new Array(MAX_PHASE_FAILURES + 1).fill({phase: 'identity', at: nowIso(), error: 'x'});
  const v = validateState(s);
  assert(!v.ok);
});

// ------------------------------------------------------------ checksum

test('computeChecksum is deterministic', () => {
  const s = createInitialState('proj');
  const a = computeChecksum(s);
  const b = computeChecksum(s);
  assertEq(a, b);
  assert(/^[0-9a-f]{64}$/.test(a), 'sha256 hex');
});

test('checksum ignores its own field', () => {
  const s = createInitialState('proj');
  const a = computeChecksum({...s, checksum: 'aaa'});
  const b = computeChecksum({...s, checksum: 'bbb'});
  assertEq(a, b);
});

test('checksum invariant under key reorder', () => {
  const s = createInitialState('proj');
  const reordered = {};
  for (const k of Object.keys(s).reverse()) reordered[k] = s[k];
  assertEq(computeChecksum(s), computeChecksum(reordered));
});

test('checksum changes when payload changes', () => {
  const s = createInitialState('proj');
  const a = computeChecksum(s);
  const b = computeChecksum({...s, project_name: 'other'});
  assert(a !== b);
});

test('verifyChecksum detects tampering', () => {
  const s = createInitialState('proj');
  s.checksum = computeChecksum(s);
  assert(verifyChecksum(s));
  s.project_name = 'tampered';
  assert(!verifyChecksum(s));
});

// ------------------------------------------------------------ mutators

test('markPhaseCompleted is idempotent (re-running same phase = safe no-op semantics)', () => {
  let s = createInitialState('proj');
  s = markPhaseCompleted(s, 'identity', {claude_md_lines: 200});
  const t1 = s.phases.identity.completed_at;
  // Re-run same phase — must not throw, must not regress fields. Timestamp may advance.
  s = markPhaseCompleted(s, 'identity', {claude_md_lines: 210});
  assert(s.phases.identity.completed_at >= t1);
  assertEq(s.phases.identity.claude_md_lines, 210);
  // Other phases untouched
  for (const p of PHASES) {
    if (p !== 'identity') assertEq(s.phases[p].completed_at, null);
  }
});

test('markPhaseCompleted rejects unknown phase', () => {
  const s = createInitialState('proj');
  let threw = false;
  try { markPhaseCompleted(s, 'bogus'); } catch { threw = true; }
  assert(threw);
});

test('markPhaseCompleted clears matching last_command', () => {
  let s = createInitialState('proj');
  s = setLastCommand(s, 'discovery:scanning');
  s = markPhaseCompleted(s, 'discovery');
  assertEq(s.last_command, null);
});

test('markPhaseFailed appends and caps at 10', () => {
  let s = createInitialState('proj');
  for (let i = 0; i < MAX_PHASE_FAILURES + 5; i++) {
    s = markPhaseFailed(s, 'discovery', `err${i}`);
  }
  assertEq(s.phase_failures.length, MAX_PHASE_FAILURES);
  assertEq(s.phase_failures[s.phase_failures.length - 1].error, `err${MAX_PHASE_FAILURES + 4}`);
  assertEq(s.phase_failures[0].error, `err5`);
});

test('setSyncStamps sets last_sync_at + next_sync_recommended', () => {
  let s = createInitialState('proj');
  const at = '2026-05-06T12:00:00.000Z';
  const next = '2026-05-13T12:00:00.000Z';
  s = setSyncStamps(s, {at, nextRecommended: next});
  assertEq(s.last_sync_at, at);
  assertEq(s.next_sync_recommended, next);
  assertEq(s.last_run, at);
});

test('isPhaseCompleted reflects completed_at presence', () => {
  let s = createInitialState('proj');
  assert(!isPhaseCompleted(s, 'identity'));
  s = markPhaseCompleted(s, 'identity');
  assert(isPhaseCompleted(s, 'identity'));
});

// ------------------------------------------------------------ atomic write/read round-trip

test('writeStateAtomic + readState round-trip', () => {
  const root = makeTmpRoot('rt');
  try {
    const s = createInitialState('rt');
    const result = writeStateAtomic(root, s);
    assert(existsSync(result.path));
    const loaded = readState(root);
    assertEq(loaded.status, 'ok');
    assertEq(loaded.state.project_name, 'rt');
    assert(verifyChecksum(loaded.state));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('writeStateAtomic produces UTF-8 with no BOM and LF line ending', () => {
  const root = makeTmpRoot('utf8');
  try {
    const s = createInitialState('rt');
    const {path} = writeStateAtomic(root, s);
    const buf = readFileSync(path);
    // UTF-8 BOM is EF BB BF
    assert(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), 'no BOM');
    // Trailing LF
    assertEq(buf[buf.length - 1], 0x0a, 'trailing LF');
    // No CR
    assert(!buf.includes(0x0d), 'no CR bytes');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('writeStateAtomic refuses invalid state', () => {
  const root = makeTmpRoot('inv');
  try {
    const s = createInitialState('rt');
    s.schema_version = 0;
    let threw = false;
    try { writeStateAtomic(root, s); } catch { threw = true; }
    assert(threw);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('writeStateAtomic creates .claude dir if missing', () => {
  const root = makeTmpRoot('mkdir');
  try {
    assert(!existsSync(join(root, '.claude')));
    const s = createInitialState('rt');
    writeStateAtomic(root, s);
    assert(existsSync(join(root, '.claude')));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('writeStateAtomic does not leak temp files on success', () => {
  const root = makeTmpRoot('tmp');
  try {
    const s = createInitialState('rt');
    writeStateAtomic(root, s);
    const dir = join(root, '.claude');
    const files = readdirSync(dir);
    const tmps = files.filter(f => f.includes('.tmp.'));
    assertEq(tmps.length, 0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ failure modes on read

test('readState: missing file', () => {
  const root = makeTmpRoot('missing');
  try {
    const r = readState(root);
    assertEq(r.status, 'missing');
    assertEq(r.state, null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('readState: invalid JSON', () => {
  const root = makeTmpRoot('badjson');
  try {
    mkdirSync(join(root, '.claude'), {recursive: true});
    writeFileSync(getStatePath(root), '{not valid json');
    const r = readState(root);
    assertEq(r.status, 'invalid_json');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('readState: invalid schema', () => {
  const root = makeTmpRoot('badschema');
  try {
    mkdirSync(join(root, '.claude'), {recursive: true});
    writeFileSync(getStatePath(root), JSON.stringify({foo: 'bar'}));
    const r = readState(root);
    assertEq(r.status, 'invalid_schema');
    assert(r.errors.length > 0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('readState: checksum mismatch (tampered file)', () => {
  const root = makeTmpRoot('tamper');
  try {
    const s = createInitialState('proj');
    writeStateAtomic(root, s);
    const path = getStatePath(root);
    const raw = readFileSync(path, 'utf8');
    const obj = JSON.parse(raw);
    obj.project_name = 'tampered';
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
    const r = readState(root);
    assertEq(r.status, 'checksum_mismatch');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ crash mid-write simulation

test('crash mid-write: original file is preserved if temp write fails before rename', () => {
  const root = makeTmpRoot('crash');
  try {
    // Write a known-good baseline.
    let s = createInitialState('baseline');
    writeStateAtomic(root, s);
    const baselineBytes = readFileSync(getStatePath(root));

    // Simulate a "crash" by leaving a stray .tmp file in .claude/ — should not affect read.
    const stray = getStatePath(root) + '.tmp.99999.deadbeef';
    writeFileSync(stray, 'partial garbage not ever renamed in');
    // Read should still return ok from the original file.
    const r = readState(root);
    assertEq(r.status, 'ok');
    assertEq(r.state.project_name, 'baseline');
    // Original bytes unchanged.
    const after = readFileSync(getStatePath(root));
    assertEq(after.equals(baselineBytes), true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('crash mid-write: subsequent successful write recovers cleanly', () => {
  const root = makeTmpRoot('recov');
  try {
    let s = createInitialState('v1');
    writeStateAtomic(root, s);
    // Stray temp file from a hypothetical earlier crash.
    writeFileSync(getStatePath(root) + '.tmp.42.cafebabe', 'junk');
    // New successful write — should produce valid readable state.
    s = markPhaseCompleted(s, 'identity', {claude_md_lines: 100});
    writeStateAtomic(root, s);
    const r = readState(root);
    assertEq(r.status, 'ok');
    assert(isPhaseCompleted(r.state, 'identity'));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ detect-and-adopt

test('synthesizeFromFilesystem: empty project → no phases marked complete', () => {
  const root = makeTmpRoot('empty');
  try {
    const s = synthesizeFromFilesystem(root);
    for (const p of PHASES) assertEq(s.phases[p].completed_at, null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('synthesizeFromFilesystem: v3.8.9-style tree synthesizes appropriate phases', () => {
  const root = makeTmpRoot('v389');
  try {
    // Simulate a v3.8.9 project: CLAUDE.md, .claude/{references,rules,agents}/
    writeFileSync(join(root, 'CLAUDE.md'), '# project\n');
    mkdirSync(join(root, '.claude', 'references'), {recursive: true});
    writeFileSync(join(root, '.claude', 'references', 'codebase.md'), '# refs\n');
    mkdirSync(join(root, '.claude', 'rules'), {recursive: true});
    mkdirSync(join(root, '.claude', 'agents'), {recursive: true});
    writeFileSync(join(root, '.claude', 'agents', 'roster.json'), '[]');

    const s = synthesizeFromFilesystem(root);
    const v = validateState({...s, checksum: computeChecksum(s)});
    assert(v.ok, v.errors.join(';'));
    assert(s.phases.identity.completed_at, 'identity');
    assert(s.phases.structure.completed_at, 'structure');
    assert(s.phases.discovery.completed_at, 'discovery');
    assert(s.phases.roster.completed_at, 'roster');
    assertEq(s.phases.health.completed_at, null);
    assertEq(s.phases.identity.synthesized, true);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('synthesizeFromFilesystem: derives project name from directory', () => {
  const root = makeTmpRoot('namederive');
  try {
    const s = synthesizeFromFilesystem(root);
    assert(typeof s.project_name === 'string' && s.project_name.length > 0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ idempotency end-to-end

test('full bootstrap + re-run is idempotent', () => {
  const root = makeTmpRoot('idem');
  try {
    let s = createInitialState('idem');
    writeStateAtomic(root, s);
    // First run: mark all phases.
    for (const p of PHASES) {
      s = readState(root).state;
      s = markPhaseCompleted(s, p, {n: p.length});
      writeStateAtomic(root, s);
    }
    const firstSnapshot = JSON.parse(readFileSync(getStatePath(root), 'utf8'));
    // Second "run" — re-mark same phases. Should be safe; checksum will refresh
    // because last_run advances, but structure must remain valid.
    for (const p of PHASES) {
      s = readState(root).state;
      s = markPhaseCompleted(s, p, {n: p.length});
      writeStateAtomic(root, s);
    }
    const r = readState(root);
    assertEq(r.status, 'ok');
    for (const p of PHASES) assert(isPhaseCompleted(r.state, p));
    // Ensure no failures accumulated
    assertEq(r.state.phase_failures.length, 0);
    // Phase metadata preserved
    for (const p of PHASES) assertEq(r.state.phases[p].n, p.length);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ v2 schema (Phase B)

test('SCHEMA_VERSION is 2 and PHASES has 7 entries', () => {
  assertEq(SCHEMA_VERSION, 2);
  assertEq(PHASES.length, 7);
  assert(PHASES.includes('plugin-validate'));
  assert(PHASES.includes('project-master'));
});

test('createInitialState sets v2 sentinel fields on every phase', () => {
  const s = createInitialState('proj');
  for (const p of PHASES) {
    assertEq(s.phases[p].status, null);
    assertEq(s.phases[p].started_at, null);
    assertEq(s.phases[p].completed_at, null);
    assertEq(s.phases[p].artifact_hashes, []);
  }
});

test('markPhaseStarted sets status=in-progress and started_at', () => {
  let s = createInitialState('proj');
  s = markPhaseStarted(s, 'discovery');
  assertEq(s.phases.discovery.status, 'in-progress');
  assert(s.phases.discovery.started_at, 'started_at set');
  // Other phases untouched
  assertEq(s.phases.identity.status, null);
});

test('markPhaseCompleted sets status=complete and preserves started_at', () => {
  let s = createInitialState('proj');
  s = markPhaseStarted(s, 'discovery');
  const startedAt = s.phases.discovery.started_at;
  s = markPhaseCompleted(s, 'discovery', {references_count: 7});
  assertEq(s.phases.discovery.status, 'complete');
  assertEq(s.phases.discovery.started_at, startedAt);
  assert(s.phases.discovery.completed_at);
  assertEq(s.phases.discovery.references_count, 7);
});

test('markPhaseCompleted accepts artifact_hashes via metadata', () => {
  let s = createInitialState('proj');
  const hashes = [{path: 'CLAUDE.md', sha256: 'abc123'}];
  s = markPhaseCompleted(s, 'identity', {artifact_hashes: hashes, claude_md_lines: 100});
  assertEq(s.phases.identity.artifact_hashes, hashes);
  assertEq(s.phases.identity.claude_md_lines, 100);
});

test('markPhaseFailed sets phase entry status=failed AND appends to phase_failures', () => {
  let s = createInitialState('proj');
  s = markPhaseStarted(s, 'discovery');
  s = markPhaseFailed(s, 'discovery', 'db unreachable');
  assertEq(s.phases.discovery.status, 'failed');
  assertEq(s.phase_failures.length, 1);
  assertEq(s.phase_failures[0].phase, 'discovery');
});

test('isPhaseCompleted reflects status=complete (preferred) and completed_at (fallback)', () => {
  // Explicit v2 status
  let s1 = createInitialState('proj');
  s1.phases.identity.status = 'complete';
  s1.phases.identity.completed_at = nowIso();
  assert(isPhaseCompleted(s1, 'identity'));
  // Legacy fallback: status null but completed_at set (v1-migrated)
  let s2 = createInitialState('proj');
  s2.phases.identity.completed_at = nowIso();
  assert(isPhaseCompleted(s2, 'identity'));
  // Truly incomplete
  let s3 = createInitialState('proj');
  assert(!isPhaseCompleted(s3, 'identity'));
});

test('validateState rejects invalid status value', () => {
  const s = createInitialState('proj');
  s.phases.identity.status = 'wat';
  const v = validateState(s);
  assert(!v.ok);
  assert(v.errors.some(e => e.includes('phases.identity.status')), v.errors.join(';'));
});

test('validateState rejects non-array artifact_hashes', () => {
  const s = createInitialState('proj');
  s.phases.identity.artifact_hashes = 'oops';
  const v = validateState(s);
  assert(!v.ok);
  assert(v.errors.some(e => e.includes('artifact_hashes')), v.errors.join(';'));
});

test('PHASE_STATUSES exports the three explicit statuses', () => {
  assertEq(PHASE_STATUSES, ['in-progress', 'complete', 'failed']);
});

// ------------------------------------------------------------ v1 → v2 migration

test('migrateV1ToV2: empty v1 state migrates to v2 with sentinel fields', () => {
  const v1 = {
    schema_version: 1,
    prism_version: '3.10.0',
    project_name: 'old',
    initialized_at: '2026-01-01T00:00:00.000Z',
    last_run: '2026-01-01T00:00:00.000Z',
    last_sync_at: null,
    next_sync_recommended: null,
    phases: {
      identity: {completed_at: null},
      structure: {completed_at: null},
      // v1 had only 5 phases; missing entries are added by migration
    },
    last_command: null,
    phase_failures: [],
    checksum: null,
  };
  const v2 = migrateV1ToV2(v1);
  assertEq(v2.schema_version, 2);
  for (const p of PHASES) {
    assert(v2.phases[p], `phase ${p} present after migration`);
    assert('status' in v2.phases[p], `status field added for ${p}`);
    assert('started_at' in v2.phases[p]);
    assert('artifact_hashes' in v2.phases[p]);
  }
  assertEq(v2.phases.identity.status, null);
});

test('migrateV1ToV2: completed v1 phase becomes status=complete with started_at = completed_at', () => {
  const completedAt = '2026-01-02T12:00:00.000Z';
  const v1 = {
    schema_version: 1,
    prism_version: '3.10.0',
    project_name: 'old',
    initialized_at: '2026-01-01T00:00:00.000Z',
    last_run: completedAt,
    last_sync_at: null,
    next_sync_recommended: null,
    phases: {
      identity: {completed_at: completedAt, claude_md_lines: 180},
      structure: {completed_at: completedAt, dirs_created: 11, synthesized: true},
    },
    last_command: null,
    phase_failures: [],
    checksum: null,
  };
  const v2 = migrateV1ToV2(v1);
  assertEq(v2.phases.identity.status, 'complete');
  assertEq(v2.phases.identity.completed_at, completedAt);
  assertEq(v2.phases.identity.started_at, completedAt);
  assertEq(v2.phases.identity.claude_md_lines, 180, 'v1 metadata preserved');
  assertEq(v2.phases.structure.synthesized, true, 'synthesized flag preserved');
  assertEq(v2.phases.structure.dirs_created, 11);
  // New v2 phases default to null status
  assertEq(v2.phases['plugin-validate'].status, null);
  assertEq(v2.phases['project-master'].status, null);
});

test('migrateV1ToV2: v2 input is returned as-is', () => {
  const v2 = createInitialState('already-v2');
  const out = migrateV1ToV2(v2);
  assertEq(out.schema_version, 2);
  // Same phase set
  for (const p of PHASES) assert(out.phases[p]);
});

test('readState transparently migrates a v1 state file', () => {
  const root = makeTmpRoot('v1read');
  try {
    // Build a v1-shaped state and write it WITH a correct v1 checksum, so the
    // reader can verify it before migrating.
    const completedAt = '2026-02-03T11:00:00.000Z';
    const v1 = {
      schema_version: 1,
      prism_version: '3.10.0',
      project_name: 'legacy',
      initialized_at: '2026-02-01T00:00:00.000Z',
      last_run: completedAt,
      last_sync_at: null,
      next_sync_recommended: null,
      phases: {
        identity: {completed_at: completedAt, claude_md_lines: 150},
        structure: {completed_at: null},
        discovery: {completed_at: null},
        roster: {completed_at: null},
        health: {completed_at: null},
      },
      last_command: null,
      phase_failures: [],
      checksum: null,
    };
    v1.checksum = computeChecksum(v1);
    mkdirSync(join(root, '.claude'), {recursive: true});
    writeFileSync(getStatePath(root), JSON.stringify(v1, null, 2) + '\n');

    const r = readState(root);
    assertEq(r.status, 'ok');
    assertEq(r.migrated, true);
    assertEq(r.state.schema_version, 2);
    assertEq(r.state.phases.identity.status, 'complete');
    assertEq(r.state.phases.identity.claude_md_lines, 150);
    // v2-only phases initialized
    assertEq(r.state.phases['plugin-validate'].status, null);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

// ------------------------------------------------------------ project_slug (D004 §1)

test('createInitialState: includes project_slug field default null', () => {
  const state = createInitialState('test-project');
  assertEq(state.project_slug, null, 'project_slug default null');
});

test('setProjectSlug: returns new state with project_slug set and checksum cleared', () => {
  let state = createInitialState('tb');
  state = setProjectSlug(state, 'foo-cli');
  assertEq(state.project_slug, 'foo-cli');
  assert(!state.checksum, 'checksum cleared on mutation');
});

test('setProjectSlug: rejects empty or whitespace-only slug', () => {
  const state = createInitialState('tb');
  let threw = false;
  try { setProjectSlug(state, '   '); } catch { threw = true; }
  assert(threw, 'empty/whitespace slug rejected');
});

test('migrateV1ToV2: project_slug field set to null on v1 → v2 migration', () => {
  // Construct a synthetic v1 state object (using the lib's v1 shape)
  const v1 = {
    schema_version: 1,
    prism_version: '3.10.0',
    project_name: 'old-project',
    initialized_at: '2026-01-01T00:00:00.000Z',
    last_run: '2026-01-01T00:00:00.000Z',
    last_sync_at: null,
    next_sync_recommended: null,
    phases: {
      identity: {completed_at: null},
      structure: {completed_at: null},
      discovery: {completed_at: null},
      roster: {completed_at: null},
      health: {completed_at: null},
    },
    last_command: null,
    phase_failures: [],
  };
  const migrated = migrateV1ToV2(v1);
  assertEq(migrated.schema_version, 2);
  assertEq(migrated.project_slug, null, 'project_slug seeded null on migration');
});

// ------------------------------------------------------------ summary

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
