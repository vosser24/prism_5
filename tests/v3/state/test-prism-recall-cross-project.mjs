#!/usr/bin/env node
// Integration tests for the F4 cross-project query surface (PRISM v5.0 F4 Phase D)
// Run: node tests/v3/state/test-prism-recall-cross-project.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// SYNCHRONOUS harness (mirrors test-prism-bm25.mjs / test-prism-kb-knowledge-indexer.mjs:
//   pass/total/check + final log + exit). queryKnowledge + writeShareMarker/removeShareMarker
//   are all synchronous, so this test stays synchronous (no async-blind risk).
//
// Builds a REAL knowledge index via buildKnowledgeIndex into a temp home from a temp
// project (mkdtempSync) — true integration, not a hand-stubbed index.
//
// Covers F4 §7/§9 contract:
//   - crossProject:false → results:[], reason:'not-cross-project'
//   - empty home (no index) → reason:'no-index'
//   - rerank:false → BM25 order, reason:'disabled', label '(lexical only — disabled)'
//   - stub runner reorder → reranked:true, label '(LLM re-ranked)'
//   - stub runner timeout → reranked:false, label '(lexical only — timeout)', BM25 order
//   - limit respected
//   - DESCRIPTOR-NOT-BODY (HARD): candidates reaching the runner carry no postings/body
//   - default-deny: unshared project contributes nothing
//   - writeShareMarker / readShareMarker / removeShareMarker round-trip

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildKnowledgeIndex,
  readShareMarker,
  writeShareMarker,
  removeShareMarker,
  SHAREABLE_TYPES,
} from '../../../tools/prism-kb-knowledge-indexer.mjs';

import {
  loadKnowledgeIndex,
  queryKnowledge,
} from '../../../tools/lib/prism-kb-knowledge-query.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// ── fixture helpers ─────────────────────────────────────────────────────────
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'prism-recall-home-'));
}
function freshProject(name = 'proj') {
  return mkdtempSync(join(tmpdir(), `prism-recall-${name}-`));
}
function writeFile(p, content) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function writeLesson(root, file, content) {
  writeFile(join(root, 'docs', 'prism', 'lessons', file), content);
}
function writeShare(root, types) {
  writeFileSync(join(root, '.prism-kb-share.json'),
    JSON.stringify({ version: 1, shared_types: types, shared_at: '2026-05-29T00:00:00.000Z' }));
}
const NOW = '2026-05-29T12:00:00.000Z';

// Unique sentinel that must NEVER reach the re-rank runner (descriptor-not-body).
const BODY_SENTINEL = 'UNIQUEBODYSENTINEL_zxcvbn full body sentence about concurrent teardown deadlock recovery';

// ── crossProject:false → not-cross-project ───────────────────────────────────
{
  const home = freshHome();
  const r = queryKnowledge('anything', { home, crossProject: false });
  check('not-cross-project: results empty', Array.isArray(r.results) && r.results.length === 0);
  check('not-cross-project: reason', r.reason === 'not-cross-project');
  check('not-cross-project: reranked false', r.reranked === false);
}

// ── empty home (no index) → no-index ──────────────────────────────────────────
{
  const home = freshHome();
  check('no-index: loadKnowledgeIndex returns null', loadKnowledgeIndex(home) === null);
  const r = queryKnowledge('anything', { home, crossProject: true });
  check('no-index: results empty', r.results.length === 0);
  check('no-index: reason', r.reason === 'no-index');
  check('no-index: label', r.label === '(no cross-project knowledge yet)');
}

// ── build a real index sharing lessons; BM25-only (rerank:false) ──────────────
function buildLessonIndex() {
  const home = freshHome();
  const root = freshProject('lessons');
  // Three lessons with distinct vocab so BM25 ordering is deterministic.
  writeLesson(root, 'deadlock.md',
    '# Deadlock Lesson\nA short benign summary line for the description.\n' +
    'deadlock deadlock deadlock concurrent teardown shutdown race condition. ' + BODY_SENTINEL);
  writeLesson(root, 'caching.md',
    '# Caching Lesson\nCaching summary line.\ncache cache invalidation memoization ttl eviction strategy.');
  writeLesson(root, 'logging.md',
    '# Logging Lesson\nLogging summary line.\nlog logging structured json rotation retention.');
  writeShare(root, ['lesson']);
  buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  return { home, root };
}

{
  const { home } = buildLessonIndex();
  check('load-index: loadKnowledgeIndex returns object', !!loadKnowledgeIndex(home));

  const r = queryKnowledge('deadlock concurrent teardown', { home, crossProject: true, rerank: false });
  check('bm25-only: reranked false', r.reranked === false);
  check('bm25-only: reason disabled', r.reason === 'disabled');
  check('bm25-only: label', r.label === '(lexical only — disabled)');
  check('bm25-only: at least one result', r.results.length >= 1);
  // The deadlock lesson must rank first for a deadlock query.
  check('bm25-only: deadlock lesson ranks first',
    r.results.length >= 1 && /deadlock/i.test(r.results[0].title));
  // Provenance fields present on each result; bodies/postings absent.
  check('bm25-only: provenance fields present',
    r.results.every(x => typeof x.project_label === 'string' && typeof x.type === 'string'
      && typeof x.title === 'string' && typeof x.source_path === 'string'));
  check('bm25-only: results carry no postings/body',
    r.results.every(x => x.postings === undefined && x.body === undefined));
}

// ── stub runner reorder → reranked:true, label '(LLM re-ranked)' ──────────────
{
  const { home } = buildLessonIndex();
  // First get the BM25 order so we know the ids, then build a stub that reverses.
  const base = queryKnowledge('deadlock concurrent teardown caching log', { home, crossProject: true, rerank: false });
  const ids = base.results.map(x => x.id);
  check('rerank-stub: have >=2 candidates to reorder', ids.length >= 2);

  // Stub runner returns the ids reversed as a JSON array.
  const reversed = ids.slice().reverse();
  const stubRunner = () => ({ stdout: JSON.stringify(reversed), code: 0, timedOut: false, error: null });

  const r = queryKnowledge('deadlock concurrent teardown caching log',
    { home, crossProject: true, rerank: true, runner: stubRunner, claudeBin: '/fake/claude' });
  check('rerank-stub: reranked true', r.reranked === true);
  check('rerank-stub: label LLM re-ranked', r.label === '(LLM re-ranked)');
  // Order matches stub (reversed) — restricted to the ids that participated.
  const gotIds = r.results.map(x => x.id);
  check('rerank-stub: order matches stub reorder',
    JSON.stringify(gotIds) === JSON.stringify(reversed.slice(0, gotIds.length)));
}

// ── stub runner timeout → reranked:false, label '(lexical only — timeout)' ────
{
  const { home } = buildLessonIndex();
  const base = queryKnowledge('deadlock concurrent teardown caching log', { home, crossProject: true, rerank: false });
  const baseIds = base.results.map(x => x.id);

  const timeoutRunner = () => ({ stdout: '', code: null, timedOut: true, error: null });
  const r = queryKnowledge('deadlock concurrent teardown caching log',
    { home, crossProject: true, rerank: true, runner: timeoutRunner, claudeBin: '/fake/claude' });
  check('timeout: reranked false', r.reranked === false);
  check('timeout: label', r.label === '(lexical only — timeout)');
  check('timeout: BM25 order preserved',
    JSON.stringify(r.results.map(x => x.id)) === JSON.stringify(baseIds));
}

// ── limit respected ───────────────────────────────────────────────────────────
{
  const { home } = buildLessonIndex();
  const r = queryKnowledge('deadlock caching log lesson', { home, crossProject: true, rerank: false, limit: 1 });
  check('limit: returns exactly 1', r.results.length === 1);
}

// ── DESCRIPTOR-NOT-BODY (HARD): capture what reaches the runner ───────────────
{
  const { home } = buildLessonIndex();
  let captured = null;
  const capturingRunner = ({ prompt }) => {
    captured = prompt;
    return { stdout: '[]', code: 0, timedOut: false, error: null };
  };
  const r = queryKnowledge('deadlock concurrent teardown caching log', {
    home, crossProject: true, rerank: true, runner: capturingRunner, claudeBin: '/fake/claude',
  });
  check('descriptor-not-body: runner was invoked', captured !== null);
  // The full multi-word body sentence must never reach the runner.
  check('descriptor-not-body: body sentinel absent from runner prompt',
    captured !== null && !captured.includes(BODY_SENTINEL));
  check('descriptor-not-body: no postings field in runner prompt',
    captured !== null && !captured.includes('postings'));
  check('descriptor-not-body: no body field in runner prompt',
    captured !== null && !/"body"\s*:/.test(captured));
  // Sanity: re-rank still produced a usable result (empty stub array => BM25 order).
  check('descriptor-not-body: query still returns results', r.results.length >= 1);
}

// ── default-deny: unshared project contributes nothing ────────────────────────
{
  const home = freshHome();
  const root = freshProject('unshared');
  writeLesson(root, 'secretproj.md', '# Unshared Lesson\nunsharedterm body content that should not surface');
  // NO writeShare → default-deny.
  buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const r = queryKnowledge('unsharedterm', { home, crossProject: true, rerank: false });
  check('default-deny: no entries surface from unshared project',
    r.results.every(x => !/unshared/i.test(x.title)) );
  // With only verdicts (none here) and no shared corpus, the unsharedterm query has no match.
  check('default-deny: unsharedterm has no cross-project match', r.results.length === 0);
}

// ── share marker round-trip: write / read / remove ────────────────────────────
{
  const root = freshProject('marker');
  const obj = writeShareMarker(root, ['lesson']);
  check('writeShareMarker: returns object with shared_types', JSON.stringify(obj.shared_types) === JSON.stringify(['lesson']));
  check('writeShareMarker: version 1', obj.version === 1);
  check('writeShareMarker: file exists', existsSync(join(root, '.prism-kb-share.json')));
  const m = readShareMarker(root);
  check('writeShareMarker: readShareMarker reads it back',
    m && JSON.stringify(m.shared_types) === JSON.stringify(['lesson']));
  check('removeShareMarker: returns true when present', removeShareMarker(root) === true);
  check('removeShareMarker: file gone', !existsSync(join(root, '.prism-kb-share.json')));
  check('removeShareMarker: returns false when absent', removeShareMarker(root) === false);

  // default to all SHAREABLE_TYPES when none specified
  const root2 = freshProject('marker2');
  const obj2 = writeShareMarker(root2);
  check('writeShareMarker: defaults to all SHAREABLE_TYPES',
    JSON.stringify(obj2.shared_types) === JSON.stringify(SHAREABLE_TYPES));
  // unknown types ignored
  const root3 = freshProject('marker3');
  const obj3 = writeShareMarker(root3, ['lesson', 'bogus', 'plan']);
  check('writeShareMarker: unknown types ignored',
    JSON.stringify(obj3.shared_types) === JSON.stringify(['lesson', 'plan']));
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
