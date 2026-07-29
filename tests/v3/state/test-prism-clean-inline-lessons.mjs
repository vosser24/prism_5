#!/usr/bin/env node
// Task #45 item 1a — regression test for the D083-decided fix to /prism-clean's
// Phase H "append lesson" path.
//
// THE BUG (repair-1a-inline brief, panel-decided 4-0, locked D083): appendLesson()
// in tools/prism-clean.mjs wrote a `- [[lessons-tactical#<date>]] <title>` POINTER
// into .claude/agents/MEMORY.md, implying the full lesson body lives in
// tasks/lessons-tactical.md and can be resolved from the pointer. But nothing in
// the /prism-clean flow ever performs the matching append into
// tasks/lessons-tactical.md — the pointer therefore resolves to nothing. This
// fired again during the very 2026-07-27 /prism-clean run that produced the
// current handoff (see .claude/agents/MEMORY.md "Recent lessons" section: 9
// dangling `[[lessons-tactical#2026-07-27]]` pointers, zero corresponding
// entries in tasks/lessons-tactical.md for that date).
//
// THE FIX (owner-approved, INLINE option): write the lesson TEXT (the one-line
// **Rule:** imperative passed as --title) directly into MEMORY.md and drop the
// `[[lessons-tactical#...]]` pointer form entirely — mirroring the format
// append-summary already uses (`- [<date>] <text>`), since there is nothing to
// resolve once the text is inline.
//
// This test operates entirely on ephemeral git-initialized temp directories
// passed via --root, exactly like tests/v3/state/test-prism-clean.mjs — it never
// touches the real .claude/agents/MEMORY.md or tasks/lessons-tactical.md.
//
// Run: node tests/v3/state/test-prism-clean-inline-lessons.mjs

import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-clean.mjs');

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

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-clean-inline-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  spawnSync('git', ['-C', root, 'config', 'user.email', 'test@test'], {});
  spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], {});
  return root;
}

// Mirrors the exact shape tools/prism-deep-dive.mjs renderMemoryMd writes,
// including the Phase-H anchor comments the subcommands key on. The anchor
// text itself is left byte-identical to production — only the format of the
// line appended UNDER it is under test here.
function seedMemoryMd(root) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = [
    '# MEMORY.md — test router',
    '',
    '## Recent decisions (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->',
    '',
    '## Recent lessons (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->',
    '',
    '## Session log',
    '',
    '<!-- /prism-clean appends session-summary lines here. -->',
    '',
    '## Active specialists',
    '',
    '- (none hired yet)',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8');
  return join(dir, 'MEMORY.md');
}

// Seeds MEMORY.md with pre-existing OLD-format `[[lessons-tactical#...]]`
// pointer bullets already sitting under the anchor, to prove the fix does not
// silently corrupt/crash on them (migration policy is documented, not code —
// see the last test below).
function seedMemoryMdWithLegacyPointers(root, n) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const legacyLines = [];
  for (let i = 1; i <= n; i++) {
    legacyLines.push(`- [[lessons-tactical#2026-07-2${i}]] Legacy lesson ${i}`);
  }
  const body = [
    '# MEMORY.md — test router',
    '',
    '## Recent lessons (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->',
    ...legacyLines,
    '',
    '## Session log',
    '',
    '<!-- /prism-clean appends session-summary lines here. -->',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8');
  return join(dir, 'MEMORY.md');
}

// Reproduces the EXACT structural shape of the live .claude/agents/MEMORY.md
// (verified by direct read + `git log -S` on 2026-07-28): a canonical,
// anchored "## Recent lessons (last 10, pointer-only)" section (the one
// append-lesson targets, confirmed non-empty in production — 9 populated
// bullets) PLUS a second, UNANCHORED "## Recent lessons (new pointer)"
// heading further down, holding 3 old `[[lessons#...]]` entries. That second
// heading was traced via `git log -S"Recent lessons (new pointer)"` to commit
// 4a8871409 ("docs(prism): session capture — D031 + Phase-4 a+b+c lessons +
// handoff", 2026-06-24) — a hand-authored /prism-clean docs-capture commit
// that predates the anchor mechanism (tools/lib/memory-anchors.mjs, C1) and
// carries NO anchor comment beneath it. No code path (grepped across
// tools/*.mjs) ever emits the string "Recent lessons (new pointer)" — it is
// orphaned legacy content, not a second live target of appendLesson(). This
// fixture proves that in code, not just by inspection: append-lesson must
// operate ONLY on the anchored section and must never create, duplicate, or
// touch the orphaned heading.
function seedMemoryMdWithLegacyHeadingShape(root) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = [
    '# MEMORY.md — test router',
    '',
    '## Recent lessons (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->',
    '',
    '- [[lessons-tactical#2026-07-27]] Existing canonical entry',
    '',
    '## Session log',
    '',
    '<!-- /prism-clean appends session-summary lines here. -->',
    '',
    '## Recent lessons (new pointer)',
    '',
    '- [[lessons#2026-06-23-legacy-a]] Old hand-authored entry A',
    '- [[lessons#2026-07-20-legacy-b]] Old hand-authored entry B',
    '',
    '## Standing rules',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8');
  return join(dir, 'MEMORY.md');
}

function readMemoryMd(root) {
  return readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ─────────────────────────────────────────────────────────────────────────

test('append-lesson: does NOT emit a `[[lessons-tactical#...]]` pointer', () => {
  const root = makeTestbed('no-pointer');
  try {
    seedMemoryMd(root);
    const r = run(root, 'append-lesson', '--slug', 'foo',
                  '--date', '2026-07-28', '--title', 'Repair the delivery layer before adding a new trigger');
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const body = readMemoryMd(root);
    // Match only a bullet-form pointer (`- [[lessons-tactical#...`), not the
    // anchor comment itself — the anchor's doc text legitimately still
    // mentions "[[lessons-tactical#date]]" as a historical description and
    // is out of this fix's scope (memory-heal.mjs, sibling-owned, keys on it).
    assert(!/^- \[\[lessons-tactical#/m.test(body),
      'a NEW `[[lessons-tactical#...]]` pointer BULLET must never be emitted — found one in:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: writes the lesson TEXT (the --title Rule imperative) directly, non-vacuously', () => {
  const root = makeTestbed('inline-text');
  try {
    seedMemoryMd(root);
    const title = 'Count-based retention fails under concurrency; age-based does not';
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-07-28', '--title', title);
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const body = readMemoryMd(root);
    assert(body.includes(title), 'the lesson title text itself must be written inline into MEMORY.md:\n' + body);
    assert(body.includes('2026-07-28'), 'the date must still be recorded alongside the inline text');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: line format matches the dated-bullet convention append-summary already uses', () => {
  const root = makeTestbed('format');
  try {
    seedMemoryMd(root);
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-07-28', '--title', 'Some rule text');
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[2026-07-28\] Some rule text/.test(body),
      'expected a `- [2026-07-28] Some rule text` bullet, got:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: anchor comment survives (still resolvable by memory-heal.mjs)', () => {
  const root = makeTestbed('anchor-survives');
  try {
    seedMemoryMd(root);
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-07-28', '--title', 'x');
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const body = readMemoryMd(root);
    assert(/<!-- \/prism-clean appends `\[\[lessons-tactical#date\]\]` lines here per Phase H\. -->/.test(body),
      'the anchor comment text must remain byte-identical — memory-heal.mjs (sibling-owned) keys on this exact string');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: still trims to last 10 entries under the new inline format', () => {
  const root = makeTestbed('trim');
  try {
    seedMemoryMd(root);
    for (let i = 1; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      const r = run(root, 'append-lesson', '--slug', 'foo', '--date', date, '--title', `Lesson ${i}`);
      assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    }
    const body = readMemoryMd(root);
    assert(!/2026-05-01/.test(body), 'first lesson should have been trimmed');
    assert(!/2026-05-02/.test(body), 'second lesson should have been trimmed');
    for (let i = 3; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      assert(body.includes(date), `${date} should remain in the last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: pre-existing legacy `[[lessons-tactical#...]]` pointers are left untouched (not migrated) and are not orphaned by a crash', () => {
  const root = makeTestbed('legacy-untouched');
  try {
    seedMemoryMdWithLegacyPointers(root, 3);
    const before = readMemoryMd(root);
    assert(/\[\[lessons-tactical#2026-07-21\]\] Legacy lesson 1/.test(before), 'fixture sanity: legacy pointer 1 present');
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-07-28', '--title', 'New inline lesson');
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const after = readMemoryMd(root);
    // Documented behavior: legacy pointers are NOT rewritten in place (out of
    // this fix's scope) — they coexist with new inline entries and age out
    // through the same last-10 trim window as everything else.
    assert(/\[\[lessons-tactical#2026-07-21\]\] Legacy lesson 1/.test(after),
      'legacy pointer must survive untouched (documented non-migration), got:\n' + after);
    assert(/- \[2026-07-28\] New inline lesson/.test(after), 'new inline lesson must also be present');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: against the live two-heading shape, appends only to the canonical anchored section, never creates/duplicates a heading, and leaves the orphaned legacy heading byte-for-byte untouched', () => {
  const root = makeTestbed('two-heading-shape');
  try {
    seedMemoryMdWithLegacyHeadingShape(root);
    const before = readMemoryMd(root);
    const headingCountBefore = (before.match(/^## Recent lessons/gm) || []).length;
    assert(headingCountBefore === 2, 'fixture sanity: expected exactly 2 "Recent lessons" headings, got ' + headingCountBefore);

    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-07-28', '--title', 'New canonical entry');
    assert(r.status === 0, 'expected exit 0: ' + r.stderr);
    const after = readMemoryMd(root);

    // No new heading was created — still exactly 2, never 3.
    const headingCountAfter = (after.match(/^## Recent lessons/gm) || []).length;
    assert(headingCountAfter === 2,
      `append-lesson must not create/duplicate a "Recent lessons" heading — expected 2, got ${headingCountAfter}:\n${after}`);

    // The new entry landed in the CANONICAL section: between the anchor and
    // the next "## " heading ("## Session log"), NOT after the legacy heading.
    const canonicalSection = after.split('## Session log')[0];
    assert(/- \[2026-07-28\] New canonical entry/.test(canonicalSection),
      'new inline entry must land in the canonical anchored section, got:\n' + canonicalSection);

    // The orphaned legacy heading and its 3 (now still 2, per fixture) old
    // entries are completely untouched — same content, same position.
    const legacySection = after.split('## Recent lessons (new pointer)')[1];
    assert(legacySection && legacySection.includes('[[lessons#2026-06-23-legacy-a]] Old hand-authored entry A'),
      'orphaned legacy heading entry A must survive untouched');
    assert(legacySection && legacySection.includes('[[lessons#2026-07-20-legacy-b]] Old hand-authored entry B'),
      'orphaned legacy heading entry B must survive untouched');
    assert(!legacySection.includes('New canonical entry'),
      'the new entry must NOT be written into the orphaned legacy heading');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
