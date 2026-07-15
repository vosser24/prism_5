#!/usr/bin/env node
// tests/v3/state/test-explicit-panel-continuation.mjs
//
// Tests the router's continuation-inherit behavior vs. explicit panel requests.
//
// The continuation-inherit path (v3.8.0) hard-codes summon_panel:false to
// prevent deadlock on approval follow-ups. But if the CURRENT prompt is an
// EXPLICIT panel request ("/panel", "run the expert panel"), the user is
// deliberately asking for the panel — summon_panel MUST be true regardless.
//
// Tests:
//   (e) Explicit /panel on a follow-up turn overrides continuation-inherit's
//       summon_panel:false → sentinel must have summon_panel===true.
//   (f) REGRESSION: explicit panel turn's additionalContext still contains
//       the orchestrator directive (the @master-orchestrator / PANEL-SUMMONING
//       branch in formatAdvice) — proving explicit path reaches full flow.
//
// These tests use formatAdvice() (pure, exported) and simulate the
// continuation-inherit sentinel to target the specific edge case.
//
// Run: node tests/v3/state/test-explicit-panel-continuation.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER_PATH = join(__dirname, '..', '..', '..', 'hooks', 'prism-prompt-tier-router.mjs');
const { formatAdvice } = await import(pathToFileURL(ROUTER_PATH).href);

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// ── (f) formatAdvice regression — explicit panel path reaches orchestrator ───
//
// When tier='opus' and summonPanel=true, formatAdvice must return advice
// containing the PANEL-SUMMONING directive (either the project-master branch
// or the @master-orchestrator branch — both contain distinguishing text).
// This confirms the explicit→orchestrator→agent-factory flow is intact.

const adviceNoMaster = formatAdvice(
  'opus',
  'novel architectural request',
  'hard',
  true,   // summonPanel=true
  'keyword-floor',
  'test-session-001',
  null,   // no activeMaster
  false,  // panelDisabled=false
);

check(
  '(f) explicit panel (no activeMaster) → advice contains PANEL-SUMMONING TURN',
  /PANEL-SUMMONING TURN/i.test(adviceNoMaster)
);
check(
  '(f) explicit panel (no activeMaster) → advice mentions @master-orchestrator',
  /master-orchestrator/i.test(adviceNoMaster)
);
check(
  '(f) explicit panel (no activeMaster) → advice mentions orchestrator dispatch',
  /spawn\s+@master-orchestrator|spawn.*master-orchestrator/i.test(adviceNoMaster)
);

const adviceWithMaster = formatAdvice(
  'opus',
  'novel architectural request',
  'hard',
  true,   // summonPanel=true
  'keyword-floor',
  'test-session-001',
  'master-prism-3',   // activeMaster present — self-chair path
  false,  // panelDisabled=false
);

check(
  '(f) explicit panel (activeMaster=master-prism-3) → advice contains PANEL-SUMMONING TURN',
  /PANEL-SUMMONING TURN/i.test(adviceWithMaster)
);
check(
  '(f) explicit panel (activeMaster) → advice mentions chair the panel',
  /chair.*panel|chair this panel/i.test(adviceWithMaster)
);
check(
  '(f) explicit panel (activeMaster) → advice does NOT say "spawn @master-orchestrator" (self-chair avoids nesting)',
  !/Spawn @master-orchestrator as your NEXT action/.test(adviceWithMaster)
);

// ── (e) continuation-inherit edge case: explicit /panel overrides summon_panel:false ─
//
// Strategy: we use the run() export from the router directly, but that does
// file I/O (sentinel + log). We exercise it in a temp session so we don't
// pollute real state. We write a prior opus sentinel first (simulating a
// previous turn), then call run() with an explicit-panel prompt in the same
// session — the continuation path would fire (prompt is short), but the
// explicit-panel override must take effect and set summon_panel=true.

const { run } = await import(pathToFileURL(ROUTER_PATH).href);

// Only run the I/O test if the router exports run (it should).
if (typeof run === 'function') {
  const sessionId = `test-cont-${randomBytes(4).toString('hex')}`;
  const H = process.env.HOME || process.env.USERPROFILE;
  const sentinelDir = join(H, '.claude');
  const sentinelFile = join(sentinelDir, `.prism-turn-tier-${sessionId}.json`);

  // Write a prior opus sentinel to simulate a recent opus turn.
  const prevSentinel = {
    tier: 'opus',
    summon_panel: false,
    force_opus: false,
    dispatched: false,
    orchestrator_dispatched: false,
    ts: new Date().toISOString(), // fresh (<5min)
    source: 'keyword-floor',
    rationale: 'prior opus turn',
    session_id: sessionId,
    mode: 'hard',
    dispatch_count: 0,
  };
  try {
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(sentinelFile, JSON.stringify(prevSentinel, null, 2));
  } catch (e) {
    process.stdout.write(`  SKIP  (e) sentinel write failed: ${e.message}\n`);
    total += 2;
  }

  // Call run() with an explicit panel prompt — short (1 word), would inherit
  // continuation otherwise.
  const result = await run({
    prompt: '/panel',
    session_id: sessionId,
    cwd: process.cwd(),
  });

  // Read the sentinel back to check what was written.
  let writtenSentinel = null;
  try {
    const { readFileSync } = await import('node:fs');
    writtenSentinel = JSON.parse(readFileSync(sentinelFile, 'utf-8'));
  } catch {}

  check(
    '(e) explicit /panel on follow-up turn → sentinel summon_panel===true (not zeroed by continuation-inherit)',
    writtenSentinel !== null && writtenSentinel.summon_panel === true
  );

  // Also verify the advice in stdout contains the panel directive.
  let outAdvice = '';
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    outAdvice = parsed?.hookSpecificOutput?.additionalContext || '';
  } catch {}
  check(
    '(e) explicit /panel follow-up → additionalContext contains PANEL-SUMMONING TURN',
    /PANEL-SUMMONING TURN/i.test(outAdvice)
  );

  // Cleanup: remove temp sentinel.
  try { unlinkSync(sentinelFile); } catch {}
} else {
  // run() not exported — skip I/O tests.
  total += 2;
  process.stdout.write('  SKIP  (e) run() not exported from router — skipping I/O tests\n');
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
