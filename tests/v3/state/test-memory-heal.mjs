#!/usr/bin/env node
// Task #45 item 1b (panel-decided 4-0, D083-governed) — regression test for the
// caps-raise fix in tools/lib/memory-heal.mjs.
//
// Bug being closed: D063 is a Locked adjudication with a valid **Rule:** line,
// yet it was silently ABSENT from MEMORY.md's Standing Rules block.
// regenerateStandingRules() ordered candidates newest-Date-first with a
// D-number-descending tiebreak, capped the list at 12, and D063/D065 are BOTH
// dated 2026-07-22 — D065 won the tiebreak purely on having a higher D-number,
// pushing D063 past the cap. There was no genuine capacity pressure (the real
// MEMORY.md was only ~15KB against a 25KB hard cap) — a Locked rule was
// dropped by a sort, not a budget.
//
// Fix: raise STANDING_RULES_CAP default (regenerateStandingRules's `cap`
// param) 12 -> 30, and POINTER_KEEP 10 -> 20. The tiebreak ordering itself is
// UNTOUCHED by design (see D083 discussion) — this test constructs a same-
// date pair where the tiebreak still fires (mirrors the real D063/D065
// case) and asserts the LOSER of that tiebreak now survives once there is
// enough headroom under the raised cap, without asserting anything about
// the ordering itself.
//
// Run: node tests/v3/state/test-memory-heal.mjs

import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

// Imported from the REPO paths (not copied into a fixture) precisely so the
// transitive `./atomic-fs.mjs` / `./memory-anchors.mjs` /
// `../../hooks/lib/prism-advisory-log.mjs` imports resolve — copying the
// module under test into a mkdtemp fixture without its full import closure
// produces an opaque ERR_MODULE_NOT_FOUND that reads like a logic bug. Only
// the DATA (MEMORY.md + docs/prism/adjudications) is fixtured.
const {healMemoryPointers, regenerateStandingRules, STANDING_RULES_ANCHORS} =
  await import(pathToFileURL(join(REPO_ROOT, 'tools', 'lib', 'memory-heal.mjs')).href);
const {upsertUnderAnchor} =
  await import(pathToFileURL(join(REPO_ROOT, 'tools', 'lib', 'memory-anchors.mjs')).href);

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

// ─────────────────────────────── testbed helpers ──────────────────────────
// Self-contained duplicates of the fixture helpers in tests/v3/test-memory-heal.mjs
// (that file is a standalone runner, not an importable module, so these are
// copied rather than shared).

function makeTestbed(label) {
  return mkdtempSync(join(tmpdir(), `memory-heal-caps-test-${label}-`));
}

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
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8');
}

function readMemoryMd(root) {
  return readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
}

function writeAdjudication(root, fileName, {title, status = 'Locked', date, rule, retired, tier, body}) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  mkdirSync(dir, {recursive: true});
  const lines = [
    `# ${title}`,
    '',
    `**Status:** ${status}`,
  ];
  // [[D097]]: a genuine header-block Tier field, same position/style as the
  // five real adjudications this task tagged (Tier immediately after Status).
  if (tier) lines.push(`**Tier:** ${tier}`);
  if (date) lines.push(`**Date:** ${date}`);
  lines.push('**Captured by:** test');
  if (rule) lines.push(`**Rule:** ${rule}`);
  // [[D093]]: retirement is an APPENDED header field; `**Status:**` above is
  // deliberately still `Locked` in these fixtures — that is the whole point of
  // the mechanism, so a fixture that flipped the status would test nothing.
  if (retired) lines.push(`**Retired:** ${retired}`);
  lines.push('', '## Context', '', body || 'Test fixture body.', '');
  writeFileSync(join(dir, fileName), lines.join('\n'), 'utf8');
}

function standingRulesBlock(body) {
  const startIdx = body.indexOf(STANDING_RULES_ANCHORS.start);
  const endIdx = body.indexOf(STANDING_RULES_ANCHORS.end);
  assert(startIdx >= 0 && endIdx > startIdx, 'standing-rules anchors not found');
  return body.slice(startIdx + STANDING_RULES_ANCHORS.start.length, endIdx).trim();
}

// ═══════════════════ D063-style tiebreak-loser retention ══════════════════

test('regenerateStandingRules (default cap): a Locked rule that LOSES a same-date ' +
     'D-number tiebreak is still retained once there is headroom under the raised cap ' +
     '(D063/D065 real-world case: both dated 2026-07-22, D065 wins the tiebreak on ' +
     'D-number, D063 was silently dropped under the old cap=12 default)', () => {
  const root = makeTestbed('d063-tiebreak-loser-retained');
  try {
    seedMemoryMd(root);

    // 11 rules strictly newer than the tiebreak pair below, so the tiebreak
    // pair ranks at positions 12 and 13 — exactly at the old cap=12 boundary.
    for (let i = 1; i <= 11; i++) {
      const day = String(i).padStart(2, '0');
      writeAdjudication(root, `D1${day}-newer-${i}.md`, {
        title: `Newer item ${i}`,
        date: `2026-08-${day}`,
        rule: `Newer rule ${i}.`,
      });
    }

    // The D063/D065 tiebreak pair — same Date, D065 (higher D-number) wins
    // the tiebreak and ranks ahead of D063 (lower D-number).
    writeAdjudication(root, 'D063-tiebreak-loser.md', {
      title: 'Tiebreak loser (D063 stand-in)',
      date: '2026-07-22',
      rule: 'Tiebreak-loser rule text.',
    });
    writeAdjudication(root, 'D065-tiebreak-winner.md', {
      title: 'Tiebreak winner (D065 stand-in)',
      date: '2026-07-22',
      rule: 'Tiebreak-winner rule text.',
    });

    // Call with NO explicit {cap} override — this exercises the function's
    // DEFAULT, exactly as hooks/prism-session-start.mjs calls it in
    // production (`healLib.regenerateStandingRules(projectDir)`, no options
    // object at all). Non-vacuous: fails under the old default (cap=12,
    // D063-stand-in ranks 13th and is cut) and passes under the new default
    // (cap=30, both fit with room to spare).
    regenerateStandingRules(root);
    const block = standingRulesBlock(readMemoryMd(root));

    assert(block.includes('D065'), 'tiebreak WINNER must be present:\n' + block);
    assert(block.includes('D063'), 'tiebreak LOSER must be retained under the raised cap ' +
      '(this is the D063/D065 bug this test guards against):\n' + block);

    // Tiebreak ordering itself is untouched — D065 (higher D-number) still
    // ranks ahead of D063 (lower D-number) on the same Date. This test does
    // NOT assert anything new about ordering; it only guards retention.
    const idx65 = block.indexOf('D065');
    const idx63 = block.indexOf('D063');
    assert(idx65 >= 0 && idx63 > idx65, 'expected D065 to still rank ahead of D063 (tiebreak unchanged):\n' + block);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ══════════════ F44 — eviction from the Standing-rules block is REPORTED ══
//
// Bug being closed ([[D046]] omissive class): regenerateStandingRules cut the
// candidate list on TWO independent paths — `all.slice(0, cap)` and the
// byte-fit `while` loop — and NEITHER logged, counted, or returned the dropped
// set. It returned `{count}`, the number KEPT, never the number LOST, so a
// pool of 35 and a pool of 53 were indistinguishable from outside. The
// function maintaining D046's own delivery was an instance of D046's class.
//
// Telemetry is isolated by pointing HOME at a scratch dir — prismHome() reads
// HOME at USE time, so the records land in the fixture, never in the real
// ~/.claude/.prism-routing.jsonl.

function withScratchHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'memory-heal-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(() => {
      const logPath = join(home, '.claude', '.prism-routing.jsonl');
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, {recursive: true, force: true});
  }
}

test('F44: count-cap eviction is returned AND logged — the dropped D-refs are named, ' +
     'and pool_size distinguishes a pool of `cap` from a pool larger than `cap`', () => {
  const root = makeTestbed('f44-count-cap-eviction');
  try {
    seedMemoryMd(root);
    // 8 rules, cap 5 -> exactly 3 evicted by the COUNT cap. Dates ascending
    // with the D-number so the eviction set is deterministic: D101..D103 are
    // the three oldest and must be the ones named.
    for (let i = 1; i <= 8; i++) {
      const day = String(i).padStart(2, '0');
      writeAdjudication(root, `D1${day}-rule-${i}.md`, {
        title: `Rule ${i}`, date: `2026-08-${day}`, rule: `Rule text ${i}.`,
      });
    }

    const {res, records} = withScratchHome((readLog) => {
      const res = regenerateStandingRules(root, {cap: 5});
      return {res, records: readLog()};
    });

    assert(res.poolSize === 8, `poolSize must report the FULL Locked-with-Rule pool, got ${res.poolSize}`);
    assert(res.count === 5, `count (kept) should be the cap, got ${res.count}`);
    assert(Array.isArray(res.evictedByCap) && res.evictedByCap.length === 3,
      'evictedByCap must name the 3 count-cap evictions, got ' + JSON.stringify(res.evictedByCap));
    for (const d of ['D101', 'D102', 'D103']) {
      assert(res.evictedByCap.includes(d), `${d} (oldest) must be reported evicted: ${JSON.stringify(res.evictedByCap)}`);
    }
    assert(res.evictedByBytes.length === 0,
      'no byte-fit trim should occur on a tiny fixture — the two causes must not be conflated: ' +
      JSON.stringify(res.evictedByBytes));

    // Region-scoped per [[D084]]: assert against the memory_heal standing_rules
    // records only, not a whole-file grep of the log.
    const sr = records.filter((r) => r.event === 'memory_heal' && r.op === 'standing_rules');
    assert(sr.length === 1, `expected exactly 1 standing_rules record, got ${sr.length}`);
    assert(sr[0].pool_size === 8 && sr[0].kept === 5 && sr[0].cap === 5,
      'log must carry pool_size/kept/cap: ' + JSON.stringify(sr[0]));
    assert(sr[0].evicted_count_cap.length === 3 && sr[0].evicted_byte_fit.length === 0,
      'log must keep the two eviction causes in SEPARATE fields: ' + JSON.stringify(sr[0]));
    assert(sr[0].status === 'written', 'expected status:written, got ' + sr[0].status);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('F44: byte-fit trim is reported SEPARATELY from count-cap eviction — raising ' +
     'the cap cannot fix a byte-fit drop, so the two causes must stay distinguishable', () => {
  const root = makeTestbed('f44-byte-fit-eviction');
  try {
    seedMemoryMd(root);
    // Each rule is ~4 KB of text, so a cap of 10 cannot possibly fit under the
    // 25 KB MEMORY.md hard cap — the byte-fit loop must do the cutting.
    const fat = 'x'.repeat(4000);
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, '0');
      writeAdjudication(root, `D2${day}-fat-${i}.md`, {
        title: `Fat ${i}`, date: `2026-08-${day}`, rule: `${fat} ${i}.`,
      });
    }

    const {res, records} = withScratchHome((readLog) => {
      const res = regenerateStandingRules(root, {cap: 10});
      return {res, records: readLog()};
    });

    assert(res.poolSize === 10, `poolSize ${res.poolSize} != 10`);
    assert(res.evictedByCap.length === 0,
      'cap=10 with a pool of 10 means ZERO count-cap evictions — a byte-fit drop must not ' +
      'be misattributed to the cap: ' + JSON.stringify(res.evictedByCap));
    assert(res.evictedByBytes.length > 0,
      'the byte-fit loop must report what it trimmed, got ' + JSON.stringify(res.evictedByBytes));
    assert(res.count + res.evictedByBytes.length === 10,
      `kept(${res.count}) + byteTrimmed(${res.evictedByBytes.length}) must account for the whole pool`);

    const sr = records.filter((r) => r.event === 'memory_heal' && r.op === 'standing_rules');
    assert(sr.length === 1 && sr[0].evicted_byte_fit.length === res.evictedByBytes.length,
      'log must carry the byte-fit set: ' + JSON.stringify(sr[0]));
    assert(sr[0].bytes <= sr[0].cap_bytes,
      `post-trim body (${sr[0] && sr[0].bytes}) must fit under cap_bytes (${sr[0] && sr[0].cap_bytes})`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('F44: the zero-eviction case still emits a record — "nothing was evicted" must be ' +
     'distinguishable from "regeneration never ran" ([[D046]] make-misses-loud)', () => {
  const root = makeTestbed('f44-zero-eviction');
  try {
    seedMemoryMd(root);
    for (let i = 1; i <= 3; i++) {
      writeAdjudication(root, `D30${i}-small-${i}.md`, {
        title: `Small ${i}`, date: `2026-08-0${i}`, rule: `Small rule ${i}.`,
      });
    }

    const {res, records} = withScratchHome((readLog) => {
      const res = regenerateStandingRules(root, {cap: 35});
      return {res, records: readLog()};
    });

    assert(res.poolSize === 3 && res.count === 3, 'all 3 should be kept');
    assert(res.evictedByCap.length === 0 && res.evictedByBytes.length === 0, 'nothing evicted');
    const sr = records.filter((r) => r.event === 'memory_heal' && r.op === 'standing_rules');
    assert(sr.length === 1, `a healthy run must STILL log exactly one record, got ${sr.length}`);
    assert(sr[0].pool_size === 3, 'healthy record carries pool_size: ' + JSON.stringify(sr[0]));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('F44: the fault path is STRUCTURALLY distinct (per the D086 proposal, rule 2 — ' +
     'Status: Proposed, not ratified) — a missing ' +
     'standing-rules anchor logs status:anchors_missing with NO kept/pool_size key, so a ' +
     'consumer tallying kept===0 cannot absorb a fault into the healthy bucket', () => {
  const root = makeTestbed('f44-anchors-missing');
  try {
    const dir = join(root, '.claude', 'agents');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n\nNo anchors here.\n', 'utf8');

    const records = withScratchHome((readLog) => {
      regenerateStandingRules(root);
      return readLog();
    });

    const sr = records.filter((r) => r.event === 'memory_heal' && r.op === 'standing_rules');
    assert(sr.length === 1 && sr[0].status === 'anchors_missing',
      'expected one anchors_missing record, got ' + JSON.stringify(sr));
    assert(!('kept' in sr[0]) && !('pool_size' in sr[0]),
      'fault record must OMIT kept/pool_size entirely, not report them as 0: ' + JSON.stringify(sr[0]));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ════ F45 item 2 — healMemoryPointers must not report success on a dropped write ═
//
// Bug being closed: writeMemoryMdAtomicSafe returns FALSE on 25 KB overflow and
// healMemoryPointers DISCARDED that boolean, then returned a populated
// addedDecisions list though nothing reached disk. The manual path for the
// identical condition (tools/prism-clean.mjs writeMemoryMdAtomic) die()s with
// exit 8 — two paths, same condition, opposite observability.

function seedMemoryMdPadded(root, padBytes) {
  seedMemoryMd(root);
  const path = join(root, '.claude', 'agents', 'MEMORY.md');
  const body = readFileSync(path, 'utf8');
  // Padding goes AFTER the anchored sections (own `## ` heading) so it cannot
  // be swallowed as anchor-section content.
  writeFileSync(path, body + '\n## Padding\n\n' + 'p'.repeat(padBytes) + '\n', 'utf8');
}

function writeDeltaAdjudication(root, fileName) {
  writeAdjudication(root, fileName, {
    title: 'Delta fixture', date: '2026-08-01', rule: 'Delta rule.',
  });
  return `docs/prism/adjudications/${fileName}`;
}

test('F45.2: healMemoryPointers reports written:false AND logs write_failed when the ' +
     '25 KB cap rejects the write — addedDecisions alone must not read as success', () => {
  const root = makeTestbed('f45-write-failed');
  try {
    seedMemoryMdPadded(root, 25 * 1024); // guarantees the post-upsert body busts the cap
    const rel = writeDeltaAdjudication(root, 'D401-delta.md');
    const before = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');

    const {res, records} = withScratchHome((readLog) => {
      const res = healMemoryPointers(root, {delta: {added: [rel], changed: [], removed: []}});
      return {res, records: readLog()};
    });

    assert(res.addedDecisions.includes('D401'), 'precondition: the pointer was assembled');
    assert(res.written === false,
      `written must be FALSE when nothing reached disk, got ${JSON.stringify(res.written)}`);
    const after = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    assert(after === before, 'ground truth: MEMORY.md must be byte-identical (write really was dropped)');

    const wf = records.filter((r) => r.event === 'memory_heal' && r.op === 'heal_pointers');
    assert(wf.length === 1 && wf[0].status === 'write_failed',
      'expected one write_failed record, got ' + JSON.stringify(wf));
    assert(wf[0].dropped_decisions.includes('D401') && wf[0].bytes > wf[0].cap_bytes,
      'the record must name what was dropped and why: ' + JSON.stringify(wf[0]));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('F45.2: written is tri-state — true on a landed write, null when no write was ' +
     'attempted (so "nothing to do" can never be read as "the write failed")', () => {
  const root = makeTestbed('f45-written-tristate');
  try {
    seedMemoryMd(root);
    const rel = writeDeltaAdjudication(root, 'D402-delta.md');

    const ok = healMemoryPointers(root, {delta: {added: [rel], changed: [], removed: []}});
    assert(ok.written === true, `expected written:true on success, got ${JSON.stringify(ok.written)}`);
    assert(readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8').includes('[[D402]]'),
      'ground truth: the pointer really is on disk');

    const noop = healMemoryPointers(root, {delta: {added: [], changed: [], removed: []}});
    assert(noop.written === null,
      `expected written:null when no write was attempted, got ${JSON.stringify(noop.written)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ═══ F45 item 3 — the keep-window trim names what it drops ([[D083]]) ══════

test('F45.3: upsertUnderAnchor logs memory_anchor_trim naming every entry pushed out of ' +
     'the keep window — this is what makes the 10-vs-20 divergence measurable', () => {
  const root = makeTestbed('f45-anchor-trim');
  try {
    seedMemoryMd(root);
    let body = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    const anchor = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';

    const records = withScratchHome((readLog) => {
      // Fill to 3 with keep:3 (no trim), then a 4th entry must push #1 out.
      for (let i = 1; i <= 3; i++) body = upsertUnderAnchor(body, anchor, `- entry ${i}`, {keep: 3});
      const noTrim = readLog().filter((r) => r.event === 'memory_anchor_trim');
      assert(noTrim.length === 0, 'no trim record may be emitted while nothing is dropped');
      body = upsertUnderAnchor(body, anchor, '- entry 4', {keep: 3});
      return readLog();
    });

    const trims = records.filter((r) => r.event === 'memory_anchor_trim');
    assert(trims.length === 1, `expected exactly 1 trim record, got ${trims.length}`);
    assert(trims[0].dropped.includes('- entry 1'),
      'the dropped entry must be NAMED, not merely counted: ' + JSON.stringify(trims[0]));
    assert(trims[0].before === 4 && trims[0].after === 3 && trims[0].keep === 3,
      'trim record must carry before/after/keep: ' + JSON.stringify(trims[0]));
    assert(!body.includes('- entry 1') && body.includes('- entry 4'),
      'ground truth: entry 1 really was dropped from the rebuilt body');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ═══ #85 — the "(last N, pointer-only)" heading tracks the ACTUAL rendered ═
// count, never the configured `keep`/cap ══════════════════════════════════
//
// Bug being closed: `.claude/agents/MEMORY.md`'s "## Recent decisions
// (last 10, pointer-only)" heading was a hand-typed literal, disconnected
// from what upsertUnderAnchor actually renders under that heading's anchor.
// tools/lib/memory-heal.mjs's SessionStart auto-heal calls with
// POINTER_KEEP=20 and tools/prism-clean.mjs's manual CLI calls with
// POINTER_KEEP=10 — same anchor, same shared upsertUnderAnchor, two
// different `keep` values (a DELIBERATE, D083-accepted divergence — this
// test must pass under the divergence, not assume it away). Whichever path
// wrote last decided the real count while the heading kept saying "last
// 10" regardless — confirmed on the live file: 20 bullets at commit
// c8c3c4f0b (SessionStart-healed), 10 bullets at HEAD 5651c3c6a
// (manually /prism-clean'd) — same literal heading both times.
//
// Fix: upsertUnderAnchor now finds the nearest preceding `## ` heading and,
// if it carries a `(last N,` parenthetical, rewrites N to `kept.length` —
// the number of bullets just rendered, NOT the `keep` param — every call.

test('#85: heading tracks a LARGE keep (20) — SessionStart auto-heal shape', () => {
  const root = makeTestbed('h85-keep20');
  try {
    seedMemoryMd(root);
    let body = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    const anchor = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
    for (let i = 1; i <= 25; i++) {
      body = upsertUnderAnchor(body, anchor, `- [[D${String(i).padStart(3, '0')}]] item ${i}`, {keep: 20});
    }
    const headingLine = body.split('\n').find((l) => l.startsWith('## Recent decisions'));
    const bulletCount = (body.match(/^- \[\[D\d+\]\]/gm) || []).length;
    assert(/\(last 20,/.test(headingLine), `expected "(last 20," in heading, got: ${headingLine}`);
    assert(bulletCount === 20, `expected 20 rendered bullets, got ${bulletCount}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('#85: heading tracks a SMALL keep (10) — manual /prism-clean CLI shape — ' +
     'proves the heading follows the WRITER, which is the actual bug', () => {
  const root = makeTestbed('h85-keep10');
  try {
    seedMemoryMd(root);
    let body = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    const anchor = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
    for (let i = 1; i <= 15; i++) {
      body = upsertUnderAnchor(body, anchor, `- [[D${String(i).padStart(3, '0')}]] item ${i}`, {keep: 10});
    }
    const headingLine = body.split('\n').find((l) => l.startsWith('## Recent decisions'));
    const bulletCount = (body.match(/^- \[\[D\d+\]\]/gm) || []).length;
    assert(/\(last 10,/.test(headingLine), `expected "(last 10," in heading, got: ${headingLine}`);
    assert(bulletCount === 10, `expected 10 rendered bullets, got ${bulletCount}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('#85: pool SMALLER than keep (4 pointers, keep=10) — heading must read ' +
     'the ACTUAL count (4), never the configured cap (10) — the sharpest case, ' +
     'the one a future "just interpolate the cap variable" simplification would break', () => {
  const root = makeTestbed('h85-pool-lt-cap');
  try {
    seedMemoryMd(root);
    let body = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    const anchor = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
    for (let i = 1; i <= 4; i++) {
      body = upsertUnderAnchor(body, anchor, `- [[D${String(i).padStart(3, '0')}]] item ${i}`, {keep: 10});
    }
    const headingLine = body.split('\n').find((l) => l.startsWith('## Recent decisions'));
    const bulletCount = (body.match(/^- \[\[D\d+\]\]/gm) || []).length;
    assert(/\(last 4,/.test(headingLine), `expected "(last 4," (actual, not cap=10) in heading, got: ${headingLine}`);
    assert(!/\(last 10,/.test(headingLine), `heading must NOT still read the configured cap: ${headingLine}`);
    assert(bulletCount === 4, `expected 4 rendered bullets, got ${bulletCount}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('#85: a `## ` heading with NO "(last N," parenthetical is provably untouched — ' +
     'pins the fix\'s scope so a future widened regex cannot start rewriting unrelated headings', () => {
  const root = makeTestbed('h85-scope-negative');
  try {
    seedMemoryMd(root);
    const before = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    const sessionLogBefore = before.slice(before.indexOf('## Session log'), before.indexOf('## Standing rules'));
    const standingRulesHeadingBefore = before.slice(
      before.indexOf('## Standing rules'), before.indexOf(STANDING_RULES_ANCHORS.start));

    let body = before;
    const anchor = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
    for (let i = 1; i <= 3; i++) {
      body = upsertUnderAnchor(body, anchor, `- [[D${String(i).padStart(3, '0')}]] item ${i}`, {keep: 10});
    }

    const sessionLogAfter = body.slice(body.indexOf('## Session log'), body.indexOf('## Standing rules'));
    const standingRulesHeadingAfter = body.slice(
      body.indexOf('## Standing rules'), body.indexOf(STANDING_RULES_ANCHORS.start));
    assert(sessionLogAfter === sessionLogBefore,
      'Session log heading/section (no "(last N," parenthetical) must be byte-identical:\n' +
      `before: ${JSON.stringify(sessionLogBefore)}\nafter:  ${JSON.stringify(sessionLogAfter)}`);
    assert(standingRulesHeadingAfter === standingRulesHeadingBefore,
      'Standing rules heading/preamble (no "(last N," parenthetical) must be byte-identical:\n' +
      `before: ${JSON.stringify(standingRulesHeadingBefore)}\nafter:  ${JSON.stringify(standingRulesHeadingAfter)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ══════════ F44/[[D093]] — retirement excludes from the ALWAYS-ON block ════
//
// D093 (Proposed) adds a `**Retired:** <date> — <reason>` header field. A file
// carrying it keeps `**Status:** Locked` and keeps every byte of its content —
// only its ALWAYS-ON injection eligibility changes. scanLockedRules() must
// skip it, and per [[D046]] the skip must be OBSERVABLE as its OWN count:
// retirement is intentional (remedy: none), a count-cap eviction is fixable by
// raising `cap`, and a byte-fit eviction is a wall `cap` cannot fix. Folding
// retirement into either eviction bucket would make a deliberate owner act
// read as capacity pressure.

test('D093: a Locked rule carrying a **Retired:** line is EXCLUDED from the standing-rules ' +
     'block and reported in its own retiredSkipped count — never folded into evictedByCap', () => {
  const root = makeTestbed('d093-retired-excluded');
  try {
    seedMemoryMd(root);
    // 3 live + 2 retired, cap well above the pool so NOTHING can be evicted by
    // the cap. Any absence must therefore be attributable to retirement alone.
    for (let i = 1; i <= 3; i++) {
      writeAdjudication(root, `D40${i}-live-${i}.md`, {
        title: `Live ${i}`, date: `2026-08-0${i}`, rule: `Live rule ${i}.`,
      });
    }
    writeAdjudication(root, 'D411-retired-spent.md', {
      title: 'Retired spent one-off',
      date: '2026-08-04', // NEWEST date — would rank FIRST if not retired,
      rule: 'Retired rule text ALPHA.', // so exclusion cannot be a ranking artifact.
      retired: '2026-07-28 — spent: completed one-off; Rule is a past-tense finding.',
    });
    writeAdjudication(root, 'D412-retired-superseded.md', {
      title: 'Retired superseded',
      date: '2026-08-05',
      rule: 'Retired rule text BETA.',
      retired: '2026-08-05 — superseded by D499 (policy replaced).',
    });

    const {res, block, records} = withScratchHome((readLog) => {
      const res = regenerateStandingRules(root, {cap: 35});
      return {res, block: standingRulesBlock(readMemoryMd(root)), records: readLog()};
    });

    // Ground truth FIRST — what actually landed in the rendered block.
    assert(!block.includes('Retired rule text ALPHA'),
      'a retired rule must NOT appear in the always-on block; block was:\n' + block);
    assert(!block.includes('Retired rule text BETA'),
      'the superseded-reason retirement must also be excluded; block was:\n' + block);
    assert(!block.includes('D411') && !block.includes('D412'),
      'no retired D-ref may appear in the block; block was:\n' + block);

    // A NORMAL Locked rule is unaffected — the skip must not over-fire.
    for (let i = 1; i <= 3; i++) {
      assert(block.includes(`Live rule ${i}.`),
        `live rule ${i} must be UNAFFECTED by the retirement skip; block was:\n` + block);
    }

    assert(res.poolSize === 3,
      `poolSize must count only the ELIGIBLE pool (3 live), got ${res.poolSize}`);
    assert(res.count === 3, `all 3 live rules should be kept, got ${res.count}`);
    assert(Array.isArray(res.retiredSkipped) && res.retiredSkipped.length === 2,
      'retiredSkipped must NAME both retired refs, got ' + JSON.stringify(res.retiredSkipped));
    assert(res.retiredSkipped.includes('D411') && res.retiredSkipped.includes('D412'),
      'retiredSkipped must carry D411 and D412: ' + JSON.stringify(res.retiredSkipped));
    // The crux of the D046 separation: retirement is NOT an eviction.
    assert(res.evictedByCap.length === 0,
      'retirement must NOT be reported as a count-cap eviction — different cause, ' +
      'different remedy: ' + JSON.stringify(res.evictedByCap));
    assert(res.evictedByBytes.length === 0,
      'retirement must NOT be reported as a byte-fit trim: ' + JSON.stringify(res.evictedByBytes));

    // Region-scoped per [[D084]]: assert on the standing_rules records only.
    const sr = records.filter((r) => r.event === 'memory_heal' && r.op === 'standing_rules');
    assert(sr.length === 1, `expected exactly 1 standing_rules record, got ${sr.length}`);
    assert(Array.isArray(sr[0].retired_skipped) && sr[0].retired_skipped.length === 2,
      'the LOG must carry retired_skipped as its own field — the production caller ' +
      '(hooks/prism-session-start.mjs) discards the return value, so a return-only ' +
      'signal would be unobservable: ' + JSON.stringify(sr[0]));
    assert(sr[0].evicted_count_cap.length === 0 && sr[0].evicted_byte_fit.length === 0,
      'the three causes must stay in SEPARATE log fields: ' + JSON.stringify(sr[0]));
    assert(sr[0].pool_size === 3 && sr[0].kept === 3,
      'pool_size/kept describe the eligible pool: ' + JSON.stringify(sr[0]));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('D093: retirement frees a real slot — a rule the cap had evicted is ADMITTED once a ' +
     'higher-ranked rule is retired, and the marker is line-anchored so a prose mention ' +
     'of "**Retired:**" inside the body can never retire a live rule', () => {
  const root = makeTestbed('d093-frees-slot-and-anchoring');
  try {
    seedMemoryMd(root);
    // 5 rules, cap 3 -> D501/D502 (oldest) are cap-evicted at baseline.
    for (let i = 1; i <= 5; i++) {
      writeAdjudication(root, `D50${i}-r-${i}.md`, {
        title: `R ${i}`, date: `2026-08-0${i}`, rule: `R rule ${i}.`,
      });
    }
    const before = withScratchHome(() => regenerateStandingRules(root, {cap: 3}));
    assert(before.poolSize === 5 && before.count === 3, 'baseline: pool 5, kept 3');
    assert(before.evictedByCap.includes('D501') && before.evictedByCap.includes('D502'),
      'baseline must cap-evict the two oldest: ' + JSON.stringify(before.evictedByCap));

    // Retire the NEWEST (top-ranked) rule. Exactly one slot must free up, and
    // it must go to D502 — the highest-ranked previously-evicted rule.
    writeAdjudication(root, 'D505-r-5.md', {
      title: 'R 5', date: '2026-08-05', rule: 'R rule 5.',
      retired: '2026-07-28 — spent: superseded by nothing; simply done.',
    });
    // A DECOY: a live rule whose BODY mentions the marker mid-line. The
    // line-anchored regex (D062's lesson) must not fire on it.
    writeAdjudication(root, 'D506-decoy.md', {
      title: 'Decoy', date: '2026-08-06', rule: 'Decoy rule 6.',
      body: 'Prose that mentions **Retired:** 2026-01-01 in the middle of a sentence.',
    });

    const {after, block} = withScratchHome(() => {
      const after = regenerateStandingRules(root, {cap: 3});
      return {after, block: standingRulesBlock(readMemoryMd(root))};
    });

    assert(after.retiredSkipped.length === 1 && after.retiredSkipped[0] === 'D505',
      'only D505 is retired: ' + JSON.stringify(after.retiredSkipped));
    assert(after.poolSize === 5,
      `eligible pool is 5 (4 originals + decoy, minus retired D505), got ${after.poolSize}`);
    assert(block.includes('Decoy rule 6.'),
      'the DECOY must survive — a mid-line "**Retired:**" in the body must NOT retire a ' +
      'live rule (line-anchored per D062); block was:\n' + block);
    assert(!block.includes('R rule 5.'),
      'the retired rule must be gone from the block; block was:\n' + block);
    assert(block.includes('R rule 4.') && block.includes('R rule 3.'),
      'the slot freed by retirement must be reused by live rules; block was:\n' + block);
    assert(after.count === 3, `cap is UNCHANGED at 3, got ${after.count}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('D093: the UNCHANGED return branch (hashOf(rendered)===hashOf(existing), ' +
     'changed:false/written:null) reports poolSize/retiredSkipped/evictedByCap/' +
     'evictedByBytes identically to the WRITTEN branch — regenerateStandingRules has ' +
     'two return sites at different indentation levels and both must carry these fields', () => {
  const root = makeTestbed('d093-unchanged-branch-parity');
  try {
    seedMemoryMd(root);
    for (let i = 1; i <= 2; i++) {
      writeAdjudication(root, `D60${i}-live-${i}.md`, {
        title: `Live ${i}`, date: `2026-08-0${i}`, rule: `Unchanged-branch live rule ${i}.`,
      });
    }
    writeAdjudication(root, 'D611-retired.md', {
      title: 'Retired for unchanged-branch test',
      date: '2026-08-11',
      rule: 'Unchanged-branch retired rule.',
      retired: '2026-07-28 — spent: completed one-off; Rule is a past-tense finding.',
    });

    // First call: hits the WRITTEN branch (block goes from seed default to the
    // 2-live/1-retired set) — establishes the baseline written block on disk.
    const written = withScratchHome(() => regenerateStandingRules(root, {cap: 35}));
    assert(written.written === true, `first call must land a write, got ${JSON.stringify(written.written)}`);
    assert(written.poolSize === 2 && written.retiredSkipped.length === 1 &&
      written.retiredSkipped[0] === 'D611', 'written-branch baseline: ' + JSON.stringify(written));

    // Second call with IDENTICAL inputs: renderedBlock hash must match the
    // existing block hash, taking the `unchanged` return (changed:false,
    // written:null) rather than the `written` return.
    const unchanged = withScratchHome(() => regenerateStandingRules(root, {cap: 35}));
    assert(unchanged.changed === false && unchanged.written === null,
      `second call must take the UNCHANGED branch, got changed=${unchanged.changed} ` +
      `written=${JSON.stringify(unchanged.written)}`);
    assert(unchanged.poolSize === 2,
      `unchanged branch must still report poolSize (eligible pool), got ${unchanged.poolSize}`);
    assert(Array.isArray(unchanged.retiredSkipped) && unchanged.retiredSkipped.length === 1 &&
      unchanged.retiredSkipped[0] === 'D611',
      `unchanged branch must still name retiredSkipped, got ${JSON.stringify(unchanged.retiredSkipped)}`);
    assert(Array.isArray(unchanged.evictedByCap) && unchanged.evictedByCap.length === 0,
      `unchanged branch must still carry evictedByCap (empty here), got ${JSON.stringify(unchanged.evictedByCap)}`);
    assert(Array.isArray(unchanged.evictedByBytes) && unchanged.evictedByBytes.length === 0,
      `unchanged branch must still carry evictedByBytes (empty here), got ${JSON.stringify(unchanged.evictedByBytes)}`);
    assert(unchanged.count === written.count,
      `unchanged branch's count must match the prior written count, got ${unchanged.count} vs ${written.count}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('F44 follow-up (D093 self-retirement bug): a worked EXAMPLE of the ' +
     '`**Retired:**` line-format inside the BODY (e.g. a fenced code block documenting ' +
     'the mechanism, as D093 itself does) must NOT retire the file that contains it — ' +
     'only a genuine header-block field may retire', () => {
  const root = makeTestbed('d093-self-retirement-guard');
  try {
    seedMemoryMd(root);
    // Mirrors the REAL D093 shape: a Locked rule-bearing file whose BODY, after
    // the header block, quotes the exact marker syntax as a worked example
    // (inside a fenced code block) so readers know the format — with NO
    // genuine **Retired:** header field of its own.
    writeAdjudication(root, 'D701-defines-the-mechanism.md', {
      title: 'Defines the retirement mechanism',
      date: '2026-08-01',
      rule: 'Self-retirement guard rule — must survive as a live standing rule.',
      body: [
        'Worked example of the format for OTHER files to use:',
        '',
        '```',
        '**Retired:** 2026-06-23 — spent: completed one-off; the Rule is a past-tense finding.',
        '```',
        '',
        'A second worked example:',
        '',
        '```',
        '**Retired:** 2026-08-01 — superseded by D999 (policy replaced).',
        '```',
      ].join('\n'),
    });
    // A genuinely retired sibling, for contrast — its header-block field must
    // still work correctly alongside the guard above.
    writeAdjudication(root, 'D702-genuinely-retired.md', {
      title: 'Genuinely retired',
      date: '2026-08-02',
      rule: 'Genuinely retired rule text.',
      retired: '2026-07-28 — spent: completed one-off.',
    });

    const {res, block} = withScratchHome(() => {
      const res = regenerateStandingRules(root, {cap: 35});
      return {res, block: standingRulesBlock(readMemoryMd(root))};
    });

    assert(block.includes('Self-retirement guard rule'),
      'D701 must NOT be excluded by its own worked example — block was:\n' + block);
    assert(!block.includes('Genuinely retired rule text'),
      'D702 must still be excluded (genuine header-block **Retired:** field); block was:\n' + block);
    assert(!res.retiredSkipped.includes('D701'),
      `D701 must NOT appear in retiredSkipped (self-retirement bug), got ${JSON.stringify(res.retiredSkipped)}`);
    assert(res.retiredSkipped.includes('D702'),
      `D702 must still appear in retiredSkipped, got ${JSON.stringify(res.retiredSkipped)}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ═══════════════ D097 — Tier: core exempts from date-ordered eviction ═════
//
// Bug being closed (not yet built until this task): regenerateStandingRules
// evicted the FOUNDATIONAL, defect-class rules (D046, D045, D043, D047, D023)
// purely for being old, while recent situational adjudications occupied the
// always-on block — measured BY INVOCATION and captured as [[D097]] (Locked).
// This adds the `**Tier:** core` mechanism: core-tagged rules are ALWAYS
// injected and EXEMPT from the date sort; everyone else still competes
// newest-first for the remaining `cap` slots, exactly as before.

test('D097: a core-tagged rule with an OLD Date is ALWAYS injected despite losing the ' +
     'date sort, while the untiered remainder still competes newest-first for the ' +
     'REMAINING cap slots (orderNewestFirst tiebreak untouched)', () => {
  const root = makeTestbed('d097-core-always-injected');
  try {
    seedMemoryMd(root);
    // Core rule dated OLDEST of everything here — under plain date-sort this
    // would be the FIRST evicted by any cap < poolSize. It must survive anyway.
    writeAdjudication(root, 'D801-core-old.md', {
      title: 'Core old rule', tier: 'core', date: '2026-01-01',
      rule: 'Core-tier rule text (old date).',
    });
    // 5 non-core rules, all newer than the core rule.
    for (let i = 1; i <= 5; i++) {
      writeAdjudication(root, `D8${10 + i}-noncore-${i}.md`, {
        title: `Non-core ${i}`, date: `2026-08-0${i}`, rule: `Non-core rule text ${i}.`,
      });
    }

    // cap=3 -> 1 core + 2 remaining slots for the 5 competing non-core rules.
    const {res, block} = withScratchHome(() => {
      const res = regenerateStandingRules(root, {cap: 3});
      return {res, block: standingRulesBlock(readMemoryMd(root))};
    });

    assert(block.includes('Core-tier rule text (old date).'),
      'the core rule (oldest Date in the pool) must be ALWAYS injected; block was:\n' + block);
    assert(res.tiered.length === 1 && res.tiered[0] === 'D801',
      'tiered must name exactly the core dRef, got ' + JSON.stringify(res.tiered));
    assert(!res.evictedByCap.includes('D801'),
      'the core rule must NEVER appear in evictedByCap: ' + JSON.stringify(res.evictedByCap));

    // Only the 2 NEWEST non-core rules (5, 4) fit the 2 remaining slots;
    // the tiebreak/ordering among non-core is otherwise unchanged.
    assert(block.includes('Non-core rule text 5.') && block.includes('Non-core rule text 4.'),
      'the 2 newest non-core rules must fill the remaining slots; block was:\n' + block);
    assert(!block.includes('Non-core rule text 1.') && !block.includes('Non-core rule text 2.') &&
      !block.includes('Non-core rule text 3.'),
      'the 3 oldest non-core rules must be cap-evicted (core consumed 1 of the 3 slots); block was:\n' + block);
    assert(res.evictedByCap.length === 3 &&
      ['D811', 'D812', 'D813'].every((d) => res.evictedByCap.includes(d)),
      'evictedByCap must name exactly the 3 oldest NON-core rules: ' + JSON.stringify(res.evictedByCap));
    assert(res.poolSize === 6, `poolSize must count core+non-core together, got ${res.poolSize}`);
    assert(res.count === 3, `count (kept) should be cap, got ${res.count}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('D097: fail-open — a MALFORMED Tier value and an ABSENT Tier field both compete as ' +
     'ordinary (non-core) rules, never an error and never treated as core', () => {
  const root = makeTestbed('d097-fail-open');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D821-genuine-core.md', {
      title: 'Genuine core', tier: 'core', date: '2026-01-01',
      rule: 'Genuine core rule text.',
    });
    writeAdjudication(root, 'D822-malformed-tier.md', {
      title: 'Malformed tier value', tier: 'important', date: '2026-08-05',
      rule: 'Malformed-tier rule text.',
    });
    writeAdjudication(root, 'D823-absent-tier.md', {
      title: 'No tier field at all', date: '2026-08-01',
      rule: 'Absent-tier rule text.',
    });

    // cap=1 with exactly 1 genuine core rule -> 0 remaining slots for anyone
    // else. If a malformed or absent Tier value granted ANY core protection,
    // one of D822/D823 would survive despite 0 remaining slots. Neither may.
    const {res, block} = withScratchHome(() => {
      const res = regenerateStandingRules(root, {cap: 1});
      return {res, block: standingRulesBlock(readMemoryMd(root))};
    });

    assert(block.includes('Genuine core rule text.'),
      'the genuinely-tiered core rule must survive; block was:\n' + block);
    assert(!block.includes('Malformed-tier rule text.'),
      'a MALFORMED Tier value must grant NO core exemption (fail-open = normal competition, ' +
      'not special treatment); block was:\n' + block);
    assert(!block.includes('Absent-tier rule text.'),
      'an ABSENT Tier field must grant NO core exemption; block was:\n' + block);
    assert(res.tiered.length === 1 && res.tiered[0] === 'D821',
      'tiered must name ONLY the genuine core rule: ' + JSON.stringify(res.tiered));
    assert(res.evictedByCap.length === 2 &&
      res.evictedByCap.includes('D822') && res.evictedByCap.includes('D823'),
      'both the malformed-tier and absent-tier rules must be ordinary cap-evictions: ' +
      JSON.stringify(res.evictedByCap));
    assert(res.poolSize === 3, `poolSize must still count all 3 (fail-open never excludes ` +
      `from the pool), got ${res.poolSize}`);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('D097: extraction is scoped to headerBlock() — a FENCED `**Tier:** core` worked ' +
     'example inside a BODY code block must NOT tier that file, while a genuine ' +
     'header-block `**Tier:** core` field DOES (paired test, same shape as the D093 ' +
     'self-retirement guard above, applied to Tier instead of Retired)', () => {
  const root = makeTestbed('d097-headerblock-scoping');
  try {
    seedMemoryMd(root);
    // Genuine header-block Tier field.
    writeAdjudication(root, 'D901-genuine-header-tier.md', {
      title: 'Genuine header Tier field', tier: 'core', date: '2026-01-01',
      rule: 'Genuine core rule text.',
    });
    // NO real Tier field — but the BODY quotes the exact marker syntax inside
    // a fenced code block, mirroring how D093 documents **Retired:** in its
    // own body (the exact self-retirement shape this must not repeat for Tier).
    writeAdjudication(root, 'D902-body-fence-decoy.md', {
      title: 'Body-fence decoy (documents the mechanism, is not itself core)',
      date: '2026-01-02',
      rule: 'Body-fence decoy rule text.',
      body: [
        'Worked example of the header field format for OTHER files to use:',
        '',
        '```',
        '**Tier:** core',
        '```',
      ].join('\n'),
    });
    // 3 newer non-core rules to force a cap squeeze so the decoy's survival
    // (or eviction) is a real assertion, not a vacuous one.
    for (let i = 1; i <= 3; i++) {
      writeAdjudication(root, `D91${i}-newer-${i}.md`, {
        title: `Newer ${i}`, date: `2026-08-0${i}`, rule: `Newer rule text ${i}.`,
      });
    }

    // cap=2 -> 1 core (D901) + 1 remaining slot. 4 non-core rules (D902 +
    // 3 newer) compete for that 1 slot; the newest (D913) wins, so D902 (the
    // decoy, dated OLDEST of the non-core group) must be evicted like any
    // ordinary non-core rule — proving the fence never tiered it.
    const {res, block} = withScratchHome(() => {
      const res = regenerateStandingRules(root, {cap: 2});
      return {res, block: standingRulesBlock(readMemoryMd(root))};
    });

    assert(block.includes('Genuine core rule text.'),
      'the genuine header-block Tier field must tier the file; block was:\n' + block);
    assert(!block.includes('Body-fence decoy rule text.'),
      'a FENCED worked example in the BODY must NOT tier the file that merely documents ' +
      'the mechanism (D093 self-retirement shape, for Tier); block was:\n' + block);
    assert(res.tiered.length === 1 && res.tiered[0] === 'D901',
      'tiered must name ONLY the genuine header-tiered file, not the body-fence decoy: ' +
      JSON.stringify(res.tiered));
    assert(res.evictedByCap.includes('D902'),
      'the decoy must be reported as an ORDINARY cap eviction, same as any non-core rule: ' +
      JSON.stringify(res.evictedByCap));
    assert(!res.evictedByCap.includes('D901'),
      'the genuine core file must never appear in evictedByCap: ' + JSON.stringify(res.evictedByCap));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('D097: BOTH return sites (the UNCHANGED branch and the WRITTEN branch) carry `tiered` ' +
     'identically — same two-return-site hazard the D093 parity test above guards, now for ' +
     'the field this task added', () => {
  const root = makeTestbed('d097-both-return-sites');
  try {
    seedMemoryMd(root);
    writeAdjudication(root, 'D921-core.md', {
      title: 'Core for parity test', tier: 'core', date: '2026-01-01',
      rule: 'Parity-test core rule text.',
    });
    writeAdjudication(root, 'D922-noncore.md', {
      title: 'Non-core for parity test', date: '2026-08-01',
      rule: 'Parity-test non-core rule text.',
    });

    // First call lands a WRITE (block goes from the seed default to this set).
    const written = withScratchHome(() => regenerateStandingRules(root, {cap: 35}));
    assert(written.written === true, `first call must land a write, got ${JSON.stringify(written.written)}`);
    assert(Array.isArray(written.tiered) && written.tiered.length === 1 && written.tiered[0] === 'D921',
      'WRITTEN branch must carry tiered: ' + JSON.stringify(written.tiered));

    // Second call with identical inputs takes the UNCHANGED branch.
    const unchanged = withScratchHome(() => regenerateStandingRules(root, {cap: 35}));
    assert(unchanged.changed === false && unchanged.written === null,
      `second call must take the UNCHANGED branch, got changed=${unchanged.changed} ` +
      `written=${JSON.stringify(unchanged.written)}`);
    assert(Array.isArray(unchanged.tiered) && unchanged.tiered.length === 1 && unchanged.tiered[0] === 'D921',
      'UNCHANGED branch must ALSO carry tiered — this is the exact defect shape the task ' +
      'warned about (a field wired into only one of the two return sites): ' +
      JSON.stringify(unchanged.tiered));
  } finally { rmSync(root, {recursive: true, force: true}); }
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
