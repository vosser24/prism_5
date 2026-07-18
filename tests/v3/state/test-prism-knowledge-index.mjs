#!/usr/bin/env node
// Tests for tools/prism-knowledge-index.mjs
// Run: node tests/v3/state/test-prism-knowledge-index.mjs
// Exit code: 0 = all pass; 1 = any failure.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = join(__dirname, '..', '..', '..', 'tools', 'prism-knowledge-index.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-ki-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

function seedAdjudication(root, filename, content) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, filename), content, 'utf8');
}

function seedLesson(root, filename, content) {
  const dir = join(root, 'docs', 'prism', 'lessons');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, filename), content, 'utf8');
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args, '--root', root], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function readIndex(root) {
  return readFileSync(join(root, '.claude', 'references', 'knowledge-index.md'), 'utf8');
}

function readManifest(root) {
  const raw = readFileSync(join(root, '.claude', 'references', '.knowledge-manifest.json'), 'utf8');
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// rebuild: basic two-adjudication + two-lesson scenario
// ─────────────────────────────────────────────────────────────────────────────

test('rebuild: produces knowledge-index.md with [[D001]], [[D002]]', () => {
  const root = makeTestbed('rebuild-basic');
  try {
    seedAdjudication(root, 'D001-first-decision.md',
      '# First Decision Title\n**Status:** Locked\n**Date:** 2026-01-01\n');
    seedAdjudication(root, 'D002-second-decision.md',
      '# Second Decision Title\n**Status:** Proposed\n**Date:** 2026-01-02\n');
    seedLesson(root, '2026-05-25-session.md',
      '# Session Handoff May 25\n**Status:** Draft\nSome lesson body here.\n');
    seedLesson(root, '2026-06-01-session.md',
      '# Session Handoff June 1\nAnother lesson.\n');

    const r = run(root, 'rebuild');
    assertEq(r.status, 0, 'rebuild should exit 0\nstderr: ' + r.stderr);

    const idx = readIndex(root);
    assert(idx.includes('[[D001]]'), 'index should contain [[D001]]: ' + idx);
    assert(idx.includes('[[D002]]'), 'index should contain [[D002]]: ' + idx);
    assert(idx.includes('[[lesson:2026-05-25-session]]'), 'index should contain [[lesson:2026-05-25-session]] (task #21: ref is now the full slug, not the bare date): ' + idx);
    assert(idx.includes('[[lesson:2026-06-01-session]]'), 'index should contain [[lesson:2026-06-01-session]] (task #21: ref is now the full slug, not the bare date): ' + idx);
    assert(idx.includes('First Decision Title'), 'index should contain adjudication title');
    assert(idx.includes('Locked'), 'index should contain status Locked');

    const manifest = readManifest(root);
    assertEq(manifest.version, 1, 'manifest version should be 1');
    const fileCount = Object.keys(manifest.files).length;
    assertEq(fileCount, 4, 'manifest should have 4 files');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('rebuild: adjudications sorted by D-number ascending', () => {
  const root = makeTestbed('rebuild-sort');
  try {
    // Write in reverse order to confirm sorting
    seedAdjudication(root, 'D003-third.md', '# Third\n**Status:** Draft\n');
    seedAdjudication(root, 'D001-first.md', '# First\n**Status:** Locked\n');
    seedAdjudication(root, 'D002-second.md', '# Second\n**Status:** Proposed\n');

    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);

    const idx = readIndex(root);
    const pos1 = idx.indexOf('[[D001]]');
    const pos2 = idx.indexOf('[[D002]]');
    const pos3 = idx.indexOf('[[D003]]');
    assert(pos1 < pos2 && pos2 < pos3, 'adjudications should be sorted ascending: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('rebuild: lessons sorted by date descending', () => {
  const root = makeTestbed('rebuild-lesson-sort');
  try {
    seedLesson(root, '2026-01-01-old.md', '# Old Lesson\n');
    seedLesson(root, '2026-06-01-new.md', '# New Lesson\n');
    seedLesson(root, '2026-03-15-mid.md', '# Middle Lesson\n');

    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);

    const idx = readIndex(root);
    const posNew = idx.indexOf('[[lesson:2026-06-01-new]]');
    const posMid = idx.indexOf('[[lesson:2026-03-15-mid]]');
    const posOld = idx.indexOf('[[lesson:2026-01-01-old]]');
    assert(posNew < posMid && posMid < posOld, 'lessons should be sorted descending by date: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('rebuild: empty dirs produce valid index with 0 adjudications, 0 lessons', () => {
  const root = makeTestbed('rebuild-empty');
  try {
    // Create the dirs but leave them empty
    mkdirSync(join(root, 'docs', 'prism', 'adjudications'), {recursive: true});
    mkdirSync(join(root, 'docs', 'prism', 'lessons'), {recursive: true});

    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);

    const idx = readIndex(root);
    assert(idx.includes('# PRISM knowledge index'), 'header present');
    assert(idx.includes('0 adjudications'), 'should show 0 adjudications in header: ' + idx);
    assert(idx.includes('0 lessons'), 'should show 0 lessons in header: ' + idx);

    const manifest = readManifest(root);
    assertEq(Object.keys(manifest.files).length, 0, 'manifest should have 0 files');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('rebuild: missing corpus dirs still exits 0 and creates output files', () => {
  const root = makeTestbed('rebuild-nodirs');
  try {
    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);
    assert(existsSync(join(root, '.claude', 'references', 'knowledge-index.md')), 'index should exist');
    assert(existsSync(join(root, '.claude', 'references', '.knowledge-manifest.json')), 'manifest should exist');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('rebuild: manifest has correct types and hashes', () => {
  const root = makeTestbed('rebuild-manifest');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedLesson(root, '2026-06-10-session.md', '# June 10 Session\n');

    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);

    const manifest = readManifest(root);
    const entries = Object.entries(manifest.files);
    assertEq(entries.length, 2, 'should have 2 file entries');

    const adjEntry = entries.find(([k]) => k.includes('D001'));
    const lessonEntry = entries.find(([k]) => k.includes('2026-06-10'));
    assert(adjEntry, 'adjudication entry present');
    assert(lessonEntry, 'lesson entry present');
    assertEq(adjEntry[1].type, 'adjudication', 'adjudication type');
    assertEq(lessonEntry[1].type, 'lesson', 'lesson type');
    assertEq(adjEntry[1].ref, 'D001', 'adjudication ref');
    assertEq(lessonEntry[1].ref, '2026-06-10-session', 'lesson ref (task #21: full-slug ref, not bare date)');
    assert(typeof adjEntry[1].hash === 'string' && adjEntry[1].hash.length > 0, 'hash present');
    assert(typeof lessonEntry[1].hash === 'string' && lessonEntry[1].hash.length > 0, 'hash present');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// append: D003 added after rebuild
// ─────────────────────────────────────────────────────────────────────────────

test('append: new adjudication D003 is added to index + manifest', () => {
  const root = makeTestbed('append-adj');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedAdjudication(root, 'D002-beta.md', '# Beta\n**Status:** Proposed\n');
    run(root, 'rebuild');

    const adjDir = join(root, 'docs', 'prism', 'adjudications');
    writeFileSync(join(adjDir, 'D003-gamma.md'), '# Gamma Decision\n**Status:** Draft\n', 'utf8');

    const r = run(root, 'append', '--type', 'adjudication', '--file', 'D003-gamma.md');
    assertEq(r.status, 0, 'append should exit 0\nstderr: ' + r.stderr);

    const idx = readIndex(root);
    assert(idx.includes('[[D001]]'), 'D001 still present');
    assert(idx.includes('[[D002]]'), 'D002 still present');
    assert(idx.includes('[[D003]]'), 'D003 newly added: ' + idx);
    assert(idx.includes('Gamma Decision'), 'D003 title present');

    const manifest = readManifest(root);
    const adjudications = Object.values(manifest.files).filter(f => f.type === 'adjudication');
    assertEq(adjudications.length, 3, 'manifest should have 3 adjudications');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append: new lesson added to index + manifest', () => {
  const root = makeTestbed('append-lesson');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedLesson(root, '2026-05-25-old.md', '# Old Session\n');
    run(root, 'rebuild');

    const lessonDir = join(root, 'docs', 'prism', 'lessons');
    writeFileSync(join(lessonDir, '2026-06-19-new.md'), '# New Session\n', 'utf8');

    const r = run(root, 'append', '--type', 'lesson', '--file', '2026-06-19-new.md');
    assertEq(r.status, 0, 'append should exit 0\nstderr: ' + r.stderr);

    const idx = readIndex(root);
    assert(idx.includes('[[lesson:2026-06-19-new]]'), 'new lesson ref present: ' + idx);
    assert(idx.includes('New Session'), 'new lesson title present: ' + idx);
    assert(idx.includes('[[lesson:2026-05-25-old]]'), 'old lesson still present');

    const manifest = readManifest(root);
    const lessons = Object.values(manifest.files).filter(f => f.type === 'lesson');
    assertEq(lessons.length, 2, 'manifest should have 2 lessons');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append: idempotent — appending same D003 twice does not duplicate', () => {
  const root = makeTestbed('append-idem');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    run(root, 'rebuild');

    const adjDir = join(root, 'docs', 'prism', 'adjudications');
    writeFileSync(join(adjDir, 'D003-gamma.md'), '# Gamma Decision\n**Status:** Draft\n', 'utf8');

    run(root, 'append', '--type', 'adjudication', '--file', 'D003-gamma.md');
    const r2 = run(root, 'append', '--type', 'adjudication', '--file', 'D003-gamma.md');
    assertEq(r2.status, 0, 'second append should exit 0');

    const idx = readIndex(root);
    const count = (idx.match(/\[\[D003\]\]/g) || []).length;
    assertEq(count, 1, 'D003 should appear exactly once (idempotent): ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append: D003 inserted in sorted position between D002 and D004', () => {
  const root = makeTestbed('append-sort');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedAdjudication(root, 'D002-beta.md', '# Beta\n**Status:** Proposed\n');
    seedAdjudication(root, 'D004-delta.md', '# Delta\n**Status:** Locked\n');
    run(root, 'rebuild');

    const adjDir = join(root, 'docs', 'prism', 'adjudications');
    writeFileSync(join(adjDir, 'D003-gamma.md'), '# Gamma\n**Status:** Draft\n', 'utf8');
    run(root, 'append', '--type', 'adjudication', '--file', 'D003-gamma.md');

    const idx = readIndex(root);
    const pos2 = idx.indexOf('[[D002]]');
    const pos3 = idx.indexOf('[[D003]]');
    const pos4 = idx.indexOf('[[D004]]');
    assert(pos2 < pos3 && pos3 < pos4, 'D003 should be between D002 and D004: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append: --file can be an absolute path', () => {
  const root = makeTestbed('append-abspath');
  try {
    run(root, 'rebuild');

    const adjDir = join(root, 'docs', 'prism', 'adjudications');
    mkdirSync(adjDir, {recursive: true});
    const absFile = join(adjDir, 'D001-absolute.md');
    writeFileSync(absFile, '# Absolute Path Test\n**Status:** Draft\n', 'utf8');

    const r = run(root, 'append', '--type', 'adjudication', '--file', absFile);
    assertEq(r.status, 0, 'append with abs path should exit 0\nstderr: ' + r.stderr);

    const idx = readIndex(root);
    assert(idx.includes('[[D001]]'), 'D001 present via abs path: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// append: task #21 regression — same-date lessons must NOT evict each other
// ─────────────────────────────────────────────────────────────────────────────

test('append: two same-date lessons with distinct slugs — BOTH survive (task #21)', () => {
  const root = makeTestbed('append-same-date-collision');
  try {
    run(root, 'rebuild');

    const lessonDir = join(root, 'docs', 'prism', 'lessons');
    mkdirSync(lessonDir, {recursive: true});
    writeFileSync(join(lessonDir, '2026-07-17-session.md'),
      '# Session Lessons\n**Status:** Draft\nBody A.\n', 'utf8');
    writeFileSync(join(lessonDir, '2026-07-17-session-addendum.md'),
      '# Session Addendum\n**Status:** Draft\nBody B.\n', 'utf8');

    const r1 = run(root, 'append', '--type', 'lesson', '--file', '2026-07-17-session.md');
    assertEq(r1.status, 0, 'first append exit 0\nstderr: ' + r1.stderr);
    const r2 = run(root, 'append', '--type', 'lesson', '--file', '2026-07-17-session-addendum.md');
    assertEq(r2.status, 0, 'second append exit 0\nstderr: ' + r2.stderr);

    const idx = readIndex(root);
    assert(idx.includes('Session Lessons'), 'first same-date lesson survives: ' + idx);
    assert(idx.includes('Session Addendum'),
      'second same-date lesson survives (pre-fix: evicted by the first): ' + idx);

    const manifest = readManifest(root);
    const lessons = Object.values(manifest.files).filter(f => f.type === 'lesson');
    assertEq(lessons.length, 2, 'manifest should retain both same-date lessons');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append: same-date lessons get distinct refs (file-derived, not date-derived) (task #21)', () => {
  const root = makeTestbed('append-same-date-ref-distinct');
  try {
    run(root, 'rebuild');
    const lessonDir = join(root, 'docs', 'prism', 'lessons');
    mkdirSync(lessonDir, {recursive: true});
    writeFileSync(join(lessonDir, '2026-07-17-session.md'), '# A\n', 'utf8');
    writeFileSync(join(lessonDir, '2026-07-17-session-addendum.md'), '# B\n', 'utf8');

    run(root, 'append', '--type', 'lesson', '--file', '2026-07-17-session.md');
    run(root, 'append', '--type', 'lesson', '--file', '2026-07-17-session-addendum.md');

    const manifest = readManifest(root);
    const refs = Object.values(manifest.files).filter(f => f.type === 'lesson').map(f => f.ref);
    assertEq(new Set(refs).size, 2, 'two distinct files must get two distinct refs: ' + JSON.stringify(refs));
    assert(!refs.includes('2026-07-17'), 'ref must not collapse to bare date: ' + JSON.stringify(refs));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// delta: detect changes and update
// ─────────────────────────────────────────────────────────────────────────────

test('delta: after rebuild, add new lesson → delta --json shows added[]', () => {
  const root = makeTestbed('delta-added');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedLesson(root, '2026-05-25-old.md', '# Old Session\n');
    run(root, 'rebuild');

    // Add a new lesson file (not in manifest)
    const lessonDir = join(root, 'docs', 'prism', 'lessons');
    writeFileSync(join(lessonDir, '2026-06-19-new.md'), '# New Session June 19\n', 'utf8');

    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta should exit 0\nstderr: ' + r.stderr);

    const out = JSON.parse(r.stdout.trim());
    assert(Array.isArray(out.added), 'added should be an array');
    assert(Array.isArray(out.changed), 'changed should be an array');
    assert(Array.isArray(out.removed), 'removed should be an array');
    assert(out.added.some(e => e.includes('2026-06-19')), 'added should include new lesson: ' + JSON.stringify(out.added));

    // Index should now contain the new lesson. task #21/#22: the delta path
    // (knowledge-delta.mjs) now shares the SAME parseLessonFilename as append,
    // so the ref is the full slug (2026-06-19-new), NOT the bare date.
    const idx = readIndex(root);
    assert(idx.includes('[[lesson:2026-06-19-new]]'), 'index updated by delta with full-slug ref: ' + idx);
    assert(!idx.includes('[[lesson:2026-06-19]]'), 'delta must not regress to bare-date ref: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: idempotent — second delta after no changes reports empty arrays', () => {
  const root = makeTestbed('delta-idem');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedLesson(root, '2026-05-25-old.md', '# Old Session\n');
    run(root, 'rebuild');

    // Add a new file and run delta once
    const lessonDir = join(root, 'docs', 'prism', 'lessons');
    writeFileSync(join(lessonDir, '2026-06-19-new.md'), '# New Session\n', 'utf8');
    run(root, 'delta', '--json');

    // Second delta — no new changes
    const r2 = run(root, 'delta', '--json');
    assertEq(r2.status, 0, 'second delta exit 0');

    const out = JSON.parse(r2.stdout.trim());
    assertEq(out.added.length, 0, 'added should be empty on second delta');
    assertEq(out.changed.length, 0, 'changed should be empty on second delta');
    assertEq(out.removed.length, 0, 'removed should be empty on second delta');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: changed file appears in changed[]', () => {
  const root = makeTestbed('delta-changed');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    run(root, 'rebuild');

    // Modify the adjudication
    writeFileSync(
      join(root, 'docs', 'prism', 'adjudications', 'D001-alpha.md'),
      '# Alpha Updated\n**Status:** Locked\nNew content.\n',
      'utf8'
    );

    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta exit 0');

    const out = JSON.parse(r.stdout.trim());
    assert(out.changed.some(e => e.includes('D001')), 'D001 should be in changed: ' + JSON.stringify(out.changed));

    const idx = readIndex(root);
    assert(idx.includes('Alpha Updated'), 'index should reflect updated title: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: removed file appears in removed[]', () => {
  const root = makeTestbed('delta-removed');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedAdjudication(root, 'D002-beta.md', '# Beta\n**Status:** Proposed\n');
    run(root, 'rebuild');

    // Remove D002
    unlinkSync(join(root, 'docs', 'prism', 'adjudications', 'D002-beta.md'));

    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta exit 0');

    const out = JSON.parse(r.stdout.trim());
    assert(out.removed.some(e => e.includes('D002')), 'D002 should be in removed: ' + JSON.stringify(out.removed));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: no manifest present → exits 0, treats all as added, writes manifest', () => {
  const root = makeTestbed('delta-no-manifest');
  try {
    seedAdjudication(root, 'D001-alpha.md', '# Alpha\n**Status:** Locked\n');
    seedAdjudication(root, 'D002-beta.md', '# Beta\n**Status:** Proposed\n');
    seedLesson(root, '2026-05-25-session.md', '# Session\n');

    // NO prior rebuild — manifest does not exist
    assert(!existsSync(join(root, '.claude', 'references', '.knowledge-manifest.json')),
      'manifest should not exist yet');

    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta should exit 0 even without manifest\nstderr: ' + r.stderr);

    // Manifest should now be created
    assert(existsSync(join(root, '.claude', 'references', '.knowledge-manifest.json')),
      'manifest should be written by delta');

    const out = JSON.parse(r.stdout.trim());
    assert(Array.isArray(out.added), 'added should be an array');
    // All 3 files treated as added (capped at 8 most recent in digest, but all should be in JSON)
    assert(out.added.length >= 3, 'all 3 files should appear in added when manifest missing: ' + JSON.stringify(out));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: no manifest, many files → exits 0, caps human digest to 8 but writes manifest', () => {
  const root = makeTestbed('delta-cap');
  try {
    // Seed 10 adjudications
    for (let i = 1; i <= 10; i++) {
      const num = String(i).padStart(3, '0');
      seedAdjudication(root, `D${num}-item${i}.md`, `# Item ${i}\n**Status:** Draft\n`);
    }

    // NO manifest
    const r = run(root, 'delta');
    assertEq(r.status, 0, 'delta exits 0: ' + r.stderr);

    assert(existsSync(join(root, '.claude', 'references', '.knowledge-manifest.json')),
      'manifest written');

    // Human output should exist but not flood — cap means ≤8 lines mentioning D-numbers
    const lines = r.stdout.split('\n').filter(l => /D\d{3}/.test(l));
    assert(lines.length <= 8, `human digest should be capped to ≤8 items, got ${lines.length}: ` + r.stdout);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('delta: always exits 0 even when corpus completely missing', () => {
  const root = makeTestbed('delta-failopen');
  try {
    // No docs/prism at all, no manifest
    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta must be fail-open: ' + r.stderr);
    // stdout should be valid JSON with empty arrays
    const out = JSON.parse(r.stdout.trim() || '{"added":[],"changed":[],"removed":[]}');
    assert(Array.isArray(out.added), 'added array present');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Output format checks
// ─────────────────────────────────────────────────────────────────────────────

test('index format: contains generated comment and header', () => {
  const root = makeTestbed('format-header');
  try {
    seedAdjudication(root, 'D001-test.md', '# Test\n**Status:** Locked\n');
    run(root, 'rebuild');

    const idx = readIndex(root);
    assert(idx.startsWith('# PRISM knowledge index'), 'header line: ' + idx.slice(0, 80));
    assert(idx.includes('Generated by tools/prism-knowledge-index.mjs'), 'generated comment: ' + idx);
    assert(idx.includes('## Adjudications'), 'adjudications section: ' + idx);
    assert(idx.includes('## Lessons'), 'lessons section: ' + idx);
    assert(idx.includes('_Last rebuilt:'), '_Last rebuilt_ line: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('index format: status rendered in parens', () => {
  const root = makeTestbed('format-status');
  try {
    seedAdjudication(root, 'D001-decision.md', '# My Decision\n**Status:** Locked\n');
    run(root, 'rebuild');

    const idx = readIndex(root);
    assert(/D001.*Locked/.test(idx), 'status Locked in line: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('index format: lesson without date prefix uses filename', () => {
  const root = makeTestbed('format-nondated');
  try {
    seedLesson(root, 'misc-notes.md', '# Misc Notes\nsome content\n');
    run(root, 'rebuild');

    const idx = readIndex(root);
    assert(idx.includes('[[lesson:misc-notes]]'), 'non-dated lesson ref: ' + idx);
    assert(idx.includes('Misc Notes'), 'non-dated lesson title: ' + idx);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Final summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
