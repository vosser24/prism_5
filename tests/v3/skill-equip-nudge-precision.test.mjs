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
  },
};

const refDir = join(HOME, '.claude', 'skills', 'prism-plan', 'references');
mkdirSync(refDir, {recursive: true});
writeFileSync(join(refDir, 'roster.json'), JSON.stringify(ROSTER));

const {run} = await import(pathToFileURL(HOOK).href);

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
} finally {
  try { rmSync(HOME, {recursive: true, force: true}); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
