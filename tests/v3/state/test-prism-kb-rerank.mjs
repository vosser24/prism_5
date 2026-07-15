#!/usr/bin/env node
// Unit tests for tools/lib/prism-kb-rerank.mjs
// Run: node tests/v3/state/test-prism-kb-rerank.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// ALL tests inject a stub runner — NO test invokes a live claude CLI.
// Synchronous harness: the same fn(); pass++ pattern as test-prism-bm25.mjs.
// The module under test is also intentionally synchronous (spawnSync-based),
// so no async/await is needed here either.

import {
  DEFAULT_RERANK_TIMEOUT_MS,
  resolveClaudeBin,
  buildRerankPrompt,
  parseRerankResponse,
  rerank,
} from '../../../tools/lib/prism-kb-rerank.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Build a minimal candidate array with the given id strings.
function makeCandidates(ids) {
  return ids.map((id, i) => ({
    id,
    type: 'lesson',
    title: `Title ${id}`,
    description: `Desc ${id}`,
    project_label: 'proj',
    domain: 'reliability',
  }));
}

// A stub runner factory: returns {stdout, code, timedOut, error} as given.
function stubRunner(response) {
  return function(opts) { return response; };
}

// ── DEFAULT_RERANK_TIMEOUT_MS ─────────────────────────────────────────────────

check(
  'DEFAULT_RERANK_TIMEOUT_MS: exported and equals 8000',
  DEFAULT_RERANK_TIMEOUT_MS === 8000
);

// ── resolveClaudeBin ──────────────────────────────────────────────────────────

check(
  'resolveClaudeBin: returns a string or null',
  typeof resolveClaudeBin() === 'string' || resolveClaudeBin() === null
);

// ── buildRerankPrompt ─────────────────────────────────────────────────────────

const sampleCandidates = makeCandidates(['a', 'b', 'c']);
const prompt = buildRerankPrompt('race condition on shutdown', sampleCandidates);

check(
  'buildRerankPrompt: returns a string',
  typeof prompt === 'string'
);

check(
  'buildRerankPrompt: includes the query text',
  prompt.includes('race condition on shutdown')
);

check(
  'buildRerankPrompt: includes each candidate id',
  ['a', 'b', 'c'].every(id => prompt.includes(id))
);

check(
  'buildRerankPrompt: includes each candidate title',
  sampleCandidates.every(c => prompt.includes(c.title))
);

check(
  'buildRerankPrompt: instructs model to return only a JSON array',
  /JSON\s+array/i.test(prompt) || /only.*\[/i.test(prompt) || /return.*\[/i.test(prompt)
);

// ── parseRerankResponse ───────────────────────────────────────────────────────

const candidates3 = makeCandidates(['a', 'b', 'c']);

// Clean JSON array
const parsed1 = parseRerankResponse('["c","a","b"]', candidates3);
check(
  'parseRerankResponse: clean JSON array reorders correctly',
  parsed1 !== null &&
  parsed1[0].id === 'c' && parsed1[1].id === 'a' && parsed1[2].id === 'b'
);

// Tolerate surrounding prose
const parsed2 = parseRerankResponse('I think the best order is ["b","c","a"] for this query.', candidates3);
check(
  'parseRerankResponse: tolerates prose wrapping the [...] array',
  parsed2 !== null &&
  parsed2[0].id === 'b' && parsed2[1].id === 'c' && parsed2[2].id === 'a'
);

// Missing ids appended in original order
const parsed3 = parseRerankResponse('["c"]', candidates3);
check(
  'parseRerankResponse: missing ids appended in original order',
  parsed3 !== null &&
  parsed3[0].id === 'c' && parsed3[1].id === 'a' && parsed3[2].id === 'b'
);

// No JSON array => null
const parsed4 = parseRerankResponse('I think the best is architecture because of reasons.', candidates3);
check(
  'parseRerankResponse: no JSON array => null',
  parsed4 === null
);

// Empty string => null
check(
  'parseRerankResponse: empty string => null',
  parseRerankResponse('', candidates3) === null
);

// Array with unrecognised ids only: all original candidates appended in order
const parsed5 = parseRerankResponse('["zzz","yyy"]', candidates3);
check(
  'parseRerankResponse: unrecognised ids in response => all originals appended in order',
  parsed5 !== null &&
  parsed5[0].id === 'a' && parsed5[1].id === 'b' && parsed5[2].id === 'c'
);

// ── rerank ── disabled via opts.rerank:false ──────────────────────────────────

const candidates3i = makeCandidates(['a', 'b', 'c']);
const r1 = rerank('query', candidates3i, { rerank: false, runner: stubRunner({stdout:'["c","a","b"]',code:0,timedOut:false}) });
check('disabled(opts.rerank:false): reranked === false', r1.reranked === false);
check('disabled(opts.rerank:false): reason === "disabled"', r1.reason === 'disabled');
check('disabled(opts.rerank:false): results order identical to input', r1.results[0].id === 'a' && r1.results[1].id === 'b' && r1.results[2].id === 'c');

// ── disabled via env PRISM_RECALL_RERANK='off' ────────────────────────────────

const r2 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  env: { PRISM_RECALL_RERANK: 'off' },
  runner: stubRunner({stdout:'["c","a","b"]',code:0,timedOut:false}),
});
check('disabled(env off): reranked === false', r2.reranked === false);
check('disabled(env off): reason === "disabled"', r2.reason === 'disabled');
check('disabled(env off): order unchanged', r2.results[0].id === 'a' && r2.results[1].id === 'b' && r2.results[2].id === 'c');

// ── no-cli: opts.claudeBin:null ───────────────────────────────────────────────

let runnerCalled = false;
const r3 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: null,
  runner: (opts) => { runnerCalled = true; return {stdout:'["c","a","b"]',code:0,timedOut:false}; },
});
check('no-cli: reranked === false', r3.reranked === false);
check('no-cli: reason === "no-cli"', r3.reason === 'no-cli');
check('no-cli: order unchanged', r3.results[0].id === 'a' && r3.results[1].id === 'b' && r3.results[2].id === 'c');
check('no-cli: runner was NOT called (guard fires before runner)', !runnerCalled);

// ── success: re-rank reorders candidates ──────────────────────────────────────

const r4 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({stdout:'["c","a","b"]',code:0,timedOut:false}),
});
check('success: reranked === true', r4.reranked === true);
check('success: reason === "ok"', r4.reason === 'ok');
check('success: results ids === [c,a,b]', r4.results[0].id === 'c' && r4.results[1].id === 'a' && r4.results[2].id === 'b');

// ── missing ids appended in original order ────────────────────────────────────

const r5 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({stdout:'["c"]',code:0,timedOut:false}),
});
check('missing ids appended: results ids === [c,a,b]', r5.results[0].id === 'c' && r5.results[1].id === 'a' && r5.results[2].id === 'b');
check('missing ids appended: reranked === true', r5.reranked === true);

// ── timeout ───────────────────────────────────────────────────────────────────

const r6 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({timedOut:true}),
});
check('timeout: reranked === false', r6.reranked === false);
check('timeout: reason === "timeout"', r6.reason === 'timeout');
check('timeout: order unchanged', r6.results[0].id === 'a' && r6.results[1].id === 'b' && r6.results[2].id === 'c');

// ── error exit: code !== 0 ────────────────────────────────────────────────────

const r7 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({code:1,timedOut:false}),
});
check('error exit: reranked === false', r7.reranked === false);
check('error exit: reason === "error"', r7.reason === 'error');
check('error exit: order unchanged', r7.results[0].id === 'a' && r7.results[1].id === 'b' && r7.results[2].id === 'c');

// ── spawn error (ENOENT or similar) ──────────────────────────────────────────

const r8 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({error: new Error('ENOENT: no such file'), code: undefined, timedOut: false}),
});
check('spawn error: reranked === false', r8.reranked === false);
check('spawn error: reason === "error"', r8.reason === 'error');
check('spawn error: order unchanged', r8.results[0].id === 'a' && r8.results[1].id === 'b' && r8.results[2].id === 'c');

// ── parse-fail: no JSON array in stdout ──────────────────────────────────────

const r9 = rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({stdout:'I think the best is architecture because of X.', code:0, timedOut:false}),
});
check('parse-fail: reranked === false', r9.reranked === false);
check('parse-fail: reason === "parse-fail"', r9.reason === 'parse-fail');
check('parse-fail: order unchanged', r9.results[0].id === 'a' && r9.results[1].id === 'b' && r9.results[2].id === 'c');

// ── trivial: 1 candidate ──────────────────────────────────────────────────────

const r10 = rerank('query', makeCandidates(['solo']), {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({stdout:'["solo"]',code:0,timedOut:false}),
});
check('trivial: reranked === false', r10.reranked === false);
check('trivial: reason === "trivial"', r10.reason === 'trivial');
check('trivial: single candidate returned', r10.results.length === 1 && r10.results[0].id === 'solo');

// ── trivial: 0 candidates ─────────────────────────────────────────────────────

const r10b = rerank('query', [], {
  claudeBin: '/usr/bin/claude',
  runner: stubRunner({stdout:'[]',code:0,timedOut:false}),
});
check('trivial: 0 candidates => reason:"trivial"', r10b.reranked === false && r10b.reason === 'trivial');

// ── timeoutMs override via env PRISM_RECALL_RERANK_TIMEOUT_MS ────────────────

let capturedTimeoutMs = null;
rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  env: { PRISM_RECALL_RERANK_TIMEOUT_MS: '1234' },
  runner: (opts) => {
    capturedTimeoutMs = opts.timeoutMs;
    return {stdout:'["a","b","c"]',code:0,timedOut:false};
  },
});
check(
  'timeoutMs override via env: runner receives 1234',
  capturedTimeoutMs === 1234
);

// ── timeoutMs default from DEFAULT_RERANK_TIMEOUT_MS ─────────────────────────

let capturedDefaultTimeout = null;
rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  env: {},
  runner: (opts) => {
    capturedDefaultTimeout = opts.timeoutMs;
    return {stdout:'["a","b","c"]',code:0,timedOut:false};
  },
});
check(
  'timeoutMs default: runner receives DEFAULT_RERANK_TIMEOUT_MS when env not set',
  capturedDefaultTimeout === DEFAULT_RERANK_TIMEOUT_MS
);

// ── opts.timeoutMs explicit override ─────────────────────────────────────────

let capturedOptsTimeout = null;
rerank('query', makeCandidates(['a', 'b', 'c']), {
  claudeBin: '/usr/bin/claude',
  timeoutMs: 5555,
  env: {},
  runner: (opts) => {
    capturedOptsTimeout = opts.timeoutMs;
    return {stdout:'["a","b","c"]',code:0,timedOut:false};
  },
});
check(
  'timeoutMs opts.timeoutMs explicit: runner receives 5555',
  capturedOptsTimeout === 5555
);

// ── K<=20 cap: only top 20 sent to runner, tail appended in BM25 order ────────

// Build 25 candidates; success re-rank returns only first 20 ids reversed.
const ids25 = Array.from({length: 25}, (_, i) => `id${String(i).padStart(2,'0')}`);
const cands25 = makeCandidates(ids25);
// The runner will receive a prompt; we verify it's called and returns 20 reversed ids.
const top20Reversed = ids25.slice(0, 20).slice().reverse();
let promptSeen = null;
const r11 = rerank('query', cands25, {
  claudeBin: '/usr/bin/claude',
  runner: (opts) => {
    promptSeen = opts.prompt;
    // Return the top-20 ids in reversed order
    return { stdout: JSON.stringify(top20Reversed), code: 0, timedOut: false };
  },
});
check('K<=20 cap: reranked === true', r11.reranked === true);
// First result should be id19 (last of top 20, reversed)
check('K<=20 cap: first result is id19 (reversed top-20)', r11.results[0].id === 'id19');
// Results should have all 25 candidates
check('K<=20 cap: all 25 candidates returned', r11.results.length === 25);
// The tail (ids 20-24) should still be in original BM25 order (id20..id24) after the top-20
const tailIds = r11.results.slice(20).map(c => c.id);
check('K<=20 cap: tail beyond 20 keeps BM25 order', tailIds[0] === 'id20' && tailIds[4] === 'id24');
// The prompt sent to runner should include only the top-20 ids, not id20..id24
check(
  'K<=20 cap: prompt does not include tail ids beyond 20',
  promptSeen !== null && !promptSeen.includes('id20') && !promptSeen.includes('id24')
);

// ── runner receives prompt and timeoutMs ─────────────────────────────────────

let runnerOpts = null;
rerank('my search query', makeCandidates(['x', 'y']), {
  claudeBin: '/usr/bin/claude',
  runner: (opts) => {
    runnerOpts = opts;
    return {stdout:'["x","y"]',code:0,timedOut:false};
  },
});
check(
  'runner opts: prompt is a string',
  runnerOpts !== null && typeof runnerOpts.prompt === 'string'
);
check(
  'runner opts: prompt contains query',
  runnerOpts !== null && runnerOpts.prompt.includes('my search query')
);
check(
  'runner opts: timeoutMs is a number',
  runnerOpts !== null && typeof runnerOpts.timeoutMs === 'number'
);

// ── never throws ─────────────────────────────────────────────────────────────

let threw = false;
try {
  // Pass a runner that throws
  rerank('query', makeCandidates(['a', 'b']), {
    claudeBin: '/usr/bin/claude',
    runner: () => { throw new Error('unexpected runner explosion'); },
  });
} catch (e) {
  threw = true;
}
check('never throws: runner exception is caught, returns fallback', !threw);

// ── Final ─────────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
