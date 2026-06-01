#!/usr/bin/env node
// Unit tests for the knowledge-dirty classification in hooks/prism-kb-autosync.mjs
// (PRISM v5.0 F4 Phase E). Run: node tests/v3/state/test-prism-kb-autosync-knowledge.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// SYNCHRONOUS harness. The hook exports two pure helpers so its path-gating logic
// is testable without feeding stdin:
//   knowledgeCorpusType(absPath) -> 'adjudication'|'lesson'|'plan'|'panel-rationale'|'verdict'|null
//   isKnowledgeDirtyPath(absPath, {existsFn, readShareTypes}) -> bool
// Contract (F4 §5): project corpus marks dirty ONLY for the project's SHARED types
// (default-deny when no marker); verdict paths ALWAYS mark dirty (always-on).

import { join } from 'path';
import { knowledgeCorpusType, isKnowledgeDirtyPath } from '../../../hooks/prism-kb-autosync.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

const ROOT = join('Y:', 'proj');

// ── knowledgeCorpusType ───────────────────────────────────────────────────────
check('corpusType: lesson md', knowledgeCorpusType(join(ROOT, 'docs', 'prism', 'lessons', 'a.md')) === 'lesson');
check('corpusType: plan md', knowledgeCorpusType(join(ROOT, 'docs', 'prism', 'plans', 'a.md')) === 'plan');
check('corpusType: adjudication md', knowledgeCorpusType(join(ROOT, 'docs', 'prism', 'adjudications', 'D1.md')) === 'adjudication');
check('corpusType: panel.json under tasks/workspace', knowledgeCorpusType(join(ROOT, 'tasks', 'workspace', 'x', 'panel.json')) === 'panel-rationale');
check('corpusType: verdict jsonl', knowledgeCorpusType(join('C:', 'Users', 'u', '.claude', '.prism-phase-1-5-verdicts.jsonl')) === 'verdict');
check('corpusType: per-sha verdict json', knowledgeCorpusType(join('C:', 'Users', 'u', '.claude', '.prism-phase-0d-verdicts-abc123.json')) === 'verdict');
check('corpusType: unrelated md => null', knowledgeCorpusType(join(ROOT, 'README.md')) === null);
check('corpusType: non-panel json under workspace => null', knowledgeCorpusType(join(ROOT, 'tasks', 'workspace', 'x', 'state.json')) === null);

// ── isKnowledgeDirtyPath: project corpus gated by share marker ────────────────
{
  const markerPath = join(ROOT, '.prism-kb-share.json');
  const existsFn = (p) => p === markerPath;          // marker only at ROOT
  const lessonPath = join(ROOT, 'docs', 'prism', 'lessons', 'a.md');

  check('dirty: shared lesson => true',
    isKnowledgeDirtyPath(lessonPath, { existsFn, readShareTypes: () => ['lesson', 'plan'] }) === true);
  check('dirty: withheld type (lesson not shared) => false',
    isKnowledgeDirtyPath(lessonPath, { existsFn, readShareTypes: () => ['plan'] }) === false);
  check('dirty: no marker anywhere => false (default-deny)',
    isKnowledgeDirtyPath(lessonPath, { existsFn: () => false, readShareTypes: () => ['lesson'] }) === false);
}

// ── isKnowledgeDirtyPath: verdicts always dirty (exempt from share marker) ─────
{
  const verdictPath = join('C:', 'Users', 'u', '.claude', '.prism-phase-1-5-verdicts.jsonl');
  check('dirty: verdict always true even with no marker / no shared types',
    isKnowledgeDirtyPath(verdictPath, { existsFn: () => false, readShareTypes: () => null }) === true);
}

// ── isKnowledgeDirtyPath: unrelated path => false ─────────────────────────────
check('dirty: unrelated path => false',
  isKnowledgeDirtyPath(join(ROOT, 'src', 'index.js'), { existsFn: () => true, readShareTypes: () => ['lesson'] }) === false);

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
