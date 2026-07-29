#!/usr/bin/env node
// PRISM Specialist Routing Guard (v1.0.0) — PreToolUse on the `Agent` tool.
//
// PROBLEM (live-repro 2026-06-19): the parent orchestrator dispatched a
// frontend/UI BUILD task to subagent_type:'general-purpose' instead of the
// domain specialist. Generic agents re-derive the design system every dispatch,
// drift from domain conventions, and accumulate no durable knowledge. Doctrine
// already said "compose-first / hire specialists" — but nothing MECHANICALLY
// enforced it at the dispatch boundary. This guard does.
//
// WHAT IT DOES: when a BUILD/EDIT-class task is routed to a generic catch-all
// agent (general-purpose / claude / absent subagent_type) AND a matching roster
// specialist exists, it recommends the specialist (advisory) or blocks the
// dispatch (enforce). When the domain is known but NO specialist exists yet, it
// nudges to hire one via @agent-factory. READ-ONLY recon to general-purpose is
// never touched — that is the correct use of a generic agent.
//
// DESIGN (grounded in the existing guard surface, not the proposal's prose):
//   • Dual-mode: export run(payload)→{exit,stdout,stderr} for the consolidated
//     PreToolUse dispatcher; standalone shim at the bottom for direct use/tests.
//   • Specialist source of truth = roster.agents matched on `core_domains`
//     (the field that ALREADY exists — no parallel domain_keywords array).
//     Archived / dead-status agents are skipped (red-team S3; the status
//     vocabulary was widened from the single literal 'available' to
//     LIVE_STATUSES by task #54 — see that block for the census).
//   • Three-path subagent-context bypass, identical to agent-model-guard /
//     parent-dispatch-guard (red-team S4): a subagent spawning a subagent is
//     not re-gated by parent rules.
//   • Override is reachable: sentinel.force_gp (set from the `!gp-force:` prompt
//     prefix by prism-prompt-tier-router via the classifier — red-team C1), or
//     PRISM_SPECIALIST_GUARD=off. ONE tri-state env var, not two (red-team S5).
//   • Deny is signalled with permissionDecision:'deny' JSON + exit 2 (the
//     parent-dispatch-guard convention). The dispatcher's normalize() unifies it.
//   • Build-vs-read classifier biased toward SILENCE (red-team / proposal §5.3,
//     §11): build-class requires build_score > read_score. False-silence is
//     safer than false-block for a guard that can deny.
//   • FAIL-OPEN: any throw → allow (exit 0). A guard bug must never brick a
//     dispatch (top-level try/catch + per-helper guards).
//
// Modes (PRISM_SPECIALIST_GUARD env var, defaults to advisory):
//   off:      pass-through (no-op).
//   advisory: nudge only (additionalContext), exit 0 — never blocks. DEFAULT.
//   enforce:  block a confident build-class-to-generic-with-specialist dispatch
//             (deny JSON + exit 2); weak matches / no-specialist stay nudges.
//
// ── Compose-first guard (Package G enforcement) ─────────────────────────────
// A SEPARATE, independent check bolted onto this same Agent-dispatch guard
// (it already owns "route to an existing capability instead of a generic /
// new one"). It fires ONLY when the dispatch CREATES a new capability, i.e.
// subagent_type === 'agent-factory' — that is the "building on the fly"
// boundary. It reminds the master that a full CAPABILITY CATALOG was injected
// at session start and to confirm nothing existing covers the need first.
//
// Modes (PRISM_COMPOSE_GUARD env var, defaults to advisory — INDEPENDENT of
// PRISM_SPECIALIST_GUARD above):
//   off:      no compose behavior at all (pass-through).
//   advisory: nudge only (additionalContext), exit 0 — never blocks. DEFAULT.
//   enforce:  DENY the agent-factory dispatch (deny JSON + exit 2) UNLESS the
//             override token '!build-new-force:' appears in the dispatch
//             description/prompt. Override present → allow + nudge.
// Behavior is NEUTRAL for every non-agent-factory dispatch in all modes.

import {readFileSync, existsSync, appendFileSync, mkdirSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {prismHome} from './lib/prism-home.mjs';

const H = prismHome();
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE_RAW = String(process.env.PRISM_SPECIALIST_GUARD || 'advisory').toLowerCase();
const MODE = ['off', 'advisory', 'enforce'].includes(MODE_RAW) ? MODE_RAW : 'advisory';

// Compose-first guard (Package G) — independent tri-state, own env var.
const COMPOSE_MODE_RAW = String(process.env.PRISM_COMPOSE_GUARD || 'advisory').toLowerCase();
const COMPOSE_MODE = ['off', 'advisory', 'enforce'].includes(COMPOSE_MODE_RAW) ? COMPOSE_MODE_RAW : 'advisory';
const COMPOSE_OVERRIDE_TOKEN = '!build-new-force:';

// Generic catch-all subagent types. Anything else (a named specialist, fork,
// master-orchestrator, etc.) is exempt — the parent already chose a non-generic
// agent, which is exactly what we want.
const GENERIC_TYPES = new Set(['general-purpose', 'claude', 'unknown', '']);

// ── Build-vs-read classifier ────────────────────────────────────────────────
// Weighted phrase scorer. Multi-word / strongly-imperative build phrases weigh
// 2; generic verbs weigh 1. Strong recon signals weigh 2. Word-boundary matched
// so "sccomponent" can't match "component". Biased to silence: a tie or
// read>=build → NOT build-class (the guard stays quiet).
const BUILD_SIGNALS = [
  [/\bbuild the\b/, 2], [/\bimplement the\b/, 2], [/\bcreate (a |an |the )?component\b/, 2],
  [/\bbuild the ui\b/, 2], [/\bdesign system\b/, 2], [/\badd (a |an |the )?(feature|endpoint|component|screen|page|route|migration)\b/, 2],
  [/\bwire up\b/, 2], [/\bredesign\b/, 2], [/\brestyle\b/, 2], [/\bscaffold\b/, 2],
  [/\bbuild\b/, 1], [/\bimplement\b/, 1], [/\bcreate\b/, 1], [/\bwrite the\b/, 1],
  [/\bedit\b/, 1], [/\brefactor\b/, 1], [/\bfix the (bug|issue|error)\b/, 1],
  [/\bmigration\b/, 1], [/\bmigrate\b/, 1], [/\bcomponent\b/, 1], [/\bgenerate\b/, 1],
  [/\bintegrate\b/, 1], [/\bdevelop\b/, 1], [/\badd (an? )?\b/, 1], [/\bstyling\b/, 1],
];
const READ_SIGNALS = [
  [/\bread-only\b/, 2], [/\binvestigate\b/, 2], [/\baudit\b/, 2], [/\bmap (the|out|all)\b/, 2],
  [/\brecon\b/, 2], [/\benumerate\b/, 2], [/\bwhere is\b/, 2], [/\btrace\b/, 2],
  [/\bsearch\b/, 1], [/\bfind\b/, 1], [/\blocate\b/, 1], [/\bsummari[sz]e\b/, 1],
  [/\banaly[sz]e\b/, 1], [/\blist\b/, 1], [/\bread\b/, 1], [/\bdocument\b/, 1],
  [/\binspect\b/, 1], [/\bexplain\b/, 1], [/\bidentify\b/, 1], [/\bcompare\b/, 1],
  [/\bgather\b/, 1], [/\breview\b/, 1], [/\bmap\b/, 1],
];

function scoreSignals(text, signals) {
  let s = 0;
  for (const [re, w] of signals) { if (re.test(text)) s += w; }
  return s;
}

// ── Negation lookback (task #32, 2026-07-28) ────────────────────────────────
// BUILD_SIGNALS was NEGATION-BLIND: `\bcreate\b` scored +1 on "do NOT create a
// branch", `\badd (an? )?\b` on "a blanket add ... is explicitly forbidden".
// Dispatch prompts are dense with prohibitions ("do NOT create", "never add",
// "avoid ... without"), so an explicitly FORBIDDEN build verb inflated
// buildScore exactly like a requested one. Measured on the real logged FP
// fixture fixtures/t32-specialist-routing-fp/fp-1-git-commit-dispatch.txt
// (a pure `git commit` task): build 4 → 3, with `\bcreate\b` correctly
// suppressed on "do not create".
//
// ASYMMETRIC ON PURPOSE — build signals only, NOT read signals. The file
// header states the governing bias: "Build-vs-read classifier biased toward
// SILENCE (red-team / proposal §5.3, §11) ... False-silence is safer than
// false-block for a guard that can deny." Suppressing a negated BUILD verb
// only ever LOWERS buildScore → strictly toward silence (safe). Suppressing a
// negated READ verb would only ever RAISE the build lean → strictly toward
// more firing, against that bias. Measured cost of the symmetric variant on
// tp-1-etimedout-dispatch.txt: read 4 → 2 (it suppresses "not even read-only",
// a constraint clause) — a real accuracy gain in isolation, but it pushes a
// TRUE-positive-adjacent text further build-ward for no fired-behaviour
// benefit. Not shipped. Revisit only with a fixture where it changes isBuild.
//
// A signal scores if it has AT LEAST ONE non-negated occurrence — so text with
// no negation at all scores byte-identically to the pre-#32 scorer (verified:
// tp-1 build=5/read=4 and fp-2 build=1/read=0 are unchanged).
const NEGATION_RE = /\b(?:not|never|dont|doesnt|didnt|cannot|cant|avoid|without|forbidden|refuses?|refused|skip)\b|\bno\s+(?:need|longer)\b/;
const NEGATION_WINDOW = 40; // chars of lookback before the matched verb

function scoreSignalsNegationAware(text, signals) {
  let s = 0;
  for (const [re, w] of signals) {
    // Fresh global clone per call — never mutate the shared literal's lastIndex.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text)) !== null) {
      const pre = text.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index);
      if (NEGATION_RE.test(pre)) continue; // explicitly forbidden → not build intent
      s += w;
      break; // weight counts once per signal, matching the pre-#32 semantics
    }
  }
  return s;
}

// Returns {isBuild, buildScore, readScore}. isBuild only when build strictly
// outweighs read AND clears a floor of 1 (biased to silence).
export function classifyBuildVsRead(text) {
  const t = String(text || '').toLowerCase();
  const buildScore = scoreSignalsNegationAware(t, BUILD_SIGNALS);
  const readScore = scoreSignals(t, READ_SIGNALS);
  return {isBuild: buildScore >= 1 && buildScore > readScore, buildScore, readScore};
}

// ── Built-in domain map (the "known domain, maybe no specialist" fallback) ──
// Only used to decide whether a build task lands in a domain a specialist SHOULD
// own. Multi-word phrases (weight 2) make a confident hit on their own.
const DOMAINS = {
  'frontend/ui': [['design system', 2], ['ui/ux', 2], ['component', 1], ['frontend', 2], ['react', 1], ['tsx', 1], ['tailwind', 1], ['styling', 1], ['layout', 1], ['wizard', 1], ['screen', 1]],
  'backend/api': [['endpoint', 1], ['django', 2], ['drf', 2], ['rest api', 2], ['serializer', 2], ['api route', 2], ['backend', 2], ['viewset', 2]],
  'database/schema': [['migration', 1], ['schema', 1], ['database', 1], ['sql', 1], ['index', 1], ['orm model', 2]],
  'scraping/extraction': [['scrape', 2], ['scraping', 2], ['crawler', 2], ['extraction', 1], ['selector', 1]],
  'matching/record-linkage': [['record linkage', 2], ['record-linkage', 2], ['fuzzy match', 2], ['dedup', 1], ['entity resolution', 2]],
  'data-pipeline/elt': [['pipeline', 1], ['elt', 2], ['etl', 2], ['ingest', 1], ['transform', 1]],
  'deploy/watchdog': [['watchdog', 2], ['deploy', 1], ['scheduled task', 2], ['redeploy', 2]],
};

function matchDomain(text) {
  const t = String(text || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const [domain, terms] of Object.entries(DOMAINS)) {
    let score = 0;
    for (const [term, w] of terms) {
      // word-ish boundary: term surrounded by non-alphanumerics or string edges
      const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (re.test(t)) score += w;
    }
    if (score > bestScore) { bestScore = score; best = domain; }
  }
  return best ? {domain: best, score: bestScore} : null;
}

// ── Roster specialist matcher ───────────────────────────────────────────────
export function loadRoster() {
  try {
    const p = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// D056 (2026-07-21): ambient/generic name-segment tokens that are NEVER
// a domain signal, dropped when mining match-terms out of a specialist's own
// NAME (agentTerms below). Two classes:
//   - Repo-ambient nouns: this repo is literally "prism" tooling for "claude"
//     code — those two words appear in the majority of task descriptions
//     regardless of domain, so a name segment 'claude' or 'prism' (e.g.
//     'claude-master', 'prism-updater') false-matches almost everything.
//     'code' is the same story — near-universal in a coding-tool repo,
//     carries no domain signal on its own.
//   - Generic agent-role nouns: describe WHAT KIND of agent it is, not what
//     DOMAIN it owns (any specialist could be an -engineer/-expert/-updater).
//     'agent'/'expert'/'engineer'/'specialist'/'master' were already filtered
//     pre-D056; 'updater' and 'assistant' are the same category, added now.
// Deliberately NOT included: 'pro' — never reaches this filter in practice
// (the name-segment path already requires length>=4 before this check, and
// no live roster name segments to a bare 'pro'), so adding it here would be
// a no-op; and genuinely domain-bearing short/common words (html, email,
// django, greek, security, ...) are kept OUT of this list on purpose.
const STOPLIST = new Set([
  'claude', 'prism', 'code',
  'agent', 'expert', 'engineer', 'specialist', 'master', 'updater', 'assistant',
]);

function agentTerms(name, entry) {
  const terms = [];
  if (Array.isArray(entry.core_domains)) terms.push(...entry.core_domains);
  // Honor an explicit domain_keywords array IF a future install adds one, but do
  // not require it (core_domains is the canonical field).
  if (Array.isArray(entry.domain_keywords)) terms.push(...entry.domain_keywords);
  // Name segments (split on - and :), drop short/noise tokens.
  for (const seg of String(name).split(/[:\-]/)) {
    if (seg.length >= 4 && !STOPLIST.has(seg.toLowerCase())) {
      terms.push(seg);
    }
  }
  return terms.map(t => String(t || '').toLowerCase()).filter(t => t.length >= 3);
}

// ── Roster status vocabulary (task #54 / F37, 2026-07-28) ───────────────────
// The candidate filter was `entry.status && entry.status !== 'available'` —
// a single-literal string equality. MEASURED against the INSTALLED roster
// (C:\Users\devuser\.claude\skills\prism-plan\references\roster.json — the copy
// that actually drives dispatch; the REPO skeleton at
// skills/prism-plan/references/roster.json is a deliberately EMPTY fresh-install
// template and carries no status values at all), 21 agents:
//     "available" × 19,  "active" × 1 (claude-master),  field absent × 1
//     (marketing-production-ops-specialist).
// So `claude-master` — 37 completed tasks, last used 2026-07-27 — was SILENTLY
// excluded from every routing suggestion.
//
// WHY THIS IS NOT A ONE-LINE STRING SWAP: the writers disagree, so no single
// literal is correct.
//   tools/prism-roster.mjs:142            → writes 'upgrade_needed'
//   tools/prism-roster.mjs:185            → 'upgrade_needed' → 'active'
//   tools/prism-capability-learn.mjs:244  → 'upgrade_needed' → 'active'
//   hooks/prism-agent-write-register.mjs:182 → writes the stub with NO status
//                                              field at all (→ undefined)
// No shipped .mjs writer in this repo emits the literal 'available' at all
// (grepped tools/ + hooks/: the only 'available' producers are unrelated —
// prism-task-api-probe.mjs:218 and this file). The 19 'available' values are
// legacy/prose-authored. Changing the literal to 'active' would break the other
// 19; the fix-class is a LIVE-STATE SET, not a different string.
//
// D046 (Locked) — an omissive failure is fixed by making misses LOUD, never by
// silently widening a parser. So this is an explicit ALLOW-list, not a
// deny-list: an unknown future status still excludes (fail-closed), but
// statusCensus() below counts and names every excluded value and run() puts it
// on the routing-log line, so the NEXT silent exclusion is measurable from the
// log alone instead of requiring archaeology.
//
// 'upgrade_needed' is LIVE on purpose: prism-roster.mjs:142 sets it as an
// upgrade FLAG on a working agent and :185 clears it after the upgrade — the
// agent is dispatchable throughout. Excluding it would create exactly the
// silent-exclusion class this fix removes.
//
// NOT included (genuinely dead): 'archived', 'retired'. `archived === true`
// remains a separate boolean check — both paths are kept, they are different
// fields.
export const LIVE_STATUSES = new Set(['available', 'active', 'upgrade_needed']);

export function isLiveStatus(entry) {
  if (!entry || entry.status === undefined || entry.status === null || entry.status === '') return true;
  return LIVE_STATUSES.has(String(entry.status).toLowerCase());
}

// D046 instrumentation: how many non-archived roster entries this guard threw
// away purely on `status`, and which literal values did it. Emitted on every
// roster-consulting log line in run(). excluded_by_status > 0 with an
// unexpected value in excluded_statuses is the tripwire for the next
// vocabulary drift.
export function statusCensus(roster) {
  const out = {excluded_by_status: 0, excluded_statuses: []};
  try {
    if (!roster || !roster.agents || typeof roster.agents !== 'object') return out;
    const seen = new Set();
    for (const entry of Object.values(roster.agents)) {
      if (!entry || entry.archived === true) continue;
      if (isLiveStatus(entry)) continue;
      out.excluded_by_status++;
      seen.add(String(entry.status));
    }
    out.excluded_statuses = [...seen].sort();
  } catch {}
  return out;
}

// Returns {name, score, matchedTerms} of the best non-archived, live-status
// specialist whose domain terms appear in the task text, or null. score =
// count of distinct matched terms (a multi-word term counts as one strong
// hit). matchedTerms is the actual list of terms that matched, for
// post-hoc log inspection (D056 instrumentation) — not used for scoring.
export function matchSpecialist(text, roster) {
  if (!roster || !roster.agents || typeof roster.agents !== 'object') return null;
  const t = String(text || '').toLowerCase();
  let best = null, bestScore = 0, bestMatched = [];
  for (const [name, entry] of Object.entries(roster.agents)) {
    if (!entry || entry.archived === true) continue;
    if (!isLiveStatus(entry)) continue; // task #54 — LIVE_STATUSES set, not one literal
    // build_class:false means this specialist does NOT own build work — skip.
    if (entry.build_class === false) continue;
    const terms = agentTerms(name, entry);
    const matched = new Set();
    for (const term of terms) {
      const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (re.test(t)) matched.add(term);
    }
    if (matched.size > bestScore) { bestScore = matched.size; best = name; bestMatched = [...matched]; }
  }
  return best ? {name: best, score: bestScore, matchedTerms: bestMatched} : null;
}

// Returns up to `limit` {name,score} entries (score>=minScore), sorted desc.
// Unlike matchSpecialist it does NOT drop build_class===false agents — panel seats
// are frequently analysis/recon specialists. Reuses agentTerms so the term source
// stays single-sourced with matchSpecialist.
export function matchSpecialists(text, roster, {limit = 6, minScore = 1} = {}) {
  if (!roster || !roster.agents || typeof roster.agents !== 'object') return [];
  const t = String(text || '').toLowerCase();
  const hits = [];
  for (const [name, entry] of Object.entries(roster.agents)) {
    if (!entry || entry.archived === true) continue;
    if (!isLiveStatus(entry)) continue; // task #54 — LIVE_STATUSES set, not one literal
    const terms = agentTerms(name, entry);
    const matched = new Set();
    for (const term of terms) {
      const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (re.test(t)) matched.add(term);
    }
    if (matched.size >= minScore) hits.push({name, score: matched.size});
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}
function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}
function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

// PRISM task #32 (2026-07-28): the routing log previously carried ONLY the
// classifier's own output (build_score/read_score/action) — no field tied
// the event back to the originating dispatch text, so a false-positive
// (e.g. a trivial one-line edit nudged toward an irrelevant specialist)
// could NOT be identified from the log alone; it required archaeology
// (joining routing-log timestamps to session transcripts by hand — see
// docs/prism/plans/... T32 report). This computes a short, non-reversible
// fingerprint of the normalised dispatch text so future FPs are joinable
// to their originating dispatch WITHOUT transcript archaeology, while
// deliberately NEVER persisting the raw prompt/description text itself
// (privacy/log-bloat guard). Same normalisation as classifyBuildVsRead()
// (lower-cased) so two log lines with the same hash are guaranteed to have
// scored identically. 16 hex chars (64 bits) is ample — this repo emits at
// most low-thousands of these events, nowhere near a birthday-bound risk.
function promptHash(text) {
  try {
    return createHash('sha256').update(String(text || '').toLowerCase()).digest('hex').slice(0, 16);
  } catch { return null; }
}

export async function run(input) {
  let out = '';
  const allow = (ctx) => ({
    exit: 0,
    stdout: ctx ? JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: ctx}}) : (out || ''),
    stderr: '',
  });
  const deny = (reason) => ({
    exit: 2,
    stdout: JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}}),
    stderr: '',
  });

  try {
    // ── Compose-first guard (Package G) ──────────────────────────────────────
    // Independent of PRISM_SPECIALIST_GUARD. Fires ONLY on an agent-factory
    // dispatch (the create-a-new-capability boundary). Neutral otherwise.
    if (input && input.tool_name === 'Agent' && COMPOSE_MODE !== 'off') {
      const ti0 = input.tool_input || {};
      if (String(ti0.subagent_type || '').toLowerCase() === 'agent-factory') {
        const promptText = `${ti0.description || ''}\n${ti0.prompt || ''}`;
        const hasOverride = promptText.includes(COMPOSE_OVERRIDE_TOKEN);
        const sid = input.session_id || 'anon';
        const nudge = `PRISM COMPOSE-FIRST: you are dispatching @agent-factory to CREATE a new agent/skill. A full CAPABILITY CATALOG (every existing agent, skill, and tool) was injected at session start — before authorizing creation, confirm that NO existing capability already covers this need, and prefer composing or extending an existing capability over building a new one (compose-first / YAGNI); if an existing agent/skill/tool fits, dispatch THAT instead.`;
        if (COMPOSE_MODE === 'enforce' && !hasOverride) {
          appendLog({event: 'compose_first_guard', ts: new Date().toISOString(), session_id: sid, action: 'block', mode: COMPOSE_MODE});
          return deny(`${nudge} [enforce] Blocked: verify no existing capability covers this, then re-dispatch with '${COMPOSE_OVERRIDE_TOKEN}' in the dispatch prompt to override (or set PRISM_COMPOSE_GUARD=advisory/off).`);
        }
        appendLog({event: 'compose_first_guard', ts: new Date().toISOString(), session_id: sid, action: hasOverride ? 'nudge-override' : 'nudge', mode: COMPOSE_MODE});
        const trailer = (COMPOSE_MODE === 'enforce' && hasOverride)
          ? ' (enforce — override token present; dispatch proceeds.)'
          : ' (advisory — dispatch proceeds.)';
        return allow(`${nudge}${trailer}`);
      }
    }

    if (MODE === 'off') return allow('');
    if (!input || input.tool_name !== 'Agent') return allow('');

    const ti = input.tool_input || {};
    const subagentType = String(ti.subagent_type || '').toLowerCase();
    const sessionId = input.session_id || 'anon';
    // Computed up front (cheap — just string concat) so EVERY specialist_
    // routing_guard log line below, including the force_gp passthrough, can
    // carry the prompt_hash join key (task #32).
    const text = `${ti.description || ''}\n${ti.prompt || ''}`.trim();
    const pHash = promptHash(text);
    // Roster status census (task #54 / D046). Empty until the roster is loaded
    // below, so the two pre-roster log lines spread a no-op — only the log
    // lines that actually consulted the roster carry excluded_by_status.
    let sc = {};

    // Exempt: a non-generic subagent_type was already chosen (specialist / fork /
    // orchestrator / etc.). This is the cheap early-exit.
    if (!GENERIC_TYPES.has(subagentType)) return allow('');

    // Three-path subagent-context bypass (parity with agent-model-guard /
    // parent-dispatch-guard). A subagent spawning a subagent inherits the
    // parent's classification and must not be re-gated here.
    const sentinel = readSentinel(sessionId);
    const inSubagent = !!input.parent_tool_use_id
      || String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent'
      || !!(sentinel && sentinel.dispatched === true);
    if (inSubagent) return allow('');

    // Override: !gp-force: → sentinel.force_gp (set upstream by the tier-router).
    if (sentinel && sentinel.force_gp === true) {
      appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'passthrough-force-gp', prompt_hash: pHash, ...sc});
      return allow('');
    }

    const cls = classifyBuildVsRead(text);

    // Read-only recon to a generic agent is correct — stay silent.
    if (!cls.isBuild) {
      appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'silent-read-class', build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
      return allow('');
    }

    const roster = loadRoster();
    const specialist = matchSpecialist(text, roster);
    const domain = matchDomain(text);
    // D046 (Locked) — the status filter above drops candidates. Make the drop
    // VISIBLE on every roster-consulting log line rather than letting a future
    // vocabulary drift silently shrink the candidate pool again (task #54).
    sc = statusCensus(roster);

    // Case A — a matching specialist EXISTS AND clears the nudge floor.
    // D056 (2026-07-21): the nudge floor was previously score>=1 (any single
    // matched term), which — combined with the pre-D056 agentTerms() name-
    // segment fallback — made a bare ambient token (e.g. 'claude', 'prism')
    // enough to nudge on its own; 78% of live fires were weak score=1
    // matches. Raised to score>=2 (NUDGE_MIN_SCORE), matching the existing
    // enforce/"confident" bar (ENFORCE_MIN_SCORE) so nudge and block are now
    // the SAME bar rather than nudge being looser than enforce. A specialist
    // that matches on only one weak term is treated as no-match here (falls
    // through to silence, not to the "no specialist exists" hire-nudge in
    // Case B — one DOES exist, it just didn't clear the bar).
    const NUDGE_MIN_SCORE = 2;
    const ENFORCE_MIN_SCORE = 2;
    if (specialist && specialist.score >= NUDGE_MIN_SCORE) {
      const confident = specialist.score >= ENFORCE_MIN_SCORE;
      const base = `PRISM SPECIALIST-ROUTING: this is BUILD-class work (build=${cls.buildScore}/read=${cls.readScore}) routed to '${subagentType || 'general-purpose'}', but roster specialist '${specialist.name}' covers this domain. Generic agents drift from the design system / domain conventions and keep no durable knowledge — re-dispatch with subagent_type:'${specialist.name}'.`;
      if (MODE === 'enforce' && confident) {
        appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'block', specialist: specialist.name, score: specialist.score, matched_terms: specialist.matchedTerms, subagent_type: subagentType, mode: MODE, build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
        return deny(`${base} Override: prefix the user prompt with !gp-force: (or set PRISM_SPECIALIST_GUARD=off / advisory).`);
      }
      appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'nudge-specialist', specialist: specialist.name, score: specialist.score, matched_terms: specialist.matchedTerms, subagent_type: subagentType, mode: MODE, build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
      return allow(`${base} (advisory — dispatch proceeds. Override: !gp-force:.)`);
    }

    // Case A2 — a specialist matched but only on a weak (<2) term count.
    // Do NOT fall through to the "no specialist exists" hire-nudge below —
    // one does exist, it just didn't clear the bar. Stay silent.
    if (specialist) {
      appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'silent-weak-match', specialist: specialist.name, score: specialist.score, matched_terms: specialist.matchedTerms, subagent_type: subagentType, mode: MODE, build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
      return allow('');
    }

    // Case B — known build domain, but NO specialist exists yet. Never blocks.
    if (domain && domain.score >= 2) {
      appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'nudge-hire', domain: domain.domain, mode: MODE, build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
      return allow(`PRISM SPECIALIST-ROUTING: this is BUILD-class ${domain.domain} work routed to a generic agent, and no roster specialist owns that domain. Consider hiring one via @agent-factory (dispatch @master-orchestrator) before building, so future ${domain.domain} work reuses durable domain knowledge. Advisory only; dispatch proceeds.`);
    }

    // Case C — build-class but unknown domain → don't nag.
    appendLog({event: 'specialist_routing_guard', ts: new Date().toISOString(), session_id: sessionId, action: 'silent-unknown-domain', mode: MODE, build_score: cls.buildScore, read_score: cls.readScore, prompt_hash: pHash, ...sc});
    return allow('');
  } catch {
    return allow('');
  }
}

// Standalone shim — preserves wire behavior + parse-error fail-open.
if (process.argv[1] && basename(process.argv[1]) === 'prism-specialist-routing-guard.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  run(input).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  }).catch(() => process.exit(0));
}
