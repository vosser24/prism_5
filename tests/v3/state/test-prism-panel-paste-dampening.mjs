#!/usr/bin/env node
// Panel-summon dampening on PASTED/QUOTED content (PRISM v5.1.7 UAT-fix).
// Run: node tests/v3/state/test-prism-panel-paste-dampening.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Live UAT (2026-06-03): pasting a /prism-doctor or /prism-audit transcript into
// a PRISM session repeatedly tripped summon_panel=true — the keyword floor scored
// the PASTED report ("security audit", "architecture", "threat model", "migrate")
// as if it were the user's own request, demanding a master-orchestrator panel for
// what was just a result paste. Fix: when a prompt is dominated by pasted/quoted
// transcript content, the PANEL decision (only) is made from the user's own words.
//
// detectSummonPanel must NOT fire on pasted-dominated prompts unless the user's
// OWN text carries a genuine panel/stakes signal. Tier scoring is intentionally
// left untouched (a maintenance paste routing to opus is fine; the panel is not).

import { classifyWithScore, detectSummonPanel, pastedRatio, stripPastedContent }
  from '../../../tools/lib/prism-tier-classify.mjs';

let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// A representative pasted /prism-audit transcript (box-drawing + CC markers +
// trigger vocabulary). >60% of this is pasted chrome, not the user's words.
const PASTED_AUDIT = [
  '🩺 Doctor Report — 2026-06-03',
  '● /prism-audit runs a security audit + integrity checks.',
  '● Agent(Run prism-audit security scan) Sonnet 4.6',
  '  ⎿  Search(pattern: "sk-...")',
  '┌─────┬──────────┬────────────────────────────────┐',
  '│  #  │ Severity │             Where              │',
  '│ 1   │ 🔴 HIGH  │ .gitignore                     │',
  '└─────┴──────────┴────────────────────────────────┘',
  '⚠️  threat model / attack surface review of the architecture',
  'migrate the database schema; re-architect the platform',
].join('\n');

// 1) Pasted report with NO real instruction → no panel.
check('pasted audit transcript alone does NOT summon a panel',
  classifyWithScore(PASTED_AUDIT, '').summon_panel === false);

// 2) Pasted report + a trivial instruction → still no panel.
check('pasted transcript + "fix all" does NOT summon a panel',
  classifyWithScore(PASTED_AUDIT + '\nfix all', '').summon_panel === false);

// 3) Pasted report + an EXPLICIT panel request in the user's own words → honored.
check('explicit "run the panel" in own words still summons, even amid a paste',
  classifyWithScore(PASTED_AUDIT + '\nrun the panel on this', '').summon_panel === true);

// 4) Genuine architecture request with NO paste → unchanged (still summons).
check('genuine architecture request (no paste) still summons',
  classifyWithScore('Help me architect a new event-driven orchestration system from scratch', '').summon_panel === true);

// 5) Pasted-dominated prompt with AMBIENT stakes vocabulary but NO explicit panel
//    request → suppressed. Conservative tradeoff: on a paste-dominated turn we
//    can't reliably tell the user's intent from residual prose, so we require an
//    explicit "run the panel". Tier still routes opus; the user can confirm.
check('pasted-dominated + ambient stakes (no explicit panel) is suppressed',
  classifyWithScore(PASTED_AUDIT + '\nplease run a security audit and threat model of the production system', '').summon_panel === false);

// 6) Ratio helpers behave.
check('pastedRatio high for a pasted-dominated prompt', pastedRatio(PASTED_AUDIT) >= 0.6);
check('pastedRatio ~0 for a plain one-line request', pastedRatio('add a dark mode toggle to the navbar') < 0.2);
check('stripPastedContent removes box-drawing/transcript lines',
  !/[│┌└]/.test(stripPastedContent(PASTED_AUDIT)) && !/⎿|●/.test(stripPastedContent(PASTED_AUDIT)));

// 7) Regression: a normal non-paste stakes prompt still summons.
check('non-paste stakes prompt (rotate leaked api key) still summons',
  detectSummonPanel('we need to rotate the leaked api key credentials immediately', '', {h:0,s:0,o:0,compound:false}) === true);

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
