#!/usr/bin/env node
// F8 — panel self-contradiction advisory: a seat that lands in BOTH
// panel.positions[] (with real challenges from a dispatched agent) AND
// dropped_positions[] (reason: specialist_unknown) signals a chair-
// construction inconsistency — the chair gave a bare general-purpose seat a
// vertical-sounding title, tripping the provenance-adjacent drop gate, while
// the seat's live challenges stayed untouched in positions[] (dropped_positions
// is an append-only annotation log; positions[] entries are never removed).
//
// classifyDropReason() checks `challenges.length === 0` FIRST (returns
// 'insufficient_challenges'), and only returns 'specialist_unknown' when
// challenges.length > 0 — so every specialist_unknown drop is BY
// CONSTRUCTION a title with live challenges in both arrays. This test locks:
//   1. FIRES  — specialist_unknown drop + live challenges → panel_guard_consistency logged.
//   2. NO-FIRE — insufficient_challenges drop (zero challenges) → no consistency event.
//   3. NO-FIRE — normal resolved, non-dropped position → no consistency event.
//
// HOME-isolated (mirrors test-panel-guard-home-isolation.mjs / test-panel-
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

const HOME = mkdtempSync(join(tmpdir(), 'prism-consist-'));
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
const prevProv = process.env.PRISM_PANEL_PROVENANCE, prevGuard = process.env.PRISM_PANEL_GUARD;
const prevDisable = process.env.PRISM_DISABLE_DROPPED_LOG;

const LOG = join(HOME, '.claude', '.prism-routing.jsonl');
const TASK_DIR = join(HOME, '.claude', '.prism-task-f8sha');
const PANEL = join(TASK_DIR, 'panel.json');

function writePanel(panel) {
  mkdirSync(TASK_DIR, {recursive: true});
  writeFileSync(PANEL, JSON.stringify(panel));
}
function droppedFromPanel() {
  try { return JSON.parse(readFileSync(PANEL, 'utf-8')).dropped_positions || []; }
  catch { return []; }
}
function consistencyEvents() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'panel_guard_consistency');
}

try {
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  process.env.PRISM_PANEL_PROVENANCE = 'off'; // isolate from the provenance-adhoc-seat gate — this test targets Path B classifyDropReason only
  delete process.env.PRISM_PANEL_GUARD;
  delete process.env.PRISM_DISABLE_DROPPED_LOG;
  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.runPostToolUse === 'function', 'panel-guard must export runPostToolUse');

  await test('FIRES: vertical-titled general-purpose seat, specialist_unknown drop + 4 live challenges → advisory logged', async () => {
    writePanel({task_id: 'f8', session_id: 'sess-f8-fire', positions: [
      {
        title: 'Performance & Measurement skeptic',
        vertical: true,
        specialist: undefined,
        challenges: [{text: 'a'}, {text: 'b'}, {text: 'c'}, {text: 'd'}],
      },
    ]});
    const before = consistencyEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}, session_id: 'sess-f8-fire'});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const drops = droppedFromPanel();
    assert(drops.length === 1 && drops[0].reason === 'specialist_unknown',
      `expected 1 specialist_unknown drop, got ${JSON.stringify(drops)}`);

    const after = consistencyEvents();
    assert(after.length - before === 1, `expected exactly 1 new panel_guard_consistency event, got ${after.length - before}`);
    const ev = after[after.length - 1];
    assert(ev.title === 'Performance & Measurement skeptic', `unexpected title: ${ev.title}`);
    assert(ev.challenge_count === 4, `expected challenge_count 4, got ${ev.challenge_count}`);
    assert(ev.specialist === null, `expected specialist null, got ${JSON.stringify(ev.specialist)}`);
    assert(ev.session_id === 'sess-f8-fire', `expected session_id passthrough, got ${JSON.stringify(ev.session_id)}`);
    assert(/specialist_unknown/.test(ev.reason), `reason must reference specialist_unknown, got ${ev.reason}`);
  });

  await test('NO-FIRE: zero challenges (insufficient_challenges drop) → no consistency event', async () => {
    writePanel({task_id: 'f8', positions: [
      {title: 'Bare vertical seat, no specialist, no challenges', vertical: true, challenges: []},
    ]});
    const before = consistencyEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const drops = droppedFromPanel();
    assert(drops.length === 1 && drops[0].reason === 'insufficient_challenges',
      `expected 1 insufficient_challenges drop, got ${JSON.stringify(drops)}`);

    const after = consistencyEvents();
    assert(after.length - before === 0, `insufficient_challenges drop must NOT fire consistency advisory, got ${after.length - before} new events`);
  });

  await test('NO-FIRE: normal resolved, non-dropped position → no consistency event', async () => {
    writePanel({task_id: 'f8', positions: [
      {
        title: 'Payment fraud detection expert',
        vertical: true,
        agent_type: 'payment-fraud-specialist',
        seat_source: 'factory-created',
        specialist: '@payment-fraud-specialist',
        dispatched_agent_id: 'a1',
        challenges: [{text: 'x'}, {text: 'y'}],
      },
    ]});
    const before = consistencyEvents().length;
    const res = mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}});
    assert(res.exit === 0, `must exit 0, got ${res.exit}`);

    const drops = droppedFromPanel();
    assert(drops.length === 0, `resolved seat must not be dropped at all, got ${JSON.stringify(drops)}`);

    const after = consistencyEvents();
    assert(after.length - before === 0, `resolved, non-dropped seat must NOT fire consistency advisory, got ${after.length - before} new events`);
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
