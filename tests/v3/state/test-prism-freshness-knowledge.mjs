#!/usr/bin/env node
// Unit tests for checkKnowledgeIndexStale in hooks/lib/prism-freshness-sweep.mjs
// (PRISM v5.0 F4 Phase E). Run: node tests/v3/state/test-prism-freshness-knowledge.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// SYNCHRONOUS harness. Contract (F4 §5): a sibling to checkKbIndexStale that
// compares the KNOWLEDGE index's source_mtime_max against the newest shared-corpus
// .md/jsonl mtime; nudges to rebuild when behind. Silent when no knowledge index
// exists (feature not in use). Absorbs the v4.6-deferred cross-project freshness item.

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { checkKnowledgeIndexStale } from '../../../hooks/lib/prism-freshness-sweep.mjs';
import { buildKnowledgeIndex, KNOWLEDGE_INDEX_REL } from '../../../tools/prism-kb-knowledge-indexer.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

function freshHome() { return mkdtempSync(join(tmpdir(), 'prism-fk-home-')); }
function freshProject() { return mkdtempSync(join(tmpdir(), 'prism-fk-proj-')); }
function writeFile(p, content) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

// ── no knowledge index => silent ──────────────────────────────────────────────
{
  const home = freshHome();
  check('no knowledge index => null (feature not in use)', checkKnowledgeIndexStale(home) === null);
}

// ── fresh index => silent; bumped corpus mtime => stale nudge ──────────────────
{
  const home = freshHome();
  const root = freshProject();
  writeFileSync(join(root, '.prism-kb-share.json'),
    JSON.stringify({ version: 1, shared_types: ['lesson'], shared_at: '2026-05-29T00:00:00.000Z' }));
  const lessonPath = join(root, 'docs', 'prism', 'lessons', 'l1.md');
  writeFile(lessonPath, '# Lesson\nshutdown race body');
  buildKnowledgeIndex({ home, projectRoot: root, now: '2026-05-29T12:00:00.000Z' });

  check('index exists at the documented path', statSync(join(home, KNOWLEDGE_INDEX_REL)).isFile());
  check('fresh index (no corpus change) => null', checkKnowledgeIndexStale(home) === null);

  // Bump the lesson's mtime well past the index's source_mtime_max.
  const future = Date.now() / 1000 + 100000;
  utimesSync(lessonPath, future, future);
  const notice = checkKnowledgeIndexStale(home);
  check('bumped shared-corpus mtime => non-null nudge', typeof notice === 'string' && notice.length > 0);
  check('nudge names the knowledge rebuild path', /prism-kb-knowledge-rebuild/.test(notice || ''));
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
