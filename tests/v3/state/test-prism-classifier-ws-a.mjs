#!/usr/bin/env node
// Workstream A regression fixtures — classifier accuracy (F1 + F6).
// Mechanical test: calls classifyWithScore() directly. Asserts corrected
// tier / summon_panel for the three confirmed mis-routes, the A2 security
// floor, plus over-trigger guards.
//
// Run: node tests/v3/state/test-prism-classifier-ws-a.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'tools', 'lib', 'prism-tier-classify.mjs');
const { classifyWithScore, detectSecurityVerb } = await import(pathToFileURL(LIB).href);

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

const tier  = (p) => classifyWithScore(p, '').tier_by_score;
const panel = (p) => classifyWithScore(p, '').summon_panel;
const sv    = (p) => detectSecurityVerb(p, '');

// ── A1: distributed-systems / scaling → opus ─────────────────────────────────
const P_RL = 'design a multi-region rate limiter with per-tenant fairness and phased migration';
check('F1 rate-limiter → opus',         tier(P_RL) === 'opus');
// D025 Fix 2a: P_RL is 13 words (< PANEL_MIN_WORDS=50) so implicit panel signals
// are floored to false. Tier remains opus (correct); explicit panel not needed
// for a short prompt — the model routes to opus and proceeds without the overhead.
check('F1 rate-limiter → summon_panel=false (D025: short implicit floor)', panel(P_RL) === false);

// ── A1: full-stack expense tracker → at least sonnet ─────────────────────────
const P_ET = 'plan an expense tracker with Node backend + React frontend';
check('F6 expense tracker → sonnet+',   ['sonnet', 'opus'].includes(tier(P_ET)));
check('F6 expense tracker not haiku',   tier(P_ET) !== 'haiku');

check('multi-region microservices → opus',
  tier('architect a multi-region microservices deployment for 50k tenants') === 'opus');
check('phased migration w/ scale → opus',
  tier('design a phased migration of the monolith to microservices across 3 regions') === 'opus');

// ── A2: security-verb floor → never haiku ────────────────────────────────────
const P_AUTH = 'implement secure user authentication with password hashing and JWT';
check('F6 secure auth → sonnet+',       ['sonnet', 'opus'].includes(tier(P_AUTH)));
check('F6 secure auth not haiku',       tier(P_AUTH) !== 'haiku');
check('detectSecurityVerb: implement auth',                 sv(P_AUTH) === true);
check('detectSecurityVerb: add login + session mgmt',       sv('add login with session management and JWT refresh tokens') === true);
check('detectSecurityVerb: build oauth integration',        sv('build an OAuth2 integration with Google SSO') === true);

// ── A2 guards: passive security vocab must NOT fire ──────────────────────────
check('A2 guard: parse JWT token → securityVerb=false',     sv('parse the JWT token from the request header') === false);
check('A2 guard: "what is JWT" → securityVerb=false',       sv('what is JWT?') === false);

// ── Over-trigger guards: trivia stays haiku ──────────────────────────────────
check('guard: "what does SIGTERM mean" → haiku',            tier('what does SIGTERM mean') === 'haiku');
check('guard: "list all files in the repo" → haiku',        tier('list all files in the repo') === 'haiku');

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
