#!/usr/bin/env node
// Fix A slice 6 — tools/prism-repair-open-tasks.mjs (dry-run pointer repair).
//
// PROBLEM
//   A corrupted .claude/.prism-open-tasks.json (markup bleed, dropped tasks,
//   zombie completed tasks — the Phase-0 forensic "scrapers" pointer is the
//   live specimen) can be rebuilt by replaying the FIXED extractor
//   (hooks/lib/prism-task-snapshot.mjs) over the project's session
//   transcripts, which still carry the true Task events (camelCase
//   toolUseResult siblings).
//
// THIS TEST (committed synthetic fixtures under fixtures/):
//   transcript truth: #1 open (full description), #2 open (markup-bled
//   subject, empty description), #3 open (empty subject), #99 completed.
//   corrupted pointer: #1 with truncated description, zombie #99, missing
//   #2/#3.
//   (a) dry-run: diff shows +#2 +#3 -#99 ~#1, FLAG lines for markup/empty
//       (E3 — flagged, NEVER auto-sanitized), pointer file byte-unchanged.
//   (b) --apply: pointer atomically rewritten; open set == {1,2,3}; #1
//       description restored in full; #2 subject retained VERBATIM (markup
//       included); repaired stamp present.
//   (c) no transcripts for the project => exit 3 (distinct from failure),
//       "cannot reconstruct" on stderr.
//   (d) CROSS-TRANSCRIPT FOLD (release-blocker fix, task #12): older
//       transcript has a full TaskCreate #17 (subject+description); newer
//       transcript has ONLY a status-only TaskUpdate #17. extractTaskSnapshot
//       starts a fresh map per transcript, so the newer transcript's own
//       record for #17 has subject/description default-initialized to ''
//       (unobserved, not cleared). Before the fix, the fold's wholesale
//       fold.set() per transcript let that blank the older transcript's full
//       record and got flagged "empty subject"/"empty description" — data
//       that was sitting right there in the older transcript. Asserts the
//       fold merges field-wise: subject/description survive from the older
//       transcript, status is the newer transcript's (in_progress), and NO
//       flags fire on this now-reconstructable data.

import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, utimesSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'prism-repair-open-tasks.mjs');
const FX_TRANSCRIPT = join(HERE, 'fixtures', 'repair-open-tasks-transcript.jsonl');
const FX_POINTER = join(HERE, 'fixtures', 'repair-open-tasks-corrupt-pointer.json');
const FX_FOLD_OLDER = join(HERE, 'fixtures', 'repair-open-tasks-fold-older.jsonl');
const FX_FOLD_NEWER = join(HERE, 'fixtures', 'repair-open-tasks-fold-newer.jsonl');

// Same munging rule Claude Code uses for ~/.claude/projects/<dir> names
// (verified against live dirs, e.g. Y--Documents-utilities-projects-prism-3).
const munge = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function run(args) {
  const res = spawnSync(process.execPath, [TOOL, ...args], {encoding: 'utf-8'});
  return {status: res.status, stdout: res.stdout || '', stderr: res.stderr || ''};
}

function main() {
  assert.ok(existsSync(FX_TRANSCRIPT), `fixture missing: ${FX_TRANSCRIPT}`);
  assert.ok(existsSync(FX_POINTER), `fixture missing: ${FX_POINTER}`);

  const sandbox = mkdtempSync(join(tmpdir(), 'prism-repair-test-'));
  try {
    // Layout: <sandbox>/proj (the project) + <sandbox>/claude (fake ~/.claude).
    const proj = join(sandbox, 'proj');
    const claudeDir = join(sandbox, 'claude');
    const pointerPath = join(proj, '.claude', '.prism-open-tasks.json');
    mkdirSync(join(proj, '.claude'), {recursive: true});
    const transcriptsDir = join(claudeDir, 'projects', munge(proj));
    mkdirSync(transcriptsDir, {recursive: true});
    cpSync(FX_TRANSCRIPT, join(transcriptsDir, 'sess-true.jsonl'));
    const pointerRaw = readFileSync(FX_POINTER, 'utf-8').replace('__PROJECT__', proj.replace(/\\/g, '\\\\'));
    writeFileSync(pointerPath, pointerRaw);

    // Sidecar gap-fill: task #7 lives ONLY in a per-session sidecar.
    const sessionsDir = join(claudeDir, '.prism-sessions');
    mkdirSync(sessionsDir, {recursive: true});
    writeFileSync(join(sessionsDir, 'sess-side.tasks.json'), JSON.stringify({
      session_id: 'sess-side', project: proj, ts: '2026-07-16T10:00:00.000Z',
      open_tasks: [{id: '7', subject: 'Sidecar-only survivor', description: 'Transcript rotated away; sidecar still has it.', activeForm: '', status: 'pending', blockedBy: null}],
    }, null, 2));

    // ── (a) DRY-RUN ─────────────────────────────────────────────────────────
    const before = readFileSync(pointerPath, 'utf-8');
    const dry = run([proj, '--claude-dir', claudeDir]);
    assert.equal(dry.status, 0, `dry-run exit != 0\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    const out = dry.stdout;
    assert.match(out, /DRY RUN/i, 'dry-run banner missing');
    assert.match(out, /\+\s*#2\b/, 'diff missing added task #2');
    assert.match(out, /\+\s*#3\b/, 'diff missing added task #3');
    assert.match(out, /\+\s*#7\b/, 'diff missing sidecar gap-fill task #7');
    assert.match(out, /-\s*#99\b/, 'diff missing removed zombie #99');
    assert.match(out, /~\s*#1\b/, 'diff missing changed task #1');
    assert.match(out, /FLAG[\s\S]*#2[\s\S]*markup/i, 'markup flag for #2 missing');
    assert.match(out, /FLAG[\s\S]*#3[\s\S]*empty subject/i, 'empty-subject flag for #3 missing');
    assert.equal(readFileSync(pointerPath, 'utf-8'), before, 'dry-run MUTATED the pointer');

    // ── (b) --apply ─────────────────────────────────────────────────────────
    const applied = run([proj, '--claude-dir', claudeDir, '--apply']);
    assert.equal(applied.status, 0, `--apply exit != 0\nstderr:\n${applied.stderr}`);
    const repaired = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    const ids = repaired.open_tasks.map(t => String(t.id)).sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(ids, ['1', '2', '3', '7'], 'repaired open set wrong');
    const t1 = repaired.open_tasks.find(t => t.id === '1');
    assert.match(t1.description, /nested arrays throw TypeError/, '#1 description not restored from transcript');
    const t2 = repaired.open_tasks.find(t => t.id === '2');
    assert.equal(t2.subject, 'Corrupted subject</subject> from tool-call bleed <parameter',
      'E3 violation: #2 subject was sanitized — must be retained verbatim, flagged only');
    assert.ok(repaired.repaired && repaired.repaired.tool, 'repaired stamp missing');
    assert.ok(!existsSync(pointerPath + '.tmp'), 'atomic-write tempfile left behind');

    // ── (c) no transcripts => exit 3 (distinct from failure) ────────────────
    const emptyClaude = join(sandbox, 'claude-empty');
    mkdirSync(emptyClaude, {recursive: true});
    const noTx = run([proj, '--claude-dir', emptyClaude]);
    assert.equal(noTx.status, 3, `expected exit 3 for missing transcripts, got ${noTx.status}`);
    assert.match(noTx.stderr, /cannot reconstruct/i, 'missing-transcript message not on stderr');

    console.log('GREEN — repair tool: dry-run diff + flags, verbatim --apply, sidecar gap-fill, exit-3 no-transcript path.');
  } finally {
    try { rmSync(sandbox, {recursive: true, force: true}); } catch {}
  }
}

// ── (d) cross-transcript fold: field-wise merge, not wholesale replace ──────
function testCrossTranscriptFold() {
  assert.ok(existsSync(FX_FOLD_OLDER), `fixture missing: ${FX_FOLD_OLDER}`);
  assert.ok(existsSync(FX_FOLD_NEWER), `fixture missing: ${FX_FOLD_NEWER}`);

  const sandbox = mkdtempSync(join(tmpdir(), 'prism-repair-fold-test-'));
  try {
    const proj = join(sandbox, 'proj');
    const claudeDir = join(sandbox, 'claude');
    const pointerPath = join(proj, '.claude', '.prism-open-tasks.json');
    mkdirSync(join(proj, '.claude'), {recursive: true});
    const transcriptsDir = join(claudeDir, 'projects', munge(proj));
    mkdirSync(transcriptsDir, {recursive: true});

    const olderPath = join(transcriptsDir, 'sess-fold-older.jsonl');
    const newerPath = join(transcriptsDir, 'sess-fold-newer.jsonl');
    cpSync(FX_FOLD_OLDER, olderPath);
    cpSync(FX_FOLD_NEWER, newerPath);
    // Tool sorts transcripts by mtime (oldest -> newest) — force the order
    // the scenario depends on regardless of copy timing.
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 3600, now - 3600);
    utimesSync(newerPath, now, now);

    const dry = run([proj, '--claude-dir', claudeDir]);
    assert.equal(dry.status, 0, `dry-run exit != 0\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    assert.match(dry.stdout, /\+\s*#17\s*\[in_progress\]\s*Full subject from original TaskCreate/,
      'fold blanked subject: older transcript\'s full TaskCreate #17 subject did not survive the status-only TaskUpdate in the newer transcript');
    assert.doesNotMatch(dry.stdout, /FLAG #17/,
      'FLAG fired on #17 despite the subject/description being reconstructable from the older transcript');

    const applied = run([proj, '--claude-dir', claudeDir, '--apply']);
    assert.equal(applied.status, 0, `--apply exit != 0\nstderr:\n${applied.stderr}`);
    const repaired = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    const t17 = repaired.open_tasks.find(t => t.id === '17');
    assert.ok(t17, '#17 missing from applied pointer');
    assert.equal(t17.subject, 'Full subject from original TaskCreate',
      'APPLIED pointer has blank subject — cross-transcript fold destroyed reconstructable data');
    assert.match(t17.description, /Must survive the cross-transcript fold/,
      'APPLIED pointer has blank description — cross-transcript fold destroyed reconstructable data');
    assert.equal(t17.status, 'in_progress', 'status should come from the newer transcript\'s TaskUpdate');
    assert.equal((repaired.repaired && repaired.repaired.flags) || 0, 0,
      'flags should be 0 once the fold reconstructs subject/description correctly');

    console.log('GREEN — repair tool: cross-transcript fold merges field-wise (subject/description survive a later status-only TaskUpdate).');
  } finally {
    try { rmSync(sandbox, {recursive: true, force: true}); } catch {}
  }
}

main();
testCrossTranscriptFold();
