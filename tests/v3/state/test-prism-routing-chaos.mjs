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

// D025 Fix 2a: implicit panel signals are floored at PANEL_MIN_WORDS (50) words.
// Tests that exercise the panel path must use padToMinWords() to guarantee ≥50 words.
const PANEL_MIN_WORDS = 50;
function padToMinWords(prompt) {
  let p = prompt; let n = 0;
  while (p.trim().split(/\s+/).length < PANEL_MIN_WORDS) p += ` filler${n++}`;
  return p;
}

const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-routchaos-')), 'cache.json');
const c = (prompt) => classifyPrompt({ prompt, skipCache: true, cachePath });

// ── A1: adjective-gap — architecture phrasing with a qualifier routes to opus ──
// D034 Amendment (2026-06-25): explicit-only panel contract. These prompts no
// longer auto-fire summon_panel (implicit signals are OFF by default). Tier
// assertions (opus) remain intact — only the panel assertions are updated.
// D025 Fix 2a: padToMinWords() guarantees ≥50 words to clear the PANEL_MIN_WORDS floor.
{
  const r = await c(padToMinWords('architect a new multi-tenant system'));
  check('A1 "architect a new multi-tenant system" → opus', r.tier === 'opus');
  check('A1 "architect a new multi-tenant system" → summon_panel=false (D034: explicit-only)', r.summon_panel === false);
}
{
  const r = await c(padToMinWords('design the entire event-driven pipeline for order processing'));
  check('A1 "design the entire event-driven pipeline" → opus', r.tier === 'opus');
  check('A1 "design the entire event-driven pipeline" → summon_panel=false (D034: explicit-only)', r.summon_panel === false);
}
// Guard: explicit panel request still works regardless of D034
{
  const r = await c('run the expert panel on the new system architecture');
  check('A1 guard: explicit panel request still → opus+panel=true', r.tier === 'opus' && r.summon_panel === true);
}

// ── A2: panel implies opus — never a panel flag on a sub-opus tier ──
// D034 Amendment: panel no longer fires implicitly. "multi-phase migration" was
// previously routed to opus SOLELY via the panel-summon tier-bump
// (summon_panel=true ⇒ tier='opus'). Under explicit-only, this prompt routes on
// its own signals (OPUS/SONNET/HAIKU) — which score haiku for this phrasing.
// The A2 INVARIANT still holds: whenever summon_panel IS true (via explicit
// request), tier MUST be opus. We verify that below via the battery check.
// D025 Fix 2a: padToMinWords() guarantees ≥50 words.
{
  const r = await c(padToMinWords('plan a multi-phase migration of the monolith to microservices'));
  // D034: panel no longer fires; tier is now determined by raw signals (scores haiku here).
  check('A2 multi-phase migration → summon_panel=false (D034: explicit-only)', r.summon_panel === false);
  // Invariant: if panel fired it must be opus. When panel is false (as here under D034),
  // we assert the invariant rather than asserting a specific tier outcome (which is brittle
  // — it depended on this phrasing scoring sub-opus, which could change with signal tuning).
  check('A2 multi-phase migration → invariant: summon_panel=true ⇒ tier=opus',
    !(r.summon_panel === true) || r.tier === 'opus');
}
{
  // Invariant across a small battery: summon_panel===true ⇒ tier==='opus'.
  // D025 Fix 2a: all battery prompts padded to ≥50 words so they clear the floor.
  const battery = [
    'a multi-phase rollout plan',
    'design the entire pipeline',
    'architect a new multi-tenant system',
    'plan a multi-phase migration of the monolith to microservices',
    're-architect the backend stack to support horizontal scaling',
  ].map(padToMinWords);
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

// ── A4: parent-driven orchestration commands must route to opus ──────────
// These run a parent-driven state machine (the conversation model runs the
// deterministic node helpers + LLM-judged phases directly — NOT subagent
// work). If they don't route to opus, the parent-dispatch-guard blocks their
// own git/node calls. Regression guard for the v5.1 UAT finding: /prism-bootstrap
// was missing from OPUS_ORCHESTRATION_COMMANDS, so its Step-0 git guard got denied.
for (const cmd of [
  '/prism-bootstrap',
  '/prism-sync',
  '/prism-deep-dive',
  '/prism-fresh',
  '/prism-clean',
  '/prism-doctor',
  '/prism-index',
]) {
  const r = await c(cmd);
  check(`A4 orchestration "${cmd}" → opus`, r.tier === 'opus');
  // ...and the rationale must be the form the dispatch-guard's carve-out detects.
  check(`A4 orchestration "${cmd}" → guard-recognizable rationale`,
    /orchestration command \/prism-/i.test(r.rationale || ''));
}

// ── A5: META-QUESTION SCREEN — a question ABOUT the system is not a TASK on it ──
// (v5.2.4) An interrogative/explanatory prompt that name-drops architecture vocab
// must NOT force the design panel; an imperative build verb co-present keeps it real.
{
  const r = await c('i dont understand why was through master orchestrator and not master-test-prism-5. am i wrong?');
  check('A5 meta "why … am i wrong?" → NOT panel', r.summon_panel === false);
}
{
  const r = await c('is it right to get all these blocks?');
  check('A5 meta "is it right …?" → NOT panel', r.summon_panel === false);
}
{
  const r = await c('can you explain why the orchestrator role-played the panel instead of dispatching it?');
  check('A5 meta "explain why …" → NOT panel', r.summon_panel === false);
}
// Guard 1 (D034 update): a genuine novel-architecture BUILD request routes to opus
// but no longer auto-fires panel (explicit-only). The A5 meta screen still works
// (meta questions don't fire panel) and architecture work routes to opus.
// D025 Fix 2a: padToMinWords() guarantees ≥50 words to clear the panel floor.
{
  const r = await c(padToMinWords('design a new event-sourcing architecture for the ledger from scratch'));
  check('A5 guard "design … from scratch" → opus (tier correct, D034)', r.tier === 'opus');
  check('A5 guard "design … from scratch" → summon_panel=false (D034: explicit-only)', r.summon_panel === false);
}
// Guard 2 (D034 update): meta words + an imperative build verb → opus, no panel.
// D025 Fix 2a: padded to ≥50 words.
{
  const r = await c(padToMinWords('explain the current design, then re-architect the entire backend system'));
  check('A5 guard "explain …, then re-architect" → opus', r.tier === 'opus');
  check('A5 guard "explain …, then re-architect" → summon_panel=false (D034: explicit-only)', r.summon_panel === false);
}
// Explicit panel request guard: always fires regardless of meta vocabulary.
{
  const r = await c('run the expert panel on this event-sourcing architecture design');
  check('A5 explicit panel request still fires panel', r.summon_panel === true);
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
