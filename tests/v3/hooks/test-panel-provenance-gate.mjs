#!/usr/bin/env node
// T1 — Fix 3 (D054) provenance detector: detectAdHocSeats wired into
// runPostToolUse. Fire-on-bad (observe silent-log + soft stderr) AND
// quiet-on-good, plus the archetype-not-flagged over-fire regression.
//
// HOME-isolated per tests/v3/hooks/test-panel-guard-home-isolation.mjs: HOME +
// USERPROFILE are pointed at a mkdtemp dir BEFORE importing the hook, since the
// roster/log paths resolve via prismHome() at call time and the roster is cached
// on first read. All cases share ONE HOME + ONE seeded roster and measure event
// deltas — so the module-level roster cache is consistent across cases.
import {mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-panel-guard.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-prov-'));
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
const prevProv = process.env.PRISM_PANEL_PROVENANCE, prevGuard = process.env.PRISM_PANEL_GUARD;

const LOG = join(HOME, '.claude', '.prism-routing.jsonl');
const TASK_DIR = join(HOME, '.claude', '.prism-task-t1sha');
const PANEL = join(TASK_DIR, 'panel.json');

function seedRoster() {
  const dir = join(HOME, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({
    agents: {'greek-ecommerce-conversion-specialist': {core_domains: ['greek-ecommerce'], status: 'available'}},
  }));
}
function writePanel(panel) {
  mkdirSync(TASK_DIR, {recursive: true});
  writeFileSync(PANEL, JSON.stringify(panel));
}
function provEvents() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'panel_provenance_adhoc_seat');
}
// RB-07: read back the annotation-only dropped_positions[] that Path B
// (classifyDropReason) writes onto the panel.json itself.
function droppedFromPanel() {
  try { return JSON.parse(readFileSync(PANEL, 'utf-8')).dropped_positions || []; }
  catch { return []; }
}
// Capture direct process.stderr.write (detectAdHocSeats writes there, not the
// returned .stderr) around a single call.
function withStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = '';
  process.stderr.write = (s) => { buf += String(s); return true; };
  try { const r = fn(); return {res: r, stderr: buf}; }
  finally { process.stderr.write = orig; }
}

// NOTE (deviation from panelfix-design.md T1 fixture): the spec's literal
// fire-on-bad seat was {expert_name:"Security skeptic", ...}. But "Security" and
// "Skeptic" are BOTH bare archetype tokens with no vertical-signal word, so the
// D054 round-2 classifier (seatRequiresProvenance) treats that seat as a
// legitimate cross-cutting archetype — which by Fix 3's OWN taxonomy (archetype
// seats stay unflagged) must NOT fire. Firing on it would be the over-fire bug
// the archetype-stays-quiet cases guard. The real ad-hoc defect is a
// DOMAIN/vertical seat filled generically, so the fixture uses a title carrying
// a vertical-signal word (`expert`) dispatched as general-purpose with a
// non-resolving specialist. See panelfix-result2.md.
const BAD_SEAT = {expert_name: 'Payment fraud detection expert', agent_type: 'general-purpose', specialist: 'fraud voice (ad-hoc)'};

try {
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  delete process.env.PRISM_PANEL_GUARD; // default soft for the good/soft cases' stderr path
  seedRoster();
  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.runPostToolUse === 'function', 'panel-guard must export runPostToolUse');

  await test('fire-on-bad (observe): one adhoc-seat event, action=log, exit 0, ZERO stderr', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'observe';
    writePanel({task_id: 't1', positions: [{...BAD_SEAT, challenges: [{text: 'x'}]}]});
    const before = provEvents().length;
    const {res, stderr} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, `observe must exit 0, got ${res.exit}`);
    assert(after.length - before === 1, `expected exactly 1 new adhoc-seat event, got ${after.length - before}`);
    assert(after[after.length - 1].action === 'log', `observe action must be "log", got ${after[after.length - 1].action}`);
    assert(stderr === '', `observe must be silent on stderr, got: ${stderr}`);
  });

  await test('fire-on-bad (soft): event logged AND stderr carries PANEL-PROVENANCE', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'soft';
    writePanel({task_id: 't1', positions: [{...BAD_SEAT, challenges: [{text: 'x'}]}]});
    const before = provEvents().length;
    const {res, stderr} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, `soft must exit 0 (advisory), got ${res.exit}`);
    assert(after.length - before === 1, `soft should log 1 event, got ${after.length - before}`);
    assert(after[after.length - 1].action === 'nudge', `soft action must be "nudge"`);
    assert(/PANEL-PROVENANCE/.test(stderr), `soft must advise on stderr, got: ${stderr}`);
  });

  await test('quiet-on-good (soft): rostered vertical seat + archetype → ZERO events, ZERO stderr', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'soft';
    writePanel({task_id: 't1', positions: [
      {expert_name: 'Greek conversion', vertical: true, agent_type: 'greek-ecommerce-conversion-specialist', seat_source: 'rostered', specialist: '@greek-ecommerce-conversion-specialist', dispatched_agent_id: 'a1', challenges: [{text: 'x'}]},
      {expert_name: 'Architect', challenges: [{text: 'y'}]},
    ]});
    const before = provEvents().length;
    const {res, stderr} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, 'good panel must exit 0');
    assert(after.length - before === 0, `good panel must produce ZERO adhoc events, got ${after.length - before}`);
    assert(stderr === '', `good panel must be silent on stderr, got: ${stderr}`);
  });

  await test('archetype-not-flagged (observe over-fire regression): lone untagged Skeptic → ZERO events', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'observe';
    writePanel({task_id: 't1', positions: [{expert_name: 'Skeptic', challenges: [{text: 'z'}]}]});
    const before = provEvents().length;
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, 'archetype panel exits 0');
    assert(after.length - before === 0, `a whitelisted archetype (Skeptic) must NOT be flagged, got ${after.length - before} events`);
  });

  // ── D054 round-2 boundary regression: the no-author validator's ESCAPE
  // fixtures. The old part-wise ARCHETYPE_WHITELIST containment let these
  // domain seats dodge the gate whenever their title carried ANY whitelist
  // token (`domain`, `data`, `cost`, `security`, …). The vertical-signal rule
  // (seatRequiresProvenance) forces VERTICAL on any `expert`/`specialist`/… —
  // so every one of these general-purpose, unresolved seats MUST now fire.
  const ESCAPES_NOW_FIRE = [
    'Security architecture domain expert',
    'Greek e-commerce domain expert',
    'Kubernetes cost optimization expert',
    'Data pipeline migration expert',
    'Payment fraud detection expert',
  ];
  for (const title of ESCAPES_NOW_FIRE) {
    await test(`escape-now-fires (observe): "${title}" general-purpose, unresolved → FLAG`, async () => {
      process.env.PRISM_PANEL_PROVENANCE = 'observe';
      writePanel({task_id: 't1', positions: [{expert_name: title, agent_type: 'general-purpose', specialist: `${title} (ad-hoc)`, challenges: [{text: 'x'}]}]});
      const before = provEvents().length;
      const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
      const after = provEvents();
      assert(res.exit === 0, 'observe exits 0');
      assert(after.length - before >= 1, `under-fire escape "${title}" must now FLAG, got ${after.length - before} events`);
    });
  }

  // ── D054 round-2: bare cross-cutting archetypes stay quiet (no over-fire).
  // Includes Red-team (the validator's over-fire) and Devil's advocate — both
  // now in ARCHETYPE_WORDS. "Security skeptic" is two archetype tokens, no
  // vertical signal → exempt.
  const ARCHETYPES_STAY_QUIET = [
    'Skeptic', 'Security skeptic', 'Architect', 'Red-team', "Devil's advocate",
  ];
  for (const title of ARCHETYPES_STAY_QUIET) {
    await test(`archetype-stays-quiet (observe): "${title}" general-purpose → ZERO events`, async () => {
      process.env.PRISM_PANEL_PROVENANCE = 'observe';
      writePanel({task_id: 't1', positions: [{expert_name: title, agent_type: 'general-purpose', challenges: [{text: 'x'}]}]});
      const before = provEvents().length;
      const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
      const after = provEvents();
      assert(res.exit === 0, 'observe exits 0');
      assert(after.length - before === 0, `bare archetype "${title}" must stay quiet, got ${after.length - before} events`);
    });
  }

  // ── D054 round-2: a properly-sourced vertical seat stays quiet even with a
  // vertical-signal title — provenance (real agent_type + factory/rostered
  // source) is what clears it, not the title.
  await test('sourced-vertical-quiet (observe): factory-created expert seat → ZERO events', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'observe';
    writePanel({task_id: 't1', positions: [
      {expert_name: 'Payment fraud detection expert', vertical: true, agent_type: 'payment-fraud-specialist', seat_source: 'factory-created', specialist: '@payment-fraud-specialist', dispatched_agent_id: 'a2', challenges: [{text: 'x'}]},
    ]});
    const before = provEvents().length;
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, 'observe exits 0');
    assert(after.length - before === 0, `factory-created vertical seat must stay quiet, got ${after.length - before} events`);
  });

  // ── F3 regression (RB-06 panelSeatSourcingBlock step 4 addition): a title
  // combining a concrete domain noun with an archetype suffix (e.g.
  // "Concurrency & Crash-Recovery") is VERTICAL — the provenance gate infers
  // vertical on these via seatRequiresProvenance REGARDLESS of the seat's
  // own vertical:false tag. Locks the CURRENT correct gate behavior: leaving
  // vertical:false on such a title produces a logged mismatch (this event),
  // never a silent exemption.
  await test('F3 domain+archetype title infers vertical despite vertical:false (no seat_source)', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'observe';
    writePanel({task_id: 't1', positions: [
      {title: 'Concurrency & Crash-Recovery', agent_type: 'general-purpose', vertical: false, challenges: [{text: 'x'}]},
    ]});
    const before = provEvents().length;
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    const after = provEvents();
    assert(res.exit === 0, 'observe exits 0');
    assert(after.length - before === 1, `expected exactly 1 panel_provenance_adhoc_seat event, got ${after.length - before}`);
    const ev = after[after.length - 1];
    assert(ev.inferred_vertical === true, `expected inferred_vertical:true, got ${JSON.stringify(ev.inferred_vertical)}`);
  });

  // ── RB-07: classifyDropReason (Path B, dropped_positions[] annotation) must
  // NOT drop bare cross-cutting archetype seats (Security/Skeptic/...) as
  // specialist_unknown merely because they carry no `specialist` key. The
  // panel-summoning protocol (prism-prompt-tier-router.mjs
  // panelSeatSourcingBlock step 4) explicitly instructs archetype seats to
  // "stay untagged" (no specialist, no seat_source) — so requiring a
  // specialist on EVERY position was the bug. Fix reuses seatRequiresProvenance,
  // the SAME archetype-vs-domain judge already used by checkFactoryFirst/
  // detectAdHocSeats in this file — no new whitelist.
  await test('RB-07 archetype-not-dropped: bare "Security" seat, no specialist, 1 challenge → kept', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'off'; // isolate from provenance-gate noise
    writePanel({task_id: 't1', positions: [
      {title: 'Security', challenges: [{text: 'x'}]},
    ]});
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    assert(res.exit === 0, 'must exit 0');
    const drops = droppedFromPanel();
    assert(drops.length === 0, `bare archetype "Security" must NOT be dropped, got ${JSON.stringify(drops)}`);
  });

  await test('RB-07 vertical-generic-still-dropped: vertical:true seat, no specialist → still specialist_unknown', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'off';
    writePanel({task_id: 't1', positions: [
      {title: 'Typed-API Advocate', vertical: true, challenges: [{text: 'x'}]},
    ]});
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    assert(res.exit === 0, 'must exit 0');
    const drops = droppedFromPanel();
    assert(drops.length === 1 && drops[0].reason === 'specialist_unknown',
      `vertical:true seat with no specialist must still be dropped as specialist_unknown, got ${JSON.stringify(drops)}`);
  });

  await test('RB-07 zero-challenge-still-dropped: seat with zero challenges → still insufficient_challenges', async () => {
    process.env.PRISM_PANEL_PROVENANCE = 'off';
    writePanel({task_id: 't1', positions: [
      {title: 'Security', challenges: []},
    ]});
    const {res} = withStderr(() => mod.runPostToolUse({tool_name: 'Write', tool_input: {file_path: PANEL}}));
    assert(res.exit === 0, 'must exit 0');
    const drops = droppedFromPanel();
    assert(drops.length === 1 && drops[0].reason === 'insufficient_challenges',
      `zero-challenge seat must still be dropped as insufficient_challenges, got ${JSON.stringify(drops)}`);
  });
} finally {
  if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
  if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  if (prevProv === undefined) delete process.env.PRISM_PANEL_PROVENANCE; else process.env.PRISM_PANEL_PROVENANCE = prevProv;
  if (prevGuard === undefined) delete process.env.PRISM_PANEL_GUARD; else process.env.PRISM_PANEL_GUARD = prevGuard;
  rmSync(HOME, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
