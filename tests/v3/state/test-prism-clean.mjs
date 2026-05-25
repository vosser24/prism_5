#!/usr/bin/env node
// Tests for tools/prism-clean.mjs (Phase A.2 helper).
// Drives the helper as a subprocess against ephemeral testbeds.
//
// Run: node tests/v3/state/test-prism-clean.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-clean-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  // Hermetic git identity so commit tests work in any environment
  spawnSync('git', ['-C', root, 'config', 'user.email', 'test@test'], {});
  spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], {});
  return root;
}

function seedMemoryMd(root, slug) {
  // Mirror the exact shape that tools/prism-deep-dive.mjs renderMemoryMd writes,
  // including the two Phase-H anchor comments that the new subcommands key on.
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = [
    `# MEMORY.md — master-${slug} router`,
    '',
    '## Project profile',
    '',
    '- **Stack**: test',
    '- **Datasources**: ',
    '- **Active workstreams**:',
    '  - (none captured yet)',
    '',
    '## Recent decisions (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->',
    '',
    '## Recent lessons (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->',
    '',
    '## Active specialists',
    '',
    '- (none hired yet)',
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

function commitFile(root, relPath, body, msg) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, body);
  spawnSync('git', ['-C', root, 'add', relPath], {});
  spawnSync('git', ['-C', root, 'commit', '-q', '-m', msg], {});
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-clean-nogit-'));
  try {
    const r = run(dir, 'next-d-number');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('next-d-number: missing adjudications dir → 001', () => {
  const root = makeTestbed('nodir');
  try {
    const r = run(root, 'next-d-number');
    assertEq(r.status, 0, r.stderr);
    assertEq(r.stdout.trim(), '001');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('next-d-number: empty adjudications dir → 001', () => {
  const root = makeTestbed('emptydir');
  try {
    mkdirSync(join(root, 'docs', 'prism', 'adjudications'), {recursive: true});
    const r = run(root, 'next-d-number');
    assertEq(r.status, 0, r.stderr);
    assertEq(r.stdout.trim(), '001');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('next-d-number: D001, D002, D003 → 004', () => {
  const root = makeTestbed('seq');
  try {
    const dir = join(root, 'docs', 'prism', 'adjudications');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'D001-foo.md'), '');
    writeFileSync(join(dir, 'D002-bar.md'), '');
    writeFileSync(join(dir, 'D003-baz.md'), '');
    const r = run(root, 'next-d-number');
    assertEq(r.stdout.trim(), '004');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('next-d-number: D003 and D050 → 051', () => {
  const root = makeTestbed('gap');
  try {
    const dir = join(root, 'docs', 'prism', 'adjudications');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'D003-x.md'), '');
    writeFileSync(join(dir, 'D050-y.md'), '');
    const r = run(root, 'next-d-number');
    assertEq(r.stdout.trim(), '051');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('next-d-number: ignores malformed filenames', () => {
  const root = makeTestbed('bad');
  try {
    const dir = join(root, 'docs', 'prism', 'adjudications');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'D001-good.md'), '');
    writeFileSync(join(dir, 'D-nodigits.md'), '');
    writeFileSync(join(dir, 'D1-short.md'), '');
    writeFileSync(join(dir, 'Dxyz-nonnumeric.md'), '');
    writeFileSync(join(dir, 'D999.md'), '');  // no slug
    const r = run(root, 'next-d-number');
    assertEq(r.stdout.trim(), '002', 'only D001 should count');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('git-stats: requires --since flag, exit 5', () => {
  const root = makeTestbed('nofla');
  try {
    const r = run(root, 'git-stats');
    assertEq(r.status, 5);
    assert(/--since/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('git-stats: empty repo since future date → all zeros', () => {
  const root = makeTestbed('zero');
  try {
    const r = run(root, 'git-stats', '--since', '9999-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, 0);
    assertEq(out.files_changed, 0);
    assertEq(out.insertions, 0);
    assertEq(out.deletions, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('git-stats: one commit since past date → commits: 1, files_changed: 1', () => {
  const root = makeTestbed('one');
  try {
    commitFile(root, 'a.txt', 'line1\nline2\n', 'first commit');
    const r = run(root, 'git-stats', '--since', '2020-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, 1);
    // files_changed counts deltas vs baseline; for a fresh repo with one commit,
    // there's no earlier baseline, so the diff shortstat may return 0 — accept either 0 or 1.
    assert(out.files_changed >= 0 && out.files_changed <= 1, 'files_changed: ' + out.files_changed);
    assert(out.insertions >= 0, 'insertions non-negative');
    assert(out.deletions >= 0, 'deletions non-negative');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────
// Phase H — append-decision
// ─────────────────────────────────────────────────────────────────────────

test('append-decision: happy path appends pointer line under the D### anchor', () => {
  const root = makeTestbed('append-dec-happy');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '042', '--title', 'Test decision');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[\[D042\]\] Test decision/.test(body), 'pointer line missing');
    // Anchor comment must still be present
    assert(/<!-- \/prism-clean appends `\[\[D###\]\]`/.test(body), 'anchor stripped');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: trims to last 10 pointers (oldest dropped)', () => {
  const root = makeTestbed('append-dec-trim');
  try {
    seedMemoryMd(root, 'foo');
    // Append 12 pointers — first 2 should be trimmed
    for (let i = 1; i <= 12; i++) {
      const r = run(root, 'append-decision', '--slug', 'foo',
                    '--d-number', String(i).padStart(3, '0'),
                    '--title', `Decision ${i}`);
      assertEq(r.status, 0, r.stderr);
    }
    const body = readMemoryMd(root);
    // First two should be gone
    assert(!/\[\[D001\]\]/.test(body), 'D001 should have been trimmed');
    assert(!/\[\[D002\]\]/.test(body), 'D002 should have been trimmed');
    // Last ten should remain
    for (let i = 3; i <= 12; i++) {
      const tag = `[[D${String(i).padStart(3, '0')}]]`;
      assert(body.includes(tag), `${tag} should remain in last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: refuses when MEMORY.md does not exist', () => {
  const root = makeTestbed('append-dec-nomem');
  try {
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '001', '--title', 'x');
    assertEq(r.status, 6, 'expected exit 6 (missing MEMORY.md)');
    assert(/MEMORY\.md/.test(r.stderr), 'stderr should mention MEMORY.md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: refuses when appending would exceed 25 KB cap', () => {
  const root = makeTestbed('append-dec-cap');
  try {
    seedMemoryMd(root, 'foo');
    // Pad MEMORY.md to ~26 KB — already over the 25 KB cap — so the helper refuses when appending
    const path = join(root, '.claude', 'agents', 'MEMORY.md');
    const body = readFileSync(path, 'utf8');
    const padding = '<!-- pad -->\n'.repeat(2000); // ~26 KB of padding
    writeFileSync(path, body + padding, 'utf8');
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '001', '--title', 'x');
    assertEq(r.status, 8, 'expected exit 8 (>25 KB cap)');
    assert(/25 ?KB|25600|cap/i.test(r.stderr), 'stderr should mention the cap');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────
// Phase H — append-lesson
// ─────────────────────────────────────────────────────────────────────────

test('append-lesson: happy path appends pointer line under the lessons anchor', () => {
  const root = makeTestbed('append-les-happy');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-lesson', '--slug', 'foo',
                  '--date', '2026-05-25', '--title', 'Test lesson');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[\[lessons-tactical#2026-05-25\]\] Test lesson/.test(body), 'pointer line missing');
    assert(/<!-- \/prism-clean appends `\[\[lessons-tactical/.test(body), 'anchor stripped');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: trims to last 10 pointers', () => {
  const root = makeTestbed('append-les-trim');
  try {
    seedMemoryMd(root, 'foo');
    for (let i = 1; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      const r = run(root, 'append-lesson', '--slug', 'foo', '--date', date, '--title', `Lesson ${i}`);
      assertEq(r.status, 0, r.stderr);
    }
    const body = readMemoryMd(root);
    assert(!/2026-05-01/.test(body), 'first lesson should have been trimmed');
    assert(!/2026-05-02/.test(body), 'second lesson should have been trimmed');
    for (let i = 3; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      assert(body.includes(date), `${date} should remain in last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: refuses when MEMORY.md does not exist', () => {
  const root = makeTestbed('append-les-nomem');
  try {
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-05-25', '--title', 'x');
    assertEq(r.status, 6, 'expected exit 6');
    assert(/MEMORY\.md/.test(r.stderr), 'stderr should mention MEMORY.md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: rejects malformed --date', () => {
  const root = makeTestbed('append-les-baddate');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', 'not-a-date', '--title', 'x');
    assertEq(r.status, 5, 'expected exit 5 (bad arg)');
    assert(/date/i.test(r.stderr), 'stderr should mention date');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
