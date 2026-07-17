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

test('git-stats: empty repo since future date → all zeros (genuine zero, not unmeasured)', () => {
  const root = makeTestbed('zero');
  try {
    const r = run(root, 'git-stats', '--since', '9999-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, 0);
    assertEq(out.files_changed, 0);
    assertEq(out.insertions, 0);
    assertEq(out.deletions, 0);
    assertEq(out.boundary_sha, null);
    assertEq(out.warning, null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('git-stats: one commit since past date → real deterministic numbers, not the old 0-or-1 ambiguity', () => {
  const root = makeTestbed('one');
  try {
    commitFile(root, 'a.txt', 'line1\nline2\n', 'first commit');
    const r = run(root, 'git-stats', '--since', '2020-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, 1);
    // D046 #7 (Fix B) deterministic repair: --since predates the repo's first
    // commit, so the boundary is git's empty-tree object and the diff is REAL
    // (previously this silently defaulted to 0/0/0 regardless of content).
    assertEq(out.files_changed, 1);
    assertEq(out.insertions, 2);
    assertEq(out.deletions, 0);
    assertEq(out.boundary_sha, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assertEq(out.warning, null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ── D046 finding #7 (Fix B) — tri-state contract ────────────────────────────
// The bug this guards: a young/recently-initialized repo with N real commits
// (measured in the field as 58) reported files_changed/insertions/deletions
// as 0/0/0 — indistinguishable from a session with genuinely zero changes —
// which let /prism-clean's LLM classifier read real work as L1 NOISE and
// drop it from capture. The fix: every numeric field is either a real
// measured number (0 included) or `null` when it could not be measured;
// `0` never means "the git command failed and we silently defaulted".

test('git-stats: many commits since before repo existed → real non-zero diff (the field-measured 58-commit bug, reproduced + fixed)', () => {
  const root = makeTestbed('many-commits-young-repo');
  try {
    commitFile(root, 'a.txt', 'line1\n', 'commit 1');
    commitFile(root, 'b.txt', 'line2\n', 'commit 2');
    commitFile(root, 'c.txt', 'line3\nline4\n', 'commit 3');
    const r = run(root, 'git-stats', '--since', '2020-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, 3);
    // Before the fix this was {files_changed: 0, insertions: 0, deletions: 0}
    // for ANY number of commits whenever --since predates the first commit.
    assert(out.files_changed > 0, 'files_changed must be REAL, not the old silent zero: ' + JSON.stringify(out));
    assert(out.insertions > 0, 'insertions must be REAL, not the old silent zero: ' + JSON.stringify(out));
    assertEq(out.files_changed, 3);
    assertEq(out.insertions, 4);
    assertEq(out.warning, null, 'a fully-measured result must not carry a warning');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('git-stats: corrupt .git → UNKNOWN (null), never a silent zero, and warning names the failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-clean-test-corrupt-'));
  try {
    // Passes the CLI's own `existsSync(.git)` guard but is not a valid gitdir
    // pointer — every subsequent git command genuinely fails.
    writeFileSync(join(root, '.git'), 'not a real gitdir\n');
    const r = run(root, 'git-stats', '--since', '2020-01-01T00:00:00Z');
    assertEq(r.status, 0, r.stderr);  // the CLI itself doesn't crash — it reports UNKNOWN
    const out = JSON.parse(r.stdout);
    assertEq(out.commits, null);
    assertEq(out.files_changed, null);
    assertEq(out.insertions, null);
    assertEq(out.deletions, null);
    assertEq(out.boundary_sha, null);
    assert(typeof out.warning === 'string' && out.warning.length > 0, 'warning must be a non-empty string: ' + JSON.stringify(out));
    assert(/UNKNOWN, not zero/.test(out.warning), 'warning must explicitly say UNKNOWN not zero: ' + out.warning);
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

// v5.1.8 UAT-fix: the slash command / model naturally passes the raw number from
// "D001" (i.e. "1"), but the validator required ≥3 digits and rejected it with a
// misleading "(digits only)" message. Accept any digit string and zero-pad.
test('append-decision: accepts un-padded --d-number 1 and zero-pads to D001', () => {
  const root = makeTestbed('append-dec-unpadded');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '1', '--title', 'Unpadded decision');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[\[D001\]\] Unpadded decision/.test(body), 'un-padded d-number not zero-padded to D001');
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

// ─────────────────────────────────────────────────────────────────────────
// v5.1 — append-summary (Mode-B session-summary fold into MEMORY.md)
// ─────────────────────────────────────────────────────────────────────────

test('append-summary: happy path appends a dated line under the Session log anchor', () => {
  const root = makeTestbed('append-sum-happy');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-summary', '--slug', 'foo',
                  '--date', '2026-06-02', '--summary', 'Shipped v5.1 append-summary');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[2026-06-02\] Shipped v5\.1 append-summary/.test(body), 'summary line missing');
    assert(/<!-- \/prism-clean appends session-summary lines here\. -->/.test(body), 'anchor stripped');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-summary: trims to last 10 summaries (oldest dropped)', () => {
  const root = makeTestbed('append-sum-trim');
  try {
    seedMemoryMd(root, 'foo');
    for (let i = 1; i <= 12; i++) {
      const date = `2026-06-${String(i).padStart(2, '0')}`;
      const r = run(root, 'append-summary', '--slug', 'foo', '--date', date, '--summary', `Session ${i}`);
      assertEq(r.status, 0, r.stderr);
    }
    const body = readMemoryMd(root);
    assert(!/2026-06-01/.test(body), 'first summary should have been trimmed');
    assert(!/2026-06-02/.test(body), 'second summary should have been trimmed');
    for (let i = 3; i <= 12; i++) {
      const date = `2026-06-${String(i).padStart(2, '0')}`;
      assert(body.includes(date), `${date} should remain in last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-summary: refuses when MEMORY.md does not exist', () => {
  const root = makeTestbed('append-sum-nomem');
  try {
    const r = run(root, 'append-summary', '--slug', 'foo', '--date', '2026-06-02', '--summary', 'x');
    assertEq(r.status, 6, 'expected exit 6 (missing MEMORY.md)');
    assert(/MEMORY\.md/.test(r.stderr), 'stderr should mention MEMORY.md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-summary: rejects malformed --date', () => {
  const root = makeTestbed('append-sum-baddate');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-summary', '--slug', 'foo', '--date', 'not-a-date', '--summary', 'x');
    assertEq(r.status, 5, 'expected exit 5 (bad arg)');
    assert(/date/i.test(r.stderr), 'stderr should mention date');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
