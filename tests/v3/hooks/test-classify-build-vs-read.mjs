#!/usr/bin/env node
// Direct unit test of classifyBuildVsRead() — hooks/prism-specialist-routing-guard.mjs:110-115.
//
// WHY THIS FILE EXISTS (PRISM task #32, 2026-07-28): classifyBuildVsRead() had
// THREE live callers (this guard's own run(), prism-file-lease-guard.mjs:179,
// prism-skill-equip-nudge.mjs:138) but ZERO direct unit coverage — only
// indirect coverage via subprocess/e2e tests that exercise it through a
// dispatcher (test-specialist-routing-guard.mjs) or reconstruct a logged
// score from a fixture string (tests/v3/skill-equip-nudge-precision.test.mjs
// Case 14). This file imports and calls the function directly.
//
// The archaeology behind the fixtures below: the routing log
// (~/.claude/.prism-routing.jsonl) recorded ONLY the classifier's OWN output
// (build_score/read_score/action) — no field tied an event back to its
// originating dispatch text, so false positives could not be identified from
// the log alone. Task #32 joined the 5 real `nudge-specialist` events in the
// log (2026-07-22..2026-07-27, 100% census — this was every such event that
// existed, not a sub-sample) to their originating Agent-dispatch text by
// session_id + nearest-timestamp match in the session transcripts under
// ~/.claude/projects/*/<session_id>.jsonl (all 5 matches were <7s apart,
// i.e. the PreToolUse hook firing on the same Agent call moments after the
// assistant message containing it was written — high-confidence joins).
// Two of the five were genuine, unambiguous false positives; the fixtures
// under fixtures/t32-specialist-routing-fp/ are those real dispatch texts,
// VERBATIM byte-for-byte (only the pre-existing repo path was left as-is —
// nothing paraphrased or shortened, so the scores below reproduce exactly),
// not invented examples. See the task #32 report for the full 5-event
// breakdown (2 clean FP, 1 clean TP, 2 borderline/arguable — not included
// here since "borderline" is not a clean fixture for a pinned assertion).
//
// Run: node tests/v3/hooks/test-classify-build-vs-read.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyBuildVsRead, matchSpecialist} from '../../../hooks/prism-specialist-routing-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 't32-specialist-routing-fp');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf-8');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// ── Basic sanity: unambiguous build phrase / unambiguous read phrase ───────
await test('1. unambiguous build phrase → isBuild true', () => {
  const r = classifyBuildVsRead('build the map-tree confirmation UI component with the design system');
  assert(r.isBuild === true, JSON.stringify(r));
  assert(r.buildScore > r.readScore, JSON.stringify(r));
});

await test('2. unambiguous read/recon phrase → isBuild false', () => {
  const r = classifyBuildVsRead('map the W2 backend endpoints and document the API surface');
  assert(r.isBuild === false, JSON.stringify(r));
});

await test('3. empty/undefined input → isBuild false, both scores 0 (fail-quiet)', () => {
  const r1 = classifyBuildVsRead('');
  const r2 = classifyBuildVsRead(undefined);
  assert(r1.isBuild === false && r1.buildScore === 0 && r1.readScore === 0, JSON.stringify(r1));
  assert(r2.isBuild === false && r2.buildScore === 0 && r2.readScore === 0, JSON.stringify(r2));
});

// ── PAIRED TRUE POSITIVE — real production log entry ───────────────────────
// session deadbeef-0000-4000-8000-000000000001, 2026-07-22T15:49:45.738Z.
// A genuine "root-cause + implement the fix" dispatch (D064 remedy 2: debug
// and fix a hook that spawns `claude -p` and hangs). The routing log recorded
// build_score:5 read_score:4 action:"nudge-specialist" (claude-master) for
// this exact dispatch text. This is the paired TP guarding against a future
// "fix" that silences the classifier into never firing (task #32 step 4).
await test('4. TP (real log #1, 2026-07-22T15:49:45Z): build/debug dispatch → isBuild true, build=5/read=4', () => {
  const text = fixture('tp-1-etimedout-dispatch.txt');
  const r = classifyBuildVsRead(text);
  assert(r.isBuild === true, JSON.stringify(r));
  assert(r.buildScore === 5 && r.readScore === 4, `expected build=5/read=4 (matches production log), got ${JSON.stringify(r)}`);
});

// ── KNOWN, UNFIXED FALSE POSITIVE #1 — real production log entry ───────────
// session deadbeef-0000-4000-8000-000000000002, 2026-07-27T07:27:42.201Z.
// This dispatch is a GIT-COMMIT task ("Commit this session's work to master
// in TWO logical commits") — no building/implementing happens in it at all.
// The live guard scored it build_score:4/read_score:2 and nudged toward
// 'marketing-production-ops-specialist' (matched_terms: newsletter, campaign,
// marketing) purely because the repo path contains "newsletter_automation"
// and the (already-written, being-committed) commit message body mentions
// "marketing feedback" / "campaign_id" / picto "generation".
//
// ROOT CAUSE (confirmed via the isolated negation-probe fixture in test 6
// below): BUILD_SIGNALS is negation-blind. "Never use git add -A", "do NOT
// create a branch" etc. still add +1 each for the bare \bcreate\b / \badd\b
// signals — the preceding "do NOT" / "never" is not inspected. Combined with
// genuinely-present nouns from filenames/commit-message prose ("build_feed.py",
// "generate.py", "picto generation pipeline"), buildScore climbs past
// readScore for a task that is fundamentally about running `git commit`, not
// building anything.
//
// ── UPDATED 2026-07-28 (task #32 fix) — the pin's own instruction, honoured ──
// The pre-fix version of this test asserted `build=4` and carried this note:
//
//   "THIS TEST PINS CURRENT (WRONG) BEHAVIOUR. It is NOT an endorsement of
//    correctness — task #32's evidence says a bare BUILD_SIGNALS/READ_SIGNALS
//    *weight* change would NOT fix this (the defect is structural negation-
//    blindness, not a miscalibrated weight), so no weight change ships here.
//    If this assertion ever needs to change, it must be because someone added
//    a deliberate negation-aware feature to the classifier (a new capability,
//    not a weight tweak) — update this test's expected numbers at that point,
//    don't just relax the assertion."
//
// That precondition is now met and NO weight was touched: a negation-lookback
// capability shipped in the SAME change (scoreSignalsNegationAware, guard
// lines ~104-150). The number is updated, not relaxed — the assertion is still
// an exact triple equality on all three fields.
//
// build 4 → 3: `\bcreate\b` is now SUPPRESSED on "do NOT create a branch"
// (the exact offender the #32 census pinned). The surviving 3 are NOT negated
// and are correctly counted: `\bbuild\b` from the filename "build_feed.py",
// `\bgenerate\b` from "tools/picto: generate.py", `\badd (an? )?\b` from
// "a blanket add". read stays 2 (`\binspect\b` + `\bmap\b` from "picto-map").
//
// HONEST PARTIAL RESULT — isBuild is STILL true (3 > 2). Negation-awareness
// removes the negated-verb inflation it was scoped to remove; it does not by
// itself close this dispatch's downstream false positive, whose residual
// buildScore comes from genuine build-ish nouns in filenames and an
// already-written commit-message body. The #32 census classified this event as
// a CROSS-DOMAIN FP (it nudged toward marketing-production-ops-specialist on
// incidental "newsletter"/"campaign"/"marketing" path+prose tokens), i.e. the
// misroute lives in matchSpecialist/agentTerms, not in the build gate. This
// test is therefore still a characterization pin, now of POST-fix behaviour.
await test('5. FP #1 (real log #2, 2026-07-27T07:27:42Z) post-negation-fix: git-commit dispatch build 4→3, read=2, isBuild STILL true', () => {
  const text = fixture('fp-1-git-commit-dispatch.txt');
  const r = classifyBuildVsRead(text);
  assert(r.buildScore === 3,
    `negation lookback must suppress \\bcreate\\b on "do NOT create a branch": expected build=3 (was 4 pre-fix). Got ${JSON.stringify(r)}`);
  assert(r.readScore === 2, `read side is untouched by the build-only negation fix: expected read=2. Got ${JSON.stringify(r)}`);
  assert(r.isBuild === true,
    `documented partial result: 3>2 still trips the gate; the residual FP is a matchSpecialist/agentTerms cross-domain issue, not a build-gate one. Got ${JSON.stringify(r)}`);
});

// ── Isolated mechanism proof: negation AWARENESS (inverted 2026-07-28) ──────
// PRE-FIX this test asserted the DEFECT and was titled
//   "6. mechanism proof: negated build verbs still score (negation-blindness)"
// with `assert(r.buildScore >= 5, ...)` and this rationale:
//   "A synthetic, minimal fixture proving the root-cause mechanism cited
//    above: EVERY build-signal match here comes from an explicitly NEGATED
//    verb phrase ("do not create", "never add a migration") — yet they still
//    contribute full positive weight to buildScore. This is what lets
//    genuinely negated build-verbs in real dispatch prose (test 5 above)
//    inflate buildScore."
// The fixture STRING is unchanged byte-for-byte; only the expectation is
// inverted, because the mechanism it proved is now fixed. Measured: 6 → 0.
// Every build hit here really was negated, so a correct scorer yields ZERO —
// and readScore 6 → 3 is untouched by the fix (build-only, by design), which
// keeps isBuild false for what is plainly a read-only task.
await test('6. mechanism proof (INVERTED): negated build verbs no longer score → build=0, isBuild false', () => {
  const text = 'Do not create a new component. Never add a migration. This is a read-only investigation; audit the existing code and document findings.';
  const r = classifyBuildVsRead(text);
  assert(r.buildScore === 0, `every build signal here is explicitly negated ("do not create", "never add a migration") — expected build=0 (was 6 pre-fix), got ${JSON.stringify(r)}`);
  assert(r.isBuild === false, `a read-only investigation must not be build-class, got ${JSON.stringify(r)}`);
});

// ── Recall guard for the negation fix (task #32) ────────────────────────────
// The negation feature must NOT quiet genuine build intent. Same verbs, NOT
// negated → full pre-fix scores. Without this, test 6 could be satisfied by a
// scorer that simply stopped counting `create`/`add` at all.
await test('6b. recall guard: the SAME verbs un-negated still score fully', () => {
  const r = classifyBuildVsRead('Create a new component. Add a migration. Build the UI.');
  assert(r.buildScore >= 5, `un-negated build verbs must score exactly as before, got ${JSON.stringify(r)}`);
  assert(r.isBuild === true, JSON.stringify(r));
});

// ── KNOWN, UNFIXED FALSE POSITIVE #2 — real production log entry (weaker) ──
// session deadbeef-0000-4000-8000-000000000003, 2026-07-23T19:18:31.109Z.
// "One tiny fix" — flip a single JSON boolean field. This IS a genuine
// (if trivial) edit, so isBuild=true is defensible on its own; the FP here is
// the downstream nudge-to-specialist for a one-line, no-domain-expertise-
// needed change, not classifyBuildVsRead's isBuild call itself. Pinned as a
// secondary characterization, not the primary RED case (see test 5).
await test('7. secondary FP (real log #3, 2026-07-23T19:18:31Z): trivial one-line edit still isBuild=true, build=1/read=0', () => {
  const text = fixture('fp-2-manifest-flag-flip.txt');
  const r = classifyBuildVsRead(text);
  assert(r.isBuild === true && r.buildScore === 1 && r.readScore === 0, `expected build=1/read=0 (matches production log), got ${JSON.stringify(r)}`);
});

// ── Task #32 (2026-07-28, session 5) — matchSpecialist/agentTerms mechanism ──
// A synthetic minimal roster (not the live installed one — keeps this test
// portable/deterministic) mirroring the two REAL roster entries' core_domains,
// verified byte-identical against the live roster before use.
const SYNTHETIC_ROSTER = {
  agents: {
    'marketing-production-ops-specialist': { core_domains: ['newsletter', 'campaign', 'marketing', 'production', 'throughput', 'templating', 'proofing', 'workflow'], status: 'available' },
    'claude-master': { core_domains: ['hooks', 'subagents', 'mcp', 'plugins', 'permissions', 'settings', 'sessions', 'powershell'], status: 'active' },
  },
};

// ── FP#1 residual: matchSpecialist cross-domain misroute (STILL UNFIXED) ────
// The build-gate/negation fix (test 5) does not touch this — D056 governs
// matchSpecialist/agentTerms scope (stoplist ambient name-tokens, score>=2
// nudge floor), both already shipped. Task #32 measured THREE candidate
// mechanisms for closing this specific residual and REJECTED all three with
// evidence, rather than shipping a fix:
//   (a) strip "REPO:"/"Repo:"/metadata-header lines before matching — MEASURED
//       NO CHANGE: 'campaign'/'marketing' recur throughout the actual commit-
//       message BODY (real task content, e.g. "build_campaign.py (36 campaign
//       assets)", "Marketing feedback Batch A"), not just the REPO line.
//   (b) require matchDomain() (the DOMAINS dict) to corroborate before
//       nudging — REJECTED: DOMAINS has no "marketing" entry AND no "hooks"
//       entry, so it returns null for BOTH this genuine FP and the tp-1 TRUE
//       positive alike (would gate on a dict that structurally can't
//       discriminate the two, and D056 already states matchSpecialist
//       "ignores [DOMAINS] entirely" by design).
//   (c) require 2+ matched terms to co-occur on the same line (proximity
//       gate) — REJECTED: fp-1's 3 matched terms never share a line (checked
//       directly), so this WOULD flip fp-1 — but tp-1's 2 matched terms
//       ("hooks" at the file-path line, "powershell" in a separate HARD
//       CONSTRAINTS line) ALSO never share a line, so the same gate would
//       silently kill the genuine tp-1 nudge too. Fails the "tp-1 stays
//       GREEN" bar.
// Discriminating "domain vocabulary describing the REQUESTED work" from
// "domain vocabulary appearing in already-written prose being committed" is a
// semantic/pragmatic judgment a deterministic keyword scorer cannot make
// without either an NLU call (against this repo's dependency-free/no-network
// hook constraint) or a heuristic overfit to this one N=1 fixture. Per D056's
// own precedent ("defer until data shows a recurring miss") and the
// dispatch-preamble rule against manufacturing a fix, this is characterized
// and left as a documented, data-gated residual — NOT patched.
await test('8. FP#1 residual (task #32): matchSpecialist STILL cross-domain-misroutes the git-commit dispatch — characterization pin, not endorsement', () => {
  const text = fixture('fp-1-git-commit-dispatch.txt');
  const r = matchSpecialist(text, SYNTHETIC_ROSTER);
  assert(r && r.name === 'marketing-production-ops-specialist' && r.score === 3,
    `expected the known-unfixed residual (name=marketing-production-ops-specialist, score=3); if this now differs, either a fix landed (update this comment, don't just relax the assertion) or the roster/fixture drifted. Got ${JSON.stringify(r)}`);
  assert(JSON.stringify(r.matchedTerms) === JSON.stringify(['newsletter', 'campaign', 'marketing']), JSON.stringify(r.matchedTerms));
});

// ── FP#2: D056's score>=2 nudge floor IS correctly enforced on this path ────
// The team's brief asked whether D056's "require score>=2 to nudge" threshold
// is actually enforced here, since fp-2 nudges at buildScore=1 (test 7).
// buildScore and specialist.score are TWO DIFFERENT numbers: buildScore>=1
// only gates whether matchSpecialist runs AT ALL (classifyBuildVsRead's own
// floor, which D056 explicitly forbids widening — "No buildScore classifier
// widening"); NUDGE_MIN_SCORE=2 (hooks/prism-specialist-routing-guard.mjs:491)
// gates whether the match actually NUDGES. This test proves the SECOND gate
// holds: fp-2 clears it at EXACTLY the D056 floor (2, not more), on two
// genuine domain terms ("hooks" — the entry being edited IS a hooks/*.mjs
// manifest row; "powershell" — a real constraint named in the dispatch), not
// on stoplisted ambient name tokens. Conclusion: this is a defensible
// advisory-only nudge on a domain-adjacent trivial edit, not a threshold-
// enforcement bug — no code change indicated.
await test('9. FP#2 (task #32): D056 score>=2 nudge floor enforced correctly, clears at exactly 2 on genuine (non-ambient) terms', () => {
  const text = fixture('fp-2-manifest-flag-flip.txt');
  const r = matchSpecialist(text, SYNTHETIC_ROSTER);
  assert(r && r.name === 'claude-master' && r.score === 2,
    `expected claude-master at exactly score=2 (the D056 floor). Got ${JSON.stringify(r)}`);
  assert(JSON.stringify(r.matchedTerms) === JSON.stringify(['hooks', 'powershell']), JSON.stringify(r.matchedTerms));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
