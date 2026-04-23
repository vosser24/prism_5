// PRISM Tier Classifier (Phase 5a.1 shared lib)
//
// Lifted verbatim from hooks/prism-agent-model-guard.mjs (Phase 3b). The
// classifier is score-based, NOT verb-match:
//   Haiku signals: bounded output, verbatim tasks, schema outputs.
//   Sonnet signals: cross-file pattern recognition, refactor, tests.
//   Opus signals: architecture, trade-offs, root cause, decisions.
// Max-tier wins. Ties round UP.
//
// Consumers:
//   - hooks/prism-agent-model-guard.mjs (PreToolUse: Agent)
//   - hooks/prism-task-tier-advisor.mjs (PostToolUse: TaskCreate)

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
  /\b(write|add)\s+tests?\b/,
  /\b(reproduce|reproduction)\s+(a\s+|the\s+)?bug\b/,
  /\b(documentation|api docs?)\s+(lookup|search|find)\b/,
  /\b(trace|follow)\s+(a|the)?\s*(call|dependency|flow)\b/,
  /\b(port|migrate)\s+(from|to)\b/,
  /\b(fix|patch)\s+(this|the)\s+(bug|issue)\b/,
  /\b(create|build|scaffold|generate)\s+(a|an|the)\s+(skill|hook|component|agent|module|page|endpoint|api|route|script|tool)\b/,
  /\b(implement|write|add)\s+(a|an|the)\s+(feature|function|endpoint|component|utility|page|handler)\b/,
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
  /\b(design|architect|plan)\s+(a|an|the)\s+(workflow|pipeline|routing|orchestration|skill-?system|agent-?system|framework)\b/,
  /\b(multi-?step|multi-?stage|end-?to-?end)\s+(workflow|plan|implementation|system)\b/,
];

// v2.2.0 fix (P3b.5): allow an object phrase + comma between the two verbs,
// e.g. "read and analyze this module, then design a refactor".
// Up to ~60 characters of intervening text; non-greedy. Leading anchor still
// requires a compound-intent verb and a connector.
export const COMPOUND_VERB_RE = /\b(read|find|search|analyze|extract|research|review|audit)(?:\s+(?:and|then)\s+(?:create|build|write|implement|design|plan|refactor|fix|redesign|orchestrate)|[^.?!]{0,60}?,\s*(?:and|then)\s+(?:create|build|write|implement|design|plan|refactor|fix|redesign|orchestrate))\b|\b(plan\s+and\s+(implement|build|execute)|design\s+and\s+build|analyze\s+and\s+recommend|summarize\s+and\s+(recommend|decide))\b/i;

export const COST_MULTIPLIER = {haiku: 1, sonnet: 5, opus: 15};

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
  const tier = scoreToTier(score);
  return {...c, score, compound, tier_by_score: tier};
}
