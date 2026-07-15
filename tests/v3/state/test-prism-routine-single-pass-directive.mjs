#!/usr/bin/env node
// tests/v3/state/test-prism-routine-single-pass-directive.mjs
//
// TDD — single-pass directive slice.
// Asserts that formatAdvice() emits a "ROUTINE single-pass" directive when
// routine_bypass is in effect (haiku/sonnet, no force_opus, no panel), and
// does NOT emit it on opus/panel/force_opus turns.
//
// Run: node tests/v3/state/test-prism-routine-single-pass-directive.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const ROUTER_PATH = join(repoRoot, 'hooks', 'prism-prompt-tier-router.mjs');

const { formatAdvice } = await import(pathToFileURL(ROUTER_PATH).href);

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// ── 1. haiku tier (routine_bypass=true) — single-pass directive present ───────
{
  const advice = formatAdvice('haiku', 'trivial lookup', 'hard', false, 'keyword-floor', 'test-sess', null);
  check('haiku: contains "ROUTINE single-pass"',     advice.includes('ROUTINE single-pass'));
  check('haiku: contains "dispatch at most ONCE"',   advice.includes('dispatch at most ONCE'));
  // existing mechanics: must still contain haiku dispatch instruction
  check('haiku: still contains haiku Agent dispatch', advice.includes("model:'haiku'"));
}

// ── 2. sonnet tier (routine_bypass=true) — single-pass directive present ──────
{
  const advice = formatAdvice('sonnet', 'standard review', 'hard', false, 'keyword-floor', 'test-sess', null);
  check('sonnet: contains "ROUTINE single-pass"',    advice.includes('ROUTINE single-pass'));
  check('sonnet: contains "dispatch at most ONCE"',  advice.includes('dispatch at most ONCE'));
  // existing mechanics: must still contain sonnet dispatch instruction
  check('sonnet: still contains sonnet Agent dispatch', advice.includes("model:'sonnet'"));
  // old orchestrate/plan/review text must be GONE from routine tier
  check('sonnet: does NOT say "orchestrate, plan, review"',
    !advice.includes('orchestrate, plan, review'));
}

// ── 3. opus tier without panel — NO single-pass directive ─────────────────────
{
  const advice = formatAdvice('opus', 'deep design work', 'hard', false, 'keyword-floor', 'test-sess', null);
  check('opus (no panel): does NOT contain "ROUTINE single-pass"',
    !advice.includes('ROUTINE single-pass'));
}

// ── 4. opus + summon_panel — NO single-pass directive ────────────────────────
{
  const advice = formatAdvice('opus', 'novel architecture', 'hard', true, 'keyword-floor', 'test-sess', null);
  check('opus+panel: does NOT contain "ROUTINE single-pass"',
    !advice.includes('ROUTINE single-pass'));
}

// ── 5. opus + panel + activeMaster (self-chair) — NO single-pass directive ───
{
  const advice = formatAdvice('opus', 'novel architecture', 'hard', true, 'keyword-floor', 'test-sess', 'master-prism-3');
  check('opus+panel+activeMaster: does NOT contain "ROUTINE single-pass"',
    !advice.includes('ROUTINE single-pass'));
}

// ── 6. force_opus turns: routine_bypass is false — no single-pass directive ──
// force_opus turns use tier='opus'; formatAdvice is called with opus tier.
// Confirm the directive is absent (force_opus bypasses the routine branches).
{
  const advice = formatAdvice('opus', 'forced opus work', 'hard', false, 'force-opus', 'test-sess', null);
  check('force_opus (opus tier, source=force-opus): no single-pass directive',
    !advice.includes('ROUTINE single-pass'));
}

// ── 7. Soft mode haiku — directive still present ──────────────────────────────
{
  const advice = formatAdvice('haiku', 'trivial', 'soft', false, 'keyword-floor', 'test-sess', null);
  check('haiku soft mode: still has single-pass directive', advice.includes('ROUTINE single-pass'));
}

// ── 8. Soft mode sonnet — directive still present ────────────────────────────
{
  const advice = formatAdvice('sonnet', 'standard', 'soft', false, 'keyword-floor', 'test-sess', null);
  check('sonnet soft mode: still has single-pass directive', advice.includes('ROUTINE single-pass'));
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
