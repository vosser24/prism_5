#!/usr/bin/env node
// tests/v3/state/test-rule-extraction-anchoring.mjs
//
// Regression test for the two `extractRule` defects fixed 2026-07-22:
//
//   (A) CORRUPTION — the pre-fix regex /\*\*Rule:\*\*\s*(.+)/ (no ^/$ anchor,
//       no /m flag) matches the FIRST occurrence of "**Rule:**" ANYWHERE in
//       the file content, including inside a TITLE or prose line that merely
//       mentions the string, not just a genuine header-style **Rule:** field.
//       docs/prism/adjudications/D062-named-teammate-report-loss.md is a
//       real, already-shipped instance: its own H1 title contains the
//       literal text "**Rule:**", so the pre-fix regex extracted the title's
//       trailing fragment instead of the real Rule on line 8.
//
//   (B) TRUNCATION — the same regex is non-global, so only the FIRST
//       **Rule:** line in a file is ever extracted. Lesson files with
//       multiple sub-lesson sections, each with its own header-style
//       **Rule:** line, silently lose every rule after the first. Measured
//       pre-fix: 6 lesson files held 31 genuine Rule declarations, of which
//       only 6 (one per file) were reachable — 25 invisible to the indexer.
//
// This test seeds exactly those two shapes and asserts against BOTH the
// `rebuild` and `append` CLI paths (tools/prism-knowledge-index.mjs) AND the
// `delta` self-heal path (which is backed by the SEPARATE, independently
// duplicated extractRule in tools/lib/knowledge-delta.mjs — see D046
// finding #4 anti-rot precedent for why these two copies must be tested
// independently rather than assumed to move in lockstep).
//
// Run: node tests/v3/state/test-rule-extraction-anchoring.mjs
// Exit code: 0 = all pass; 1 = any failure.

import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), `prism-rule-extract-${label}-`));
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

function readManifest(root) {
  const raw = readFileSync(join(root, '.claude', 'references', '.knowledge-manifest.json'), 'utf8');
  return JSON.parse(raw);
}

function readKeywordMap(root) {
  const raw = readFileSync(join(root, '.claude', 'references', '.knowledge-keyword-map.json'), 'utf8');
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) CORRUPTION — a title containing the literal string "**Rule:**" must not
// hijack extraction away from the real header-style Rule field.
// ─────────────────────────────────────────────────────────────────────────────

const D062_STYLE_TITLE =
  '# D999 — captured lesson could not fire because it had no `**Rule:**` line';
const D062_STYLE_REAL_RULE =
  'Do not pass name: to an Agent() dispatch whose job is to return a report.';

function d062StyleContent() {
  return `${D062_STYLE_TITLE}\n\n**Status:** Locked\n**Date:** 2026-01-01\n` +
    `**Rule:** ${D062_STYLE_REAL_RULE}\n\nBody text.\n`;
}

test('(A) rebuild: title containing "**Rule:**" does not corrupt extraction — real header Rule wins', () => {
  const root = makeTestbed('corruption-rebuild');
  try {
    seedAdjudication(root, 'D999-title-mentions-rule.md', d062StyleContent());
    const r = run(root, 'rebuild');
    assertEq(r.status, 0, 'rebuild should exit 0\nstderr: ' + r.stderr);

    const manifest = readManifest(root);
    const entry = Object.values(manifest.files).find(f => f.ref === 'D999');
    assert(entry, 'D999 entry present in manifest');
    assertEq(entry.rule, D062_STYLE_REAL_RULE,
      `manifest rule should be the REAL header Rule text, not a title fragment. Got: ${JSON.stringify(entry.rule)}`);
    assert(!entry.rule.startsWith('` line'),
      `manifest rule must not be the corrupted title-fragment "\`\` line\`" seen pre-fix. Got: ${JSON.stringify(entry.rule)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('(A) append: title containing "**Rule:**" does not corrupt extraction — real header Rule wins', () => {
  const root = makeTestbed('corruption-append');
  try {
    run(root, 'rebuild');
    seedAdjudication(root, 'D999-title-mentions-rule.md', d062StyleContent());
    const r = run(root, 'append', '--type', 'adjudication', '--file', 'D999-title-mentions-rule.md');
    assertEq(r.status, 0, 'append should exit 0\nstderr: ' + r.stderr);

    const manifest = readManifest(root);
    const entry = manifest.files['docs/prism/adjudications/D999-title-mentions-rule.md'];
    assert(entry, 'D999 entry present in manifest after append');
    assertEq(entry.rule, D062_STYLE_REAL_RULE,
      `append-path manifest rule should be the REAL header Rule text. Got: ${JSON.stringify(entry.rule)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('(A) delta: title containing "**Rule:**" does not corrupt extraction on the self-heal path', () => {
  const root = makeTestbed('corruption-delta');
  try {
    // No prior manifest — delta treats everything as added and self-heals.
    seedAdjudication(root, 'D999-title-mentions-rule.md', d062StyleContent());
    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, 'delta should exit 0\nstderr: ' + r.stderr);

    const manifest = readManifest(root);
    const entry = Object.values(manifest.files).find(f => f.ref === 'D999');
    assert(entry, 'D999 entry present in manifest after delta self-heal');
    assertEq(entry.rule, D062_STYLE_REAL_RULE,
      `delta-path (knowledge-delta.mjs) manifest rule should be the REAL header Rule text — this is a SEPARATE duplicated extractRule from the rebuild/append path. Got: ${JSON.stringify(entry.rule)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) TRUNCATION — a lesson file with N header-style **Rule:** lines must
// yield all N, not just the first.
// ─────────────────────────────────────────────────────────────────────────────

function multiRuleLessonContent() {
  return [
    '# Session with three sub-lessons',
    '',
    '**Status:** Draft',
    '**Date:** 2026-01-01',
    '',
    '## L1',
    '**Rule:** First rule text.',
    '',
    '## L2',
    '**Rule:** Second rule text.',
    '',
    '## L3',
    '**Rule:** Third rule text.',
    '',
  ].join('\n');
}

test('(B) rebuild: lesson with 3 header Rule lines yields ALL 3 in manifest.rules[]', () => {
  const root = makeTestbed('truncation-rebuild');
  try {
    seedLesson(root, '2026-01-01-multi-rule.md', multiRuleLessonContent());
    const r = run(root, 'rebuild');
    assertEq(r.status, 0, 'rebuild should exit 0\nstderr: ' + r.stderr);

    const manifest = readManifest(root);
    const entry = manifest.files['docs/prism/lessons/2026-01-01-multi-rule.md'];
    assert(entry, 'lesson entry present');
    assertEq(entry.rule, 'First rule text.', 'scalar rule stays backward-compatible (first rule)');
    assert(Array.isArray(entry.rules), 'entry.rules must be an array: ' + JSON.stringify(entry));
    assertEq(entry.rules, ['First rule text.', 'Second rule text.', 'Third rule text.'],
      `all 3 rules must be reachable, not just the first. Got: ${JSON.stringify(entry.rules)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('(B) rebuild: single-rule file does NOT get a redundant rules[] field (minimal-diff design)', () => {
  const root = makeTestbed('truncation-singlerule');
  try {
    seedAdjudication(root, 'D001-single.md', '# Single\n**Status:** Locked\n**Rule:** Only one rule.\n');
    const r = run(root, 'rebuild');
    assertEq(r.status, 0, r.stderr);

    const manifest = readManifest(root);
    const entry = Object.values(manifest.files).find(f => f.ref === 'D001');
    assertEq(entry.rule, 'Only one rule.');
    assert(entry.rules === undefined, 'single-rule entries should not carry a rules[] array: ' + JSON.stringify(entry));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('(B) append: lesson with 3 header Rule lines yields ALL 3 via the append path', () => {
  const root = makeTestbed('truncation-append');
  try {
    run(root, 'rebuild');
    seedLesson(root, '2026-01-01-multi-rule.md', multiRuleLessonContent());
    const r = run(root, 'append', '--type', 'lesson', '--file', '2026-01-01-multi-rule.md');
    assertEq(r.status, 0, r.stderr);

    const manifest = readManifest(root);
    const entry = manifest.files['docs/prism/lessons/2026-01-01-multi-rule.md'];
    assertEq(entry.rules, ['First rule text.', 'Second rule text.', 'Third rule text.'],
      `append-path must surface all 3 rules. Got: ${JSON.stringify(entry.rules)}`);

    const kwMap = readKeywordMap(root);
    const mapEntry = kwMap.entries.find(e => e.relPath === 'docs/prism/lessons/2026-01-01-multi-rule.md');
    assert(mapEntry, 'keyword-map entry present');
    // Second/third rule tokens must be reachable for matching even though
    // display still shows only the first rule (documented design decision).
    assert(mapEntry.tokens.includes('second'), `keyword-map tokens should include tokens from rule #2, not just #1: ${JSON.stringify(mapEntry.tokens)}`);
    assert(mapEntry.tokens.includes('third'), `keyword-map tokens should include tokens from rule #3: ${JSON.stringify(mapEntry.tokens)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('(B) delta: lesson with 3 header Rule lines yields ALL 3 via the self-heal path', () => {
  const root = makeTestbed('truncation-delta');
  try {
    seedLesson(root, '2026-01-01-multi-rule.md', multiRuleLessonContent());
    const r = run(root, 'delta', '--json');
    assertEq(r.status, 0, r.stderr);

    const manifest = readManifest(root);
    const entry = manifest.files['docs/prism/lessons/2026-01-01-multi-rule.md'];
    assertEq(entry.rules, ['First rule text.', 'Second rule text.', 'Third rule text.'],
      `delta-path (knowledge-delta.mjs, separately duplicated) must surface all 3 rules. Got: ${JSON.stringify(entry.rules)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
