#!/usr/bin/env node
// tests/v3/state/test-prism-panel-paste-bypass.mjs
//
// Regression for A16 / D034 pasted-content panel-suppression BYPASS.
//
// Bug (UAT 2026-07-23, reproduced): detectSummonPanel() in
// tools/lib/prism-tier-classify.mjs:409-412 correctly suppresses the panel on a
// pasted-dominated prompt (honors ONLY an explicit request in the user's OWN,
// non-pasted words). classifyWithScore() therefore returns summon_panel=false.
// BUT the LIVE sentinel-producing path — keywordFloor() in
// hooks/lib/prism-opus-classifier.mjs — recomputed its OWN explicit flag against
// the RAW, UNSTRIPPED prompt (`EXPLICIT_PANEL_RE.test(String(prompt||''))`, :265)
// and let it OVERRIDE the suppressed value (`panel = explicit ? true : ...`, :267).
// Result: a pasted transcript whose PASTED portion carries panel language
// ("summon the adversarial panel", "expert panel", "re-architect the platform")
// forced summon_panel=true on the sentinel even though the user only asked a
// plain question — defeating the D034 pasted-content safeguard entirely.
//
// D068 residual (UAT 2026-07-24, reproduced): the A16/D034 fix above only
// stripped pasted content when pastedRatio(prompt) >= 0.6 (paste-DOMINANT).
// A MINORITY paste — a single quoted/glyph-prefixed transcript line ("●
// summon the adversarial panel...") embedded inside an otherwise much longer
// own-words prompt — has a LOW pastedRatio (e.g. ~0.11), so BOTH
// summonPanelCore() (tools/lib/prism-tier-classify.mjs) and keywordFloor()
// (hooks/lib/prism-opus-classifier.mjs) fell through to testing
// EXPLICIT_PANEL_RE against the RAW, unstripped prompt — re-summoning the
// panel from a small pasted quote even though the user's own words never
// asked for one. Root cause: stripPastedContent() was gated behind the same
// 0.6 dominance ratio as the "which implicit-scoring path to take" decision,
// but the explicit-panel test itself must ALWAYS run on paste-stripped text
// (stripPastedContent is a no-op on genuine typed prose, so this is safe
// unconditionally). Fixed by removing the ratio gate around the explicit
// check in both summonPanelCore() and keywordFloor() — see their code
// comments for the precise diff.
//
// These tests exercise the FULL classifier path (classifyPrompt), NOT
// classifyWithScore — the existing paste-dampening suite only tests
// classifyWithScore and therefore could not catch this. This is the missing
// coverage.
//
// Run: node tests/v3/state/test-prism-panel-paste-bypass.mjs
// Exit: 0 = all pass; 1 = any failure.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'tools', 'lib', 'prism-tier-classify.mjs');
const CLASSIFIER_LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-opus-classifier.mjs');

const { classifyWithScore, pastedRatio, detectSummonPanel, hasTranscriptPaste, trailingOwnWords } = await import(pathToFileURL(LIB).href);
const { classifyPrompt } = await import(pathToFileURL(CLASSIFIER_LIB).href);

// Temp cache dir so these probes never touch the user's real tier cache and
// never share state between cases.
const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-paste-bypass-')), 'cache.json');

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// A pasted Claude Code panel transcript (fenced block + box/CC glyphs) whose
// PASTED portion contains explicit panel language and an architecture verb. The
// user's OWN words (the trailing line) are a plain, non-panel question.
const PASTED_WITH_PANEL_LANG = [
  '```',
  '● master-orchestrator convened a 4-seat adversarial panel',
  '  ⎿  Done (12 tool uses · 48.1k tokens)',
  '│  summon the adversarial panel for the migration',
  '│  expert panel review complete — re-architect the platform backend',
  '└  Churned for 3.2k tokens',
  '```',
  'Based on the transcript above, what was the final recommendation?',
].join('\n');

// Precondition: this prompt really is pasted-dominated (>=60%).
check('precondition: pastedRatio(prompt) >= 0.6 (pasted-dominated)',
  pastedRatio(PASTED_WITH_PANEL_LANG) >= 0.6);

// Precondition: classifyWithScore (tools lib) ALREADY suppresses correctly.
// This proves the divergence is in the keywordFloor/classifyPrompt path, not
// in detectSummonPanel.
check('precondition: classifyWithScore().summon_panel === false (already correct)',
  classifyWithScore(PASTED_WITH_PANEL_LANG, '').summon_panel === false);

// ── THE BYPASS (RED against pre-fix code) ────────────────────────────────────
// The LIVE sentinel path must NOT let pasted panel language summon the panel.
{
  const r = await classifyPrompt({ prompt: PASTED_WITH_PANEL_LANG, skipCache: true, cachePath });
  check('A16: pasted panel language does NOT summon panel on the LIVE sentinel (classifyPrompt)',
    r.summon_panel === false);
}

// ── OVER-FIX GUARD: explicit request in the user's OWN words still fires ──────
// The fix must only strip pasted content before the explicit test — an explicit
// panel request the user actually typed (outside any paste) must still summon.
{
  const explicitOwnWords = PASTED_WITH_PANEL_LANG + '\nnow run the expert panel on whether to adopt that recommendation';
  const r = await classifyPrompt({ prompt: explicitOwnWords, skipCache: true, cachePath });
  check('over-fix guard: explicit "run the expert panel" in own words still summons (even amid a paste)',
    r.summon_panel === true);
}

// ── OVER-FIX GUARD: a plain (non-paste) explicit request is unaffected ────────
{
  const r = await classifyPrompt({ prompt: 'summon the panel to evaluate REST vs GraphQL', skipCache: true, cachePath });
  check('over-fix guard: plain explicit "summon the panel" (no paste) still summons',
    r.summon_panel === true);
}

// ── D068 residual: MINORITY paste (low pastedRatio) with panel language ──────
// A single glyph-prefixed quoted line ("● summon the adversarial panel…")
// embedded in an otherwise much longer own-words prompt. Unlike
// PASTED_WITH_PANEL_LANG above, this prompt is NOT paste-dominant.
{
  const MINORITY_PASTE_WITH_PANEL_LANG = [
    'Hey, I was looking back at a scratch session I ran earlier this week and',
    'wanted to sanity check something with you before I go further on the',
    'actual task at hand.',
    'Here is the one line I wanted to quote from that transcript:',
    '●  summon the adversarial panel for the migration decision',
    'Anyway, forget that context — my real question right now is just: can you',
    'explain what a JavaScript debounce function does, and give me a short code',
    'example I can drop into a utils file? I do not need anything else right',
    'now, just the explanation and example, thanks.',
  ].join('\n');

  check('precondition: pastedRatio(prompt) < 0.6 (minority paste, NOT dominant)',
    pastedRatio(MINORITY_PASTE_WITH_PANEL_LANG) < 0.6);

  check('D068: classifyWithScore().summon_panel === false on minority paste',
    classifyWithScore(MINORITY_PASTE_WITH_PANEL_LANG, '').summon_panel === false);

  const r = await classifyPrompt({ prompt: MINORITY_PASTE_WITH_PANEL_LANG, skipCache: true, cachePath });
  check('D068: minority-paste panel language does NOT summon panel on the LIVE sentinel (classifyPrompt)',
    r.summon_panel === false);
}

// ── NEGATIVE control: pasted content with NO panel language, plain question ───
{
  const benignPaste = [
    '```',
    '● Build succeeded (0 errors)',
    '  ⎿  Done (3 tool uses)',
    '│  lint: 0 warnings',
    '└  bundle size 142kb',
    '```',
    'What does the bundle size number mean here?',
  ].join('\n');
  const r = await classifyPrompt({ prompt: benignPaste, skipCache: true, cachePath });
  check('negative control: benign paste + plain question → summon_panel=false',
    r.summon_panel === false);
}

// ── D068-follow-up (2026-07-24): TRANSCRIPT-PASTE panel suppression ──────────
//
// Root cause: a prompt containing a pasted CC/CLI transcript (>=3 strong
// transcript markers) is the user SHOWING Claude output, not requesting a
// fresh panel. Before this fix, an explicit "run the panel: <question>" line
// sitting OUTSIDE the transcript span (before the first marker / after the
// last) survived stripPastedContent()'s block-strip branch untouched and
// still matched EXPLICIT_PANEL_RE, wrongly summoning the panel from a pasted
// demonstration. Fixed by hasTranscriptPaste() — an unconditional top-of-
// function suppression in BOTH summon paths:
//   1. detectSummonPanel() in tools/lib/prism-tier-classify.mjs
//   2. keywordFloor() in hooks/lib/prism-opus-classifier.mjs (exercised here
//      via classifyPrompt(), which is the exported entry point; keywordFloor
//      itself is module-private).

// CASE2 — transcript paste. The "run the panel: ..." line sits BEFORE the
// transcript's strong markers (>=3: four "●" lines + two "⎿" lines), so it
// is outside stripPastedContent's block-strip span and would previously
// still match EXPLICIT_PANEL_RE. Must now summon_panel=false on BOTH paths.
const CASE2_TRANSCRIPT_PASTE = [
  'run the panel: should the widget-forge ledger add a background compaction',
  '  pass for the append-only log, or keep replaying the full log on every read?',
  '',
  '● I will start by loading my orchestration skill and reading the roster.',
  '● Skill(master-orchestrator)',
  '  ⎿  Successfully loaded skill',
  '● Write(panel.json)',
  '  ⎿  Wrote 85 lines',
  '✻ Brewed for 5m 58s this is what i got from the cli',
].join('\n');

{
  check('hasTranscriptPaste(CASE2) === true (unit assert)',
    hasTranscriptPaste(CASE2_TRANSCRIPT_PASTE) === true);

  check('CASE2: detectSummonPanel(...) === false (path 1 — tools/lib/prism-tier-classify.mjs)',
    detectSummonPanel(CASE2_TRANSCRIPT_PASTE, '', {h: 0, s: 0, o: 0, compound: false}) === false);

  check('CASE2: classifyWithScore().summon_panel === false (tools lib, full path)',
    classifyWithScore(CASE2_TRANSCRIPT_PASTE, '').summon_panel === false);

  const r = await classifyPrompt({ prompt: CASE2_TRANSCRIPT_PASTE, skipCache: true, cachePath });
  check('CASE2: classifyPrompt(...).summon_panel === false (path 2 — keywordFloor via hooks/lib/prism-opus-classifier.mjs)',
    r.summon_panel === false);
}

// ── POSITION-DISTINCTION (coordinator-mandated correction) ──────────────────
// Direct proof that the fix discriminates on POSITION relative to the
// transcript span, not merely "does a transcript exist somewhere in the
// prompt". Reuses the CASE2 string for the LEADING variant (explicit phrase
// BEFORE the transcript's first strong marker) and adds a TRAILING variant
// (same transcript, explicit phrase AFTER the last strong marker instead).
{
  check('position-distinction: trailingOwnWords(CASE2 leading variant) contains NO explicit panel phrase',
    !/\b(?:summon|convene|run)\s+(?:the\s+|an?\s+)?(?:expert\s+|adversarial\s+)?panel\b/i.test(trailingOwnWords(CASE2_TRANSCRIPT_PASTE)));

  // LEADING: "run the panel: ..." sits BEFORE the transcript's markers (this
  // is exactly CASE2) → must be FALSE on both paths.
  check('position-distinction LEADING: detectSummonPanel(...) === false',
    detectSummonPanel(CASE2_TRANSCRIPT_PASTE, '', {h: 0, s: 0, o: 0, compound: false}) === false);
  const rLeading = await classifyPrompt({ prompt: CASE2_TRANSCRIPT_PASTE, skipCache: true, cachePath });
  check('position-distinction LEADING: classifyPrompt(...).summon_panel === false',
    rLeading.summon_panel === false);

  // TRAILING: same transcript body, but the explicit phrase now sits AFTER
  // the last strong marker (genuine own-words request following the paste)
  // → must be TRUE on both paths — this is the LOCKED v5.2.6/D034 guarantee.
  const TRAILING_VARIANT = [
    'Here is what happened when I ran a session earlier:',
    '',
    '● I will start by loading my orchestration skill and reading the roster.',
    '● Skill(master-orchestrator)',
    '  ⎿  Successfully loaded skill',
    '● Write(panel.json)',
    '  ⎿  Wrote 85 lines',
    '✻ Brewed for 5m 58s this is what i got from the cli',
    '',
    'run the panel on whether the widget-forge ledger should add background compaction',
  ].join('\n');
  check('position-distinction precondition: TRAILING_VARIANT hasTranscriptPaste === true',
    hasTranscriptPaste(TRAILING_VARIANT) === true);
  check('position-distinction TRAILING: detectSummonPanel(...) === true',
    detectSummonPanel(TRAILING_VARIANT, '', {h: 0, s: 0, o: 0, compound: false}) === true);
  const rTrailing = await classifyPrompt({ prompt: TRAILING_VARIANT, skipCache: true, cachePath });
  check('position-distinction TRAILING: classifyPrompt(...).summon_panel === true',
    rTrailing.summon_panel === true);
}

// GENUINE requests — must stay summon_panel:true, no regression. These have
// NO transcript markers at all, so hasTranscriptPaste() must be false and the
// existing explicit-panel logic must fire exactly as before.
const GENUINE_SHORT = 'run the panel: should we adopt tRPC across our services?';

// 60+ word own-words prompt, no transcript markers — proves the fix keys on
// transcript markers, not on prompt length.
const GENUINE_LONG = [
  'run the panel: should we adopt tRPC across our services, or standardize on',
  'a plain REST-plus-OpenAPI contract instead? We have six internal services',
  'today, three written in Node and three in Go, and the frontend team wants',
  'stronger end-to-end type safety without hand-maintaining client SDKs. I am',
  'worried about coupling every consumer to a single TypeScript toolchain and',
  'about the operational cost of adding a new codegen step to our release',
  'pipeline. Please weigh developer velocity, cross-language support, and',
  'long-term maintenance burden before recommending a direction.',
].join('\n');

{
  const wc = GENUINE_LONG.trim().split(/\s+/).filter(Boolean).length;
  check(`precondition: GENUINE_LONG is 60+ words (actual ${wc})`, wc >= 60);

  check('hasTranscriptPaste(GENUINE_LONG) === false (unit assert)',
    hasTranscriptPaste(GENUINE_LONG) === false);

  check('GENUINE_SHORT: classifyWithScore().summon_panel === true (no regression)',
    classifyWithScore(GENUINE_SHORT, '').summon_panel === true);
  const rShort = await classifyPrompt({ prompt: GENUINE_SHORT, skipCache: true, cachePath });
  check('GENUINE_SHORT: classifyPrompt().summon_panel === true (no regression)',
    rShort.summon_panel === true);

  check('GENUINE_LONG: classifyWithScore().summon_panel === true (no regression, proves length is not the key)',
    classifyWithScore(GENUINE_LONG, '').summon_panel === true);
  const rLong = await classifyPrompt({ prompt: GENUINE_LONG, skipCache: true, cachePath });
  check('GENUINE_LONG: classifyPrompt().summon_panel === true (no regression, proves length is not the key)',
    rLong.summon_panel === true);
}

// CASE1 — KNOWN RESIDUAL. Pure-prose quote, NO transcript markers at all: it
// is string-indistinguishable from a genuine request. Documenting current
// (expected) behavior — this test asserts summon_panel stays TRUE. Do NOT
// attempt a keyword fix here — see comment below.
//
// KNOWN RESIDUAL — markerless prose quote is indistinguishable from a genuine
// request; backstopped by the conversation-model sentinel override. Do NOT
// attempt a keyword fix (regresses real panels).
const CASE1_MARKERLESS_PROSE_QUOTE = [
  'run the panel: should the widget-forge ledger add a background compaction',
  '  pass for the append-only log, or keep replaying the full log on every read?',
  '  Evaluate crash safety, read latency as the log grows, and complexity.',
  '',
  '  Swap that for any real open design question in the scratch app if it fits better i pasted this in scratch uat project',
].join('\n');

{
  check('CASE1 precondition: hasTranscriptPaste(...) === false (no strong markers)',
    hasTranscriptPaste(CASE1_MARKERLESS_PROSE_QUOTE) === false);

  check('CASE1 KNOWN RESIDUAL: classifyWithScore().summon_panel === true (documented, not a regression)',
    classifyWithScore(CASE1_MARKERLESS_PROSE_QUOTE, '').summon_panel === true);

  const r1 = await classifyPrompt({ prompt: CASE1_MARKERLESS_PROSE_QUOTE, skipCache: true, cachePath });
  check('CASE1 KNOWN RESIDUAL: classifyPrompt().summon_panel === true (documented, not a regression)',
    r1.summon_panel === true);
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
