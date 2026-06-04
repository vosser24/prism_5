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
import {homedir} from 'node:os';
import {join} from 'node:path';

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
];

// UAT-3/5 (2026-06-02): EXPLICIT user requests for a panel. Honoring explicit
// intent is SAFE — it is not an ambient false-positive (the class that caused
// the v5.0 finding-#1 deadlock), it is exactly what the user asked for. Kept
// narrow so benign "admin/control/solar/settings panel" nouns don't trip it.
export const EXPLICIT_PANEL_RE = /\b(?:summon|convene|run)\s+(?:the\s+|an?\s+)?(?:expert\s+|adversarial\s+)?panel\b|\b(?:expert|adversarial)\s+panel\b|\bpanel\s+review\b|(?:^|\s)[!/]panel\b|\bPRISM\s+this\b/i;

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
    process.env.HOME || process.env.USERPROFILE || homedir(),
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

export function stripPastedContent(prompt) {
  const noFences = String(prompt || '').replace(FENCE_RE, ' ');
  return noFences.split(/\r?\n/).filter(line => !PASTE_LINE_RE.test(line)).join('\n');
}

export function pastedRatio(prompt) {
  const full = String(prompt || '').replace(/\s/g, '');
  if (!full.length) return 0;
  const kept = stripPastedContent(prompt).replace(/\s/g, '').length;
  return 1 - kept / full.length;
}

// v2.7.0 panel-signal core (unchanged logic). Triggers when the floor is strong
// enough to warrant orchestrator involvement without needing the Opus API.
function summonPanelCore(prompt, description, {h, s, o, compound}) {
  const hay = `${prompt || ''} ${description || ''}`;
  // UAT-3/5: explicit user request for a panel — honor it directly.
  if (EXPLICIT_PANEL_RE.test(hay)) return true;
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
  if (pastedRatio(prompt) >= 0.6) {
    const own = `${stripPastedContent(prompt)} ${description || ''}`;
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
  const summon_panel = detectSummonPanel(prompt, description, {h: c.h, s: c.s, o: c.o, compound});
  // v5.0.x A2: a summoned design panel implies opus-tier work. Without this a
  // panel signal (e.g. "multi-phase migration") could leave tier at haiku/
  // sonnet — the router only honors the panel on opus, so the flag was
  // silently dropped AND the work routed cheap. Panel ⇒ opus, like stakes.
  if (summon_panel) tier = 'opus';
  return {...c, score, compound, stakes, tier_by_score: tier, summon_panel};
}
