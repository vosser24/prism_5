#!/usr/bin/env node
// tests/v3/cli/knowledge-index-append-pathfix.test.mjs
//
// Contract test for tools/prism-knowledge-index.mjs parseSingleFile().
//
// THE ORIGINAL DEFECT: for any non-absolute --file, parseSingleFile()
// unconditionally prepended the corpus dir (docs/prism/lessons or
// docs/prism/adjudications) without checking whether filePath already
// contained that prefix. A relative path that already includes the
// corpus-dir prefix (the form used by /prism-clean and documented in
// --file's own usage text) got the prefix doubled and failed "file not found".
//
// THE CONTRACT (what this file pins down), three accepted --file forms:
//   (a) bare basename (no separator) → resolved inside the corpus dir
//   (b) relative WITH separators     → resolved against --root
//   (c) absolute path                → used as-is
// ...and then, unconditionally, the resolved path MUST be a real FILE that is
// a DIRECT CHILD of the corpus dir FOR THE GIVEN --type. Anything else dies
// non-zero. The corpus dir is no longer allowed to validate --type
// *implicitly* via path arithmetic (an accident); containment is EXPLICIT.
//
// Per D047 (vacuous signals): an exit 0 here must mean "filed the right thing
// in the right place", NOT merely "found something on disk". Existence-based
// dispatch collapses YES/NO/UNKNOWN and is banned.
//
// F-numbers below match the audit findings this file locks closed.
//
// NOTE (scope): lesson `ref` is derived from date only (parseLessonFilename),
// so two same-date lessons collide and evict each other in the index. That is
// a SEPARATE pre-existing data-loss bug (task #21), NOT under test here — every
// lesson case below uses a DISTINCT DATE to sidestep it.
//
// Run: node tests/v3/cli/knowledge-index-append-pathfix.test.mjs

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
    timeout: 15000,
    encoding: 'utf-8',
  });
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'prism-kb-pathfix-'));
  mkdirSync(join(root, 'docs', 'prism', 'lessons'), {recursive: true});
  mkdirSync(join(root, 'docs', 'prism', 'adjudications'), {recursive: true});
  return root;
}

function manifestKeys(root) {
  const p = join(root, '.claude', 'references', '.knowledge-manifest.json');
  if (!existsSync(p)) return [];
  try { return Object.keys(JSON.parse(readFileSync(p, 'utf8')).files || {}); }
  catch { return []; }
}

function indexBody(root) {
  const p = join(root, '.claude', 'references', 'knowledge-index.md');
  if (!existsSync(p)) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

// Each case gets a distinct file (distinct ref) so upserts never collide and
// each result can be checked independently.
const LESSON_CASES = [
  {form: 'bare basename', name: '2026-01-01-form-a-lesson.md', title: 'Lesson Form A'},
  {form: 'relative incl. prefix', name: '2026-01-02-form-b-lesson.md', title: 'Lesson Form B'},
  {form: 'absolute path', name: '2026-01-03-form-c-lesson.md', title: 'Lesson Form C'},
];

const ADJ_CASES = [
  {form: 'bare basename', name: 'D901-form-a-adj.md', title: 'Adjudication Form A', ref: 'D901'},
  {form: 'relative incl. prefix', name: 'D902-form-b-adj.md', title: 'Adjudication Form B', ref: 'D902'},
  {form: 'absolute path', name: 'D903-form-c-adj.md', title: 'Adjudication Form C', ref: 'D903'},
];

function lessonContent(title) {
  return `# ${title}\n\n**Status:** Locked\n**Date:** 2026-01-01\n**Captured by:** test\n**Rule:** Test rule for ${title}.\n\nBody text.\n`;
}

function adjContent(title) {
  return `# ${title}\n\n**Status:** Proposed\n**Date:** 2026-01-01\n**Captured by:** test\n**Rule:** Test rule for ${title}.\n\nBody text.\n`;
}

function runCase({root, type, corpusDir, caseDef, filePathFor}) {
  const absPath = join(corpusDir, caseDef.name);
  writeFileSync(absPath, type === 'lesson' ? lessonContent(caseDef.title) : adjContent(caseDef.title));

  const filePath = filePathFor(caseDef);
  const result = runCLI(root, ['append', '--type', type, '--file', filePath]);
  return result;
}

let root;
try {
  root = makeRoot();
  const lessonsDir = join(root, 'docs', 'prism', 'lessons');
  const adjDir = join(root, 'docs', 'prism', 'adjudications');

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1 — the 6 form×type cases (the original bug must stay fixed)
  // ═══════════════════════════════════════════════════════════════════════

  // ── lessons: 3 forms ──────────────────────────────────────────────────
  {
    const [formA, formB, formC] = LESSON_CASES;

    const rA = runCase({
      root, type: 'lesson', corpusDir: lessonsDir, caseDef: formA,
      filePathFor: (c) => c.name, // bare basename
    });
    check('lesson (a) bare basename → exit 0', rA.status === 0,
      `stdout=${rA.stdout}\nstderr=${rA.stderr}`);

    const rB = runCase({
      root, type: 'lesson', corpusDir: lessonsDir, caseDef: formB,
      filePathFor: (c) => join('docs', 'prism', 'lessons', c.name), // relative incl. prefix
    });
    check('lesson (b) relative incl. prefix → exit 0', rB.status === 0,
      `stdout=${rB.stdout}\nstderr=${rB.stderr}`);

    const rC = runCase({
      root, type: 'lesson', corpusDir: lessonsDir, caseDef: formC,
      filePathFor: (c) => join(lessonsDir, c.name), // absolute
    });
    check('lesson (c) absolute path → exit 0', rC.status === 0,
      `stdout=${rC.stdout}\nstderr=${rC.stderr}`);
  }

  // ── adjudications: 3 forms ────────────────────────────────────────────
  {
    const [formA, formB, formC] = ADJ_CASES;

    const rA = runCase({
      root, type: 'adjudication', corpusDir: adjDir, caseDef: formA,
      filePathFor: (c) => c.name, // bare basename
    });
    check('adjudication (a) bare basename → exit 0', rA.status === 0,
      `stdout=${rA.stdout}\nstderr=${rA.stderr}`);

    const rB = runCase({
      root, type: 'adjudication', corpusDir: adjDir, caseDef: formB,
      filePathFor: (c) => join('docs', 'prism', 'adjudications', c.name), // relative incl. prefix
    });
    check('adjudication (b) relative incl. prefix → exit 0', rB.status === 0,
      `stdout=${rB.stdout}\nstderr=${rB.stderr}`);

    const rC = runCase({
      root, type: 'adjudication', corpusDir: adjDir, caseDef: formC,
      filePathFor: (c) => join(adjDir, c.name), // absolute
    });
    check('adjudication (c) absolute path → exit 0', rC.status === 0,
      `stdout=${rC.stdout}\nstderr=${rC.stderr}`);
  }

  // ── sanity: all 6 titles actually landed in the rendered index ────────
  {
    const body = indexBody(root);
    for (const c of [...LESSON_CASES, ...ADJ_CASES]) {
      check(`index contains title for ${c.form} (${c.name})`,
        body.includes(c.title),
        `expected "${c.title}" in index body`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2 — F1: type/path MISMATCH must be REJECTED, in BOTH directions.
  //
  // The corpus dir used to validate --type implicitly (a real adjudication
  // path under --type lesson double-prefixed itself into a not-found).
  // Containment must now reject it DELIBERATELY. The consumer is
  // commands/prism-clean.md:217-220 — a prompt spec where an LLM supplies
  // BOTH --type and --file, so a mismatch is a realistic slip that must
  // fail LOUDLY rather than mis-file an adjudication as a lesson at exit 0.
  // ═══════════════════════════════════════════════════════════════════════

  // ── F1a: --type lesson + a REAL adjudication path ────────────────────
  {
    const name = 'D905-real-adjudication.md';
    writeFileSync(join(adjDir, name), adjContent('Real Adjudication D905'));
    const r = runCLI(root, [
      'append', '--type', 'lesson',
      '--file', join('docs', 'prism', 'adjudications', name),
    ]);
    check('F1a lesson --type + adjudication path → NON-ZERO exit',
      r.status !== 0,
      `expected non-zero, got ${r.status}; stdout=${r.stdout}`);
    check('F1a → no manifest key for the mis-typed file',
      !manifestKeys(root).some(k => k.includes('D905-real-adjudication')),
      `manifest keys=${JSON.stringify(manifestKeys(root))}`);
    check('F1a → index does NOT gain a lesson: line for D905',
      !indexBody(root).includes('lesson:D905-real-adjudication'),
      'index gained `- [[lesson:D905-real-adjudication]]` — adjudication filed as lesson');
    check('F1a → error names --type/containment, not a mangled join',
      /corpus|--type|not (a|an) .*(lesson|adjudication)|outside/i.test(r.stderr || ''),
      `stderr=${r.stderr}`);
  }

  // ── F1b: --type adjudication + a REAL lesson path ────────────────────
  // The lesson file is deliberately named `D904-...` so that it MATCHES
  // parseAdjFilename's `D###-<slug>.md` regex. That regex is the ONLY thing
  // rejecting this direction today — i.e. it passes by ACCIDENT. A lesson
  // named like an adjudication defeats the accident; containment must catch
  // it on purpose.
  {
    const name = 'D904-lesson-named-like-adj.md';
    writeFileSync(join(lessonsDir, name), lessonContent('Lesson Named Like Adj'));
    const r = runCLI(root, [
      'append', '--type', 'adjudication',
      '--file', join('docs', 'prism', 'lessons', name),
    ]);
    check('F1b adjudication --type + lesson path → NON-ZERO exit (deliberately, not via D###- regex)',
      r.status !== 0,
      `expected non-zero, got ${r.status}; stdout=${r.stdout}`);
    check('F1b → no manifest key for the mis-typed file',
      !manifestKeys(root).some(k => k.includes('D904-lesson-named-like-adj')),
      `manifest keys=${JSON.stringify(manifestKeys(root))}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 3 — F2: a bare basename must resolve in the CORPUS dir, even when a
  // same-named decoy exists at --root. Form (a) is dispatched by path SHAPE,
  // never by which candidate happens to exist.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const name = '2026-01-04-decoy.md';
    writeFileSync(join(lessonsDir, name), lessonContent('Corpus Decoy Lesson'));
    writeFileSync(join(root, name), lessonContent('ROOT DECOY WRONG FILE'));
    const r = runCLI(root, ['append', '--type', 'lesson', '--file', name]);
    check('F2 bare basename with root decoy → exit 0', r.status === 0,
      `stdout=${r.stdout}\nstderr=${r.stderr}`);
    check('F2 → resolved the CORPUS file, not the root decoy',
      indexBody(root).includes('Corpus Decoy Lesson') &&
      !indexBody(root).includes('ROOT DECOY WRONG FILE'),
      'root decoy won the resolution — bare basename must be corpus-scoped');
    check('F2 → manifest key is corpus-relative, not a bare root key',
      manifestKeys(root).includes('docs/prism/lessons/' + name) &&
      !manifestKeys(root).includes(name),
      `manifest keys=${JSON.stringify(manifestKeys(root))}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 4 — F3: a `../` path that escapes the corpus must be rejected.
  // ═══════════════════════════════════════════════════════════════════════
  {
    writeFileSync(join(root, 'outside-corpus.md'), lessonContent('Outside Corpus File'));
    const r = runCLI(root, [
      'append', '--type', 'lesson',
      '--file', 'docs/prism/lessons/../../../outside-corpus.md',
    ]);
    check('F3 ../ escaping path → NON-ZERO exit', r.status !== 0,
      `expected non-zero, got ${r.status}; stdout=${r.stdout}`);
    check('F3 → nothing outside the corpus entered the manifest',
      !manifestKeys(root).some(k => k.includes('outside-corpus')),
      `manifest keys=${JSON.stringify(manifestKeys(root))}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 5 — F4: a DIRECTORY must die() cleanly (existsSync is not isFile).
  // ═══════════════════════════════════════════════════════════════════════
  {
    // F4a: bare basename 'docs' → corpus-scoped, so simply not found. Under
    // shape-based dispatch this never reaches isFile(); asserting isFile()
    // semantics here would test nothing.
    const rA = runCLI(root, ['append', '--type', 'lesson', '--file', 'docs']);
    check('F4a bare basename naming a root dir → NON-ZERO exit', rA.status !== 0,
      `expected non-zero, got ${rA.status}; stdout=${rA.stdout}`);
    check('F4a → no raw EISDIR / stack trace leaked',
      !/EISDIR/.test(rA.stderr || '') && !/\n\s+at /.test(rA.stderr || ''),
      `stderr=${rA.stderr}`);

    // F4b: form (b) naming a real directory outside the corpus.
    const rB = runCLI(root, ['append', '--type', 'lesson', '--file', 'docs/prism']);
    check('F4b relative path naming a real directory → NON-ZERO exit', rB.status !== 0,
      `expected non-zero, got ${rB.status}; stdout=${rB.stdout}`);
    check('F4b → no raw EISDIR / stack trace leaked',
      !/EISDIR/.test(rB.stderr || '') && !/\n\s+at /.test(rB.stderr || ''),
      `stderr=${rB.stderr}`);
    check('F4b → error message is intelligible',
      /not a file|not inside the corpus/i.test(rB.stderr || ''),
      `stderr=${rB.stderr}`);

    // F4c: THE load-bearing case — a directory that IS a direct child of the
    // corpus dir. It passes existence AND containment, so ONLY isFile() can
    // reject it.
    mkdirSync(join(lessonsDir, '2026-01-08-i-am-a-dir.md'), {recursive: true});
    const rC = runCLI(root, [
      'append', '--type', 'lesson', '--file', '2026-01-08-i-am-a-dir.md',
    ]);
    check('F4c directory directly inside corpus → NON-ZERO exit', rC.status !== 0,
      `expected non-zero, got ${rC.status}; stdout=${rC.stdout}`);
    check('F4c → no raw EISDIR / stack trace leaked',
      !/EISDIR/.test(rC.stderr || '') && !/\n\s+at /.test(rC.stderr || ''),
      `stderr=${rC.stderr}`);
    check('F4c → error says it is not a file',
      /not a file/i.test(rC.stderr || ''),
      `stderr=${rC.stderr}`);
    check('F4c → the directory did not enter the manifest',
      !manifestKeys(root).some(k => k.includes('i-am-a-dir')),
      `manifest keys=${JSON.stringify(manifestKeys(root))}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 6 — F5: the not-found error must name the path the USER passed,
  // never an internally doubled join.
  //
  // Both forms are exercised. Form (b) is the one that actually doubles: a
  // bare-basename miss joins the corpus dir exactly once and so reports a
  // sane path even on the broken code — testing only form (a) would pass
  // VACUOUSLY and pin nothing.
  // ═══════════════════════════════════════════════════════════════════════
  {
    // form (a) miss — bare basename
    const rA = runCLI(root, [
      'append', '--type', 'lesson', '--file', '2026-01-09-does-not-exist.md',
    ]);
    check('F5a missing bare basename → NON-ZERO exit', rA.status !== 0,
      `expected non-zero, got ${rA.status}`);
    check('F5a → error names the path the user actually passed',
      (rA.stderr || '').includes('2026-01-09-does-not-exist.md'),
      `stderr=${rA.stderr}`);

    // form (b) miss — relative incl. prefix. THIS is where the prefix doubles.
    const rB = runCLI(root, [
      'append', '--type', 'lesson',
      '--file', 'docs/prism/lessons/2026-01-10-does-not-exist.md',
    ]);
    check('F5b missing relative-incl-prefix → NON-ZERO exit', rB.status !== 0,
      `expected non-zero, got ${rB.status}`);
    check('F5b → error names the path the user actually passed',
      (rB.stderr || '').includes('2026-01-10-does-not-exist.md'),
      `stderr=${rB.stderr}`);
    check('F5b → error does NOT contain a doubled corpus prefix',
      !/lessons[\\/]docs[\\/]prism[\\/]lessons/i.test(rB.stderr || ''),
      `stderr shows doubled prefix: ${rB.stderr}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART 7 — F7: a mis-cased path on a case-INSENSITIVE volume must not
  // create a duplicate manifest key.
  //
  // DOCUMENTED BEHAVIOR: the resolved path is canonicalized to its real
  // on-disk casing (realpathSync.native) before the manifest key is derived,
  // so a mis-cased --file upserts the SAME key. On a case-SENSITIVE volume
  // the mis-cased path simply does not exist and dies non-zero; both
  // outcomes are correct, and neither may produce two keys for one file.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const name = '2026-01-05-casecheck.md';
    writeFileSync(join(lessonsDir, name), lessonContent('Case Check Lesson'));

    const r1 = runCLI(root, ['append', '--type', 'lesson', '--file', name]);
    check('F7 setup: correct-case append → exit 0', r1.status === 0,
      `stdout=${r1.stdout}\nstderr=${r1.stderr}`);

    const r2 = runCLI(root, [
      'append', '--type', 'lesson',
      '--file', 'DOCS/PRISM/LESSONS/2026-01-05-CASECHECK.md',
    ]);
    const caseKeys = manifestKeys(root).filter(k => /casecheck/i.test(k));
    check('F7 mis-cased path → never a duplicate manifest key',
      caseKeys.length <= 1,
      `expected <=1 key, got ${caseKeys.length}: ${JSON.stringify(caseKeys)} (exit was ${r2.status})`);
    check('F7 → the surviving key (if any) uses real on-disk casing',
      caseKeys.length === 0 || caseKeys[0] === 'docs/prism/lessons/' + name,
      `keys=${JSON.stringify(caseKeys)}`);
  }
} finally {
  if (root) { try { rmSync(root, {recursive: true, force: true}); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
