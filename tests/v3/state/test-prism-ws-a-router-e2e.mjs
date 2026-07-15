#!/usr/bin/env node
// Workstream A — CLI-driven E2E. Distinct from the mechanical unit test:
// spawns the REAL router hook with a UserPromptSubmit payload on stdin and
// asserts the on-disk sentinel (~/.claude/.prism-turn-tier-<sid>.json) was
// written with the corrected tier / summon_panel. fakeHome isolates writes.
//
// Run: node tests/v3/state/test-prism-ws-a-router-e2e.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const HOOK = join(REPO, 'hooks', 'prism-prompt-tier-router.mjs');

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// Run the router with an isolated HOME so sentinel/log/cache writes don't collide.
function route(sessionId, prompt) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'prism-wsa-'));
  const payload = JSON.stringify({ session_id: sessionId, prompt, cwd: REPO });
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, PRISM_PROMPT_ROUTER: 'hard' },
  });
  const sentinelPath = join(fakeHome, '.claude', `.prism-turn-tier-${sessionId}.json`);
  let sentinel = null;
  if (existsSync(sentinelPath)) sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'));
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  return { exit: r.status, stdout: r.stdout || '', sentinel };
}

// CLF-010 — multi-region rate limiter → opus + summon_panel on disk
{
  const r = route('wsa-e2e-010', 'design a multi-region rate limiter with per-tenant fairness and phased migration');
  check('CLF-010 exit 0',                 r.exit === 0);
  check('CLF-010 sentinel written',       !!r.sentinel);
  check('CLF-010 sentinel tier=opus',     r.sentinel && r.sentinel.tier === 'opus');
  // D025 Fix 2a: this prompt is 13 words (< PANEL_MIN_WORDS=50) so implicit
  // panel signals are floored to false. Tier remains opus; panel not summoned
  // for short architectural prompts — model routes opus and works directly.
  check('CLF-010 sentinel summon_panel=false (D025: short implicit floor)',
    r.sentinel && r.sentinel.summon_panel === false);
  check('CLF-010 stdout mentions opus',   /opus/i.test(r.stdout));
}

// CLF-011 — expense tracker (full-stack) → NOT haiku on disk
{
  const r = route('wsa-e2e-011', 'plan an expense tracker with Node backend + React frontend');
  check('CLF-011 exit 0',                 r.exit === 0);
  check('CLF-011 sentinel tier != haiku', r.sentinel && r.sentinel.tier !== 'haiku');
}

// CLF-012 — secure auth (A2 floor) → NOT haiku on disk
{
  const r = route('wsa-e2e-012', 'implement secure user authentication with password hashing and JWT');
  check('CLF-012 exit 0',                 r.exit === 0);
  check('CLF-012 sentinel tier != haiku', r.sentinel && r.sentinel.tier !== 'haiku');
}

// CLF-013 — over-trigger guard: trivial question stays haiku on disk
{
  const r = route('wsa-e2e-013', 'what does SIGTERM mean');
  check('CLF-013 exit 0',                 r.exit === 0);
  check('CLF-013 sentinel tier=haiku',    r.sentinel && r.sentinel.tier === 'haiku');
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
