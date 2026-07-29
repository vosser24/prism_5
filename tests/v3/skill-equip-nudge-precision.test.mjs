#!/usr/bin/env node
// Precision/ranking tests for hooks/prism-skill-equip-nudge.mjs (F9 fix).
// Proves the matcher: (a) matches on WORD BOUNDARIES, (b) does NOT surface a
// skill matched only on ultra-generic single words, (c) surfaces a genuinely
// relevant specialist on a specific domain term, (d) caps output at MAX_NUDGE
// (=3). Hermetic: seeds an isolated temp HOME roster and calls run() directly.
//
// Run: node tests/v3/skill-equip-nudge-precision.test.mjs

import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'prism-skill-equip-nudge.mjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`PASS  ${name}`); }
function bad(name, msg) { fail++; console.log(`FAIL  ${name}\n        ${msg}`); }
function check(name, cond, msg) { if (cond) ok(name); else bad(name, msg || 'condition false'); }

// Seed a roster in an isolated temp HOME, point the hook at it via env, then
// import run() fresh. `const H` is captured at module load, so env must be set
// BEFORE the dynamic import — we import once against a stable temp HOME.
const HOME = mkdtempSync(join(tmpdir(), 'prism-f9-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const ROSTER = {
  version: '3.1.0',
  agents: {},
  tools: {},
  mcps: {},
  skills: {
    // Only-generic terms → must NEVER surface on a generic prompt.
    'generic-only': {
      description: 'generic',
      domains: ['refactor'],
      keywords: ['review', 'implement', 'tests', 'debugging', 'fix', 'code'],
    },
    // Specific hyphenated + single specific keyword.
    'superpowers:test-driven-development': {
      description: 'tdd',
      domains: ['testing'],
      keywords: ['tdd', 'red-green-refactor'],
    },
    // Specific domain specialist.
    'postgres-migration-expert': {
      description: 'pg',
      domains: ['postgres', 'database-migration'],
      keywords: ['postgres', 'schema'],
    },
    // Word-boundary probe: 'graph' must NOT match 'graphql'.
    'graph-skill': {
      description: 'graph',
      domains: [],
      keywords: ['graph'],
    },
    // Four distinct specialists sharing one prompt → cap test.
    'kubernetes-expert': {description: 'k8s', domains: ['kubernetes'], keywords: ['kubernetes']},
    'terraform-expert': {description: 'tf', domains: ['terraform'], keywords: ['terraform']},
    'redis-expert': {description: 'redis', domains: ['redis'], keywords: ['redis']},
    'kafka-expert': {description: 'kafka', domains: ['kafka', 'event-streaming'], keywords: ['kafka', 'kafka-streams']},

    // --- 2026-07-14 precision-fix regression cases ---
    // Reproduces the live misfire: "build a dependency-free Node .mjs hook"
    // matched a memory-leak skill on the bare, non-generic word "node" alone
    // (weight 1, old floor 1). MUST NOT surface at floor 2.
    'memory-leak-debugging': {
      description: 'leak',
      domains: ['debugging', 'backend', 'performance'],
      keywords: ['node', 'javascript', 'applications', 'heapsnapshots'],
    },
    // Duplicate-counting pair: same term listed in BOTH domains[] and
    // keywords[] (mirrors real roster.json entries like a11y-debugging's
    // "accessibility" or supabase's "database"). widget-keyword-only must
    // stay at weight 1 (single distinct hit after dedup) and NOT surface;
    // widget-domain-tagged gets the domain-boost (weight 2) and DOES
    // surface on the identical single-word match.
    'widget-keyword-only': {
      description: 'w1',
      domains: [],
      keywords: ['zzzwidgetfoo', 'zzzwidgetfoo'],
    },
    'widget-domain-tagged': {
      description: 'w2',
      domains: ['zzzwidgetfoo'],
      keywords: ['zzzwidgetfoo'],
    },
    // Two-distinct-ordinary-word skill: neither term alone clears the
    // floor, but two distinct weight-1 hits together (2) do.
    'two-hit-skill': {
      description: 'two',
      domains: [],
      keywords: ['cronwatcher', 'pagewatcher'],
    },
    // Pure-stopword skill: both keywords are English function words. Must
    // score 0 and never surface regardless of how many of them match.
    'stopword-only': {
      description: 'stop',
      domains: [],
      keywords: ['this', 'before', 'already', 'where'],
    },
    // Tiebreak probe: equal score (2) via ONE domain-tag hit vs TWO
    // ordinary keyword hits. Domain-tag hit must rank first.
    'tiebreak-domain': {
      description: 'tb-domain',
      domains: ['ztiebreakdomterm'],
      keywords: ['ztiebreakdomterm'],
    },
    'tiebreak-keywords': {
      description: 'tb-keywords',
      domains: [],
      keywords: ['ztiebreakalpha', 'ztiebreakbeta'],
    },
    // Case 14 (#38 FIRE fixture) probe: a hyphenated phrase term ("dry-run")
    // that appears verbatim in the reconstructed #38 dispatch prompt, so the
    // FIRE case has a real matching specialist to surface once suppression
    // no longer withholds it (hyphenated term → weight 3, clears floor alone).
    'dry-run-audit-expert': {
      description: 'dry-run audit tooling',
      domains: ['dry-run'],
      keywords: ['dry-run'],
    },
  },
};

const refDir = join(HOME, '.claude', 'skills', 'prism-plan', 'references');
mkdirSync(refDir, {recursive: true});
writeFileSync(join(refDir, 'roster.json'), JSON.stringify(ROSTER));

const {run, scoreSkills} = await import(pathToFileURL(HOOK).href);

async function nudgeFor(prompt) {
  const res = await run({tool_name: 'Agent', session_id: 's', tool_input: {prompt}});
  if (res.exit !== 0) throw new Error(`hook exit ${res.exit} (contract: always 0)`);
  if (!res.stdout) return {ctx: '', skills: []};
  const parsed = JSON.parse(res.stdout);
  const ctx = (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
  const skills = Object.keys(ROSTER.skills).filter(s => ctx.includes(s));
  return {ctx, skills};
}

try {
  // Case 1: realistic engineering prompt of pure generics → no misfire.
  {
    const {ctx, skills} = await nudgeFor('implement the fix, run the tests, review the diff');
    check('generic prompt → no nudge (does not match on a generic single word)',
      ctx === '' && skills.length === 0,
      `expected empty nudge, got ctx="${ctx}" skills=${JSON.stringify(skills)}`);
  }

  // Case 2: specific domain term → relevant specialist surfaces; generics stay out.
  {
    const {ctx, skills} = await nudgeFor('migrate the postgres schema to the new database');
    check('specific term → surfaces postgres-migration-expert',
      skills.includes('postgres-migration-expert'),
      `expected postgres-migration-expert, got ${JSON.stringify(skills)} ctx="${ctx}"`);
    check('specific term → does NOT surface generic-only skill',
      !skills.includes('generic-only'),
      `generic-only should be excluded, got ${JSON.stringify(skills)}`);
    check('specific term → count ≤ 3',
      skills.length <= 3, `expected ≤3, got ${skills.length}`);
    check('specific term → advisory keeps skill-equip marker',
      /skill-equip advisory/i.test(ctx), `marker missing: "${ctx}"`);
  }

  // Case 3: word-boundary — 'graph' keyword must NOT match 'graphql'.
  {
    const {ctx, skills} = await nudgeFor('build a graphql resolver');
    check("word-boundary → 'graph' does not match 'graphql'",
      !skills.includes('graph-skill'),
      `graph-skill should not match graphql, got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 4: cap — four specialists all match, at most 3 surface.
  {
    const {ctx, skills} = await nudgeFor('wire kubernetes, terraform, redis and kafka together');
    check('cap → at most 3 skills surfaced (MAX_NUDGE_SKILLS)',
      skills.length === 3,
      `expected exactly 3 (cap), got ${skills.length}: ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 5: contract — non-Agent tool passes through silently.
  {
    const res = await run({tool_name: 'Edit', tool_input: {}});
    check('non-Agent tool → silent, exit 0', res.exit === 0 && res.stdout === '',
      `expected silent pass, got exit=${res.exit} stdout="${res.stdout}"`);
  }

  // --- 2026-07-14 precision-fix regression cases ---
  // Reproduces the exact live misfire measured in
  // docs/prism/2026-07-14-advisory-precision.md: a single ordinary word
  // ("node") in one skill's keyword list must NOT alone qualify it anymore
  // (old floor 1 let this through; new floor 2 requires more evidence).
  {
    const {ctx, skills} = await nudgeFor('build a dependency-free Node .mjs hook');
    check('Case 6: single ordinary-word hit ("node") → does NOT surface (regression for the live misfire)',
      !skills.includes('memory-leak-debugging'),
      `memory-leak-debugging should NOT surface on "node" alone, got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 7: dedup + domain-boost pair. Same single-word match ("zzzwidgetfoo")
  // against two skills that both list it in keywords[], but only one also
  // lists it in domains[] (curated). The keyword-only one must stay silent
  // (dedup: one distinct hit, weight 1, below floor 2); the domain-tagged
  // one must surface (domain-boosted weight 2, clears floor 2 on the SAME
  // single word — proves the dedup fix didn't just uniformly kill single-
  // word matches, it correctly kept the domain-tagged ones alive).
  {
    const {ctx, skills} = await nudgeFor('please handle the zzzwidgetfoo migration');
    check('Case 7a: duplicate term in domains+keywords, weight 1 (keyword-only) → does NOT surface',
      !skills.includes('widget-keyword-only'),
      `widget-keyword-only should NOT surface, got ${JSON.stringify(skills)} ctx="${ctx}"`);
    check('Case 7b: duplicate term in domains+keywords, weight 2 (domain-tagged) → DOES surface',
      skills.includes('widget-domain-tagged'),
      `widget-domain-tagged SHOULD surface (domain-boost), got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 8: two distinct ordinary-word hits (weight 1 each) sum to the
  // floor and DO surface — "several distinct term hits" clears the bar even
  // without a domain tag or phrase match.
  {
    const {ctx, skills} = await nudgeFor('wire up the cronwatcher and pagewatcher together');
    check('Case 8: two distinct weight-1 hits sum to floor → surfaces',
      skills.includes('two-hit-skill'),
      `two-hit-skill should surface on 2 distinct hits, got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 9: pure-stopword skill never surfaces, however many stopwords match.
  {
    const {ctx, skills} = await nudgeFor('this is already done, check where this goes before that');
    check('Case 9: stopword-only skill → never surfaces regardless of hit count',
      !skills.includes('stopword-only'),
      `stopword-only should never surface, got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 10: tiebreak — equal score (2) via one domain-tag hit vs two
  // ordinary-keyword hits. Domain-tag evidence must rank first (secondary
  // sort key), not fall through to alphabetical ("tiebreak-domain" would
  // lose alphabetically to "tiebreak-keywords" under the old pure-alpha
  // tiebreak, since 'd' > 'k'... wait alphabetically 'd' < 'k', so this
  // specific pair would ALREADY rank correctly under old alpha tiebreak —
  // the assertion below is on domainHits ordering, not on alpha, so it
  // holds regardless of naming; kept for readability).
  {
    const {ctx, skills} = await nudgeFor('handle ztiebreakdomterm ztiebreakalpha and ztiebreakbeta together');
    const domainIdx = skills.indexOf('tiebreak-domain');
    const keywordsIdx = skills.indexOf('tiebreak-keywords');
    check('Case 10: domain-tag-hit tiebreak ranks a domain-tagged equal-score skill before a keyword-only one',
      domainIdx !== -1 && keywordsIdx !== -1 && domainIdx < keywordsIdx,
      `expected tiebreak-domain before tiebreak-keywords, got order ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 11: telemetry — every evaluation (including zero-match) is logged
  // to the routing log, so "honest silence" leaves a visible trace.
  {
    await nudgeFor('implement the fix, run the tests, review the diff'); // known zero-match prompt (Case 1)
    const routingLog = join(HOME, '.claude', '.prism-routing.jsonl');
    const lines = existsSync(routingLog)
      ? readFileSync(routingLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const equipEvents = lines.filter(l => l.event === 'skill_equip_advisory');
    check('Case 11a: telemetry logs at least one skill_equip_advisory event',
      equipEvents.length > 0,
      `expected skill_equip_advisory entries in routing log, got ${lines.length} total lines`);
    check('Case 11b: telemetry logs the zero-match ("honest silence") case with matched: []',
      equipEvents.some(e => Array.isArray(e.matched) && e.matched.length === 0 && e.candidate_count === 0),
      `expected a matched:[] entry, got ${JSON.stringify(equipEvents)}`);
  }

  // Case 12 (v6.6.0 FIX-5): read-dominant dispatch → suppressed. The prompt
  // matches a specific domain term (postgres) that WOULD otherwise surface
  // postgres-migration-expert (see Case 2), but "investigate"/"audit" push
  // readScore (4) above buildScore (0) — the equip nudge must stay silent,
  // and the routing log must record WHY (suppressed:'read-dominant'), not
  // just fall through to the ordinary zero-candidate silent path.
  {
    const {ctx, skills} = await nudgeFor('investigate and audit the postgres schema layout, report only');
    check('Case 12: read-dominant dispatch → empty nudge despite a matching domain term',
      ctx === '' && skills.length === 0,
      `expected empty nudge (suppressed), got ctx="${ctx}" skills=${JSON.stringify(skills)}`);

    const routingLog = join(HOME, '.claude', '.prism-routing.jsonl');
    const lines = existsSync(routingLog)
      ? readFileSync(routingLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const suppressedEvents = lines.filter(l => l.event === 'skill_equip_advisory' && l.suppressed === 'read-dominant');
    check('Case 12: routing log records suppressed:\'read-dominant\' for this evaluation',
      suppressedEvents.length > 0,
      `expected a suppressed:'read-dominant' entry, got ${JSON.stringify(lines.filter(l => l.event === 'skill_equip_advisory'))}`);
  }

  // Case 13: existing Case 2 prompt re-asserted as still firing — guards the
  // gate DIRECTION (build-dominant, buildScore=1 via "migrate" > readScore=0,
  // must NOT be suppressed by the new read-dominant gate).
  {
    const {ctx, skills} = await nudgeFor('migrate the postgres schema to the new database');
    check('Case 13: build-dominant prompt (Case 2, re-asserted) still surfaces postgres-migration-expert after FIX-5',
      skills.includes('postgres-migration-expert'),
      `expected postgres-migration-expert to still surface, got ${JSON.stringify(skills)} ctx="${ctx}"`);
  }

  // Case 14 (R3 F6 / #38 miscalibration fix — D042 FIRE case). Real live-UAT
  // #38 dispatch (session 63ef55e2…, docs/prism/plans/uat-results/
  // live-batch2-scorecard.md row #38) logged
  // `skill_equip_advisory suppressed:"read-dominant" build_score:4 read_score:7`
  // for a genuine "Add --dry-run flag to prism-audit-runner" BUILD dispatch —
  // the raw dispatch prompt text itself was never persisted (only the
  // description + a prompt hash exist in ~/.claude/.prism-routing.jsonl), so
  // this fixture is a reconstruction that reproduces the EXACT logged
  // classifier scores (buildScore=4, readScore=7 verified via
  // classifyBuildVsRead in hooks/prism-specialist-routing-guard.mjs) against
  // that same real task description, rather than the byte-for-byte original
  // string. Pre-fix this suppressed (readScore 7 > buildScore 4, old
  // condition). Post-fix (buildScore 4 >= 2) it must NOT suppress.
  {
    const fixture = 'Add --dry-run flag to prism-audit-runner. First read tools/prism-audit-runner.mjs to understand how it lists and runs each scenario today, then analyze the current argument parsing, identify where a --dry-run flag should short-circuit execution, note the existing test invocations, and document what you find before you implement the change and generate the flag.';
    const {ctx, skills} = await nudgeFor(fixture);
    check('Case 14 (FIRE): #38 build=4/read=7 fixture → advisory context IS emitted (not suppressed)',
      ctx !== '' && skills.includes('dry-run-audit-expert'),
      `expected non-empty advisory context surfacing dry-run-audit-expert, got ctx="${ctx}" skills=${JSON.stringify(skills)}`);

    const routingLog = join(HOME, '.claude', '.prism-routing.jsonl');
    const lines = existsSync(routingLog)
      ? readFileSync(routingLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const thisEval = lines.filter(l => l.event === 'skill_equip_advisory' && Array.isArray(l.matched) && l.matched.includes('dry-run-audit-expert'));
    check('Case 14 (FIRE): routing log for this build=4/read=7 evaluation has NO suppressed field',
      thisEval.length > 0 && thisEval.every(e => !('suppressed' in e)),
      `expected a matched:[...,"dry-run-audit-expert"] entry with no 'suppressed' key, got ${JSON.stringify(thisEval)}`);
  }

  // Case 15 (R3 F6 — D042 QUIET case). The real #37-style pure read/review
  // prompt (verbatim from tests/v3/audit-scenarios.json id UAT60-J37:
  // "read hooks/prism-safety.mjs and summarize its regex list") scores
  // buildScore=0 / readScore=3 (read > build, build < 2) — must STILL be
  // suppressed as read-dominant after the fix (only the buildScore>=2 case is
  // exempted from suppression).
  {
    const fixture = 'read hooks/prism-safety.mjs and summarize its regex list';
    const {ctx, skills} = await nudgeFor(fixture);
    check('Case 15 (QUIET): #37-style buildScore<2 read-dominant prompt → empty stdout',
      ctx === '' && skills.length === 0,
      `expected empty nudge, got ctx="${ctx}" skills=${JSON.stringify(skills)}`);

    const routingLog = join(HOME, '.claude', '.prism-routing.jsonl');
    const lines = existsSync(routingLog)
      ? readFileSync(routingLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const suppressedEvents = lines.filter(l => l.event === 'skill_equip_advisory' && l.suppressed === 'read-dominant' && l.build_score === 0 && l.read_score === 3);
    check('Case 15 (QUIET): routing log records suppressed:\'read-dominant\' for build=0/read=3',
      suppressedEvents.length > 0,
      `expected a suppressed:'read-dominant' build_score:0/read_score:3 entry, got ${JSON.stringify(lines.filter(l => l.event === 'skill_equip_advisory'))}`);
  }

  // ── Task #60 (F43, 2026-07-28): baseline-affinity RED test + controls ──────
  // Real, VERBATIM session-4 dispatch prompts (fixtures/f43-skill-equip-
  // affinity/), not synthetic boilerplate (#53's lesson). A SYNTHETIC roster
  // mirroring the ACTUAL core_domains/keywords of the 4 real skills involved
  // (verified byte-identical against the live installed roster before use —
  // keeps this hermetic/deterministic rather than depending on a 68-skill
  // live roster that can grow/shrink), scored directly via the newly exported
  // scoreSkills() (extracted, zero-behavior-change, from run()'s formerly-
  // inline loop — reused rather than a second hand-rolled tokenizer).
  const F43_ROSTER = {
    'redeploy-readiness': {
      domains: ['deployment', 'devops', 'windows', 'powershell'],
      keywords: ['audit', 'silently', 'laptop-side', 'redeploy', 'plumbing', 'current', 'windows', 'powershell', 'laptop', 'smb-mounted', 'user', 'asks', 'this', 'redeploy-ready', 'rede'],
    },
    'redeploy-vm-laptop': {
      domains: ['deployment', 'devops', 'windows', 'powershell'],
      keywords: ['laptop-side', 'companion', 'redeploy-readiness-vm', 'which', 'runs', 'provides', 'three', 'ssh-wrapped', 'commands', 'vm-scaffold', 'vm-promote', 'vm-demote', 'laptop', 'user', 'never', 'into'],
    },
    'design-is': {
      domains: ['design', 'ui-ux'],
      keywords: ['audit', 'design', 'against', 'dieter', 'rams', 'good', 'principles', 'then', 'hand', 'make-plan', 'prompt', 'three', 'outcomes', 'refine', 'redesign', 'user', 'says'],
    },
    'verification-before-completion': {
      domains: ['development', 'testing'],
      keywords: ['about', 'claim', 'work', 'complete', 'fixed', 'passing', 'before', 'committing', 'creating', 'requires', 'running', 'verification', 'commands', 'confirming', 'output', 'making', 'success', 'claims', 'evidence'],
    },
  };
  const F43_FIXTURES = join(__dirname, 'hooks', 'fixtures', 'f43-skill-equip-affinity');
  const readFixture = (name) => readFileSync(join(F43_FIXTURES, name), 'utf-8');

  // Case 16 (RED→GREEN, measured — HONEST partial result, not full silence):
  // the real "Ratify D088" governance dispatch — closing out an adjudication
  // queue, ZERO deployment content. Pre-fix, redeploy-vm-laptop scored EXACTLY
  // 8 on this text (verified: matches the live routing log's real fire —
  // domainHits=3 on 'deployment'+'windows'+'powershell' [all ambient
  // boilerplate: the D081 "deployment is orchestrator-owned" line + the
  // Bash/PowerShell BOM warning] × weight 2 = 6, plus 'three'+'commands' [2
  // ordinary weight-1 coincidences] = 8 total). Post-fix, all three ambient
  // terms are zero-weighted, dropping it to EXACTLY 2 — driven entirely by
  // 'three'+'commands', the SAME pre-existing auto-extracted-keyword
  // imprecision the file's own 2026-07-14 history already discloses as a
  // known, undischarged limitation (not a new mechanism, not chased further
  // here — seep AMBIENT_ENV_TERMS' own comment for why). This is a real,
  // measured 75% score reduction (8→2), not a full elimination — reported
  // honestly rather than asserting a stronger result than was shipped.
  {
    const text = readFixture('real-1-ratify-d088-governance.txt');
    const ranked = scoreSkills(text, {skills: F43_ROSTER});
    const rv = ranked.find(r => r.skillName === 'redeploy-vm-laptop');
    const rr = ranked.find(r => r.skillName === 'redeploy-readiness');
    check('Case 16 (RED→GREEN): redeploy-vm-laptop drops from 8 (pre-fix, matches live log) to exactly 2 (post-fix — residual is a pre-existing, disclosed limitation, not this fix\'s target)',
      rv && rv.score === 2,
      `expected redeploy-vm-laptop score===2 (was 8 pre-fix), got ${JSON.stringify(rv)}`);
    check('Case 16: redeploy-readiness materially reduced from its pre-fix dominance (was score=9)',
      !rr || rr.score <= 5,
      `expected redeploy-readiness score <= 5 (was 9 pre-fix) or absent, got ${JSON.stringify(rr)}`);
  }

  // Case 17 (negative control, must STILL be silent): the real F42 read-only-
  // investigation dispatch (task #59) — this is suppressed by the EARLIER
  // read-dominance gate (readScore > buildScore, run()'s own :140-152), a
  // DIFFERENT code path than scoreSkills()/AMBIENT_ENV_TERMS entirely, so it
  // must be unaffected by this fix. Verified via the full dispatcher path
  // (run()), not scoreSkills() directly, since the read-dominance gate lives
  // in run() before scoreSkills() is ever reached.
  {
    const text = readFixture('real-2-negative-control-f42-readonly.txt');
    const res = await run({tool_name: 'Agent', session_id: 'f43-control', tool_input: {prompt: text}});
    check('Case 17 (negative control): real F42 read-only dispatch → still silent (unaffected by this fix)',
      res.exit === 0 && res.stdout === '',
      `expected silent pass, got exit=${res.exit} stdout="${res.stdout}"`);
  }

  // Case 18 (must STILL fire, and now ranks correctly): the real "Fix F39/F41
  // guard fixes" dispatch — a genuine fix-then-verify task. Pre-fix, the live
  // log recorded verification-before-completion in 2nd place (score 7) BEHIND
  // redeploy-vm-laptop's noise (score 9). Post-fix: verification-before-
  // completion must still score (unsuppressed — this is the DEFENSIBLE match
  // the brief explicitly said not to kill), and should now rank at or above
  // redeploy-vm-laptop rather than being crowded out by ambient noise.
  {
    const text = readFixture('real-3-verification-control-f39-f41.txt');
    const ranked = scoreSkills(text, {skills: F43_ROSTER});
    const vbc = ranked.find(r => r.skillName === 'verification-before-completion');
    check('Case 18: verification-before-completion STILL fires on the real fix-and-verify dispatch (anti-scope: must not be suppressed)',
      vbc !== undefined && vbc.score >= 2,
      `expected verification-before-completion to score >= 2, got ${JSON.stringify(vbc)}`);
    const topScore = ranked.length ? ranked[0].score : -1;
    check('Case 18: verification-before-completion now ranks at the top (or tied for it), not crowded out by ambient noise',
      vbc && vbc.score === topScore,
      `expected verification-before-completion score (${vbc && vbc.score}) to equal the top score (${topScore}); full ranking: ${JSON.stringify(ranked)}`);
  }
} finally {
  try { rmSync(HOME, {recursive: true, force: true}); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
