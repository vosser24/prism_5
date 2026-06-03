// tools/lib/prism-kb-knowledge-query.mjs
//
// Purpose: the stable programmatic query API for PRISM's cross-project knowledge
// index (PRISM v5.0 F4 Phase D). Loads the global descriptor index and answers a
// free-text query with a BM25-ranked, optionally LLM-re-ranked candidate list —
// the actual A5 unblock per F4 §9.7: A5 calls queryKnowledge() DIRECTLY, never the
// CLI surface.
//
// Two stages (F4 §7):
//   Stage 1 — BM25 over the global index (always, fast, local; fully materialized
//             BEFORE any re-rank spawn so fallback is a zero-cost return).
//   Stage 2 — claude -p re-rank of the top-K BODY-FREE descriptors (default-on when
//             the CLI is available; degrades silently to the held BM25 ordering on
//             disable/timeout/error). Delegated to lib/prism-kb-rerank.mjs.
//
// Dep-free: Node core (fs, os, path) + three local imports below. No external
//           packages, no network beyond the rerank's existing subscription-auth
//           claude -p channel (and only when explicitly opted in).
// SYNCHRONOUS: no async/await — rerank uses spawnSync; keeps A5's call site simple
//              and avoids the async-blind test-harness trap (feedback-async-blind-test-harness).
//
// Design reference: docs/prism/plans/2026-05-29-F4-design.md §7 (query surface), §9 (MVP).

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { rank } from './prism-bm25.mjs';
import { rerank } from './prism-kb-rerank.mjs';
import { KNOWLEDGE_INDEX_REL } from '../prism-kb-knowledge-indexer.mjs';

// ── loadKnowledgeIndex ──────────────────────────────────────────────────────
// Reads <home>/.prism-kb/knowledge-index.json. Returns the parsed index object,
// or null if the file is absent / unreadable / corrupt / wrong-kind. Never throws.
export function loadKnowledgeIndex(home) {
  const p = join(home, KNOWLEDGE_INDEX_REL);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (parsed && parsed.kind === 'prism-kb-knowledge' && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch { /* corrupt ⇒ treat as absent */ }
  return null;
}

// ── queryKnowledge ──────────────────────────────────────────────────────────
// Returns { results, reranked, reason, label }. NEVER throws.
//
// opts:
//   home          string   default os.homedir()
//   crossProject  boolean  default false (gate — F4 §4.3 default-deny consumption)
//   limit         number   default 10  (final result count)
//   rerank        boolean  default true (stage-2 toggle; false ⇒ BM25-only)
//   runner        fn       injectable rerank runner (tests); passed through to rerank()
//   claudeBin     string|null|undefined  passed through to rerank() (null ⇒ no CLI)
//   env           object   default process.env
//   candidatePool number   default 20  (BM25 candidates carried into stage 2)
export function queryKnowledge(query, opts = {}) {
  const {
    home = homedir(),
    crossProject = false,
    limit = 10,
    rerank: doRerank = true,
    runner,
    claudeBin,
    env = process.env,
    candidatePool = 20,
  } = opts;

  // Gate: cross-project consumption is explicit opt-in (F4 §4.3).
  if (!crossProject) {
    return { results: [], reranked: false, reason: 'not-cross-project', label: '' };
  }

  const index = loadKnowledgeIndex(home);
  if (!index) {
    return { results: [], reranked: false, reason: 'no-index', label: '(no cross-project knowledge yet)' };
  }
  if (index.entries.length === 0) {
    return { results: [], reranked: false, reason: 'empty', label: '(no cross-project knowledge yet)' };
  }

  // Stage 1 — BM25 over the global index. Fully materialized BEFORE any re-rank.
  const docs = index.entries.map(e => {
    const postings = e.postings || {};
    let length = 0;
    for (const k of Object.keys(postings)) length += postings[k];
    return { id: e.id, postings, length: length || 1 };
  });
  const ranked = rank(query, docs); // [{id, score}] desc, score > 0

  if (ranked.length === 0) {
    return { results: [], reranked: false, reason: 'no-match', label: '(no cross-project matches)' };
  }

  // Join the ranked ids back to BODY-FREE descriptors (NO postings, NO body).
  const byId = new Map(index.entries.map(e => [e.id, e]));
  const poolSize = Math.max(limit, candidatePool);
  const pool = ranked.slice(0, poolSize).map(r => {
    const e = byId.get(r.id);
    return {
      id: e.id,
      type: e.type,
      title: e.title,
      description: e.description,
      project_label: e.project_label,
      source_path: e.source_path,
      domain: e.domain,
      score: r.score,
    };
  });

  // Stage 2 — claude -p re-rank of the body-free descriptors. Degrades silently.
  const rr = rerank(query, pool, { rerank: doRerank, runner, claudeBin, env });
  const final = rr.results.slice(0, limit);
  const label = rr.reranked ? '(LLM re-ranked)' : `(lexical only — ${rr.reason})`;

  return { results: final, reranked: rr.reranked, reason: rr.reason, label };
}
