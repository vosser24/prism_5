#!/usr/bin/env node
// tests/v3/cli/knowledge-delta-lesson-ref-parity.test.mjs
//
// Anti-rot parity test for lesson `ref` derivation across the TWO code paths
// that both write .claude/references/knowledge-index.md:
//
//   1. append  → tools/prism-knowledge-index.mjs   (parseSingleFile)
//   2. delta   → tools/lib/knowledge-delta.mjs      (applyDelta, the
//                SessionStart self-heal — re-renders the WHOLE index)
//
// THE DEFECT (task #22, a D046-finding-#4 instance): parseLessonFilename was
// COPY-PASTED into both modules. task #21 fixed the copy in
// prism-knowledge-index.mjs (ref = full filename stem) but left the copy in
// knowledge-delta.mjs on the OLD date-only bug (ref = 'YYYY-MM-DD'). So the
// moment applyDelta re-renders (any corpus change on the next SessionStart) it
// rewrites EVERY lesson ref back to the collision-prone bare-date form —
// silently regressing task #21. Two copies of one function, diverged.
//
// THE CONTRACT this pins: append and delta MUST produce IDENTICAL, full-slug
// lesson refs for the same corpus, and two same-date lessons must survive with
// DISTINCT refs through BOTH paths.
//
// This test MUST FAIL against pre-fix code (the delta re-render regresses the
// same-date pair to a single bare-date ref) and pass once ONE definition of
// parseLessonFilename governs both paths.
//
// Run: node tests/v3/cli/knowledge-delta-lesson-ref-parity.test.mjs

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.KB_CLI_UNDER_TEST
  || join(__dirname, '..', '..', '..', 'tools', 'prism-knowledge-index.mjs');

let pass = 0, fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n        ${msg || 'condition false'}`); }
}

function runCLI(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--root', root], {
    timeout: 20000,
    encoding: 'utf-8',
  });
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'prism-kb-refparity-'));
  mkdirSync(join(root, 'docs', 'prism', 'lessons'), {recursive: true});
  mkdirSync(join(root, 'docs', 'prism', 'adjudications'), {recursive: true});
  return root;
}

function lessonContent(title) {
  return `# ${title}\n\n**Status:** Locked\n**Date:** 2026-07-17\n**Captured by:** test\n**Rule:** Test rule for ${title}.\n\nBody text.\n`;
}

function indexBody(root) {
  const p = join(root, '.claude', 'references', 'knowledge-index.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

// All lesson refs in the rendered index, as a set of strings.
function lessonRefs(root) {
  const body = indexBody(root);
  const refs = [];
  const re = /\[\[lesson:([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body)) !== null) refs.push(m[1]);
  return refs;
}

// Only the 2026-07-17-* refs, sorted, for the append-vs-delta identity check.
function sameDateRefs(root) {
  return lessonRefs(root).filter(r => r.startsWith('2026-07-17')).sort();
}

let root;
try {
  root = makeRoot();
  const lessonsDir = join(root, 'docs', 'prism', 'lessons');

  const A = '2026-07-17-session.md';
  const B = '2026-07-17-session-addendum.md';
  writeFileSync(join(lessonsDir, A), lessonContent('Session Lessons'));
  writeFileSync(join(lessonsDir, B), lessonContent('Session Lessons Addendum'));

  // ── APPEND PATH ─────────────────────────────────────────────────────────
  const rA = runCLI(root, ['append', '--type', 'lesson', '--file', A]);
  const rB = runCLI(root, ['append', '--type', 'lesson', '--file', B]);
  check('append both same-date lessons → exit 0', rA.status === 0 && rB.status === 0,
    `rA=${rA.status} ${rA.stderr}\nrB=${rB.status} ${rB.stderr}`);

  const appendRefs = sameDateRefs(root);
  check('append path: BOTH same-date lessons present with DISTINCT full-slug refs',
    appendRefs.length === 2 &&
    appendRefs.includes('2026-07-17-session') &&
    appendRefs.includes('2026-07-17-session-addendum'),
    `append 2026-07-17 refs = ${JSON.stringify(appendRefs)}`);
  check('append path: no bare-date ref [[lesson:2026-07-17]]',
    !appendRefs.includes('2026-07-17'),
    `append 2026-07-17 refs = ${JSON.stringify(appendRefs)}`);

  // ── DELTA PATH ──────────────────────────────────────────────────────────
  // Force applyDelta to actually re-render: drop a THIRD, differently-dated
  // lesson into the corpus so computeDelta sees added != [] (this is exactly
  // the SessionStart-after-a-new-lesson case). applyDelta re-renders the WHOLE
  // index for EVERY lesson via knowledge-delta.mjs's parseLessonFilename.
  writeFileSync(join(lessonsDir, '2026-07-16-other.md'), lessonContent('Other Day Lesson'));

  const rDelta = runCLI(root, ['delta', '--json']);
  check('delta → exit 0', rDelta.status === 0, `stderr=${rDelta.stderr}`);

  const deltaRefs = sameDateRefs(root);

  // (a) full-slug on the delta path
  check('delta path: same-date pair present with DISTINCT full-slug refs (REGRESSES pre-fix)',
    deltaRefs.length === 2 &&
    deltaRefs.includes('2026-07-17-session') &&
    deltaRefs.includes('2026-07-17-session-addendum'),
    `delta 2026-07-17 refs = ${JSON.stringify(deltaRefs)}  (pre-fix: collapses to bare '2026-07-17')`);

  // (b) IDENTICAL across the append path and the delta path
  check('append and delta produce IDENTICAL same-date refs (single-owner parser)',
    JSON.stringify(appendRefs) === JSON.stringify(deltaRefs),
    `append=${JSON.stringify(appendRefs)}\n        delta =${JSON.stringify(deltaRefs)}`);

  // (c) the bare-date collision form never appears on the delta path
  check('delta path: no bare-date ref [[lesson:2026-07-17]]',
    !deltaRefs.includes('2026-07-17'),
    `delta 2026-07-17 refs = ${JSON.stringify(deltaRefs)}`);
} finally {
  if (root) { try { rmSync(root, {recursive: true, force: true}); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
