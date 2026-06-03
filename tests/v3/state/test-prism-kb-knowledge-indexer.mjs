#!/usr/bin/env node
// Unit tests for tools/prism-kb-knowledge-indexer.mjs  (PRISM v5.0 F4 Phase B)
// Run: node tests/v3/state/test-prism-kb-knowledge-indexer.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// SYNCHRONOUS harness (mirrors test-prism-bm25.mjs: pass/total/check + final log + exit).
// Builds temp fixtures via mkdtempSync. Covers the F4 §3/§4 contract:
//   default-deny, per-corpus-type opt-in, verdict always-on, provenance,
//   secret-scan redaction, DESCRIPTOR-NOT-BODY (hard), cross-project merge,
//   schema invariants, re-build idempotence.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  KNOWLEDGE_INDEX_REL,
  SHAREABLE_TYPES,
  projectIdFor,
  readShareMarker,
  scanSecrets,
  buildKnowledgeIndex,
} from '../../../tools/prism-kb-knowledge-indexer.mjs';

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// ── fixture helpers ─────────────────────────────────────────────────────────
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'prism-kbk-home-'));
}
function freshProject(name = 'proj') {
  const root = mkdtempSync(join(tmpdir(), `prism-kbk-${name}-`));
  return root;
}
function writeFile(p, content) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function makeCorpus(root, { adjudication, lesson, plan } = {}) {
  if (adjudication) writeFile(join(root, 'docs', 'prism', 'adjudications', 'D001-thing.md'), adjudication);
  if (lesson) writeFile(join(root, 'docs', 'prism', 'lessons', 'lesson-one.md'), lesson);
  if (plan) writeFile(join(root, 'docs', 'prism', 'plans', 'plan-one.md'), plan);
}
function writeShare(root, types) {
  writeFileSync(join(root, '.prism-kb-share.json'),
    JSON.stringify({ version: 1, shared_types: types, shared_at: '2026-05-29T00:00:00.000Z' }));
}
const NOW = '2026-05-29T12:00:00.000Z';

// ── exported constants ──────────────────────────────────────────────────────
check('KNOWLEDGE_INDEX_REL is the documented relative path',
  KNOWLEDGE_INDEX_REL === '.prism-kb/knowledge-index.json');
check('SHAREABLE_TYPES is the four shareable types',
  JSON.stringify(SHAREABLE_TYPES) === JSON.stringify(['adjudication', 'lesson', 'plan', 'panel-rationale']));

// ── projectIdFor: stable short hash ─────────────────────────────────────────
{
  const root = freshProject('idtest');
  const a = projectIdFor(root);
  const b = projectIdFor(root);
  check('projectIdFor: stable across calls', a === b && typeof a === 'string' && a.length === 12);
  const root2 = freshProject('idtest2');
  check('projectIdFor: distinct roots => distinct ids', projectIdFor(root2) !== a);
}

// ── readShareMarker ─────────────────────────────────────────────────────────
{
  const root = freshProject('share');
  check('readShareMarker: null when absent', readShareMarker(root) === null);
  writeShare(root, ['lesson', 'plan']);
  const m = readShareMarker(root);
  check('readShareMarker: reads shared_types', m && JSON.stringify(m.shared_types) === JSON.stringify(['lesson', 'plan']));
  const bad = freshProject('sharebad');
  writeFileSync(join(bad, '.prism-kb-share.json'), 'not json{{{');
  check('readShareMarker: null on invalid JSON', readShareMarker(bad) === null);
}

// ── scanSecrets ─────────────────────────────────────────────────────────────
check('scanSecrets: clean text => redacted false', scanSecrets('hello world, normal prose here').redacted === false);
check('scanSecrets: sk- key => redacted', scanSecrets('key sk-ant-abc12345 here').redacted === true);
check('scanSecrets: gho_ token => redacted', scanSecrets('gho_ABCDefgh12345678').redacted === true);
check('scanSecrets: AKIA key => redacted', scanSecrets('AKIA1234567890ABCDEF').redacted === true);
check('scanSecrets: BEGIN PRIVATE KEY => redacted', scanSecrets('-----BEGIN RSA PRIVATE KEY-----').redacted === true);
check('scanSecrets: api_key=... => redacted', scanSecrets('api_key=supersecret123').redacted === true);
check('scanSecrets: password: ... => redacted', scanSecrets('password: hunter2xyz').redacted === true);
// S1 (v5.0 review): keyword-less / URL-embedded secrets the original 5 patterns missed.
check('scanSecrets: slack token => redacted', scanSecrets('bot xoxb-123456789012-abcdefABCDEF0987').redacted === true);
check('scanSecrets: google api key => redacted', scanSecrets('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q').redacted === true);
check('scanSecrets: JWT => redacted', scanSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.abc123def').redacted === true);
check('scanSecrets: stripe live key => redacted', scanSecrets('sk_live_abcd1234EFGH5678ijkl').redacted === true);
check('scanSecrets: connection string with creds => redacted', scanSecrets('postgres://admin:s3cr3tpw@db.example.com:5432/mydb').redacted === true);
// Negative control: a plain URL with no embedded credentials must NOT redact.
check('scanSecrets: plain url => not redacted', scanSecrets('see https://example.com/docs/page for details').redacted === false);

// ── default-deny: no marker => 0 project entries for that project_id ─────────
{
  const home = freshHome();
  const root = freshProject('deny');
  makeCorpus(root, { adjudication: '# Adj\nbody', lesson: '# Lesson\nbody', plan: '# Plan\nbody' });
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const pid = projectIdFor(root);
  const mine = idx.entries.filter(e => e.project_id === pid);
  check('default-deny: no share marker => 0 project entries', mine.length === 0);
}

// ── per-corpus-type: share lesson+plan, NOT adjudication ─────────────────────
{
  const home = freshHome();
  const root = freshProject('pertype');
  makeCorpus(root, {
    adjudication: '# Adjudication Title\nadjbody',
    lesson: '# Lesson Title\nlessonbody',
    plan: '# Plan Title\nplanbody',
  });
  writeShare(root, ['lesson', 'plan']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const pid = projectIdFor(root);
  const types = new Set(idx.entries.filter(e => e.project_id === pid).map(e => e.type));
  check('per-type: lesson indexed', types.has('lesson'));
  check('per-type: plan indexed', types.has('plan'));
  check('per-type: adjudication NOT indexed', !types.has('adjudication'));
}

// ── verdict always-on (exempt from share marker) ─────────────────────────────
{
  const home = freshHome();
  writeFileSync(join(home, '.prism-phase-1-5-verdicts.jsonl'),
    JSON.stringify({ verdict: 'APPROVED', sha: 'abc123', note: 'looks fine' }) + '\n' +
    JSON.stringify({ verdict: 'BLOCKED', sha: 'def456', note: 'needs work' }) + '\n');
  const root = freshProject('noverdmarker'); // NO share marker
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const verdicts = idx.entries.filter(e => e.type === 'verdict');
  check('verdict always-on: verdict entries present despite no marker', verdicts.length >= 2);
  check('verdict always-on: project_id is GLOBAL', verdicts.every(e => e.project_id === 'GLOBAL'));
  check('verdict always-on: project_label is (home-global)', verdicts.every(e => e.project_label === '(home-global)'));
}

// ── provenance: every project entry carries id + project_id + label + path ───
{
  const home = freshHome();
  const root = freshProject('prov');
  makeCorpus(root, { lesson: '# Provenance Lesson\nsome lesson body about deadlocks' });
  writeShare(root, ['lesson']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const pid = projectIdFor(root);
  const mine = idx.entries.filter(e => e.project_id === pid);
  check('provenance: at least one project entry', mine.length >= 1);
  check('provenance: project_id matches projectIdFor', mine.every(e => e.project_id === pid));
  check('provenance: project_label present', mine.every(e => typeof e.project_label === 'string' && e.project_label.length > 0));
  check('provenance: source_path present', mine.every(e => typeof e.source_path === 'string' && e.source_path.length > 0));
  check('provenance: id is project_id:type:slug', mine.every(e => e.id.startsWith(`${pid}:${e.type}:`)));
}

// ── secret-scan redaction (HARD) ─────────────────────────────────────────────
{
  const home = freshHome();
  const root = freshProject('secret');
  makeCorpus(root, { lesson: '# Secret Lesson\nANTHROPIC_API_KEY=sk-ant-abc12345 do not leak' });
  writeShare(root, ['lesson']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const pid = projectIdFor(root);
  const entry = idx.entries.find(e => e.project_id === pid && e.type === 'lesson');
  check('secret-scan: entry still indexed (discoverable)', !!entry);
  check('secret-scan: redacted === true', entry && entry.redacted === true);
  check('secret-scan: postings === {}', entry && JSON.stringify(entry.postings) === '{}');
  check('secret-scan: description === redaction placeholder',
    entry && entry.description === '(redacted — possible secret)');
}

// ── DESCRIPTOR-NOT-BODY (HARD): full body prose never stored ──────────────────
{
  const home = freshHome();
  const root = freshProject('body');
  const sentinelLine = 'UNIQUEBODYSENTINEL_qwerty appears as a whole multiword sentence here';
  // First non-heading line is a benign summary (legitimately allowed into the bounded
  // description); the sentinel prose lives DEEPER in the body and must never be stored.
  makeCorpus(root, { lesson: `# Body Lesson\nA benign one-line summary for the description.\n${sentinelLine}\nmore prose follows the sentinel line` });
  writeShare(root, ['lesson']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const json = JSON.stringify(idx);
  // The verbatim multi-word body line must NOT appear anywhere in the index.
  check('descriptor-not-body: verbatim body line absent from index', !json.includes(sentinelLine));
  check('descriptor-not-body: multiword prose phrase absent',
    !json.includes('more prose follows the sentinel line'));
  // The single token IS allowed as a posting key (bag-of-words footprint).
  const pid = projectIdFor(root);
  const e = idx.entries.find(x => x.project_id === pid && x.type === 'lesson');
  check('descriptor-not-body: tokenized posting key is allowed', !!(e && e.postings && Object.keys(e.postings).length > 0));
}

// ── HIGH-ENTROPY TOKEN LEAK (HARD, §6.B): a keyword-less secret that scanSecrets'
//    keyworded patterns MISS must still not survive verbatim in the egress index.
//    Defense-in-depth: long hex hashes / API-key-shaped blobs are dropped from
//    postings + keywords (they are never legitimate BM25 search terms), so they
//    never reach the global cross-project index or claude -p rerank egress.
{
  const home = freshHome();
  const root = freshProject('entropy');
  const hexSecret = 'a3f9c1e8b7d24056af3e9c1b8d7f2046a3f9c1e8b7d24056af3e9c1b8d7f2046'; // 64-hex, keyword-less
  const blobSecret = 'qwxhzgrpbjpvcgvuu2vzyw1lmtizndu2nzg5mefcq0rfrkdisuo';                 // 51-char mixed blob
  // scanSecrets does NOT flag these (confirms the keyword-less gap they close).
  check('high-entropy: scanSecrets misses bare hex (keyword-less gap)', scanSecrets(hexSecret).redacted === false);
  makeCorpus(root, { lesson: `# Entropy Lesson\nbenign summary line for description.\nnormal prose then ${hexSecret} and ${blobSecret} embedded.` });
  writeShare(root, ['lesson']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const json = JSON.stringify(idx);
  check('high-entropy: 64-hex secret ABSENT from egress index', !json.includes(hexSecret));
  check('high-entropy: mixed blob secret ABSENT from egress index', !json.includes(blobSecret));
  const pid = projectIdFor(root);
  const e = idx.entries.find(x => x.project_id === pid && x.type === 'lesson');
  check('high-entropy: hex not a posting key', e && !Object.keys(e.postings || {}).some(k => k.includes(hexSecret)));
  // GUARD: ordinary words on the same line must still be indexed (no over-drop).
  check('high-entropy: normal terms still indexed (no over-drop)', e && Object.keys(e.postings || {}).includes('embedded'));
}

// ── cross-project merge: two roots both sharing lesson ───────────────────────
{
  const home = freshHome();
  const rootA = freshProject('mergeA');
  const rootB = freshProject('mergeB');
  makeCorpus(rootA, { lesson: '# Alpha Lesson\nalpha unique alphaterm content here' });
  makeCorpus(rootB, { lesson: '# Beta Lesson\nbeta unique betaterm content here' });
  writeShare(rootA, ['lesson']);
  writeShare(rootB, ['lesson']);
  buildKnowledgeIndex({ home, projectRoot: rootA, now: NOW });
  const idx = buildKnowledgeIndex({ home, projectRoot: rootB, now: NOW });
  const pidA = projectIdFor(rootA);
  const pidB = projectIdFor(rootB);
  const hasA = idx.entries.some(e => e.project_id === pidA);
  const hasB = idx.entries.some(e => e.project_id === pidB);
  check('cross-merge: entries from project A present', hasA);
  check('cross-merge: entries from project B present', hasB);
  check('cross-merge: doc_count === entries.length after merge', idx.doc_count === idx.entries.length);
  // df reflects union: alphaterm only in A, betaterm only in B, both df=1
  check('cross-merge: df["alphaterm"] === 1', idx.df['alphaterm'] === 1);
  check('cross-merge: df["betaterm"] === 1', idx.df['betaterm'] === 1);
  // "content" appears in both => df=2
  check('cross-merge: df["content"] === 2 (union df)', idx.df['content'] === 2);
}

// ── schema invariants ─────────────────────────────────────────────────────────
{
  const home = freshHome();
  const root = freshProject('schema');
  makeCorpus(root, { lesson: '# Schema Lesson\nschema body content' });
  writeShare(root, ['lesson']);
  const idx = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  check('schema: version === 1', idx.version === 1);
  check('schema: kind === prism-kb-knowledge', idx.kind === 'prism-kb-knowledge');
  check('schema: df is an object', idx.df && typeof idx.df === 'object' && !Array.isArray(idx.df));
  check('schema: doc_count === entries.length', idx.doc_count === idx.entries.length);
  check('schema: built_at is the injected now', idx.built_at === NOW);
  check('schema: machine_id present', typeof idx.machine_id === 'string' && idx.machine_id.length > 0);
  check('schema: projects map carries this project', !!idx.projects[projectIdFor(root)]);
  check('schema: source_mtime_max is a number', typeof idx.source_mtime_max === 'number');
  // file written atomically to home/<KNOWLEDGE_INDEX_REL>
  const written = join(home, KNOWLEDGE_INDEX_REL);
  check('schema: index file written to disk', existsSync(written));
  const onDisk = JSON.parse(readFileSync(written, 'utf-8'));
  check('schema: on-disk matches returned (doc_count)', onDisk.doc_count === idx.doc_count);
}

// ── re-build idempotence: rebuild same project does not duplicate ────────────
{
  const home = freshHome();
  const root = freshProject('idem');
  makeCorpus(root, { lesson: '# Idem Lesson\nidem body content', plan: '# Idem Plan\nplan body content' });
  writeShare(root, ['lesson', 'plan']);
  const idx1 = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const pid = projectIdFor(root);
  const count1 = idx1.entries.filter(e => e.project_id === pid).length;
  const idx2 = buildKnowledgeIndex({ home, projectRoot: root, now: NOW });
  const count2 = idx2.entries.filter(e => e.project_id === pid).length;
  check('idempotence: same project entry count on rebuild', count1 === count2 && count1 === 2);
  check('idempotence: no duplicate ids', new Set(idx2.entries.map(e => e.id)).size === idx2.entries.length);
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
