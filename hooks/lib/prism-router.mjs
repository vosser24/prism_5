// PRISM Router Library (v2.1.25 Phase 1.2)
//
// Pure-function scoring over an PRISM KB index. No I/O. Deterministic.
//
// export routeQuery(prompt, index, opts?) -> [{entry, score, reason}]
//   Scoring:
//     exact trigger phrase substring -> 10.0 + specificity bonus (max 3)
//     name-as-substring match         -> 5.0 (whole-word) / 2.5 (loose)
//     keyword Jaccard overlap         -> 0..1  weighted by keyword count
//
// Returned list is sorted desc by score, truncated to opts.limit (default 3),
// filtered by opts.minScore (default 2.0).

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','to','for','of','on','in',
  'at','by','as','is','it','be','this','that','these','those','with','from','use',
  'when','user','says','into','out','via','will','not','you','your','i','my','we',
  'our','me','us','can','should','would','could','may','might','must','shall','so',
  'also','just','very','any','all','each','every','some','more','most','than',
  'which','what','who','whom','whose','how','why','where','about','over','under'
]);

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function triggerScore(promptLC, triggers) {
  let best = 0;
  if (!triggers) return 0;
  for (const trig of triggers) {
    if (!trig) continue;
    const trigLC = trig.toLowerCase();
    if (promptLC.includes(trigLC)) {
      const words = trigLC.trim().split(/\s+/).length;
      const score = 10 + Math.min(words * 0.5, 3);
      if (score > best) best = score;
    }
  }
  return best;
}

function nameScore(promptLC, entryName) {
  if (!entryName) return 0;
  const n = entryName.toLowerCase();
  // Whole-word match gets full credit
  const escaped = n.replace(/[-_]/g, '[-_]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`).test(promptLC)) return 5;
  // Substring without word boundary -> half
  if (promptLC.includes(n)) return 2.5;
  return 0;
}

function keywordScore(promptTokens, keywords) {
  if (!keywords || !keywords.length || !promptTokens.length) return 0;
  const promptSet = new Set(promptTokens);
  const kwSet = new Set(keywords);
  let intersection = 0;
  for (const k of kwSet) if (promptSet.has(k)) intersection++;
  if (intersection === 0) return 0;
  const union = promptSet.size + kwSet.size - intersection;
  const jacc = intersection / union;
  return jacc * (kwSet.size / 10);
}

export function routeQuery(prompt, index, opts = {}) {
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 2.0;
  const includeDisabled = opts.includeDisabled ?? true;

  if (!index || !Array.isArray(index.entries) || !prompt) return [];

  const promptLC = String(prompt).toLowerCase();
  const promptTokens = tokenize(prompt);

  const scored = [];
  for (const e of index.entries) {
    if (!includeDisabled && e.plugin_enabled === false) continue;

    const t = triggerScore(promptLC, e.triggers);
    const n = nameScore(promptLC, e.name);
    const k = keywordScore(promptTokens, e.keywords_top10);
    const score = t + n + k;
    if (score < minScore) continue;

    const reasons = [];
    if (t > 0) reasons.push(`trigger+${t.toFixed(1)}`);
    if (n > 0) reasons.push(`name+${n.toFixed(1)}`);
    if (k > 0) reasons.push(`kw+${k.toFixed(2)}`);

    scored.push({ entry: e, score, reason: reasons.join(',') });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const dl = (a.entry.description || '').length;
    const el = (b.entry.description || '').length;
    return dl - el;
  });

  return scored.slice(0, limit);
}

export function formatRouterHint(results) {
  if (!results || !results.length) return null;
  const top = results[0];
  const e = top.entry;
  let bits = `PRISM match: ${e.id} (score ${top.score.toFixed(1)}, ${top.reason})`;
  if (e.invoke_hint) bits += ` — invoke: ${e.invoke_hint}`;
  if (e.plugin_enabled === false) bits += ' [plugin disabled — direct body load only]';
  return bits;
}

export { tokenize };
