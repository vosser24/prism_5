#!/usr/bin/env node
// Unit tests for tools/lib/prism-bm25.mjs
// Run: node tests/v3/state/test-prism-bm25.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// Decision: 1-char tokens ARE kept (e.g. "a" in "a b c"). BM25 ranking benefits
// from stop-word removal at caller level; the tokenizer is deliberately minimal.
// Single-char tokens can carry semantic weight in IDs / short codes.

import {
  tokenize,
  termFrequencies,
  idf,
  buildStats,
  bm25Score,
  rank,
} from '../../../tools/lib/prism-bm25.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// ── tokenize ─────────────────────────────────────────────────────────────────

check(
  'tokenize: lowercases and splits on non-alphanumeric',
  JSON.stringify(tokenize('Race-Condition on Shutdown!')) ===
    JSON.stringify(['race', 'condition', 'on', 'shutdown'])
);

check(
  'tokenize: drops empty tokens (consecutive separators)',
  JSON.stringify(tokenize('foo  bar---baz')) ===
    JSON.stringify(['foo', 'bar', 'baz'])
);

check(
  'tokenize: single-char tokens are kept',
  JSON.stringify(tokenize('a b c')) === JSON.stringify(['a', 'b', 'c'])
);

check(
  'tokenize: empty string => empty array',
  JSON.stringify(tokenize('')) === JSON.stringify([])
);

check(
  'tokenize: all separators => empty array',
  JSON.stringify(tokenize('---!!!   ')) === JSON.stringify([])
);

check(
  'tokenize: numbers treated as alphanumeric',
  JSON.stringify(tokenize('IPv4 127.0.0.1')) ===
    JSON.stringify(['ipv4', '127', '0', '0', '1'])
);

// ── termFrequencies ───────────────────────────────────────────────────────────

const tf1 = termFrequencies(['a', 'b', 'a']);
check('termFrequencies: counts repeats', tf1['a'] === 2 && tf1['b'] === 1);

check(
  'termFrequencies: single unique term',
  termFrequencies(['x'])['x'] === 1
);

check(
  'termFrequencies: empty array => empty object',
  Object.keys(termFrequencies([])).length === 0
);

const tf2 = termFrequencies(['z', 'z', 'z']);
check('termFrequencies: all same => single key with count 3', tf2['z'] === 3 && Object.keys(tf2).length === 1);

// ── idf ───────────────────────────────────────────────────────────────────────
// Formula: ln(1 + (N - df + 0.5) / (df + 0.5))

check(
  'idf: formula correctness — df=1 N=10',
  Math.abs(idf(1, 10) - Math.log(1 + (10 - 1 + 0.5) / (1 + 0.5))) < 1e-10
);

check(
  'idf: formula correctness — df=5 N=10',
  Math.abs(idf(5, 10) - Math.log(1 + (10 - 5 + 0.5) / (5 + 0.5))) < 1e-10
);

// Monotonic: rarer term (df=1) > common term (df=9) at same N=10
check(
  'idf: monotonic — rarer term has strictly higher idf',
  idf(1, 10) > idf(9, 10)
);

// Positive for df < N
check(
  'idf: positive when df < N',
  idf(1, 10) > 0 && idf(5, 10) > 0
);

check(
  'idf: df=0 is valid (term in no docs) and positive',
  idf(0, 10) > 0
);

// Edge: df = N (term in every doc) => idf approaches ln(1+0.5/1.5) = ln(1.333) > 0
check(
  'idf: df == N is still positive (saturation but non-zero)',
  idf(10, 10) > 0
);

// ── buildStats ────────────────────────────────────────────────────────────────

const docs3 = [
  { id: 'doc1', postings: { cat: 2, dog: 1 }, length: 3 },
  { id: 'doc2', postings: { cat: 1, fish: 2 }, length: 3 },
  { id: 'doc3', postings: { bird: 3 }, length: 3 },
];
const stats3 = buildStats(docs3);

check('buildStats: N = docs.length', stats3.N === 3);
check(
  'buildStats: avgDocLen = mean of lengths',
  Math.abs(stats3.avgDocLen - 3) < 1e-10
);
// "cat" appears in doc1 + doc2 => df=2
check('buildStats: df counts distinct documents (cat)', stats3.df['cat'] === 2);
// "dog" appears only in doc1 => df=1
check('buildStats: df counts distinct documents (dog)', stats3.df['dog'] === 1);
// "fish" appears only in doc2 => df=1
check('buildStats: df counts distinct documents (fish)', stats3.df['fish'] === 1);
// "bird" appears only in doc3 => df=1
check('buildStats: df counts distinct documents (bird)', stats3.df['bird'] === 1);
// A term not present should be undefined / 0, not a key
check(
  'buildStats: unknown term not in df',
  stats3.df['unknown'] === undefined
);

// 3-doc fixture with varying lengths
const docs3b = [
  { id: 'a', postings: { x: 1 }, length: 2 },
  { id: 'b', postings: { x: 1, y: 1 }, length: 4 },
  { id: 'c', postings: { y: 1, z: 1 }, length: 6 },
];
const stats3b = buildStats(docs3b);
check('buildStats: avgDocLen varied', Math.abs(stats3b.avgDocLen - 4) < 1e-10);
check('buildStats: x df=2', stats3b.df['x'] === 2);
check('buildStats: y df=2', stats3b.df['y'] === 2);
check('buildStats: z df=1', stats3b.df['z'] === 1);

// Empty docs
const statsEmpty = buildStats([]);
check('buildStats: empty docs => N=0', statsEmpty.N === 0);
check('buildStats: empty docs => avgDocLen=0 (no divide-by-zero)', statsEmpty.avgDocLen === 0);

// Single doc
const statsSingle = buildStats([{ id: 'x', postings: { hello: 1 }, length: 1 }]);
check('buildStats: single doc N=1', statsSingle.N === 1);
check('buildStats: single doc avgDocLen=1', statsSingle.avgDocLen === 1);
check('buildStats: single doc df hello=1', statsSingle.df['hello'] === 1);

// ── bm25Score ─────────────────────────────────────────────────────────────────

// (a) doc containing more distinct query terms scores higher
const statsA = buildStats([
  { id: 'rich', postings: { cat: 2, dog: 1, fish: 1 }, length: 4 },
  { id: 'poor', postings: { cat: 1 }, length: 1 },
]);
const richDoc  = { postings: { cat: 2, dog: 1, fish: 1 }, length: 4 };
const poorDoc  = { postings: { cat: 1 }, length: 1 };
const queryABC = ['cat', 'dog', 'fish'];
check(
  'bm25Score: doc with more distinct query terms scores higher',
  bm25Score(queryABC, richDoc, statsA) > bm25Score(queryABC, poorDoc, statsA)
);

// (b) higher tf raises score but with saturation (sublinear)
// Build a corpus where the only variable is tf of "cat" in the target doc.
// Use a helper to compute contribution of one extra count.
const statsSat = buildStats([
  { id: 'd1', postings: { cat: 1 }, length: 1 },
  { id: 'd2', postings: { cat: 2 }, length: 2 },
  { id: 'd3', postings: { cat: 4 }, length: 4 },
]);
const docTf1 = { postings: { cat: 1 }, length: 1 };
const docTf2 = { postings: { cat: 2 }, length: 2 };
const docTf4 = { postings: { cat: 4 }, length: 4 };
const s1 = bm25Score(['cat'], docTf1, statsSat);
const s2 = bm25Score(['cat'], docTf2, statsSat);
const s4 = bm25Score(['cat'], docTf4, statsSat);
check('bm25Score: higher tf raises score (tf2 > tf1)', s2 > s1);
check('bm25Score: higher tf raises score (tf4 > tf2)', s4 > s2);
// Saturation: delta from tf1->tf2 > delta from tf2->tf4 (sublinear growth)
check(
  'bm25Score: tf saturation — delta(1->2) > delta(2->4)/2',
  (s2 - s1) > (s4 - s2) / 2
);
// Stricter: the gain from 1->2 is strictly larger than the gain from 3->4
// (i.e. doubling tf less-than-doubles the contribution)
check(
  'bm25Score: doubling tf less-than-doubles score',
  s2 < s1 * 2
);

// (c) length normalisation: longer doc with same tf scores lower when b > 0
const statsLen = buildStats([
  { id: 'short', postings: { word: 2 }, length: 2 },
  { id: 'long',  postings: { word: 2 }, length: 20 },
]);
const shortDoc = { postings: { word: 2 }, length: 2 };
const longDoc  = { postings: { word: 2 }, length: 20 };
check(
  'bm25Score: longer doc with same tf scores lower (b=0.75)',
  bm25Score(['word'], shortDoc, statsLen) > bm25Score(['word'], longDoc, statsLen)
);
// At b=0 the length normalisation is disabled → equal scores
const scoreB0Short = bm25Score(['word'], shortDoc, statsLen, { b: 0 });
const scoreB0Long  = bm25Score(['word'], longDoc,  statsLen, { b: 0 });
check(
  'bm25Score: at b=0 length does not penalise score',
  Math.abs(scoreB0Short - scoreB0Long) < 1e-9
);

// (d) absent query term contributes 0
// Build a stat where "absent" is not in any doc
const statsD = buildStats([
  { id: 'dx', postings: { present: 3 }, length: 3 },
]);
const docD = { postings: { present: 3 }, length: 3 };
const scorePresent  = bm25Score(['present'], docD, statsD);
const scoreAbsent   = bm25Score(['absent'],  docD, statsD);
check('bm25Score: query term absent from doc contributes 0', scoreAbsent === 0);
check('bm25Score: present query term scores > 0', scorePresent > 0);

// (e) empty queryTerms => score 0
check('bm25Score: empty queryTerms => 0', bm25Score([], docD, statsD) === 0);

// ── rank ──────────────────────────────────────────────────────────────────────

const rankDocs = [
  { id: 'best',    postings: { node: 3, async: 2, error: 1 }, length: 6 },
  { id: 'middle',  postings: { node: 1 },                     length: 1 },
  { id: 'nomatch', postings: { python: 5, flask: 2 },          length: 7 },
];

const results = rank('Node async', rankDocs);

check('rank: returns array',         Array.isArray(results));
check('rank: best doc ranks first',  results[0]?.id === 'best');
check('rank: middle doc ranks second', results[1]?.id === 'middle');
check('rank: nomatch doc excluded',  results.every(r => r.id !== 'nomatch'));
check('rank: scores are numbers',    results.every(r => typeof r.score === 'number'));
check('rank: sorted desc',           results.every((r, i) => i === 0 || r.score <= results[i - 1].score));

// empty query => []
check('rank: empty query => []',     JSON.stringify(rank('', rankDocs)) === '[]');
check('rank: whitespace query => []', JSON.stringify(rank('   ', rankDocs)) === '[]');

// empty docs => []
check('rank: empty docs => []',      JSON.stringify(rank('node', [])) === '[]');

// single doc that matches
const singleMatch = rank('bird', [{ id: 'only', postings: { bird: 1 }, length: 1 }]);
check('rank: single matching doc returned', singleMatch.length === 1 && singleMatch[0].id === 'only');

// single doc with no match excluded
const singleNoMatch = rank('cat', [{ id: 'only', postings: { bird: 1 }, length: 1 }]);
check('rank: single non-matching doc excluded', singleNoMatch.length === 0);

// ── Final ──────────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
