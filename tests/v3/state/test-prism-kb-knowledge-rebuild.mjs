#!/usr/bin/env node
// Unit tests for tools/prism-kb-knowledge-rebuild.mjs  (PRISM v5.0 F4 Phase E)
// Run: node tests/v3/state/test-prism-kb-knowledge-rebuild.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// SYNCHRONOUS harness (mirrors test-prism-kb-knowledge-indexer.mjs). The module
// under test is sync (buildKnowledgeIndex is sync), so no async/await needed.
//
// Covers the F4 §5 drain contract:
//   - dedicated knowledge-dirty flag path
//   - readDirtyPaths: absent => [], present => filtered lines
//   - deriveProjectRoots: walk up to the .prism-kb-share.json marker, dedupe,
//     drop paths with no shared-project ancestor (e.g. home-global verdicts)
//   - runKnowledgeRebuild: builds the index for the changed project(s),
//     clears the dirty flag, idempotent, verdict-only fallback refreshes.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  knowledgeDirtyFlagPath,
  readDirtyPaths,
  deriveProjectRoots,
  runKnowledgeRebuild,
} from '../../../tools/prism-kb-knowledge-rebuild.mjs';
import { KNOWLEDGE_INDEX_REL, projectIdFor } from '../../../tools/prism-kb-knowledge-indexer.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// ── fixture helpers ─────────────────────────────────────────────────────────
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'prism-kbr-home-'));
}
function freshProject(name = 'proj') {
  return mkdtempSync(join(tmpdir(), `prism-kbr-${name}-`));
}
function writeFile(p, content) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function makeShared(root, types, { lesson, plan, adjudication } = {}) {
  writeFileSync(join(root, '.prism-kb-share.json'),
    JSON.stringify({ version: 1, shared_types: types, shared_at: '2026-05-29T00:00:00.000Z' }));
  if (lesson) writeFile(join(root, 'docs', 'prism', 'lessons', 'l1.md'), lesson);
  if (plan) writeFile(join(root, 'docs', 'prism', 'plans', 'p1.md'), plan);
  if (adjudication) writeFile(join(root, 'docs', 'prism', 'adjudications', 'D001.md'), adjudication);
}
const NOW = '2026-05-29T12:00:00.000Z';

// ── knowledgeDirtyFlagPath ────────────────────────────────────────────────────
{
  const home = freshHome();
  check('knowledgeDirtyFlagPath: under ~/.claude/.prism-kb-knowledge-dirty',
    knowledgeDirtyFlagPath(home) === join(home, '.claude', '.prism-kb-knowledge-dirty'));
}

// ── readDirtyPaths ────────────────────────────────────────────────────────────
{
  const home = freshHome();
  const flag = knowledgeDirtyFlagPath(home);
  check('readDirtyPaths: [] when flag absent', JSON.stringify(readDirtyPaths(flag)) === '[]');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(flag, '/a/b.md\n\n/c/d.md\n   \n');
  const got = readDirtyPaths(flag);
  check('readDirtyPaths: filters blank lines', JSON.stringify(got) === JSON.stringify(['/a/b.md', '/c/d.md']));
}

// ── deriveProjectRoots ────────────────────────────────────────────────────────
{
  const root = freshProject('derive');
  makeShared(root, ['lesson'], { lesson: '# L\nbody' });
  const dirtyPaths = [
    join(root, 'docs', 'prism', 'lessons', 'l1.md'),
    join(root, 'docs', 'prism', 'plans', 'p1.md'),  // same project => dedup
  ];
  const roots = deriveProjectRoots(dirtyPaths);
  check('deriveProjectRoots: maps corpus paths to the share-marked project root',
    roots.length === 1 && roots[0] === root);

  // A path with no .prism-kb-share.json ancestor (home-global verdict) => excluded.
  const verdictPath = join(freshHome(), '.claude', '.prism-phase-1-5-verdicts.jsonl');
  const roots2 = deriveProjectRoots([verdictPath]);
  check('deriveProjectRoots: drops paths with no shared-project ancestor',
    roots2.length === 0);

  // Two distinct projects => two roots.
  const rootB = freshProject('deriveB');
  makeShared(rootB, ['plan'], { plan: '# P\nbody' });
  const roots3 = deriveProjectRoots([
    join(root, 'docs', 'prism', 'lessons', 'l1.md'),
    join(rootB, 'docs', 'prism', 'plans', 'p1.md'),
  ]);
  check('deriveProjectRoots: distinct projects => distinct roots',
    roots3.length === 2 && roots3.includes(root) && roots3.includes(rootB));
}

// ── runKnowledgeRebuild: explicit roots build the index ────────────────────────
{
  const home = freshHome();
  const root = freshProject('build');
  makeShared(root, ['lesson', 'plan'], { lesson: '# Lesson\nshutdown race body', plan: '# Plan\nplan body' });
  const res = runKnowledgeRebuild({ home, roots: [root], now: NOW });
  const indexPath = join(home, KNOWLEDGE_INDEX_REL);
  check('runKnowledgeRebuild: writes the knowledge index', existsSync(indexPath));
  const idx = JSON.parse(readFileSync(indexPath, 'utf-8'));
  const pid = projectIdFor(root);
  const projEntries = idx.entries.filter(e => e.project_id === pid);
  check('runKnowledgeRebuild: indexes the shared corpus (2 entries)', projEntries.length === 2);
  check('runKnowledgeRebuild: returns the processed roots', JSON.stringify(res.roots) === JSON.stringify([root]));
}

// ── runKnowledgeRebuild: clears the dirty flag after a drain ───────────────────
{
  const home = freshHome();
  const root = freshProject('drain');
  makeShared(root, ['lesson'], { lesson: '# L\nbody' });
  const flag = knowledgeDirtyFlagPath(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(flag, join(root, 'docs', 'prism', 'lessons', 'l1.md') + '\n');
  runKnowledgeRebuild({ home, dirtyFlagPath: flag, now: NOW });
  check('runKnowledgeRebuild: drains (deletes) the dirty flag', !existsSync(flag));
  const idx = JSON.parse(readFileSync(join(home, KNOWLEDGE_INDEX_REL), 'utf-8'));
  check('runKnowledgeRebuild: derives root from flag and indexes it',
    idx.entries.some(e => e.project_id === projectIdFor(root)));
}

// ── runKnowledgeRebuild: idempotent ────────────────────────────────────────────
{
  const home = freshHome();
  const root = freshProject('idem');
  makeShared(root, ['lesson', 'plan'], { lesson: '# L\nbody', plan: '# P\nbody' });
  const a = runKnowledgeRebuild({ home, roots: [root], now: NOW });
  const b = runKnowledgeRebuild({ home, roots: [root], now: NOW });
  const pid = projectIdFor(root);
  const ca = a.index.entries.filter(e => e.project_id === pid).length;
  const cb = b.index.entries.filter(e => e.project_id === pid).length;
  check('runKnowledgeRebuild: idempotent project entry count', ca === cb && ca === 2);
  check('runKnowledgeRebuild: no duplicate ids', new Set(b.index.entries.map(e => e.id)).size === b.index.entries.length);
}

// ── runKnowledgeRebuild: verdict-only fallback still refreshes verdicts ────────
{
  const home = freshHome();
  // A home-global verdict exists but no shared project => derive yields nothing.
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.prism-phase-1-5-verdicts.jsonl'),
    JSON.stringify({ verdict: 'APPROVED', note: 'concurrent teardown deadlock fix' }) + '\n');
  const fallbackRoot = freshProject('fallback'); // no share marker
  const res = runKnowledgeRebuild({ home, roots: [fallbackRoot], now: NOW });
  check('runKnowledgeRebuild: always-on verdicts indexed even with no shared project',
    res.index.entries.some(e => e.type === 'verdict'));
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
