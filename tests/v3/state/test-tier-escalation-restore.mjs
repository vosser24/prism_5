#!/usr/bin/env node
// tests/v3/state/test-tier-escalation-restore.mjs
//
// D038 — TIER escalation restored for genuinely-complex prompts, DECOUPLED
// from panel firing.
//
// Root cause: D034 (locked, 2026-06-25) made the expert PANEL explicit-only.
// As a side effect it removed the ONLY path that escalated the TIER (model
// routing) to opus for complex architecture prompts — they used to reach opus
// via summon_panel=true → `if (summon_panel) tier='opus'`. With the panel now
// explicit-only, complex-but-not-explicitly-panel prompts silently routed to
// sonnet/haiku (sonnet over-selection on complex work).
//
// D038 restores the TIER escalation ONLY: TIER_ESCALATION_SIGNALS bump `tier`
// to opus while `summon_panel` STAYS false (panel remains explicit-only — D034
// preserved). This suite asserts:
//   (a) genuinely-complex prompts → tier==='opus' AND summon_panel===false
//   (b) OVER-ESCALATION GUARD: simple/routine prompts stay haiku/sonnet
//   (c) explicit panel requests → summon_panel===true (explicit path intact)
//   (d) D034 preserved: implicit signals never auto-fire the panel by default
//
// Run: node tests/v3/state/test-tier-escalation-restore.mjs

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'tools', 'lib', 'prism-tier-classify.mjs');
const {classifyWithScore} = await import(pathToFileURL(LIB).href);

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  PASS ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}
const cls = (p) => classifyWithScore(p, '');

// ── (a) Genuinely-complex prompts → opus AND summon_panel=false ──────────────
// Escalation restored (opus routing) WITHOUT auto-firing the panel (D034).
const COMPLEX = [
  'redesign the backend architecture',
  'plan a novel greenfield real-time system',
  'migrate our data model across services',
  're-architect the platform to be multi-tenant',
  'design a new payment platform from scratch',
  'plan a multi-phase migration of our monolith',
  'redesign our frontend stack',
  'should we adopt event sourcing or CQRS for the ledger, weigh the tradeoffs',
  'design a multi-region rate limiter with per-tenant fairness and phased migration',
];
process.stdout.write('── (a) complex prompts → opus + no auto-panel ──\n');
for (const p of COMPLEX) {
  const r = cls(p);
  check(`(a) "${p}" → tier=opus (got ${r.tier_by_score})`, r.tier_by_score === 'opus');
  check(`(a) "${p}" → summon_panel=false (D034 preserved) (got ${r.summon_panel})`, r.summon_panel === false);
}

// ── (b) OVER-ESCALATION GUARD: simple/routine prompts must NOT go opus ───────
// This is the cost-safety assertion — over-correcting = opus cost blowup.
const SIMPLE = [
  'fix this typo',
  'rename a variable',
  'review this small function',
  "what's the flexbox syntax",
  'what does SIGTERM mean',
  'list all files in the repo',
  'add a comment to line 5',
  'update the readme',
  'add a test for the parser',
  'add a field to the Purchase model',
  'add a column to the users table',
  'fix the flexbox alignment in Header.tsx',
  'parse the JWT token from the header',
  'migrate this React component to hooks',
  'what time is it',
  'rename the ledger folder',
];
process.stdout.write('── (b) over-escalation guard: simple prompts stay cheap ──\n');
for (const p of SIMPLE) {
  const r = cls(p);
  check(`(b) "${p}" → NOT opus (got ${r.tier_by_score})`, r.tier_by_score !== 'opus');
}

// ── (c) EXPLICIT panel requests → summon_panel=true (explicit path intact) ───
process.stdout.write('── (c) explicit panel requests still fire ──\n');
for (const p of ['run the panel', '/panel', '!panel', 'summon the expert panel', 'convene an adversarial panel']) {
  const r = cls(p);
  check(`(c) "${p}" → summon_panel=true (got ${r.summon_panel})`, r.summon_panel === true);
}

// ── (d) D034 preserved: implicit complex signals do NOT auto-fire the panel ──
// Every complex prompt in (a) escalates tier but must leave the panel closed.
process.stdout.write('── (d) D034 preserved: complexEscalation flag set, panel stays closed ──\n');
for (const p of COMPLEX) {
  const r = cls(p);
  // At least one of: score-path opus, stakes, or complexEscalation drove opus;
  // and crucially the panel must be closed.
  check(`(d) "${p}" → panel closed while opus`, r.summon_panel === false && r.tier_by_score === 'opus');
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
