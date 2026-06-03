#!/usr/bin/env node
// §6.A torture-battery routing-chaos findings (v5.0 stress-test, round 2).
// Three confirmed classifier defects, all on the routing path used by
// hooks/prism-prompt-tier-router.mjs → classifyPrompt():
//
//   A1 ADJECTIVE-GAP — PANEL_SIGNALS / OPUS_SIGNAL #9 require the head noun
//      (system/pipeline/...) to follow new|entire|the IMMEDIATELY. A natural
//      adjective ("multi-tenant", "event-driven") between them defeats the
//      regex, so a textbook architecture request MISSES the design panel.
//      (Same failure class as FIX-D's dead-sonnet bug — an intervening word.)
//
//   A2 PANEL/TIER DECOUPLING — detectSummonPanel could return true while the
//      score-tier stayed haiku/sonnet. The router only honors the panel when
//      tier==='opus', so the flag was silently dropped AND the work routed to
//      a cheap tier. A panel-worthy prompt → haiku dispatch. Panel must imply
//      opus (as `stakes` already does).
//
//   A3 "shipping" SUBSTRING OVER-FIRE — the release-safety screen's ship(ping)?
//      alternative had no context anchor, so common e-commerce domain phrases
//      ("shipping address", "shipping cost", "shipping options") were promoted
//      to opus. Must carve out domain nouns WITHOUT regressing real release
//      detection (ship v5 / ship the release / ready to ship / release vX).
//
// classifyPrompt is ASYNC — top-level await so every assertion completes before
// the count prints ([[feedback-async-blind-test-harness]]).
// Verdict tokens are checked case-sensitively ([[feedback-drift-guard-tdd-red-verification]]).

import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-opus-classifier.mjs');
const { classifyPrompt } = await import(pathToFileURL(LIB).href);

let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-routchaos-')), 'cache.json');
const c = (prompt) => classifyPrompt({ prompt, skipCache: true, cachePath });

// ── A1: adjective-gap — architecture phrasing with a qualifier still summons ──
{
  const r = await c('architect a new multi-tenant system');
  check('A1 "architect a new multi-tenant system" → opus', r.tier === 'opus');
  check('A1 "architect a new multi-tenant system" → panel', r.summon_panel === true);
}
{
  const r = await c('design the entire event-driven pipeline for order processing');
  check('A1 "design the entire event-driven pipeline" → opus', r.tier === 'opus');
  check('A1 "design the entire event-driven pipeline" → panel', r.summon_panel === true);
}
// Guard: the no-adjective form already worked — must stay working.
{
  const r = await c('architect a new system');
  check('A1 guard "architect a new system" still → opus+panel', r.tier === 'opus' && r.summon_panel === true);
}

// ── A2: panel implies opus — never a panel flag on a sub-opus tier ──
{
  const r = await c('plan a multi-phase migration of the monolith to microservices');
  check('A2 multi-phase migration → opus (not haiku/sonnet)', r.tier === 'opus');
  check('A2 multi-phase migration → panel', r.summon_panel === true);
}
{
  // Invariant across a small battery: summon_panel===true ⇒ tier==='opus'.
  const battery = [
    'a multi-phase rollout plan',
    'design the entire pipeline',
    'architect a new multi-tenant system',
    'plan a multi-phase migration of the monolith to microservices',
    're-architect the backend stack to support horizontal scaling',
  ];
  let coherent = true;
  for (const p of battery) {
    const r = await c(p);
    if (r.summon_panel === true && r.tier !== 'opus') { coherent = false; console.log(`   incoherent: panel=true tier=${r.tier} :: ${p}`); }
  }
  check('A2 invariant: panel=true ⇒ tier=opus (no incoherent states)', coherent);
}

// ── A3: "shipping" domain nouns must NOT over-fire to opus ──
for (const p of [
  'the shipping address field shows a spinner, fix it',
  'add a shipping cost calculator to checkout',
  'show shipping options on the cart page',
]) {
  const r = await c(p);
  check(`A3 domain "${p.slice(0, 32)}…" → NOT opus`, r.tier !== 'opus');
}
// ── A3 REGRESSION GUARD: real release phrasing must STILL be opus ──
for (const p of [
  'ship v5 to origin now',
  'are we ready to ship v5?',
  "let's release v5.0.0",
  'redesign the system architecture and then ship the release',
  'ready to ship?',
]) {
  const r = await c(p);
  check(`A3 guard "${p.slice(0, 32)}…" stays opus`, r.tier === 'opus');
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
