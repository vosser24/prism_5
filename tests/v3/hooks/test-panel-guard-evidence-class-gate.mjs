#!/usr/bin/env node
// F24 — evidence_class ILLEGAL-VALUE gate (not just absence). The pre-fix
// gate in classifyPanelEvidence()/prism-panel-guard.mjs was `!c.evidence_class`
// — absence-only. It never validated a value that is PRESENT but OUT OF THE
// 7-class taxonomy (PRECEDENT, MEASUREMENT, SPEC, QUOTE, DEMO,
// REASONED-INFERENCE, CHALLENGE-SUBSTANCE), so a chair that invents an
// out-of-taxonomy value (observed live: "CODE-GROUNDED", RB-16,
// task_sha widget-forge-group-commit-20260727, ts 2026-07-27T11:07:19.648Z)
// passed every structural hook untouched even though
// prism-prompt-tier-router.mjs:172 explicitly instructs "ONLY these 7
// values — never invent others".
//
// This test locks the fixed behavior:
//   1. FIRES — illegal evidence_class ("CODE-GROUNDED", the real observed
//      value) is COERCED to a legal value AND an advisory/telemetry record
//      capturing the ORIGINAL illegal value is appended (disobedience stays
//      visible — silent coercion alone would lose that signal).
//   2. NO-FIRE (fill) — absent evidence_class still gets classified in,
//      exactly as before (pre-existing absence-only behavior preserved).
//   3. NO-FIRE (pass-through) — a legal evidence_class already present is
//      left untouched and does not trip the illegal-value advisory.
//
// HOME-isolated (mirrors test-panel-guard-consistency.mjs / test-panel-
// provenance-gate.mjs): HOME + USERPROFILE point at a mkdtemp dir BEFORE
// importing the hook, since roster/log paths resolve via prismHome() at call
// time and the roster is cached on first read.
import {mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-panel-guard.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const LEGAL_CLASSES = new Set([
  'PRECEDENT', 'MEASUREMENT', 'SPEC', 'QUOTE', 'DEMO',
  'REASONED-INFERENCE', 'CHALLENGE-SUBSTANCE',
]);

const HOME = mkdtempSync(join(tmpdir(), 'prism-evclass-'));
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
const prevProv = process.env.PRISM_PANEL_PROVENANCE, prevGuard = process.env.PRISM_PANEL_GUARD;
const prevDisable = process.env.PRISM_DISABLE_DROPPED_LOG;

const LOG = join(HOME, '.claude', '.prism-routing.jsonl');
const TASK_DIR = join(HOME, '.claude', '.prism-task-f24sha');
const PANEL = join(TASK_DIR, 'panel.json');

function writePanel(panel) {
  mkdirSync(TASK_DIR, {recursive: true});
  writeFileSync(PANEL, JSON.stringify(panel));
}
function readPanel() {
  return JSON.parse(readFileSync(PANEL, 'utf-8'));
}
function illegalEvents() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'panel_guard_evidence_class_illegal');
}

try {
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  process.env.PRISM_PANEL_PROVENANCE = 'off';
  delete process.env.PRISM_PANEL_GUARD;
  delete process.env.PRISM_DISABLE_DROPPED_LOG;
  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.runPostToolUse === 'function', 'panel-guard must export runPostToolUse');

  await test('FIRES: illegal evidence_class ("CODE-GROUNDED", the real observed value) is coerced to a legal value AND logged with the original illegal value', async () => {
    writePanel({task_id: 'f24', session_id: 'sess-f24-fire', positions: [
      {
        title: 'widget-forge-expert',
        vertical: true,
        specialist: '@widget-forge-expert',
        challenges: [
          {text: 'per the spec, this MUST validate input', evidence_class: 'CODE-GROUNDED'},
        ],
      },
      {
        title: 'Evidence and measurement skeptic',
        vertical: true,
        challenges: [
          {text: 'measured 45ms p99, benchmark passed', evidence_class: 'CODE-GROUNDED'},
        ],
      },
    ]});
    const before = illegalEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}, session_id: 'sess-f24-fire'});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const panel = readPanel();
    const c0 = panel.positions[0].challenges[0];
    const c1 = panel.positions[1].challenges[0];
    assert(c0.evidence_class !== 'CODE-GROUNDED', 'illegal value must not survive verbatim into panel.json (position 0)');
    assert(LEGAL_CLASSES.has(c0.evidence_class), `coerced value must be one of the 7 legal classes, got ${c0.evidence_class}`);
    assert(c1.evidence_class !== 'CODE-GROUNDED', 'illegal value must not survive verbatim into panel.json (position 1)');
    assert(LEGAL_CLASSES.has(c1.evidence_class), `coerced value must be one of the 7 legal classes, got ${c1.evidence_class}`);

    // One batched advisory event per panel-write (mirrors the pre-existing
    // panel_guard_dropped batching pattern: dropped_count + an array), not
    // one event per illegal challenge.
    const after = illegalEvents();
    assert(after.length - before === 1, `expected exactly 1 new panel_guard_evidence_class_illegal event (batched per panel-write), got ${after.length - before}`);
    const ev = after[after.length - 1];
    assert(ev.illegal_count === 2, `expected illegal_count 2, got ${ev.illegal_count}`);
    const originals = (ev.illegal || []).map(i => i.illegal_value);
    assert(originals.length === 2 && originals.every(v => v === 'CODE-GROUNDED'), `advisory must capture the ORIGINAL illegal value verbatim for both challenges, got ${JSON.stringify(originals)}`);
  });

  await test('NO-FIRE (fill): absent evidence_class still gets classified in, no illegal-value advisory', async () => {
    writePanel({task_id: 'f24', positions: [
      {title: 'Some seat', vertical: true, challenges: [{text: 'no evidence, hand-wavy claim'}]},
    ]});
    const before = illegalEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const panel = readPanel();
    assert(!!panel.positions[0].challenges[0].evidence_class, 'absent evidence_class must still be filled in (pre-existing behavior)');
    assert(LEGAL_CLASSES.has(panel.positions[0].challenges[0].evidence_class), 'filled-in value must be legal');

    const after = illegalEvents();
    assert(after.length - before === 0, `filling an ABSENT value must NOT fire the illegal-value advisory, got ${after.length - before} new events`);
  });

  await test('NO-FIRE (pass-through): a legal evidence_class already present is left untouched, no advisory', async () => {
    writePanel({task_id: 'f24', positions: [
      {title: 'Some seat', vertical: true, challenges: [{text: 'x', evidence_class: 'SPEC'}]},
    ]});
    const before = illegalEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const panel = readPanel();
    assert(panel.positions[0].challenges[0].evidence_class === 'SPEC', 'a legal pre-existing value must not be altered');

    const after = illegalEvents();
    assert(after.length - before === 0, `a legal pre-existing value must NOT fire the illegal-value advisory, got ${after.length - before} new events`);
  });
} finally {
  if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
  if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  if (prevProv === undefined) delete process.env.PRISM_PANEL_PROVENANCE; else process.env.PRISM_PANEL_PROVENANCE = prevProv;
  if (prevGuard === undefined) delete process.env.PRISM_PANEL_GUARD; else process.env.PRISM_PANEL_GUARD = prevGuard;
  if (prevDisable === undefined) delete process.env.PRISM_DISABLE_DROPPED_LOG; else process.env.PRISM_DISABLE_DROPPED_LOG = prevDisable;
  rmSync(HOME, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
