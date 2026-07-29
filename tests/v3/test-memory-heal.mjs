#!/usr/bin/env node
// Tests for the recall-hardening CORE workstream (C1/C2/C3/C4):
//   tools/lib/memory-anchors.mjs   — upsertUnderAnchor (C1)
//   tools/lib/memory-heal.mjs      — healMemoryPointers / regenerateStandingRules (C2)
//   hooks/lib/prism-freshness-sweep.mjs — checkMemoryRecallStale, check M1 (C4)
//
// Drives the lib functions in-process against ephemeral testbeds (no
// subprocess spawn needed — these are plain ESM modules, not CLIs).
//
// Run: node tests/v3/test-memory-heal.mjs

import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const {healMemoryPointers, regenerateStandingRules, STANDING_RULES_ANCHORS} =
  await import(pathToFileURL(join(REPO_ROOT, 'tools', 'lib', 'memory-heal.mjs')).href);
const {checkMemoryRecallStale} =
  await import(pathToFileURL(join(REPO_ROOT, 'hooks', 'lib', 'prism-freshness-sweep.mjs')).href);

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ─────────────────────────────── testbed helpers ──────────────────────────

function makeTestbed(label) {
  return mkdtempSync(join(tmpdir(), `memory-heal-test-${label}-`));
}

// Mirrors the CURRENT tools/prism-deep-dive.mjs renderMemoryMd shape (post
// C3), including the Recent-decisions/-lessons Phase-H anchors AND the new
// Standing-rules start/end anchors.
function seedMemoryMd(root) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = [
    '# MEMORY.md — master-test router',
    '',
    '## Project profile',
    '',
    '- **Stack**: test',
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
    '## Standing rules',
    '',
    'Imperatives drawn from the most important Locked adjudications:',
    '',
    STANDING_RULES_ANCHORS.start,
    STANDING_RULES_ANCHORS.end,
    '',
    '## Active specialists',
    '',
    '- (none hired yet)',
    '',
  ].join('\n');
  const path = join(dir, 'MEMORY.md');
  writeFileSync(path, body, 'utf8');
  return path;
}

function readMemoryMd(root) {
  return readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
}

function writeAdjudication(root, fileName, {title, status = 'Locked', date, rule}) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  mkdirSync(dir, {recursive: true});
  const lines = [
    `# ${title}`,
    '',
    `**Status:** ${status}`,
  ];
  if (date) lines.push(`**Date:** ${date}`);
  lines.push('**Captured by:** test');
  if (rule) lines.push(`**Rule:** ${rule}`);
  lines.push('', '## Context', '', 'Test fixture body.', '');
  writeFileSync(join(dir, fileName), lines.join('\n'), 'utf8');
}

function writeLesson(root, fileName, title) {
  const dir = join(root, 'docs', 'prism', 'lessons');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, fileName), [`# ${title}`, '', 'Test lesson body.', ''].join('\n'), 'utf8');
}

// ═══════════════════════════════ C2a: healMemoryPointers ══════════════════

test('healMemoryPointers: upserts a missing D### pointer (D038-style)', () => {
  const root = makeTestbed('heal-missing-decision');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D038-tier-escalation.md', {
      title: 'Tier escalation decoupled from panel',
      date: '2026-07-06',
      rule: 'Escalate tier independent of panel state.',
    });
    const r = healMemoryPointers(root, {
      delta: {added: ['docs/prism/adjudications/D038-tier-escalation.md'], changed: [], removed: []},
    });
    assertEq(r.addedDecisions, ['D038']);
    const body = readMemoryMd(root);
    assert(/- \[\[D038\]\] Tier escalation decoupled from panel/.test(body), 'D038 pointer missing:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('healMemoryPointers: upserts a missing lesson pointer', () => {
  const root = makeTestbed('heal-missing-lesson');
  try {
    seedMemoryMd(root);
    writeLesson(root, '2026-07-13-recall-hardening-session.md', 'Recall hardening session notes');
    const r = healMemoryPointers(root, {
      delta: {added: ['docs/prism/lessons/2026-07-13-recall-hardening-session.md'], changed: [], removed: []},
    });
    assertEq(r.addedLessons, ['2026-07-13-recall-hardening-session']);
    const body = readMemoryMd(root);
    assert(/- \[\[lessons#2026-07-13-recall-hardening-session\]\] Recall hardening session notes/.test(body),
      'lesson pointer missing:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('healMemoryPointers: idempotent — calling twice does not duplicate the pointer', () => {
  const root = makeTestbed('heal-idempotent');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D038-tier-escalation.md', {
      title: 'Tier escalation decoupled from panel',
      date: '2026-07-06',
      rule: 'Escalate tier independent of panel state.',
    });
    const delta = {added: ['docs/prism/adjudications/D038-tier-escalation.md'], changed: [], removed: []};
    healMemoryPointers(root, {delta});
    healMemoryPointers(root, {delta});
    const body = readMemoryMd(root);
    assertEq(countOccurrences(body, '[[D038]]'), 1, 'D038 pointer should appear exactly once:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('healMemoryPointers: fail-open when MEMORY.md is missing (never throws)', () => {
  const root = makeTestbed('heal-no-memory-md');
  try {
    writeAdjudication(root, 'D001-x.md', {title: 'X', date: '2026-01-01', rule: 'x'});
    let r;
    let threw = false;
    try {
      r = healMemoryPointers(root, {delta: {added: ['docs/prism/adjudications/D001-x.md'], changed: [], removed: []}});
    } catch { threw = true; }
    assert(!threw, 'healMemoryPointers must never throw');
    // `written: null` = "no write was attempted" (F45 item 2 tri-state — see
    // the export doc in tools/lib/memory-heal.mjs). Deliberately NOT `false`,
    // which now means "a write was attempted and DROPPED".
    assertEq(r, {addedDecisions: [], addedLessons: [], written: null});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('healMemoryPointers: no-op when delta has no touched files', () => {
  const root = makeTestbed('heal-empty-delta');
  try {
    seedMemoryMd(root);
    const before = readMemoryMd(root);
    const r = healMemoryPointers(root, {delta: {added: [], changed: [], removed: []}});
    // See the note above: `written: null` = no write attempted (F45 item 2).
    assertEq(r, {addedDecisions: [], addedLessons: [], written: null});
    assertEq(readMemoryMd(root), before);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ═══════════════════════════ C2b: regenerateStandingRules ═════════════════

function standingRulesBlock(body) {
  const startIdx = body.indexOf(STANDING_RULES_ANCHORS.start);
  const endIdx = body.indexOf(STANDING_RULES_ANCHORS.end);
  assert(startIdx >= 0 && endIdx > startIdx, 'standing-rules anchors not found');
  return body.slice(startIdx + STANDING_RULES_ANCHORS.start.length, endIdx).trim();
}

test('regenerateStandingRules: orders newest-Date-first', () => {
  const root = makeTestbed('standing-rules-order');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-old.md', {title: 'Old', date: '2026-01-01', rule: 'Rule OLD.'});
    writeAdjudication(root, 'D002-mid.md', {title: 'Mid', date: '2026-06-01', rule: 'Rule MID.'});
    writeAdjudication(root, 'D003-new.md', {title: 'New', date: '2026-07-01', rule: 'Rule NEW.'});
    const r = regenerateStandingRules(root, {cap: 12});
    assertEq(r.changed, true);
    assertEq(r.count, 3);
    const block = standingRulesBlock(readMemoryMd(root));
    const idxNew = block.indexOf('D003');
    const idxMid = block.indexOf('D002');
    const idxOld = block.indexOf('D001');
    assert(idxNew >= 0 && idxMid > idxNew && idxOld > idxMid, 'expected D003 < D002 < D001 order:\n' + block);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: tiebreaks same-Date by D-number desc', () => {
  const root = makeTestbed('standing-rules-tiebreak');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D005-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    writeAdjudication(root, 'D010-b.md', {title: 'B', date: '2026-07-01', rule: 'Rule B.'});
    regenerateStandingRules(root, {cap: 12});
    const block = standingRulesBlock(readMemoryMd(root));
    const idx10 = block.indexOf('D010');
    const idx05 = block.indexOf('D005');
    assert(idx10 >= 0 && idx05 > idx10, 'expected D010 before D005 on same-Date tiebreak:\n' + block);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: skips non-Locked and rule-less adjudications', () => {
  const root = makeTestbed('standing-rules-filter');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-locked-with-rule.md', {title: 'Keep', date: '2026-07-01', rule: 'Keep me.'});
    writeAdjudication(root, 'D002-draft.md', {title: 'Draft', status: 'Draft', date: '2026-07-02', rule: 'Drop me (draft).'});
    writeAdjudication(root, 'D003-no-rule.md', {title: 'NoRule', date: '2026-07-03'});
    const r = regenerateStandingRules(root, {cap: 12});
    assertEq(r.count, 1);
    const block = standingRulesBlock(readMemoryMd(root));
    assert(block.includes('D001'), 'D001 should be included');
    assert(!block.includes('D002'), 'D002 (Draft) should be excluded');
    assert(!block.includes('D003'), 'D003 (no Rule line) should be excluded');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: caps at the requested count', () => {
  const root = makeTestbed('standing-rules-cap');
  try {
    seedMemoryMd(root);
    for (let i = 1; i <= 5; i++) {
      writeAdjudication(root, `D00${i}-x.md`, {
        title: `Item ${i}`,
        date: `2026-0${i}-01`,
        rule: `Rule ${i}.`,
      });
    }
    const r = regenerateStandingRules(root, {cap: 2});
    assertEq(r.count, 2);
    const block = standingRulesBlock(readMemoryMd(root));
    // Newest two (D005, D004) kept; oldest three dropped.
    assert(block.includes('D005') && block.includes('D004'), 'expected the two newest kept:\n' + block);
    assert(!block.includes('D003') && !block.includes('D002') && !block.includes('D001'),
      'expected the three oldest dropped:\n' + block);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: never exceeds the 25 KB MEMORY.md cap — drops lowest-priority rules', () => {
  const root = makeTestbed('standing-rules-25kb-guard');
  try {
    seedMemoryMd(root);
    // Each rule ~2KB; with cap=20 candidates this would push MEMORY.md well
    // past 25KB, forcing the tail (oldest) to be dropped to fit.
    const bigRule = 'X'.repeat(2000) + '.';
    for (let i = 1; i <= 20; i++) {
      const mm = String(i).padStart(2, '0');
      writeAdjudication(root, `D0${mm}-x.md`, {
        title: `Item ${i}`,
        date: `2026-${mm}-01`,
        rule: `Rule ${i}: ${bigRule}`,
      });
    }
    const r = regenerateStandingRules(root, {cap: 20});
    assert(r.count < 20, `expected the 25KB guard to drop some candidates, got count=${r.count}`);
    const finalBytes = Buffer.byteLength(readMemoryMd(root), 'utf8');
    assert(finalBytes <= 25 * 1024, `MEMORY.md is ${finalBytes} bytes — exceeds the 25KB cap`);
    // Highest-priority (most recent) survivors must still be present.
    const block = standingRulesBlock(readMemoryMd(root));
    assert(block.includes('D020'), 'expected the newest rule (D020) to survive the drop:\n(count=' + r.count + ')');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: no-op (changed:false) when nothing changed', () => {
  const root = makeTestbed('standing-rules-noop');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    const r1 = regenerateStandingRules(root, {cap: 12});
    assertEq(r1.changed, true);
    const bodyAfterFirst = readMemoryMd(root);
    const r2 = regenerateStandingRules(root, {cap: 12});
    assertEq(r2.changed, false, 'second regen with no corpus change should be a no-op');
    assertEq(r2.count, r1.count);
    assertEq(readMemoryMd(root), bodyAfterFirst, 'body must be byte-identical after a no-op regen');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: re-runs and reflects a genuinely new Locked adjudication', () => {
  const root = makeTestbed('standing-rules-change-detect');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    regenerateStandingRules(root, {cap: 12});
    writeAdjudication(root, 'D002-b.md', {title: 'B', date: '2026-07-05', rule: 'Rule B.'});
    const r2 = regenerateStandingRules(root, {cap: 12});
    assertEq(r2.changed, true);
    const block = standingRulesBlock(readMemoryMd(root));
    assert(block.includes('D002') && block.includes('D001'), 'both rules expected:\n' + block);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: fail-open when anchors are missing from MEMORY.md', () => {
  const root = makeTestbed('standing-rules-no-anchors');
  try {
    const dir = join(root, '.claude', 'agents');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n\n## Standing rules\n\n(hand-written, no anchors)\n', 'utf8');
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    let threw = false;
    let r;
    try { r = regenerateStandingRules(root, {cap: 12}); } catch { threw = true; }
    assert(!threw, 'regenerateStandingRules must never throw');
    assertEq(r, {count: 0, changed: false});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('regenerateStandingRules: fail-open when MEMORY.md does not exist', () => {
  const root = makeTestbed('standing-rules-no-memory-md');
  try {
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    let threw = false;
    let r;
    try { r = regenerateStandingRules(root, {cap: 12}); } catch { threw = true; }
    assert(!threw, 'regenerateStandingRules must never throw');
    assertEq(r, {count: 0, changed: false});
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ═══════════════════════════ C4: freshness-sweep M1 ════════════════════════

test('M1 checkMemoryRecallStale: reports N item(s) behind when D-refs are unrecalled', () => {
  const root = makeTestbed('m1-behind');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    writeAdjudication(root, 'D002-b.md', {title: 'B', date: '2026-07-02', rule: 'Rule B.'});
    // Neither D001 nor D002 appears anywhere in the seeded MEMORY.md.
    const notice = checkMemoryRecallStale(root);
    assert(notice, 'expected a staleness notice');
    assert(/MEMORY\.md recall 2 item\(s\) behind corpus/.test(notice), 'notice text: ' + notice);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('M1 checkMemoryRecallStale: silent once heal + regen bring MEMORY.md current', () => {
  const root = makeTestbed('m1-current');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    writeAdjudication(root, 'D002-b.md', {title: 'B', date: '2026-07-02', rule: 'Rule B.'});
    healMemoryPointers(root, {
      delta: {added: ['docs/prism/adjudications/D001-a.md', 'docs/prism/adjudications/D002-b.md'], changed: [], removed: []},
    });
    regenerateStandingRules(root, {cap: 12});
    const notice = checkMemoryRecallStale(root);
    assertEq(notice, null, 'expected silence once both D-refs are recalled: ' + notice);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('M1 checkMemoryRecallStale: silent when a D-ref is covered only via Standing rules (not Recent-decisions)', () => {
  const root = makeTestbed('m1-standing-only');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    // Only regenerate Standing rules (no Recent-decisions pointer) — the
    // **D001:** form alone should count as "recalled".
    regenerateStandingRules(root, {cap: 12});
    const notice = checkMemoryRecallStale(root);
    assertEq(notice, null, 'Standing-rules coverage alone should satisfy recall: ' + notice);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('M1 checkMemoryRecallStale: silent (fail-open) when cwd has no docs/prism/adjudications', () => {
  const root = makeTestbed('m1-no-corpus');
  try {
    seedMemoryMd(root);
    const notice = checkMemoryRecallStale(root);
    assertEq(notice, null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('M1 checkMemoryRecallStale: silent when MEMORY.md does not exist', () => {
  const root = makeTestbed('m1-no-memory-md');
  try {
    writeAdjudication(root, 'D001-a.md', {title: 'A', date: '2026-07-01', rule: 'Rule A.'});
    const notice = checkMemoryRecallStale(root);
    assertEq(notice, null);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('M1 checkMemoryRecallStale: silent when cwd is falsy', () => {
  assertEq(checkMemoryRecallStale(undefined), null);
  assertEq(checkMemoryRecallStale(''), null);
});

// ─────────────────────────────── runner ──────────────────────────────────

for (const [name, fn] of tests) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
