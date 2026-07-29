#!/usr/bin/env node
// T2 — Fix 1: the router force-injects the seat-sourcing discipline + a
// deterministic roster fit-line on a panel-summoning turn, and injects NEITHER
// onto a routine (non-panel) turn. Drives run() end-to-end.
//
// HOME + USERPROFILE are set to a mkdtemp dir BEFORE importing the router,
// because (a) the router captures H at module load for its sentinel/log paths,
// and (b) it imports prism-specialist-routing-guard, whose loadRoster reads the
// installed roster via an H captured at that guard's module load. cwd is a
// separate temp dir with no .claude/settings.json so detectActiveMaster()
// returns null (wrapper-dispatch branch) and gitSnapshot stays empty.
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-prompt-tier-router.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const HOME = mkdtempSync(join(tmpdir(), 'prism-t2-home-'));
const CWD = mkdtempSync(join(tmpdir(), 'prism-t2-cwd-'));
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
const prevRouter = process.env.PRISM_PROMPT_ROUTER, prevConv = process.env.PRISM_CONVERSATION_MODE;

function seedRoster() {
  const dir = join(HOME, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'roster.json'), JSON.stringify({
    agents: {'greek-ecommerce-conversion-specialist': {core_domains: ['greek-ecommerce'], status: 'available'}},
  }));
}
async function ctxFor(mod, prompt, session_id) {
  const res = await mod.run({prompt, session_id, cwd: CWD});
  try { return JSON.parse(res.stdout || '{}').hookSpecificOutput?.additionalContext || ''; }
  catch { return ''; }
}

try {
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  process.env.PRISM_PROMPT_ROUTER = 'hard';
  delete process.env.PRISM_CONVERSATION_MODE;
  seedRoster();
  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.run === 'function', 'router must export run');

  await test('present-on-panel-turn: block + fit-line naming the seeded agent', async () => {
    const ctx = await ctxFor(mod, 'run the panel on the greek-ecommerce checkout conversion redesign', 's-panel');
    assert(/@agent-factory/.test(ctx), 'must inject the @agent-factory gap-fill instruction');
    assert(/"vertical":true/.test(ctx), 'must inject the vertical:true tagging instruction');
    assert(/NEVER a valid fill/.test(ctx), 'must inject the ad-hoc-persona prohibition');
    assert(/Rostered specialists that fit/.test(ctx), 'must inject the deterministic fit-line');
    assert(/greek-ecommerce-conversion-specialist/.test(ctx), 'fit-line must NAME the seeded roster agent');
    // RB-07 Fix 2: seat_source is documented ONLY as "rostered"|"factory-created"
    // (skills/master-orchestrator/references/phase-0d-adversarial.md line 126)
    // — a real panel.json was seen emitting invented "archetype"/"generic"
    // labels the guard doesn't recognize. Since those are NOT canonical, the
    // fix is the writer-side schema explicitly enumerating the allowed set
    // and forbidding invention, not teaching the guard to accept them.
    assert(/ONLY these two values/.test(ctx), 'must explicitly enumerate the canonical seat_source vocabulary');
    assert(/never invent others like "archetype" or "generic"/.test(ctx), 'must explicitly forbid the observed invented seat_source labels');
    assert(/omit seat_source entirely, do not set it to "archetype"/.test(ctx), 'must clarify that untagged means OMIT the field, not set it to "archetype"');
    // F1: nameless seat dispatch — a named Agent() call becomes an Agent-Teams
    // teammate whose position never returns as the tool result (D062).
    assert(/WITHOUT a "?name:"? field/.test(ctx), 'must instruct dispatching seats WITHOUT a name: field (F1/D062)');
    // F3: domain+archetype compound titles (e.g. "Concurrency & Crash-Recovery")
    // are VERTICAL — the provenance gate infers vertical on these regardless of
    // the tag, so leaving vertical:false only produces a logged mismatch.
    assert(/domain noun with an archetype suffix[\s\S]*is VERTICAL/.test(ctx), 'must inject the domain+archetype "is VERTICAL" guidance (F3)');
    assert(/Concurrency & Crash-Recovery/.test(ctx), 'must inject the concrete F3 example title');
    // F4: <task-id> must be freshly generated per panel — never reused from an
    // earlier or declined panel in the same session.
    assert(/freshly generated for THIS panel/.test(ctx), 'must inject the fresh-task-id guidance (F4)');
    assert(/never reuse an id minted for an earlier or declined panel/.test(ctx), 'must inject the no-reuse rationale for the fresh-task-id guidance (F4)');
  });

  await test('quiet-on-non-panel: routine turn injects NEITHER block NOR fit-list', async () => {
    const ctx = await ctxFor(mod, 'count the words in the readme file', 's-routine');
    assert(!/READ the roster/.test(ctx), 'routine turn must NOT carry the seat-sourcing block');
    assert(!/Rostered specialists that fit/.test(ctx), 'routine turn must NOT carry a fit-list');
    assert(!/@agent-factory/.test(ctx), 'routine turn must NOT mention @agent-factory seat-sourcing');
  });

  await test('no-match fit-line: panel turn with no roster match uses the no-match variant', async () => {
    const ctx = await ctxFor(mod, 'run the panel on the quarterly office party budget spreadsheet', 's-nomatch');
    assert(/No rostered specialist strongly matches/.test(ctx), 'must inject the no-match fit-line variant');
    // still a real panel turn — the seat-sourcing block is present
    assert(/READ the roster/.test(ctx), 'panel turn still injects the seat-sourcing block');
  });
} finally {
  if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
  if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  if (prevRouter === undefined) delete process.env.PRISM_PROMPT_ROUTER; else process.env.PRISM_PROMPT_ROUTER = prevRouter;
  if (prevConv === undefined) delete process.env.PRISM_CONVERSATION_MODE; else process.env.PRISM_CONVERSATION_MODE = prevConv;
  rmSync(HOME, {recursive: true, force: true});
  rmSync(CWD, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
