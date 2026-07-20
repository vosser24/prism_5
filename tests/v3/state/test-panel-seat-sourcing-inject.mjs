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
