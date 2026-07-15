#!/usr/bin/env node
// tests/v3/state/test-explicit-only-panel.mjs
//
// TDD test suite for the explicit-only panel trigger change.
//
// Design: panel fires ONLY on explicit user request (EXPLICIT_PANEL_RE).
// Legacy lexical auto-fire (PANEL_SIGNALS, detectStakes, ≥3 opus, compound)
// is OFF by default and restores only when PRISM_LEXICAL_PANEL=1.
//
// Test cases:
//   (a) Implicit high-signal prompt → summon_panel===false (default)
//   (b) detectStakes-type prompt → summon_panel===false (default)
//   (c) Explicit "/panel" / "run the expert panel" → summon_panel===true
//   (d) PRISM_LEXICAL_PANEL=1 rollback → implicit resumes auto-fire
//   (e) Explicit panel request phrased AS a meta/why question → summon_panel===true
//       (BLOCKER: the meta-screen in prism-opus-classifier must not override explicit)
//   (f) PRISM_LEXICAL_PANEL='true' (string) also restores legacy implicit firing
//
// Run: node tests/v3/state/test-explicit-only-panel.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'tools', 'lib', 'prism-tier-classify.mjs');
const CLASSIFIER_LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-opus-classifier.mjs');

// Import without cache so we can re-import with env changes for test (d).
const { classifyWithScore, PANEL_MIN_WORDS } = await import(pathToFileURL(LIB).href);
// Import the full classifier (which has the meta-screen) for (e) tests.
const { classifyPrompt } = await import(pathToFileURL(CLASSIFIER_LIB).href);
// Temp cache dir so (e) tests don't share state with (d) env-mutation tests.
const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-explicit-meta-')), 'cache.json');

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// Helper: pad a prompt to at least PANEL_MIN_WORDS words so word-count floor
// is NOT the reason a panel signal is suppressed. These tests are verifying
// the EXPLICIT-ONLY gate, not the length floor.
function padToMinWords(prompt) {
  let p = prompt; let n = 0;
  while (p.trim().split(/\s+/).filter(Boolean).length < PANEL_MIN_WORDS) {
    p += ` filler${n++}`;
  }
  return p;
}

const panel = (p, desc = '') => classifyWithScore(p, desc).summon_panel;

// ── (a) Implicit high-signal prompt must NOT auto-fire panel ─────────────────
//
// "redesign the entire platform architecture with multi-phase migration and
// multi-region deployment" — hits PANEL_SIGNALS (multi-phase migration +
// multi-region deployment pattern) AND OPUS_SIGNALS ≥2. Under the OLD code
// (panelHit=true) this fires the panel. Under explicit-only it must NOT.
const IMPLICIT_NOVEL = padToMinWords(
  'redesign the entire platform architecture with multi-phase migration and multi-region deployment system service'
);
check(
  '(a) implicit high-signal novel prompt → summon_panel=false by default',
  panel(IMPLICIT_NOVEL) === false
);

// Verify the prompt still routes to opus (the tier bump should still happen
// for complex prompts — only the panel is suppressed).
check(
  '(a) implicit high-signal novel prompt still routes to opus tier',
  classifyWithScore(IMPLICIT_NOVEL, '').tier_by_score === 'opus'
);

// ── (b) detectStakes-type prompt must NOT auto-fire panel ────────────────────
//
// "migrate the users table to a new schema and backfill production data" — a
// canonical STAKES_SIGNALS match (database migration + backfill). Under old
// code detectStakes() triggered the panel. Under explicit-only: stakes still
// escalates to opus tier, but the panel does NOT summon.
const STAKES_PROMPT = padToMinWords(
  'migrate the users table to a new schema and backfill production data'
);
check(
  '(b) stakes-type (migration+backfill) → summon_panel=false by default',
  panel(STAKES_PROMPT) === false
);
check(
  '(b) stakes-type prompt still escalates to opus tier via stakes flag',
  classifyWithScore(STAKES_PROMPT, '').tier_by_score === 'opus'
);

// ── (c) Explicit panel request MUST still fire the panel ─────────────────────
//
// Explicit requests are recognized by EXPLICIT_PANEL_RE — these must fire
// regardless of the PRISM_LEXICAL_PANEL flag.
check(
  '(c) "!panel" → summon_panel=true',
  panel('!panel') === true
);
check(
  '(c) "/panel" → summon_panel=true',
  panel('/panel') === true
);
check(
  '(c) "run the expert panel on this" → summon_panel=true',
  panel('run the expert panel on this') === true
);
check(
  '(c) "summon the panel" → summon_panel=true',
  panel('summon the panel') === true
);
check(
  '(c) "run the panel" (short — bypasses length floor too) → summon_panel=true',
  panel('run the panel') === true
);
check(
  '(c) "convene an expert panel" → summon_panel=true',
  panel('convene an expert panel') === true
);
check(
  '(c) "adversarial panel review" → summon_panel=true',
  panel('adversarial panel review') === true
);

// ── (d) PRISM_LEXICAL_PANEL=1 rollback restores legacy behavior ───────────────
//
// With the rollback env var set, the implicit high-signal prompt from (a)
// must re-fire summon_panel=true (restoring the old behavior). We set the
// env var and re-import the module fresh (cache-bust via a dummy query param
// is not possible in ESM without vm; use process.env mutation + re-import
// with a different URL fragment via the Node cache-buster trick).
//
// Because ESM modules are cached by URL, we use a workaround: set the env
// before the module is loaded (it is already loaded above). The module reads
// process.env at call time — as long as it reads process.env.PRISM_LEXICAL_PANEL
// inside summonPanelCore (not at module init time), this works.
{
  const prev = process.env.PRISM_LEXICAL_PANEL;
  process.env.PRISM_LEXICAL_PANEL = '1';
  // Re-read classifyWithScore from the cached module — env is read at call time.
  check(
    '(d) PRISM_LEXICAL_PANEL=1 → implicit high-signal prompt resumes summon_panel=true',
    classifyWithScore(IMPLICIT_NOVEL, '').summon_panel === true
  );
  // Also confirm explicit requests still work with the flag set.
  check(
    '(d) PRISM_LEXICAL_PANEL=1 + explicit request → summon_panel=true (unchanged)',
    classifyWithScore('run the expert panel on this', '').summon_panel === true
  );
  if (prev === undefined) delete process.env.PRISM_LEXICAL_PANEL;
  else process.env.PRISM_LEXICAL_PANEL = prev;
}

// ── Regression: EXPLICIT_PANEL_RE still honored in pasted-content suppression ─
// The pastedRatio wrapper in detectSummonPanel() must still honor EXPLICIT_PANEL_RE
// even on a pasted-dominated prompt.
{
  const pastedBlock = '> '.repeat(100) + 'some quote here '.repeat(50);
  const explicit = pastedBlock + '\nrun the expert panel on this';
  check(
    'pasted-content wrapper: explicit request in own text still fires panel',
    panel(explicit) === true
  );
  const noExplicit = pastedBlock + '\nplease review this block';
  check(
    'pasted-content wrapper: no explicit request → summon_panel=false',
    panel(noExplicit) === false
  );
}

// ── (e) BLOCKER: explicit panel phrased as a meta/why question ───────────────
//
// The meta-screen in prism-opus-classifier.mjs clears summon_panel when
// META_QUESTION_RE fires and BUILD_VERB_RE is absent. These prompts contain
// WHY/EXPLAIN/CAN-YOU-EXPLAIN phrasing but ALSO contain an explicit panel
// request. The explicit request MUST WIN — meta-screen must not override it.
//
// These go through classifyPrompt (the full opus-classifier path) because that
// is where the meta-screen lives (keywordFloor lines ~266-267), NOT in
// classifyWithScore (prism-tier-classify). Testing via classifyWithScore would
// not catch this regression.
{
  const r1 = await classifyPrompt({
    prompt: 'explain why this is failing and convene the expert panel',
    skipCache: true, cachePath,
  });
  check(
    '(e) "explain why … convene the expert panel" → summon_panel=true (meta must not override explicit)',
    r1.summon_panel === true
  );

  const r2 = await classifyPrompt({
    prompt: 'why is this broken? run the expert panel on it',
    skipCache: true, cachePath,
  });
  check(
    '(e) "why is this broken? run the expert panel" → summon_panel=true',
    r2.summon_panel === true
  );

  const r3 = await classifyPrompt({
    prompt: 'can you explain the orchestrator? also convene an adversarial panel',
    skipCache: true, cachePath,
  });
  check(
    '(e) "can you explain …? also convene an adversarial panel" → summon_panel=true',
    r3.summon_panel === true
  );

  // NEGATIVE guard: a pure meta question with no explicit panel phrasing stays false.
  const r4 = await classifyPrompt({
    prompt: 'why is this test failing?',
    skipCache: true, cachePath,
  });
  check(
    '(e) negative: "why is this test failing?" (no explicit panel) → summon_panel=false',
    r4.summon_panel === false
  );
}

// ── (f) PRISM_LEXICAL_PANEL='true' also restores legacy implicit firing ───────
//
// Fix 2: the rollback flag currently only accepts '1'. It must also accept 'true'
// (matching the PRISM_PANEL_DISABLED convention).
{
  const prev = process.env.PRISM_LEXICAL_PANEL;
  process.env.PRISM_LEXICAL_PANEL = 'true';
  check(
    "(f) PRISM_LEXICAL_PANEL='true' → implicit high-signal prompt resumes summon_panel=true",
    classifyWithScore(padToMinWords(
      'redesign the entire platform architecture with multi-phase migration and multi-region deployment system service'
    ), '').summon_panel === true
  );
  if (prev === undefined) delete process.env.PRISM_LEXICAL_PANEL;
  else process.env.PRISM_LEXICAL_PANEL = prev;
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
