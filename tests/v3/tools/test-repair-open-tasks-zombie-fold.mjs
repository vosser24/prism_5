#!/usr/bin/env node
// Task #24 — repair tool: shared foldTaskRecords() field-wise fold across
// transcripts, replacing the old FOLD_FALLBACK_FIELDS allowlist
// (subject/description only) in tools/prism-repair-open-tasks.mjs.
//
// SCENARIO (two transcripts, oldest -> newest):
//   older:  TaskCreate #99 "Zombie task" (full desc) -> TaskUpdate #99
//           status=completed (same transcript).
//           TaskCreate #88 "Genuinely open task" (full desc) -> TaskUpdate
//           #88 status=in_progress (same transcript).
//   newer:  TaskUpdate #99 subject-only rename ("Renamed zombie") — NO
//           status field.
//           TaskUpdate #88 subject-only rename ("Open task renamed") — NO
//           status field.
//
// extractTaskSnapshot() starts a FRESH per-transcript map, so the newer
// transcript's own record for #88 has ONLY {id, subject} — status was never
// observed IN THAT TRANSCRIPT. The old FOLD_FALLBACK_FIELDS allowlist only
// carried subject/description across transcripts, never status — so #88's
// folded record ended up with no status key at all and isOpen() dropped a
// genuinely-open task (a false negative / DATA LOSS, the mirror image of the
// #99 zombie-resurrection bug). foldTaskRecords() folds the FULL key union
// generically, so status carries forward from the older transcript's
// TaskUpdate the same way subject/description always did.
//
// ASSERTIONS
//   #99 is DROPPED — completed status carried forward field-wise, isOpen()
//   filters it (same as before the fix — this is not the regression case).
//   #88 SURVIVES, open, status=in_progress (carried from the older
//   transcript) AND subject updated to the newer transcript's rename. This
//   is the assertion that FAILS against the old foldMergeTask (which had no
//   status fallback, so #88's status key was simply absent and isOpen()
//   dropped it) and PASSES with foldTaskRecords().
//
// D048 (6.5.2) — collision-flag PRECISION: #99 and #88 are both ORDINARY
// same-task renames (a subject-only TaskUpdate in the newer transcript, no
// TaskCreate). Independent verification found the prior subject-diff
// trigger ("prevSubj !== nextSubj") fired an id-collision FLAG on both of
// them — false positives on completely normal usage. The fix replaces that
// heuristic with PROVENANCE: extractTaskSnapshot's opt-in `createdIds` Set
// records which ids a transcript's scan actually TaskCreate'd; a collision
// now requires the LATER transcript to have independently TaskCreate'd an id
// an earlier transcript's fold already populated. A rename never adds to
// `createdIds`, so #99/#88 must NOT be flagged — asserted below. The mirror
// case (genuine id-reuse, which MUST flag) is covered by testIdReuseFlag().

import {readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, utimesSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'prism-repair-open-tasks.mjs');
const FX_OLDER = join(HERE, 'fixtures', 'repair-open-tasks-zombie-older.jsonl');
const FX_NEWER = join(HERE, 'fixtures', 'repair-open-tasks-zombie-newer.jsonl');
const FX_REUSE_OLDER = join(HERE, 'fixtures', 'repair-open-tasks-reuse-older.jsonl');
const FX_REUSE_NEWER = join(HERE, 'fixtures', 'repair-open-tasks-reuse-newer.jsonl');

// Same munging rule Claude Code uses for ~/.claude/projects/<dir> names.
const munge = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function run(args) {
  const res = spawnSync(process.execPath, [TOOL, ...args], {encoding: 'utf-8'});
  return {status: res.status, stdout: res.stdout || '', stderr: res.stderr || ''};
}

function testZombieFold() {
  assert.ok(existsSync(FX_OLDER), `fixture missing: ${FX_OLDER}`);
  assert.ok(existsSync(FX_NEWER), `fixture missing: ${FX_NEWER}`);

  const sandbox = mkdtempSync(join(tmpdir(), 'prism-repair-zombie-test-'));
  try {
    const proj = join(sandbox, 'proj');
    const claudeDir = join(sandbox, 'claude');
    const pointerPath = join(proj, '.claude', '.prism-open-tasks.json');
    mkdirSync(join(proj, '.claude'), {recursive: true});
    const transcriptsDir = join(claudeDir, 'projects', munge(proj));
    mkdirSync(transcriptsDir, {recursive: true});

    const olderPath = join(transcriptsDir, 'sess-zombie-older.jsonl');
    const newerPath = join(transcriptsDir, 'sess-zombie-newer.jsonl');
    cpSync(FX_OLDER, olderPath);
    cpSync(FX_NEWER, newerPath);
    // Tool sorts transcripts by mtime (oldest -> newest) — force the order
    // the scenario depends on regardless of copy timing.
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 3600, now - 3600);
    utimesSync(newerPath, now, now);

    // ── dry-run ───────────────────────────────────────────────────────────
    const dry = run([proj, '--claude-dir', claudeDir]);
    assert.equal(dry.status, 0, `dry-run exit != 0\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    assert.doesNotMatch(dry.stdout, /\+\s*#99\b/, '#99 (completed, carried forward) should NOT appear as an added open task');
    assert.match(dry.stdout, /\+\s*#88\s*\[in_progress\]\s*Open task renamed/,
      '#88 must survive as open, in_progress, with its renamed subject — this is the field-wise-fold assertion');
    // D048 flag-content assertions: #99 and #88 are ORDINARY renames
    // (TaskUpdate only, no TaskCreate in the newer transcript) — neither
    // must trigger the id-reuse collision flag.
    assert.doesNotMatch(dry.stdout, /FLAG #99[\s\S]*id-reuse/, 'FLAG fired on #99 (ordinary rename) — collision trigger is over-broad');
    assert.doesNotMatch(dry.stdout, /FLAG #88[\s\S]*id-reuse/, 'FLAG fired on #88 (ordinary rename) — collision trigger is over-broad');

    // ── --apply ───────────────────────────────────────────────────────────
    const applied = run([proj, '--claude-dir', claudeDir, '--apply']);
    assert.equal(applied.status, 0, `--apply exit != 0\nstderr:\n${applied.stderr}`);
    const repaired = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    const ids = repaired.open_tasks.map(t => String(t.id));
    assert.ok(!ids.includes('99'), 'applied pointer open_tasks must NOT contain #99 (zombie, completed)');
    const t88 = repaired.open_tasks.find(t => t.id === '88');
    assert.ok(t88, 'applied pointer open_tasks must contain #88 (genuinely open task)');
    assert.equal(t88.status, 'in_progress', '#88 status must be carried forward from the older transcript (in_progress)');
    assert.equal(t88.subject, 'Open task renamed', '#88 subject must reflect the newer transcript\'s rename');
    assert.equal((repaired.repaired && repaired.repaired.flags) || 0, 0,
      'applied pointer flags must be 0 — both #99/#88 are ordinary renames, no genuine id-reuse present');

    console.log('GREEN — repair tool: zombie fold — completed task dropped, genuinely-open task survives with status carried field-wise across transcripts.');
  } finally {
    try { rmSync(sandbox, {recursive: true, force: true}); } catch {}
  }
}

// ── D048 (6.5.2): genuine id-reuse MUST still flag ──────────────────────────
// Mirror scenario to testZombieFold: here the NEWER transcript genuinely
// TaskCreates id #42 — the same id an EARLIER transcript's TaskCreate also
// used, for an unrelated task ("Original task A" vs "Different task B").
// This is the real collision the flag exists to catch. Asserts the id-reuse
// flag DOES fire (unlike the ordinary-rename cases above), and that the
// field-wise merge is still NOT suppressed (newest observed subject wins).
function testIdReuseFlag() {
  assert.ok(existsSync(FX_REUSE_OLDER), `fixture missing: ${FX_REUSE_OLDER}`);
  assert.ok(existsSync(FX_REUSE_NEWER), `fixture missing: ${FX_REUSE_NEWER}`);

  const sandbox = mkdtempSync(join(tmpdir(), 'prism-repair-reuse-test-'));
  try {
    const proj = join(sandbox, 'proj');
    const claudeDir = join(sandbox, 'claude');
    const pointerPath = join(proj, '.claude', '.prism-open-tasks.json');
    mkdirSync(join(proj, '.claude'), {recursive: true});
    const transcriptsDir = join(claudeDir, 'projects', munge(proj));
    mkdirSync(transcriptsDir, {recursive: true});

    const olderPath = join(transcriptsDir, 'sess-reuse-older.jsonl');
    const newerPath = join(transcriptsDir, 'sess-reuse-newer.jsonl');
    cpSync(FX_REUSE_OLDER, olderPath);
    cpSync(FX_REUSE_NEWER, newerPath);
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 3600, now - 3600);
    utimesSync(newerPath, now, now);

    // ── dry-run ───────────────────────────────────────────────────────────
    const dry = run([proj, '--claude-dir', claudeDir]);
    assert.equal(dry.status, 0, `dry-run exit != 0\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    assert.match(dry.stdout, /FLAG #42[\s\S]*id-reuse/,
      'id-reuse flag must fire for #42 — independently TaskCreate\'d in two transcripts under the same id');
    assert.match(dry.stdout, /\+\s*#42\s*\[pending\]\s*Different task B/,
      '#42 must survive the merge (NOT suppressed) with the newest observed subject');

    // ── --apply ───────────────────────────────────────────────────────────
    const applied = run([proj, '--claude-dir', claudeDir, '--apply']);
    assert.equal(applied.status, 0, `--apply exit != 0\nstderr:\n${applied.stderr}`);
    const repaired = JSON.parse(readFileSync(pointerPath, 'utf-8'));
    const t42 = repaired.open_tasks.find(t => t.id === '42');
    assert.ok(t42, 'applied pointer open_tasks must contain #42');
    assert.equal(t42.subject, 'Different task B', '#42 subject must be the newest-observed value — merge not suppressed by the flag');
    assert.ok(repaired.repaired && repaired.repaired.flags >= 1, 'applied pointer flags count must reflect the id-reuse flag');

    console.log('GREEN — repair tool: genuine id-reuse (independent TaskCreate under the same id in two transcripts) flags without suppressing the merge.');
  } finally {
    try { rmSync(sandbox, {recursive: true, force: true}); } catch {}
  }
}

testZombieFold();
testIdReuseFlag();
