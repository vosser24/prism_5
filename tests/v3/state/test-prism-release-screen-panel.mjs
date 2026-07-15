#!/usr/bin/env node
// Tests for the release-safety screen's summon_panel decoupling (v5.0.x routing fix).
// Run: node tests/v3/state/test-prism-release-screen-panel.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// classifyPrompt is ASYNC — this harness uses top-level await so every assertion
// completes BEFORE the final count prints (avoids the async-blind-runner trap,
// [[feedback-async-blind-test-harness]]).
//
// Contract under test: the release/meta-work safety screen must still promote
// release-sensitive prompts to OPUS tier (never ship from haiku), but it must NOT
// force summon_panel=true on its own. A design panel is summoned only when the
// genuine novel-architecture SIGNAL path (PANEL_SIGNALS / stakes / ≥3 opus signals)
// fires — so a readiness QUESTION or a plain ship ACTION gets the strong model
// without a forced design-panel detour.

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { classifyPrompt } from '../../../hooks/lib/prism-opus-classifier.mjs';
import { PANEL_MIN_WORDS } from '../../../tools/lib/prism-tier-classify.mjs';

// D025 helper: pad a prompt to clear PANEL_MIN_WORDS.
function padToMinWords(prompt) {
  let p = prompt; let n = 0;
  while (p.trim().split(/\s+/).length < PANEL_MIN_WORDS) p += ` filler${n++}`;
  return p;
}

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-relscreen-')), 'cache.json');
const classify = (prompt) => classifyPrompt({ prompt, skipCache: true, cachePath });

// 1. The exact incident: a ship-readiness QUESTION must NOT summon a panel,
//    but must still be opus (release-sensitive → never haiku).
{
  const r = await classify('so we are ready to ship v5 or we are missing something?');
  check('readiness question → opus tier (anti-haiku safety preserved)', r.tier === 'opus');
  check('readiness question → summon_panel FALSE (no forced design panel)', r.summon_panel === false);
}

// 2. A plain ship/release ACTION with no novel-design signals: opus, no panel.
{
  const r = await classify('ship v5 to origin now');
  check('plain ship action → opus tier', r.tier === 'opus');
  check('plain ship action → summon_panel FALSE', r.summon_panel === false);
}

// 3. REGRESSION GUARD: a genuine long novel-architecture prompt that ALSO mentions
//    release still routes to opus tier.
//    D034 Amendment (2026-06-25): panel no longer auto-fires on implicit signals
//    (PANEL_SIGNALS, redesign, phased migration). The tier stays opus (signals still
//    score correctly via OPUS_SIGNALS + stakes). Only an EXPLICIT panel request fires
//    summon_panel. We verify both behaviors.
//    D025 Fix 2a: padToMinWords() guarantees ≥50 words.
{
  const r = await classify(padToMinWords(
    'we need to redesign the entire system architecture from scratch with tradeoffs ' +
    'and phased migration strategy and then ship the release'
  ));
  check('design+release prompt → opus tier', r.tier === 'opus');
  // D034: implicit PANEL_SIGNALS no longer auto-fires panel.
  check('design+release prompt → summon_panel FALSE (D034: explicit-only)', r.summon_panel === false);
}
// Explicit panel request within the same context still fires.
{
  const r = await classify('run the expert panel on our system architecture redesign and release planning');
  check('explicit panel request in design+release context → summon_panel=true', r.summon_panel === true);
}

// 4. Anti-haiku safety: a bare release action is never downgraded to haiku.
{
  const r = await classify("let's release v5.0.0");
  check('release action → not haiku (opus)', r.tier === 'opus');
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
