// PRISM Tier Classifier (v2.7.0)
//
// Score-based, NOT verb-match:
//   Haiku signals: bounded output, verbatim tasks, schema outputs.
//   Sonnet signals: cross-file pattern recognition, refactor, tests.
//   Opus signals: architecture, trade-offs, root cause, decisions.
// Max-tier wins. Ties round UP.
//
// v2.7.0 additions:
//   - classifyWithScore() now returns summon_panel when floor signals are
//     strong enough (≥3 OPUS_SIGNALS, or compound-verb on opus tier).
//     This lets the keyword-floor path trigger the orchestrator gate when
//     the Opus API is unreachable (offline or no API key).
//   - loadCostMultipliers() reads pricing from model-matrix.md at runtime.
//     Drop-in replacement for the hardcoded COST_MULTIPLIER constant;
//     pricing stays in one place (model-matrix.md) that /prism-update owns.
//
// Consumers:
//   - hooks/prism-agent-model-guard.mjs (PreToolUse: Agent)
//   - hooks/prism-task-tier-advisor.mjs (PreToolUse: TaskCreate, v2.7.0+)
//   - hooks/lib/prism-opus-classifier.mjs (keyword-floor fallback)

import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {prismHome} from '../../hooks/lib/prism-home.mjs';

export const HAIKU_SIGNALS = [
  /\b(return|output)\s+(a\s+)?(list|array|json|csv|tsv|yaml)\b/,
  /\b(extract|find\s+all|list\s+all|enumerate|count|tally)\b/,
  /\b(quote|copy|dump|verbatim|literal|exact)\b/,
  /\b(first\s+\d+|top\s+\d+|last\s+\d+|up\s+to\s+\d+)\b/,
  /\bunder\s+\d+\s+(words?|tokens?|chars?|lines?)\b/,
  /\b(grep|regex|pattern match)\b/,
  /\b(concise|brief|terse|short answer)\b/,
  /\bschema:\s*\{/,
];

export const SONNET_SIGNALS = [
  /\b(cross-?file|multi-?file|across\s+(the\s+)?(codebase|repo))\b/,
  /\b(refactor|rename|consolidate)\b/,
  /\b(write|add)\s+(\w+\s+)?tests?\b/,
  /\b(reproduce|reproduction)\s+(a\s+|the\s+)?bug\b/,
  /\b(documentation|api docs?)\s+(lookup|search|find)\b/,
  /\b(trace|follow)\s+(a|the)?\s*(call|dependency|flow)\b/,
  /\b(port|migrate)\s+(from|to)\b/,
  /\b(fix|patch)\s+(this|the)\s+(bug|issue)\b/,
  /\b(create|build|scaffold|generate)\s+(a|an|the)\s+(skill|hook|component|agent|module|page|endpoint|api|route|script|tool)\b/,
  /\b(implement|write|add)\s+(a|an|the)\s+(\w+\s+){0,3}(feature|function|endpoint|component|utility|page|handler|field|model|column|method|migration|attribute|property|serializer|middleware|validator|validation|fixture|route|setting)\b/,
];

export const OPUS_SIGNALS = [
  /\b(architect(ure)?|design\s+(the|a)\s+(system|api|schema|data model))\b/,
  /\b(trade-?off|tradeoffs?|pros?\s+and\s+cons?|cost[- ]benefit)\b/,
  /\b(root\s+cause|diagnose|why\s+(is|does|did))\b/,
  /\b(decide|decision|should\s+we|go[\/|]no[\/|-]?go)\b/,
  /\b(plan\s+(the|a|all)\s+phases?|strategy|roadmap)\b/,
  /\b(security\s+(review|audit)|threat model|attack surface)\b/,
  /\b(performance\s+(analysis|tradeoff)|scalability\s+(review|plan))\b/,
  /\b(adversarial\s+review|deep\s+analysis|holistic\s+(review|analysis))\b/,
  // v5.0.x A1 adjective-gap fix: allow up to 3 qualifier words between the
  // article and the head noun ("design the entire EVENT-DRIVEN pipeline",
  // "architect the new AGENT-ORCHESTRATION framework"). Without this an
  // intervening adjective scored the prompt to haiku (same failure class as
  // FIX-D's dead-sonnet bug).
  /\b(design|architect|plan)\s+(a|an|the)\s+(?:[\w-]+\s+){0,3}(workflow|pipeline|routing|orchestration|skill-?system|agent-?system|framework)\b/,
  /\b(multi-?step|multi-?stage|end-?to-?end)\s+(workflow|plan|implementation|system)\b/,
  // A1 — distributed-systems & scaling vocabulary
  /\b(multi-?region|multi-?tenant|per-?tenant|sharding|shard(ed)?|fan-?out|N\s+tenants?|phased\s+migration|fairness\s+(policy|algorithm|constraint))\b/i,
  // A1 — rate-limiting and quota systems
  /\b(rate[\s-]?limit(er|ing)?|quota\s+(system|enforcement|manager)|throttl(e|ing)\s+(policy|strategy|system))\b/i,
  // A1 — build/plan/scaffold/design verbs in cross-concern (full-stack) context:
  //      app/service noun followed (within 200 chars) by a backend/data concern
  /\b(plan|scaffold|design|build)\s+(an?\s+)?(app|application|service|system|platform|tracker|dashboard)\b(?=[\s\S]{0,200}\b(backend|api|database|db|server)\b)/i,
  // A1 — full-stack signal: backend + frontend co-present in same prompt
  /\b(backend|server[\s-]?side|api\s+layer)\b(?=[\s\S]{0,300}\b(frontend|client[\s-]?side|react|vue|angular|svelte|ui\s+layer)\b)/i,
];

// v2.7.0 additions — novel-architecture signals that bump summon_panel on
// the keyword-floor path. Offline users and no-API-key installs still get
// the orchestrator gate when these fire.
export const PANEL_SIGNALS = [
  /\b(novel|unprecedented|greenfield|from scratch)\s+(architect|design|system|migration|pipeline)/,
  /\b(architect|design|plan)\s+(a |an |the )?(new|entire|whole|complete)\s+(?:[\w-]+\s+){0,3}(system|app|platform|pipeline|workflow|architecture)/,
  /\b(multi-?phase|multi-?quarter)\s+(plan|migration|rollout|redesign)/,
  /\b(expert panel|architect panel|panel of)/,
  /\b(redesign|re-architect)\s+(the |my |our )?(app|system|platform|backend|frontend|stack)/,
  // A1 — multi-region / multi-tenant system design implies panel-level novelty
  /\b(multi-?region|multi-?tenant|global\s+distribution)\s+(?:[\w-]+\s+){0,3}(system|service|platform|architecture|deployment|infrastructure|limiter|gateway|cache|queue|proxy|mesh)\b/i,
  // A1 — phased migration with scale context
  /\b(phased|staged)\s+migration\b(?=[\s\S]{0,200}\b(tenant|region|shard|scale|traffic|prod|database)\b)/i,
];

// D038 (2026-07-06): TIER-ESCALATION signals — DECOUPLED from panel firing.
//
// Background: D034 (locked, 2026-06-25) made the expert PANEL explicit-only.
// As a SIDE EFFECT it also removed the only path that escalated the TIER
// (model routing) to opus for genuinely-complex architecture prompts: those
// prompts used to reach opus via summonPanelCore → summon_panel=true →
// `if (summon_panel) tier='opus'` in classifyWithScore. With the panel now
// gated behind EXPLICIT_PANEL_RE (and legacy lexical fire behind
// PRISM_LEXICAL_PANEL=1), complex-but-not-explicitly-panel prompts silently
// fell back to sonnet/haiku — sonnet over-selection on complex work.
//
// D038 restores the TIER escalation ONLY, without re-enabling auto-panel:
// these signals bump `tier` to opus while `summon_panel` STAYS false. The
// panel remains explicit-only per D034 — we do NOT touch EXPLICIT_PANEL_RE,
// the summon-panel gate, or PRISM_LEXICAL_PANEL. Tier-escalation is a much
// cheaper failure mode (one opus turn ≈ 15× a haiku turn) than firing a
// 3–5 agent panel, so — unlike the panel — this escalation is NOT subject to
// the PANEL_MIN_WORDS length floor: a short "redesign the backend
// architecture" is worth an opus model even though it is not worth a panel.
//
// Membership: the first six patterns are the *complexity* members carried
// over verbatim from PANEL_SIGNALS (the "expert panel"/"panel of" member is
// deliberately EXCLUDED — it is a panel-REQUEST phrase, not a complexity
// signal, and is already handled by EXPLICIT_PANEL_RE). The last two are
// tightly-anchored additions covering genuine-complexity classes the literal
// PANEL_SIGNALS regexes missed on short prompts (greenfield/novel system
// design; cross-service data-model migration). Each pattern anchors an
// architecture VERB or an unambiguous architecture NOUN so everyday dev
// vocabulary ("fix this typo", "rename a variable") cannot trip it — see the
// over-escalation guard in tests/v3/state/test-tier-escalation-restore.mjs.
export const TIER_ESCALATION_SIGNALS = [
  // ── carried over from PANEL_SIGNALS complexity members ──────────────────
  /\b(novel|unprecedented|greenfield|from scratch)\s+(architect|design|system|migration|pipeline)/i,
  /\b(architect|design|plan)\s+(a |an |the )?(new|entire|whole|complete)\s+(?:[\w-]+\s+){0,3}(system|app|platform|pipeline|workflow|architecture)/i,
  /\b(multi-?phase|multi-?quarter)\s+(plan|migration|rollout|redesign)/i,
  /\b(redesign|re-architect)\s+(the |my |our )?(app|system|platform|backend|frontend|stack)/i,
  /\b(multi-?region|multi-?tenant|global\s+distribution)\s+(?:[\w-]+\s+){0,3}(system|service|platform|architecture|deployment|infrastructure|limiter|gateway|cache|queue|proxy|mesh)\b/i,
  /\b(phased|staged)\s+migration\b(?=[\s\S]{0,200}\b(tenant|region|shard|scale|traffic|prod|database)\b)/i,
  // ── tightly-anchored additions (D038) ───────────────────────────────────
  // greenfield / novel / from-scratch system or platform design — the arch
  // word must sit within 3 qualifier words of a system/platform noun.
  /\b(novel|greenfield|from[\s-]scratch|unprecedented|brand[\s-]new)\s+(?:[\w-]+\s+){0,3}(system|platform|architecture|service|pipeline|app(?:lication)?|infrastructure)\b/i,
  // cross-service / multi-service data-model or schema migration.
  /\bmigrat\w*\b[\s\S]{0,40}\b(data|schema)\b[\s\S]{0,40}\b(across|between)\b[\s\S]{0,20}\bservices?\b/i,
];

export function detectComplexEscalation(prompt, description) {
  const hay = `${prompt || ''} ${description || ''}`;
  return TIER_ESCALATION_SIGNALS.some(r => r.test(hay));
}

// UAT-3/5 (2026-06-02): EXPLICIT user requests for a panel. Honoring explicit
// intent is SAFE — it is not an ambient false-positive (the class that caused
// the v5.0 finding-#1 deadlock), it is exactly what the user asked for. Kept
// narrow so benign "admin/control/solar/settings panel" nouns don't trip it.
export const EXPLICIT_PANEL_RE = /\b(?:summon|convene|run)\s+(?:the\s+|an?\s+)?(?:expert\s+|adversarial\s+)?panel\b|\b(?:expert|adversarial)\s+panel\b|\bpanel\s+review\b|(?:^|\s)[!/]panel\b|\bPRISM\s+this\b/i;

// Item 2a, D025: Minimum prompt word-count below which IMPLICIT panel signals
// (stakes, PANEL_SIGNALS, ≥3 OPUS_SIGNALS, compound-verb) are floored to
// summon_panel=false. Short prompts share vocabulary with long ones but have
// no room for the context that makes architecture signals reliable — "novel
// greenfield system" is 3 words, not a real design request. EXPLICIT requests
// ("run the panel", "!panel") bypass this floor regardless of length.
export const PANEL_MIN_WORDS = 50;

// D1 — high-stakes work: migrations, destructive ops, security, money. These
// bias toward opus + mandatory panel independent of length-based tier floor.
// Each pattern carries a CONTEXT ANCHOR so it fires on genuine high-stakes work,
// not everyday dev vocabulary: bare "token"/"migrate"/"billing"/"security"
// over-escalated benign prompts ("parse the JWT token", "migrate this React
// component", "billing page spinner") — anchors keep those on the normal path.
const STAKES_SIGNALS = [
  // DB/schema migrations & data ops (NOT framework/UI "migrations")
  /\b(database|schema|data|table|db)\s+migrat/i,
  /\bmigrat\w*\s+(the\s+)?(database|schema|table|db|data)\b/i,
  /\b(backfill|schema change|alter table)\b/i,
  // Destructive data operations
  /\bdrop\b[\w\s]{0,20}\b(table|database|column)\b/i,
  /\b(delete\s+(from|all)|truncate|rm\s+-rf|wipe\s+(the\s+)?(db|database|data))\b/i,
  /\b(destructive|irreversible)\b/i,
  // Security / credentials with action or threat context
  /\b(security\s+(audit|review|incident|hardening)|threat\s+model|vulnerabilit(y|ies)|\bCVE\b|RBAC|privilege\s+escalation)\b/i,
  /\b(rotate|revoke|invalidate|leak\w*|expos\w*|hard-?cod\w*)\b[\w\s]{0,25}\b(secret|credential|token|api\s*key|password)s?\b/i,
  /\b(secret|credential|password)s?\b[\w\s]{0,25}\b(rotat\w*|leak\w*|expos\w*|revoke)\b/i,
  // Money / payments with action context (NOT mere page/feature names)
  /\b(charg(e|ing|ed)|refund|payout|chargeback|invoic(e|ing))\b/i,
  /\b(process\w*\s+(a\s+)?payment|bill\w*\s+(the\s+)?(customer|card)|financial\s+transaction)\b/i,
  // "ledger" is the DOMAIN NOUN of ledger/finance apps — it appears in every file
  // path, README, and read query. A bare mention is everyday vocabulary, not
  // high-stakes work (it over-escalated "ledger balance", "ledger README typo",
  // "rename the ledger folder" → opus+panel). Anchor to genuine ledger MUTATIONS.
  /\b(reconcil\w*|rebalanc\w*|recomput\w*|settl\w*|void\w*|revers\w*)\s+(the\s+|all\s+|an?\s+)?ledger\b/i,
  // Production / sensitive data
  /\b(production\s+(deploy\w*|release|rollout|incident|outage)|deploy\w*\s+to\s+prod\w*|prod(uction)?\s+(db|database|data)|customer\s+data|\bPII\b|data\s?loss)\b/i,
];

// A2 — SECURITY-VERB FLOOR. Prompts that describe BUILDING security-sensitive
// features (auth, crypto, sessions, payments, PII) must not route to haiku.
// Distinct from STAKES_SIGNALS (incident/audit/rotation context). Sets a
// minimum tier of sonnet regardless of keyword score. Each pattern anchors a
// BUILD verb near the sensitive noun so passive mentions ("parse the JWT",
// "what is JWT") do NOT fire.
const SECURITY_VERB_SIGNALS = [
  // Authentication, login, SSO, session management
  /\b(implement|add|build|create|set\s?up|integrate|write)\b[\s\S]{0,60}\b(auth(?:entication|oriz(?:ation|e))?|login|sign[\s-]?in|sso|oauth|saml|openid)\b/i,
  /\b(implement|add|build|create|set\s?up|integrate|write)\b[\s\S]{0,60}\b(session\s+management|session\s+token|cookie\s+(?:auth|session))\b/i,
  // Password & credential handling
  /\b(password\s+hash(?:ing)?|bcrypt|argon2|pbkdf2|scrypt|credential\s+stor(?:age|ing))\b/i,
  /\b(implement|add|build|create)\b[\s\S]{0,60}\b(password\s+(?:reset|recovery|change)|forgot\s+password)\b/i,
  // JWT / tokens as a feature being built (NOT merely parsed)
  /\b(implement|add|issue|sign|verify|validate)\b[\s\S]{0,60}\b(jwt|json\s+web\s+token|access\s+token|refresh\s+token)\b/i,
  // Cryptography as a feature
  /\b(implement|add|build|create)\b[\s\S]{0,60}\b(encrypt(?:ion)?|decrypt(?:ion)?|hashing|digital\s+signature|hmac|aes|rsa)\b/i,
  // PII / payment handling as a feature
  /\b(implement|add|build|create|store|collect)\b[\s\S]{0,60}\b(pii|personal\s+(?:data|information)|payment\s+(?:form|flow|processing)|credit\s+card|checkout)\b/i,
];

export function detectSecurityVerb(prompt, description) {
  const hay = `${prompt || ''} ${description || ''}`;
  return SECURITY_VERB_SIGNALS.some(r => r.test(hay));
}

export function detectStakes(prompt, description) {
  const hay = `${prompt || ''} ${description || ''}`;
  return STAKES_SIGNALS.some(r => r.test(hay));
}

// v2.2.0 fix (P3b.5): allow an object phrase + comma between the two verbs,
// e.g. "read and analyze this module, then design a refactor".
// Up to ~60 characters of intervening text; non-greedy. Leading anchor still
// requires a compound-intent verb and a connector.
export const COMPOUND_VERB_RE = /\b(read|find|search|analyze|extract|research|review|audit)(?:\s+(?:and|then)\s+(?:create|build|write|implement|design|plan|refactor|fix|redesign|orchestrate)|[^.?!]{0,60}?,\s*(?:and|then)\s+(?:create|build|write|implement|design|plan|refactor|fix|redesign|orchestrate))\b|\b(plan\s+and\s+(implement|build|execute)|design\s+and\s+build|analyze\s+and\s+recommend|summarize\s+and\s+(recommend|decide))\b/i;

// --- v2.7.0: dynamic cost multiplier from model-matrix.md ---
//
// Reads "$X/MTok input" from each model's section in model-matrix.md,
// normalizes to haiku-input = 1. Cached in-memory per process. Falls
// back to hardcoded constants if the file is absent or unparseable.

const FALLBACK_COST_MULTIPLIER = {haiku: 1, sonnet: 5, opus: 15};
let _costMultiplierCache = null;

function parseCostFromMatrix(text) {
  if (!text) return null;
  // Match lines like: "- Cost: $15/MTok input, $75/MTok output (cache: ...)"
  // under section headers like "## Opus 4.7", "## Sonnet 4.6", "## Haiku 4.5".
  const result = {};
  const sectionRe = /^##\s+(Opus|Sonnet|Haiku)\s+\d/gmi;
  const parts = text.split(sectionRe);
  // parts: [preamble, "Opus", opusBlock, "Sonnet", sonnetBlock, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const name = String(parts[i]).toLowerCase();
    const block = parts[i + 1] || '';
    const m = block.match(/\$(\d+(?:\.\d+)?)\s*\/MTok\s+input/i);
    if (m) result[name] = parseFloat(m[1]);
  }
  if (!result.haiku || !result.sonnet || !result.opus) return null;
  const base = result.haiku;
  return {
    haiku: 1,
    sonnet: Math.round((result.sonnet / base) * 10) / 10,
    opus: Math.round((result.opus / base) * 10) / 10,
  };
}

export function loadCostMultipliers(matrixPath) {
  if (_costMultiplierCache) return _costMultiplierCache;
  const path = matrixPath || join(
    prismHome(),
    '.claude', 'skills', 'prism-plan', 'references', 'model-matrix.md'
  );
  try {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf-8');
      const parsed = parseCostFromMatrix(text);
      if (parsed) {
        _costMultiplierCache = parsed;
        return parsed;
      }
    }
  } catch {}
  _costMultiplierCache = FALLBACK_COST_MULTIPLIER;
  return FALLBACK_COST_MULTIPLIER;
}

// Backward compat export — consumers can still import COST_MULTIPLIER as a
// frozen snapshot. New code should call loadCostMultipliers() at hook
// startup to get live values from model-matrix.md.
export const COST_MULTIPLIER = FALLBACK_COST_MULTIPLIER;

export function score(text, patterns) {
  if (!text) return 0;
  let hits = 0;
  for (const r of patterns) if (r.test(text)) hits++;
  return hits;
}

export function classifyTier(prompt, description) {
  const hay = `${prompt || ''} ${description || ''}`.toLowerCase();
  if (!hay.trim()) return {tier: 'sonnet', reason: 'empty-prompt-safe-default', h: 0, s: 0, o: 0};
  const h = score(hay, HAIKU_SIGNALS);
  const s = score(hay, SONNET_SIGNALS);
  const o = score(hay, OPUS_SIGNALS);
  let tier = 'haiku', winning = h;
  if (s >= winning && s > 0) { tier = 'sonnet'; winning = s; }
  if (o >= winning && o > 0) { tier = 'opus'; winning = o; }
  if (h === 0 && s === 0 && o === 0) return {tier: 'sonnet', reason: 'no-signals-safe-default', h, s, o};
  return {tier, reason: `scores h=${h} s=${s} o=${o}`, h, s, o};
}

export function detectCompound(prompt, description) {
  const hay = `${prompt || ''} ${description || ''}`;
  return COMPOUND_VERB_RE.test(hay);
}

// v5.1.7: PASTED/QUOTED-content detection. When a user pastes a transcript or
// report (e.g. a /prism-doctor or /prism-audit run) into a PRISM session, that
// pasted text carries trigger vocabulary (architecture, security audit, migrate,
// panel…) that is NOT the user's own request. Scoring it the same as a genuine
// ask over-fired summon_panel repeatedly (UAT 2026-06-03). These helpers let the
// PANEL decision (and only the panel decision) fall back to the user's own words.
const FENCE_RE = /```[\s\S]*?```/g;
// Lines that are clearly pasted CC/tool transcript or table chrome — blockquotes,
// CC transcript markers (●, ⎿), box-drawing/table rules, and status glyphs — not
// prose the user typed.
const PASTE_LINE_RE = /^\s*(?:>|●|⎿|│|┃|┌|┐|└|┘|├|┤|┬|┴|┼|━|─|═|╔|╗|╚|╝|╠|╣|✅|❌|⚠|🔴|🟢|🟡|🩺|ℹ)/u;
// v5.2.6: STRONG transcript markers — same set MINUS the bare ">" blockquote (which
// users type in their OWN prose). Used to detect a transcript BLOCK for span strip.
const STRONG_PASTE_LINE_RE = /^\s*(?:●|⎿|│|┃|┌|┐|└|┘|├|┤|┬|┴|┼|━|─|═|╔|╗|╚|╝|╠|╣|✅|❌|⚠|🔴|🟢|🟡|🩺|ℹ)/u;
// Transcript CONTENT lines that carry NO leading glyph but are unmistakably tool
// output: tool-call signatures, run summaries, token/turn counts, expand hints.
const TRANSCRIPT_LINE_RE = /\b\d+\s+tool uses?\b|\(ctrl\+o to expand\)|\bBackgrounded agent\b|\bChurned for\b|[·•]\s*[\d.]+k?\s*tokens|^\s*(?:Agent|Bash|Read|Edit|Write|MultiEdit|Update|Search|Grep|Glob|Skill|Task|WebFetch|WebSearch|NotebookEdit)\(/;
const TRANSCRIPT_MIN_MARKERS = 3;

function isStrongMarker(line) {
  return STRONG_PASTE_LINE_RE.test(line) || TRANSCRIPT_LINE_RE.test(line);
}

// D068-follow-up (2026-07-24): TRANSCRIPT-PASTE detection for the panel gate.
// A prompt containing a pasted CC/CLI transcript (>=TRANSCRIPT_MIN_MARKERS
// strong transcript-marker lines) is the user SHOWING Claude output, not
// asking for a fresh panel — even when a "run the panel: <question>" line
// sits OUTSIDE the transcript span (see stripPastedContent's block-strip
// branch just below). Reuses the EXACT same isStrongMarker() predicate and
// TRANSCRIPT_MIN_MARKERS threshold that stripPastedContent()'s block-strip
// branch already uses, so the two stay consistent by construction.
export function hasTranscriptPaste(prompt) {
  const noFences = String(prompt || '').replace(FENCE_RE, ' ');
  const lines = noFences.split(/\r?\n/);
  let count = 0;
  for (const line of lines) if (isStrongMarker(line)) count++;
  return count >= TRANSCRIPT_MIN_MARKERS;
}

// D068-follow-up CORRECTED (2026-07-24): POSITION-AWARE variant of the panel
// explicit-check text. The unconditional `hasTranscriptPaste() -> suppress`
// fix (first attempt) was too blunt: it also suppressed the LOCKED v5.2.6/
// D034 guarantee that an explicit panel request TRAILING a pasted transcript
// (the user's own words, typed AFTER showing the transcript) must still be
// honored — e.g. "<pasted transcript>\nsummon the panel on this question".
//
// The real discriminator is POSITION relative to the transcript span:
//   - explicit phrase BEFORE the transcript's first strong marker (the
//     leading block that produced the pasted output, e.g. case-2's
//     "run the panel: <question>" immediately followed by a pasted CLI run)
//     -> must be EXCLUDED from the panel decision.
//   - explicit phrase AFTER the transcript's last strong marker (genuine
//     trailing own-words request) -> must still be HONORED.
//
// trailingOwnWords() returns only the text AFTER the last strong-marker line
// when the prompt is transcript-dominated (>=TRANSCRIPT_MIN_MARKERS strong
// markers, same threshold as stripPastedContent's block-strip branch and
// hasTranscriptPaste()); this deliberately drops any leading pre-transcript
// block. When there are fewer strong markers (no real transcript), behavior
// is UNCHANGED — falls back to the existing stripPastedContent() call so
// every non-transcript path (fenced pastes, minority pastes, plain prose) is
// untouched.
export function trailingOwnWords(prompt) {
  const s = String(prompt || '');
  const noFences = s.replace(FENCE_RE, ' ');
  const lines = noFences.split(/\r?\n/);
  const strongIdx = [];
  for (let i = 0; i < lines.length; i++) if (isStrongMarker(lines[i])) strongIdx.push(i);
  if (strongIdx.length < TRANSCRIPT_MIN_MARKERS) return stripPastedContent(prompt);
  const hi = strongIdx[strongIdx.length - 1];
  return lines.slice(hi + 1).join('\n');
}

export function stripPastedContent(prompt) {
  const noFences = String(prompt || '').replace(FENCE_RE, ' ');
  const lines = noFences.split(/\r?\n/);
  // v5.2.6: when a prompt is transcript-DOMINATED (≥3 strong structural markers),
  // strip the contiguous transcript BLOCK — first→last strong-marker line inclusive
  // — so interior synthesis prose (e.g. "a 4-seat adversarial panel …",
  // "re-architect the platform") that carries trigger vocabulary does NOT survive
  // into the user's "own words" and re-fire the panel. The user's actual request
  // sits OUTSIDE that span (before the first / after the last marker) and is kept.
  const strongIdx = [];
  for (let i = 0; i < lines.length; i++) if (isStrongMarker(lines[i])) strongIdx.push(i);
  if (strongIdx.length >= TRANSCRIPT_MIN_MARKERS) {
    const lo = strongIdx[0], hi = strongIdx[strongIdx.length - 1];
    return [...lines.slice(0, lo), ...lines.slice(hi + 1)].join('\n');
  }
  // Fallback (sparse markers): per-line strip of any pasted/transcript chrome.
  return lines.filter(line => !PASTE_LINE_RE.test(line) && !TRANSCRIPT_LINE_RE.test(line)).join('\n');
}

export function pastedRatio(prompt) {
  const full = String(prompt || '').replace(/\s/g, '');
  if (!full.length) return 0;
  const kept = stripPastedContent(prompt).replace(/\s/g, '').length;
  return 1 - kept / full.length;
}

// v2.7.0 panel-signal core.
//
// D034 Amendment (2026-06-25): explicit-only panel trigger.
// Panel fires ONLY on explicit user request (EXPLICIT_PANEL_RE). The legacy
// lexical implicit paths (PANEL_SIGNALS, detectStakes, ≥3 opus, compound-verb)
// are retired from the default-on trigger and gated behind PRISM_LEXICAL_PANEL=1
// (rollback flag) — D033 found no panel rework-survival advantage that would
// justify mechanizing an unproven intervention on every high-signal prompt.
// Soft master judgment (plain-chat offer, no mechanism) is the backstop for
// genuine high-stakes calls.
//
// Item 2a, D025: EXPLICIT requests (EXPLICIT_PANEL_RE) are honored at any
// length. IMPLICIT signals (PANEL_SIGNALS, stakes, ≥3 opus, compound) are
// suppressed when the prompt is shorter than PANEL_MIN_WORDS — short prompts
// share vocabulary with genuine architecture work but lack the surrounding
// context that makes those signals reliable. When PRISM_LEXICAL_PANEL=1 this
// floor still applies to the restored implicit paths.
function summonPanelCore(prompt, description, {h, s, o, compound}) {
  const hay = `${prompt || ''} ${description || ''}`;
  // UAT-3/5: explicit user request for a panel — honor it directly, bypassing
  // the length floor. "run the panel" is 3 words and must still summon.
  // Explicit-only contract: this is the SOLE trigger in default mode.
  //
  // D068 residual fix: the explicit test MUST run against paste-stripped text
  // ALWAYS, not only when the prompt is pasted-DOMINANT (>=60%, the threshold
  // detectSummonPanel() below uses to decide which scoring path to take). A
  // MINORITY paste — a single quoted transcript line ("summon the adversarial
  // panel...") embedded in an otherwise much longer own-words prompt — has a
  // low pastedRatio() and was falling through to this function with the RAW,
  // unstripped `hay`, so the quoted panel language still matched
  // EXPLICIT_PANEL_RE and re-summoned the panel from pasted vocabulary.
  // stripPastedContent() is a no-op on genuine typed prose (no paste markers
  // to strip), so calling it unconditionally here is safe and does not affect
  // a real "summon the panel" the user typed themselves.
  //
  // D068-follow-up CORRECTED (2026-07-24): position-aware. On a transcript-
  // dominated prompt (hasTranscriptPaste), only text TRAILING the transcript's
  // last strong marker counts as the user's own words — a leading pre-
  // transcript block (e.g. "run the panel: <question>" immediately followed
  // by the pasted CLI run it produced) is excluded. Non-transcript prompts are
  // unaffected (trailingOwnWords falls back to stripPastedContent unchanged).
  const ownHay = hasTranscriptPaste(prompt)
    ? `${trailingOwnWords(prompt)} ${description || ''}`
    : `${stripPastedContent(prompt)} ${description || ''}`;
  if (EXPLICIT_PANEL_RE.test(ownHay)) return true;
  // D034: implicit lexical paths are OFF by default. Set PRISM_LEXICAL_PANEL=1
  // to restore legacy auto-fire behavior (rollback flag).
  const _lex = String(process.env.PRISM_LEXICAL_PANEL || '');
  if (_lex !== '1' && _lex !== 'true') return false;
  // ── Legacy implicit paths (PRISM_LEXICAL_PANEL=1 only) ──────────────────
  // Item 2a, D025: apply word-count floor to ALL implicit signals below.
  const wordCount = hay.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < PANEL_MIN_WORDS) return false;
  const panelHit = PANEL_SIGNALS.some(r => r.test(hay));
  if (panelHit) return true;
  if (detectStakes(prompt, description)) return true;
  // ≥3 opus signals on a single prompt — strong novel-architecture indicator.
  if (Number(o) >= 3) return true;
  // compound verb chain on opus-tier prompt — likely multi-stage novel work.
  if (compound && Number(o) >= 1) return true;
  return false;
}

export function detectSummonPanel(prompt, description, sig) {
  // v5.1.7: a prompt dominated by pasted/quoted transcript content (a report the
  // user pasted, not their own request) must not auto-summon a panel from the
  // pasted vocabulary. Re-scoring the stripped remainder is too leaky — a single
  // unmarked prose line ("PRISM Security Audit…", "re-architect the platform")
  // survives and re-fires. So on a pasted-dominated prompt we honor ONLY an
  // EXPLICIT panel request in the user's own (non-pasted) words. The tier is
  // still scored from the full prompt (a maintenance paste routing to opus is
  // fine and the cost-ratchet nudge covers it) — only the PANEL is suppressed.
  // A genuine architecture ask should be its own prompt, or just say "run the
  // panel".
  //
  // D068-follow-up CORRECTED (2026-07-24): position-aware. On a transcript-
  // dominated prompt, an explicit request BEFORE the transcript's first strong
  // marker (a leading pre-transcript block, e.g. "run the panel: <question>"
  // immediately followed by the pasted CLI run it produced) must NOT summon —
  // it is the input that generated the pasted output, not a fresh request.
  // An explicit request AFTER the transcript's last strong marker (genuine
  // trailing own-words, the LOCKED v5.2.6/D034 guarantee) must still summon.
  // trailingOwnWords() falls back to the unchanged stripPastedContent() when
  // the prompt is not transcript-dominated, so every other path is untouched.
  if (pastedRatio(prompt) >= 0.6) {
    const own = hasTranscriptPaste(prompt)
      ? `${trailingOwnWords(prompt)} ${description || ''}`
      : `${stripPastedContent(prompt)} ${description || ''}`;
    return EXPLICIT_PANEL_RE.test(own);
  }
  return summonPanelCore(prompt, description, sig);
}

// --- Phase 5.1 score compression ---
//
// Convert {h, s, o} raw signal counts into a 0-10 complexity score and a
// tier bucket. Weights reflect cost hierarchy: one Opus signal > several
// Haiku signals. Ties round UP (overpay < retry).
//
// Thresholds are env-tunable via PRISM_TIER_THRESHOLDS="haiku_max,sonnet_max"
// e.g. "2,7" => score 0-2 haiku, 3-7 sonnet, 8+ opus (defaults).

export function complexityScore(h, s, o) {
  return Number(h || 0) + 3 * Number(s || 0) + 8 * Number(o || 0);
}

function parseThresholds(raw) {
  if (!raw) return {haikuMax: 2, sonnetMax: 7};
  const parts = String(raw).split(',').map(x => parseInt(x.trim(), 10));
  if (parts.length !== 2 || parts.some(Number.isNaN)) return {haikuMax: 2, sonnetMax: 7};
  const [hMax, sMax] = parts;
  if (hMax >= sMax) return {haikuMax: 2, sonnetMax: 7};
  return {haikuMax: hMax, sonnetMax: sMax};
}

export function scoreToTier(score, thresholds) {
  const t = thresholds || parseThresholds(process.env.PRISM_TIER_THRESHOLDS);
  const n = Number(score || 0);
  if (n <= t.haikuMax) return 'haiku';
  if (n <= t.sonnetMax) return 'sonnet';
  return 'opus';
}

export function classifyWithScore(prompt, description) {
  const c = classifyTier(prompt, description);
  let score = complexityScore(c.h, c.s, c.o);
  const compound = detectCompound(prompt, description);
  if (compound) score += 2;
  let tier = scoreToTier(score);
  const stakes = detectStakes(prompt, description);
  if (stakes) tier = 'opus';
  const securityVerb = detectSecurityVerb(prompt, description);
  // A2: security-verb floor — never route security-feature build work below sonnet.
  if (securityVerb && tier === 'haiku') tier = 'sonnet';
  // D038: TIER escalation for genuinely-complex architecture prompts,
  // DECOUPLED from panel firing (see TIER_ESCALATION_SIGNALS above and D034).
  // This restores the opus routing that D034 removed as a side effect of making
  // the panel explicit-only — but it ONLY moves `tier`, never `summon_panel`.
  // The panel stays explicit-only (EXPLICIT_PANEL_RE) per the locked D034.
  const complexEscalation = detectComplexEscalation(prompt, description);
  if (complexEscalation) tier = 'opus';
  const summon_panel = detectSummonPanel(prompt, description, {h: c.h, s: c.s, o: c.o, compound});
  // v5.0.x A2: a summoned design panel implies opus-tier work. Without this a
  // panel signal (e.g. "multi-phase migration") could leave tier at haiku/
  // sonnet — the router only honors the panel on opus, so the flag was
  // silently dropped AND the work routed cheap. Panel ⇒ opus, like stakes.
  if (summon_panel) tier = 'opus';
  return {...c, score, compound, stakes, securityVerb, complexEscalation, tier_by_score: tier, summon_panel};
}
