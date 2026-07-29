#!/usr/bin/env node
// prism-skill-equip-nudge.mjs — advisory (non-blocking) guard (D1 / F9).
// On every Agent dispatch, checks whether the dispatch prompt contains keywords
// that match a roster skill but does NOT reference the skill by name. If so,
// emits an additionalContext nudge reminding the orchestrator to equip the
// worker IN ITS PROMPT per phase-1-execution.md:124-133.
//
// Contract: ALWAYS exit 0, ALWAYS allow — purely advisory, never blocks.
// Pure-read, no side-effects, order-independent (safe for parallel Agent route).

import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {logAdvisory} from './lib/prism-advisory-log.mjs';
import {classifyBuildVsRead} from './prism-specialist-routing-guard.mjs';
import {prismHome} from './lib/prism-home.mjs';

const H = prismHome();

// F9 precision tuning. The old matcher raw-substring-matched every domain/
// keyword term against the prompt, so ultra-generic single words ("review",
// "debugging", "refactor", "tdd") flagged ~45 loosely-related skills per
// dispatch — noise. The new matcher (a) matches on WORD BOUNDARIES, (b) scores
// by term specificity, (c) zero-weights ultra-generic single words so they
// never alone qualify a skill, and (d) surfaces only the TOP N by score.
//
// 2026-07-14 precision fix (measured in docs/prism/2026-07-14-advisory-precision.md):
// F9's MIN_SKILL_SCORE=1 floor was real but trivially cleared, because
// roster.json's `keywords[]` is NOT curated — it's auto-tokenized from each
// skill's plugin description prose, filtered only against the ~30 CODING-
// generic words below. Ordinary English words that happen to appear in a
// description ("node", "session", "issues", "this") sat in real skills'
// keyword arrays at weight 1 and alone cleared the bar, e.g. "build a
// dependency-free Node .mjs hook" matched chrome-devtools' memory-leak-
// debugging skill on the bare word "node". Measured top-1 precision at
// MIN_SKILL_SCORE=1 was 31.6% (6/19) on a 20-prompt representative set.
// Three changes, validated against that same set (now 6/8 = 75% top-1,
// 8/8 = 100% any-of-top-3, among the prompts that still fire; the hook now
// stays silent on 12/20 instead of manufacturing a weak guess on 19/20):
//   1. MIN_SKILL_SCORE raised 1 -> 2. A single ordinary-word hit can no
//      longer alone qualify a skill — needs either a curated DOMAIN-tag hit
//      (weight 2, see domainTerms below), a phrase/hyphenated hit (weight 3,
//      unchanged), or two distinct ordinary-word hits.
//   2. Terms are now DEDUPED per skill before scoring (a term that appears
//      in both `domains[]` and `keywords[]` — common, since keywords are
//      auto-extracted from the same description domains[] summarizes —
//      no longer counts twice).
//   3. A small ENGLISH_STOPWORDS set (pure function words: "this", "from",
//      "where", "already"...) is zero-weighted alongside GENERIC_TERMS. This
//      is the SECONDARY fix — most misfires died from #1 alone; stopwording
//      closes the remaining case where two coincidental hits (one of them a
//      bare function word) summed past the raised floor on their own.
const MAX_NUDGE_SKILLS = 3;
const MIN_SKILL_SCORE = 2;  // a skill must clear this (specific overlap) to surface

// Single-word engineering terms so generic they substring-match almost any
// coding prompt. Weight 0 → cannot alone qualify a skill.
const GENERIC_TERMS = new Set([
  'review', 'reviews', 'code-review', 'debug', 'debugging', 'refactor',
  'refactoring', 'tdd', 'test', 'tests', 'testing', 'implement',
  'implementation', 'feature', 'features', 'bug', 'bugfix', 'fix', 'fixes',
  'code', 'coding', 'build', 'run', 'diff', 'agent', 'agents', 'task',
  'tasks', 'plan', 'planning', 'work', 'change', 'changes', 'update',
  'edit', 'file', 'files', 'check', 'verify', 'verification',
  'create', 'creates', 'created', 'creating', 'write', 'writes', 'writing',
]);

// Pure English function words (pronouns, prepositions, conjunctions,
// generic quantifiers/verbs) that show up in auto-extracted description
// prose but never denote a domain by themselves. Distinct from
// GENERIC_TERMS (which is coding-specific vocabulary) — this is general-
// English noise. Weight 0.
const ENGLISH_STOPWORDS = new Set([
  'this', 'that', 'these', 'those', 'here', 'there', 'where', 'when', 'why',
  'how', 'who', 'whom', 'whose', 'which', 'what', 'does', 'doing', 'done',
  'already', 'having', 'before', 'after', 'from', 'into', 'onto', 'upon',
  'about', 'above', 'below', 'under', 'over', 'through', 'during', 'without',
  'within', 'between', 'among', 'since', 'until', 'unless', 'while',
  'because', 'although', 'though', 'however', 'therefore', 'thus',
  'otherwise', 'instead', 'rather', 'whether', 'than', 'such', 'same',
  'other', 'another', 'each', 'every', 'both', 'either', 'neither', 'none',
  'much', 'many', 'most', 'less', 'least', 'own', 'its', 'their', 'your',
  'our', 'always', 'never', 'sometimes', 'often', 'once', 'again',
  'further', 'still', 'yet', 'also', 'even', 'just', 'only', 'quite',
  'very', 'really', 'actually', 'wants', 'wanted', 'uses', 'used', 'using',
]);

// F43 (task #60, 2026-07-28): AMBIENT ENVIRONMENT terms — words that appear as
// this REPO'S OWN recurring dispatch-safety boilerplate, not per-task domain
// content. MEASURED: the census's 3 dominant, near-invariant skills are
// redeploy-readiness / redeploy-vm-laptop (domains include 'windows',
// 'powershell') and design-is (domain 'design'). Verbatim from a real
// session-4 dispatch (fixtures/f43-skill-equip-affinity/real-1-ratify-d088.txt,
// the "Ratify D088" task — governance/adjudication work, ZERO deployment
// content): "Use the Edit/Write TOOLS for all file changes — never Bash/
// PowerShell redirection (`>`, Set-Content, Out-File default to UTF-8-with-
// BOM on Windows and will mangle these files)." This exact sentence (or a
// close paraphrase) opens NEARLY EVERY dispatch in this session regardless of
// task — it is a Windows-laptop operational safety warning, not deployment
// domain signal. Measured: this ONE sentence alone scores redeploy-readiness
// and redeploy-vm-laptop at score=4 (both 'windows' and 'powershell' are
// DOMAIN terms for those two skills, weight 2 each) on ANY prompt, including
// ones about coffee-ledger schema changes or pure math — invariant of
// content, which is exactly the "high baseline affinity" signature, not a
// mis-tuned-but-responsive scorer.
// MEASURED SESSION-WIDE (not just the one fixture): grepped all 11 real Agent
// dispatches in this session's transcript for these bare words — 'deployment'
// 7/11 (64%), 'windows' 7/11 (64%), 'powershell' 9/11 (82%). 'deployment'
// turned out to recur at the SAME rate for the SAME reason: the standing
// D081 boilerplate ("deployment is the orchestrator's single post-batch
// step... do NOT run the installer") appears in nearly every dispatch this
// repo issues, same structural cause as the Windows/PowerShell BOM warning —
// so it is included here too, NOT because "deployment" is generically
// meaningless (in another repo it would be a fine domain word), but because
// in THIS repo it is measurably ambient boilerplate, not per-task signal.
// 'devops' (this same skill pair's OTHER domain tag) does NOT recur this way
// and is left untouched — it is NOT part of any standing boilerplate here.
// SCOPED to these three measured terms, not a general env-vocabulary sweep.
// This is the SAME remedy shape D056 already shipped for the sibling guard
// (stoplist ambient repo-context tokens — 'claude'/'prism'/'code' there
// because this is a Claude/PRISM repo; these three here because this is a
// Windows-laptop repo with standing safety/deployment-ownership boilerplate).
//
// HONEST LIMIT (measured, not assumed): this does NOT fully silence
// redeploy-vm-laptop on the real-1 fixture (see tests/v3/skill-equip-nudge-
// precision.test.mjs Case 16) — its score there drops from 8 (pre-fix,
// matches the live log exactly) to 2 (post-fix: 'deployment'/'windows'/
// 'powershell' now zero-weighted, but 'three' + 'commands' are two ordinary,
// coincidentally-matching weight-1 words that independently sum to the
// floor). That residual is the SAME pre-existing, already-documented
// auto-extracted-keywords imprecision the 2026-07-14 fix-history comment
// above discloses ("not something a purely mechanical scorer can fully
// resolve without semantic understanding of the prompt") — not a new
// mechanism, and not chased further here to avoid an unbounded stoplist.
const AMBIENT_ENV_TERMS = new Set(['windows', 'powershell', 'deployment']);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Specificity weight: generic/stopword single words → 0; multi-word /
// hyphenated phrase terms → 3 (a phrase hit is strong on its own — real
// alternation/co-occurrence, not incidental); a single word that is one of
// the skill's own CURATED domain[] tags → 2 (domains[] is a short,
// deliberately-assigned category list, unlike keywords[] which is auto-
// extracted from free-text prose — a domain-tag hit is materially stronger
// evidence than a random description word); any other ordinary single
// word → 1 (weak on its own; needs a second distinct hit to clear the
// floor). Ultra-short tokens (<=3 chars) → 0.
function termWeight(term, isDomainTerm) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return 0;
  if (GENERIC_TERMS.has(t) || ENGLISH_STOPWORDS.has(t) || AMBIENT_ENV_TERMS.has(t)) return 0;
  if (/[\s-]/.test(t)) return 3;
  if (t.length <= 3) return 0;
  return isDomainTerm ? 2 : 1;
}

// Word-boundary match (treats non-alphanumerics — incl. hyphens — as
// boundaries) against an already-lowercased prompt. NOT a raw substring test.
function matchesWord(term, lowerPrompt) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  const re = new RegExp('(?:^|[^a-z0-9])' + escapeRe(t) + '(?:$|[^a-z0-9])');
  return re.test(lowerPrompt);
}

// F43 (task #60, 2026-07-28): pure extraction of the scoring/ranking loop
// (previously inline in run(), lines ~166-228) into a standalone, directly
// testable, EXPORTED function — zero behavior change (verified against the
// full existing test suite before/after). Reused rather than re-derived: this
// IS the "68-skill scored[] pool" the task #60 brief asked to evaluate for
// reuse before hand-rolling a second tokenizer for measurement/testing.
// Returns the FULL ranked array (every skill scoring >= MIN_SKILL_SCORE), not
// just the top-N slice run() nudges on — callers that need the full ranking
// (baseline-affinity measurement, precision tests) get it directly instead of
// reconstructing it from routing-log top-3 telemetry.
export function scoreSkills(rawPrompt, roster) {
  const prompt = String(rawPrompt || '').toLowerCase();
  if (!roster || !roster.skills) return [];

  const scored = [];
  for (const [skillName, entry] of Object.entries(roster.skills)) {
    if (!entry || typeof entry !== 'object') continue;
    // domains[] is the skill's curated category list (short, deliberate) —
    // a term match against it is stronger evidence than a keywords[] match
    // (auto-extracted from free-text description prose).
    const domainTerms = new Set(
      (Array.isArray(entry.domains) ? entry.domains : [])
        .map(d => String(d || '').toLowerCase().trim())
        .filter(Boolean)
    );

    // Collect keyword terms from domains + keywords arrays + skill name's last segment
    const termsRaw = [];
    if (Array.isArray(entry.domains)) termsRaw.push(...entry.domains);
    if (Array.isArray(entry.keywords)) termsRaw.push(...entry.keywords);
    // Last segment of the skill name (e.g. "test-driven-development" from "superpowers:test-driven-development")
    const lastSegment = skillName.includes(':') ? skillName.split(':').pop() : skillName;
    termsRaw.push(lastSegment);

    // Dedup — the same term commonly appears in BOTH domains[] and
    // keywords[] (keywords is extracted from the same description domains
    // summarizes), which previously double-counted a single piece of
    // evidence as if it were two independent hits.
    const terms = [...new Set(termsRaw.map(t => String(t || '').toLowerCase().trim()).filter(Boolean))];

    // Score by specificity of WORD-BOUNDARY matches. Generic/stopword single
    // words contribute 0, so a skill matched only on "review"/"this" scores
    // 0 and is dropped. domainHits/distinctHits are tracked for tiebreak.
    let score = 0, domainHits = 0, distinctHits = 0;
    for (const t of terms) {
      if (!matchesWord(t, prompt)) continue;
      const isDomainTerm = domainTerms.has(t);
      const w = termWeight(t, isDomainTerm);
      if (w > 0) {
        score += w;
        distinctHits++;
        if (isDomainTerm) domainHits++;
      }
    }
    const skillInPrompt = String(rawPrompt || '').includes(skillName);

    if (score >= MIN_SKILL_SCORE && !skillInPrompt) {
      scored.push({skillName, score, domainHits, distinctHits});
    }
  }

  // Rank by score (desc), then by domain-tag-hit count (desc — prefer a
  // skill whose evidence came from its curated domains[] over one that only
  // matched auto-extracted keywords[]), then by distinct-term-hit count
  // (desc), then alphabetical as the final deterministic fallback. Keep top
  // N only. NOTE: alphabetical can still decide a genuine tie between two
  // equally-weak, equally-generic-provenance matches (e.g. two unrelated
  // skills that each hit exactly 2 ordinary keywords) — that residual case
  // is a real, disclosed limitation (see docs/prism/2026-07-14-advisory-
  // precision.md §"tiebreak"), not something a purely mechanical scorer can
  // fully resolve without semantic understanding of the prompt.
  scored.sort((a, b) =>
    (b.score - a.score) ||
    (b.domainHits - a.domainHits) ||
    (b.distinctHits - a.distinctHits) ||
    a.skillName.localeCompare(b.skillName)
  );

  return scored;
}

export async function run(payload) {
  const allow = (ctx) => ({
    exit: 0,
    stdout: ctx
      ? JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: ctx}})
      : '',
    stderr: '',
  });

  // Only act on Agent dispatches
  if (!payload || payload.tool_name !== 'Agent') return allow('');

  const rawPrompt = (payload.tool_input && payload.tool_input.prompt) || '';

  // FIX-5 (v6.6.0): suppress on read-dominant dispatches. Live routing log
  // showed a 77% fire rate (132/172 evals) because this hook fires on ANY
  // Agent dispatch regardless of build/read class — a read-only analysis/
  // scan/extract worker gets the same equip nudge as a build worker, even
  // though skill injection is skippable for pure reads. `readScore >
  // buildScore` (not a hard isBuild-required gate) is the verified-safe
  // subset: a hard build-only gate breaks precision-test Cases 4 and 10
  // (neutral prompts, buildScore 0 / readScore 0, that must still nudge).
  const cls = classifyBuildVsRead(rawPrompt);
  if (cls.readScore > cls.buildScore && cls.buildScore < 2) {
    logAdvisory({
      event: 'skill_equip_advisory',
      session_id: payload.session_id || null,
      matched: [],
      scores: [],
      candidate_count: 0,
      suppressed: 'read-dominant',
      build_score: cls.buildScore,
      read_score: cls.readScore,
    });
    return allow('');
  }

  // Read roster — fail-open on any error
  let roster = null;
  try {
    const rosterPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    if (!existsSync(rosterPath)) return allow('');
    roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  } catch {
    return allow('');
  }

  if (!roster || !roster.skills) return allow('');

  const scored = scoreSkills(rawPrompt, roster);

  // Telemetry (F9.1 / 2026-07-14): log every evaluation — including the
  // zero-match case — so fire-rate and precision are measurable from
  // ~/.claude/.prism-routing.jsonl going forward instead of invisible. This
  // is the "honest silence" record: a logged matched:[] entry proves the
  // hook evaluated and found nothing, distinguishable from never running.
  // Logged AFTER sort so it reflects the actual ranked top-N, not scan order.
  logAdvisory({
    event: 'skill_equip_advisory',
    session_id: payload.session_id || null,
    matched: scored.slice(0, MAX_NUDGE_SKILLS).map(s => s.skillName),
    scores: scored.slice(0, MAX_NUDGE_SKILLS).map(s => s.score),
    candidate_count: scored.length,
  });

  if (scored.length === 0) return allow('');

  const missing = scored.slice(0, MAX_NUDGE_SKILLS).map(s => s.skillName);

  const msg = `PRISM skill-equip advisory (F9): the worker task matches ${missing.length === 1 ? 'relevant skill' : 'relevant skills'} ${missing.join(', ')}, but the dispatch prompt does not reference ${missing.length === 1 ? 'it' : 'them'}. Per phase-1-execution.md:124-133, equip the worker IN ITS PROMPT (inject the discipline / SKILL.md path) — do NOT tell the worker to "invoke the skill". Advisory only; dispatch proceeds.`;
  return allow(msg);
}

// Standalone mode (called directly, not via dispatcher)
if (process.argv[1] && process.argv[1].endsWith('prism-skill-equip-nudge.mjs')) {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf-8') || '{}');
    const result = await run(payload);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exit);
  } catch {
    process.exit(0);
  }
}
