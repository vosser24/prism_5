#!/usr/bin/env node
// PRISM v5.0 F4 — re-rank quality + latency spike (design §11 senior-review residual).
// Run: node tests/v3/rerank-spike.mjs
//
// NOT a unit test and NOT a shipped artifact (lives under tests/, outside the
// install-manifest glob). It exercises the LIVE `claude -p` re-rank against a small
// synthetic cross-project corpus to answer the two §11 questions before the feature
// is considered done:
//   (1) LATENCY — does a real K≤20 re-rank return within the 8s hard budget (§7/§8)?
//   (2) QUALITY — does the LLM re-rank surface a PARAPHRASE match that bare BM25 ranks
//                 below it? (the paraphrase gap is the whole reason stage 2 is default-on)
// Degrades exactly like production: if `claude` is absent/slow/errors, it reports the
// silent BM25 fallback rather than failing.

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { buildKnowledgeIndex } from '../../tools/prism-kb-knowledge-indexer.mjs';
import { queryKnowledge } from '../../tools/lib/prism-kb-knowledge-query.mjs';
import { resolveClaudeBin, DEFAULT_RERANK_TIMEOUT_MS } from '../../tools/lib/prism-kb-rerank.mjs';

function writeFile(p, content) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); }
function mkProject(name, lessons) {
  const root = mkdtempSync(join(tmpdir(), `prism-spike-${name}-`));
  writeFileSync(join(root, '.prism-kb-share.json'),
    JSON.stringify({ version: 1, shared_types: ['lesson'], shared_at: '2026-06-01T00:00:00.000Z' }));
  for (const [slug, body] of Object.entries(lessons)) {
    writeFile(join(root, 'docs', 'prism', 'lessons', `${slug}.md`), body);
  }
  return root;
}

const home = mkdtempSync(join(tmpdir(), 'prism-spike-home-'));

// Two projects. The QUERY uses one vocabulary ("race condition on shutdown"); the
// BEST answer is phrased as a PARAPHRASE ("concurrent teardown deadlock") — lexical
// overlap with the query is deliberately weak, while a keyword-dense decoy repeats
// "shutdown"/"race" so BM25 alone should rank the decoy at or above the real answer.
// A good re-rank promotes the paraphrase.
const alpha = mkProject('alpha', {
  // The REAL answer: a genuine shutdown race-condition deadlock. It mentions the
  // query terms once, so BM25 includes it — but ranks it BELOW the keyword-stuffed
  // decoy. A good semantic re-rank should recognise this is the true match.
  'teardown-deadlock': '---\nname: Concurrent teardown deadlock\ndescription: A race condition during shutdown: two workers tearing down shared state at process exit deadlocked; fixed by ordering the shutdown sequence.\n---\n# Concurrent teardown deadlock\nWe hit a race condition on shutdown: during graceful exit two threads raced to release the same lock and deadlocked. The fix ordered the shutdown sequence and drained queues before close.',
  // Keyword-stuffed DECOY: repeats the query terms many times but is about an
  // unrelated cache-key collision — high BM25 score, low real relevance.
  'cache-keys': '---\nname: Cache key collision on shutdown flush\ndescription: shutdown race condition shutdown race condition shutdown race condition cache key collision flush.\n---\n# Cache key collision\nshutdown race condition shutdown race condition shutdown race condition shutdown race condition. A cache key collision happened during a flush; unrelated to concurrency but mentions shutdown race condition repeatedly.',
});
const beta = mkProject('beta', {
  'retry-backoff': '---\nname: Exponential retry backoff\ndescription: Flaky network calls needed jittered exponential backoff to stop thundering-herd retries.\n---\n# Retry backoff\nUnrelated lesson about network retries.',
});
buildKnowledgeIndex({ home, projectRoot: alpha });
buildKnowledgeIndex({ home, projectRoot: beta });

const QUERY = 'race condition on shutdown';
const bin = resolveClaudeBin();
console.log(`claude CLI: ${bin || '(absent — will report BM25 fallback only)'}`);
console.log(`re-rank timeout budget: ${DEFAULT_RERANK_TIMEOUT_MS} ms`);
console.log(`query: "${QUERY}"\n`);

// BM25-only baseline.
const bm25 = queryKnowledge(QUERY, { home, crossProject: true, rerank: false, limit: 5 });
console.log('— BM25-only (stage 1) —');
bm25.results.forEach((r, i) => console.log(`  ${i + 1}. [${r.type}] ${r.title}  (score ${typeof r.score === 'number' ? r.score.toFixed(3) : r.score})`));

// Live re-rank, timed.
const t0 = process.hrtime.bigint();
const rr = queryKnowledge(QUERY, { home, crossProject: true, rerank: true, limit: 5 });
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`\n— re-rank (stage 2) — ${rr.label} — wall ${ms.toFixed(0)} ms`);
rr.results.forEach((r, i) => console.log(`  ${i + 1}. [${r.type}] ${r.title}`));

const bm25Top = bm25.results[0] && bm25.results[0].title;
const rrTop = rr.results[0] && rr.results[0].title;
console.log('\n=== SPIKE VERDICT ===');
console.log(`latency: ${ms.toFixed(0)} ms vs ${DEFAULT_RERANK_TIMEOUT_MS} ms budget — ${ms <= DEFAULT_RERANK_TIMEOUT_MS ? 'WITHIN budget' : 'OVER budget (fell back)'}`);
console.log(`reranked: ${rr.reranked} (${rr.reason})`);
console.log(`BM25 top:    ${bm25Top}`);
console.log(`re-rank top: ${rrTop}`);
console.log(`reordering:  ${bm25Top !== rrTop ? 'YES — re-rank changed the top result' : 'no change vs BM25'}`);
