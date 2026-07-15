#!/usr/bin/env node
// UAT-3/5 classifier calibration (2026-06-02):
//   (a) explicit panel-summon requests ("summon the panel", "run the panel",
//       "PRISM this", "panel review") must set summon_panel=true — they were
//       silently ignored (the router only set it on ambient novel-architecture
//       signals). Explicit user intent is SAFE to honor (not a false positive).
//   (b) common code-structure edits ("add a field to the model", "add a column",
//       "add a method") should score SONNET, not haiku — the middle tier was
//       under-selected.
//   Negative cases guard against over-firing on benign "panel" nouns and trivia.
//
// Run: node tests/v3/state/test-prism-classifier-uat.mjs

import { classifyWithScore } from '../../../tools/lib/prism-tier-classify.mjs';

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`  FAIL ${label}`);
}
const panel = (p) => classifyWithScore(p, '').summon_panel === true;
const tierOf = (p) => classifyWithScore(p, '').tier_by_score;

// ── (a) explicit panel requests → summon_panel=true ──────────────────────────
check('summon the panel', panel('summon the panel'));
check('run the panel: review the architecture', panel('run the panel: review the sharding architecture'));
check('convene a panel', panel('convene a panel on this decision'));
check('panel review', panel('I want a panel review of this design'));
check('expert panel', panel('get an expert panel to weigh in'));
check('PRISM this', panel('PRISM this: should we migrate to Postgres?'));

// ── (a-neg) benign "panel" nouns must NOT summon ─────────────────────────────
check('admin panel (no summon)', !panel('the admin panel has a rendering bug'));
check('control panel (no summon)', !panel('fix the control panel styling'));
check('solar panel (no summon)', !panel('add a solar panel cost calculator'));
check('plain panel mention (no summon)', !panel('the settings panel is too wide'));

// ── (b) code-structure edits → sonnet (not haiku) ────────────────────────────
check('add a field to the model → sonnet', tierOf('add a field to the Purchase model') === 'sonnet');
check('add a column to a table → sonnet', tierOf('add a column to the users table') === 'sonnet');
check('add a method to the serializer → sonnet', tierOf('add a method to the serializer') === 'sonnet');

// ── (b-neg) trivia stays haiku; existing behavior preserved ──────────────────
check('what time is it → haiku', tierOf('what time is it') === 'haiku');
check('add a comment → not promoted to sonnet', tierOf('add a comment to line 5') === 'haiku');

console.log(`\n${pass} passed, ${total - pass} failed (${total} total)`);
process.exit(pass === total ? 0 : 1);
