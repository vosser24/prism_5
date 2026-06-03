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

// 3. REGRESSION GUARD: a genuine novel-architecture prompt that ALSO mentions
//    release must STILL summon a panel — via the signal path, not the screen.
{
  const r = await classify('redesign the system architecture and then ship the release');
  check('design+release prompt → opus tier', r.tier === 'opus');
  check('design+release prompt → summon_panel TRUE (signal path still summons)', r.summon_panel === true);
}

// 4. Anti-haiku safety: a bare release action is never downgraded to haiku.
{
  const r = await classify("let's release v5.0.0");
  check('release action → not haiku (opus)', r.tier === 'opus');
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
