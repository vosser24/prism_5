/**
 * prism-bm25.mjs — BM25 lexical-scoring library for PRISM v5.0 F4
 *
 * Purpose: rank candidate documents by relevance to a query using the
 *          Okapi BM25 algorithm, suitable for agent-roster and skill
 *          retrieval inside PRISM's intent-routing layer.
 *
 * Constraints:
 *   - Pure Node core — zero external dependencies, no imports.
 *   - ESM named exports only; no default export.
 *
 * Design reference: docs/prism/plans/2026-05-29-F4-design.md §3 / §7
 *
 * BM25 formula used throughout:
 *   score(q, d) = Σ_t [ idf(t) * (tf_t * (k1+1)) / (tf_t + k1*(1 - b + b*|d|/avgdl)) ]
 *   idf(t)      = ln(1 + (N - df_t + 0.5) / (df_t + 0.5))
 *
 * Defaults: k1 = 1.5, b = 0.75
 */

// ── tokenize ──────────────────────────────────────────────────────────────────

/**
 * Tokenize a text string into lowercase alphanumeric tokens.
 * Splits on any non-alphanumeric character; drops empty tokens.
 * Single-character tokens are KEPT (design choice: the tokenizer is minimal;
 * callers that want stop-word removal should filter downstream).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0);
}

// ── termFrequencies ───────────────────────────────────────────────────────────

/**
 * Count how many times each token appears in the token array.
 *
 * @param {string[]} tokens
 * @returns {Record<string, number>}
 */
export function termFrequencies(tokens) {
  /** @type {Record<string, number>} */
  const freq = Object.create(null);
  for (const t of tokens) {
    freq[t] = (freq[t] ?? 0) + 1;
  }
  return freq;
}

// ── idf ───────────────────────────────────────────────────────────────────────

/**
 * Inverse Document Frequency (BM25 variant).
 *   idf = ln(1 + (N - df + 0.5) / (df + 0.5))
 *
 * Properties:
 *   - Monotonically decreasing in df at fixed N: rarer terms score higher.
 *   - Always positive (the argument to ln is always > 1 for df >= 0, N >= 1).
 *   - Defined for df = 0 (term absent from corpus) and df = N (universal term).
 *
 * @param {number} df - Number of documents containing the term.
 * @param {number} N  - Total number of documents in the corpus.
 * @returns {number}
 */
export function idf(df, N) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

// ── buildStats ────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: string, postings: Record<string, number>, length: number }} Doc
 * @typedef {{ df: Record<string, number>, N: number, avgDocLen: number }} Stats
 */

/**
 * Build corpus-level statistics from an array of documents.
 *
 * - df[term]  : number of DOCUMENTS (not total occurrences) containing that term.
 * - N         : total document count.
 * - avgDocLen : arithmetic mean of doc.length values; 0 when docs is empty
 *               (guards against divide-by-zero in bm25Score).
 *
 * @param {Doc[]} docs
 * @returns {Stats}
 */
export function buildStats(docs) {
  const N = docs.length;
  /** @type {Record<string, number>} */
  const df = Object.create(null);
  let totalLen = 0;

  for (const doc of docs) {
    totalLen += doc.length;
    for (const term of Object.keys(doc.postings)) {
      df[term] = (df[term] ?? 0) + 1;
    }
  }

  const avgDocLen = N === 0 ? 0 : totalLen / N;
  return { df, N, avgDocLen };
}

// ── bm25Score ─────────────────────────────────────────────────────────────────

/**
 * Compute the BM25 score for a single document given a query term list.
 *
 * @param {string[]}                              queryTerms
 * @param {{ postings: Record<string,number>, length: number }} doc
 * @param {Stats}                                 stats
 * @param {{ k1?: number, b?: number }}           opts
 * @returns {number}
 */
export function bm25Score(queryTerms, doc, stats, opts = {}) {
  if (queryTerms.length === 0) return 0;

  const k1 = opts.k1 ?? 1.5;
  const b  = opts.b  ?? 0.75;

  const { df, N, avgDocLen } = stats;
  const docLen = doc.length;

  // Guard: if avgDocLen is 0 treat the length-normalisation factor as 1
  // (happens only when the corpus is empty, in which case N=0 and idf=0 anyway).
  const lenNorm = avgDocLen === 0 ? 1 : docLen / avgDocLen;

  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.postings[term] ?? 0;
    if (tf === 0) continue; // absent term contributes 0

    const df_t = df[term] ?? 0;
    const idf_t = idf(df_t, N);

    const numerator   = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * lenNorm);
    score += idf_t * (numerator / denominator);
  }

  return score;
}

// ── rank ──────────────────────────────────────────────────────────────────────

/**
 * Rank documents by BM25 relevance to a free-text query.
 *
 * Steps:
 *   1. Tokenize queryText.
 *   2. Build corpus stats from docs.
 *   3. Score each doc.
 *   4. Filter out docs with score <= 0.
 *   5. Sort descending by score.
 *
 * @param {string}                             queryText
 * @param {Doc[]}                              docs
 * @param {{ k1?: number, b?: number }}        opts
 * @returns {Array<{ id: string, score: number }>}
 */
export function rank(queryText, docs, opts = {}) {
  const queryTerms = tokenize(queryText);
  if (queryTerms.length === 0) return [];
  if (docs.length === 0) return [];

  const stats = buildStats(docs);

  return docs
    .map(doc => ({ id: doc.id, score: bm25Score(queryTerms, doc, stats, opts) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
