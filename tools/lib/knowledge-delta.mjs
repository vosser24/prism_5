// tools/lib/knowledge-delta.mjs — shared in-process knowledge delta computation.
//
// Extracted from tools/prism-knowledge-index.mjs so hooks can call computeDelta /
// applyDelta without spawning a subprocess (satisfies the SessionStart zero-
// spawnSync invariant asserted by test-session-start-async-audit.mjs).
//
// Exports:
//   computeDelta(root) → { added:string[], changed:string[], removed:string[], entries:object[] }
//     Pure read — hashes corpus vs manifest. Never writes anything.
//
//   applyDelta(root)   → same shape as computeDelta
//     Computes delta and, if anything changed (or manifest is missing), writes
//     index + manifest + keyword-map (the self-heal that cmdDelta performs).
//     Returns the delta summary.  Fully fail-open — never throws.
//
// Both functions are synchronous-friendly at their core (file I/O only); they
// call async buildKeywordMap internally (via a fire-forget pattern so the
// synchronous caller still works).  applyDelta itself is async so callers
// can await the keyword-map write to complete.
//
// Dependency-free: only node: builtins and a lazy dynamic import of the
// prism-router tokenizer (same approach as prism-knowledge-index.mjs).

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
        statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {renameWithRetry} from './atomic-fs.mjs';

// ─── tokenizer (lazy) ────────────────────────────────────────────────────────

let _tokenize = null;
async function getTokenize() {
  if (_tokenize) return _tokenize;
  try {
    const routerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'hooks', 'lib', 'prism-router.mjs'
    );
    const {tokenize} = await import(pathToFileURL(routerPath).href);
    _tokenize = tokenize;
  } catch {
    _tokenize = (text) => {
      if (!text) return [];
      return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
    };
  }
  return _tokenize;
}

// ─── low-level helpers ───────────────────────────────────────────────────────

function sha1(content) {
  return createHash('sha1').update(content).digest('hex');
}

function atomicWrite(path, body) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY.
  renameWithRetry(renameSync, tmp, path);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

// ─── keyword-token construction (single owner) ────────────────────────────────
//
// SINGLE OWNER (task #58/D053). buildEntryTokens (and its RULE_TOKEN_CAP /
// DEV_STOP constants) used to live in tools/prism-knowledge-index.mjs and was
// used by the rebuild + append writers there — but the THIRD keyword-map writer,
// buildKeywordMap() in THIS file (the SessionStart self-heal), still used the
// old seed-only text (title+slug+ref, NO rule tokens). Every SessionStart with a
// corpus delta re-rendered the whole map from that old seed, silently dropping
// every rule token — reverting round-1 recall AND stripping the DF=1 anchors the
// D053 precision gate depends on. Centralizing here makes all three writers share
// one definition, so the token set can never drift again.

// F58/D052: cap on total keyword-map tokens per entry. Bounds the D023
// keywordScore multiplier (kwSet.size/10) so appending rule tokens can never
// re-inflate it the way F5 did (94-token kwSet -> 9.4x). 22 keeps the ceiling
// at 2.2x (vs the pre-fix 1.8x) — see docs/prism/adjudications/D052.
const RULE_TOKEN_CAP = 22;

// Generic tokens that survive the base tokenizer (len>=3, not in router
// STOPWORDS) yet are English/dev-generic — corpus-IDF cannot catch them because
// they are rare-in-corpus but common in prompts. Stripped from RULE candidates
// only (never from title/slug/ref seed). Load-bearing: without it, multi-word
// generic prompts ("how do I use this code") over-fire at 0.20.
const DEV_STOP = new Set([
  'use','used','using','run','runs','running','build','builds','building',
  'make','makes','making','get','gets','getting','set','sets','need','needs',
  'want','wants','way','ways','thing','things','code','codes','file','files',
  'test','tests','new','add','adds','one','two','per','via','also','every',
  'any','all','into','onto','out','own','much','many','more','most','less',
  'just','only','real','actually'
]);

// Build the capped keyword token list for one entry. seed = title+slug+ref
// tokens (ALWAYS fully kept — precision-preserving, matches pre-fix behavior).
// Then append rule tokens in document order, minus seed dups and DEV_STOP,
// up to RULE_TOKEN_CAP total.
export function buildEntryTokens(tokenize, title, slug, ref, rule) {
  const seedSrc = (title || '') + ' ' + (slug || '') + ' ' + (ref || '');
  const seed = [...new Set(tokenize(seedSrc))];
  const seedSet = new Set(seed);
  const ruleTokens = [...new Set(tokenize(rule || ''))]
    .filter(t => !seedSet.has(t) && !DEV_STOP.has(t));
  const budget = Math.max(0, RULE_TOKEN_CAP - seed.length);
  return [...seed, ...ruleTokens.slice(0, budget)];
}

// ─── filename parsers ────────────────────────────────────────────────────────

const ADJ_FILE_RE = /^D(\d{3,})-(.+)\.md$/;
function parseAdjFilename(name) {
  const m = name.match(ADJ_FILE_RE);
  if (!m) return null;
  return {dNum: parseInt(m[1], 10), slug: m[2], ref: 'D' + m[1]};
}

// LESSON_DATE_RE is retained for sortDate only (scanLessons below); it no
// longer feeds the lesson `ref`.
const LESSON_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

// Parse lesson filename: ref = the full basename slug (filename minus .md).
//
// SINGLE OWNER (task #22, anti-rot per D046 finding #4). This function used to
// be COPY-PASTED here and in tools/prism-knowledge-index.mjs. task #21 fixed
// the copy over there (ref = full stem) but left THIS copy on the old
// date-only bug, so every SessionStart self-heal (applyDelta re-renders the
// WHOLE index) rewrote every lesson ref back to the collision-prone bare-date
// form — silently regressing the fix. Two same-date lessons
// (e.g. 2026-07-17-session.md and 2026-07-17-session-addendum.md) both reduced
// to ref '2026-07-17' and evicted/duplicated each other in the index and
// keyword map (exit 0, no warning — the D047 vacuous-signal class).
//
// Fix: ref = the full filename stem — unique BY CONSTRUCTION (a directory
// cannot hold two files with the same name), so no separate collision check is
// needed. This module is now the ONE definition: prism-knowledge-index.mjs
// imports parseLessonFilename FROM HERE, so the append and delta paths can
// never diverge again.
export function parseLessonFilename(name) {
  const ref = name.replace(/\.md$/, '');
  return {ref};
}

// ─── field extractors ────────────────────────────────────────────────────────

function extractTitle(content, fallback) {
  for (const line of content.split('\n')) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return fallback;
}

function extractStatus(content) {
  const m = content.match(/\*\*Status:\*\*\s*(\S+)/);
  return m ? m[1] : null;
}

// Anchored to line-start (^...$/m) so this matches only a genuine
// header-style **Rule:** FIELD, never a mid-line mention inside prose or a
// TITLE (D062: the non-anchored version matched inside a title's own text
// and returned corrupted output). Global so a file with multiple sub-lesson
// **Rule:** lines (each its own header-style line) yields ALL of them, not
// just the first — pre-fix, 25 of 31 genuine Rule declarations across 6
// lesson files were silently truncated to the first hit.
function extractRuleAll(content) {
  const matches = [...content.matchAll(/^\*\*Rule:\*\*\s*(.+)$/gm)];
  return matches.map(m => m[1].trim()).filter(Boolean);
}

// Scalar accessor — kept for backward compatibility with every existing
// consumer of the single `rule` field (manifest, keyword-map tokenizing,
// prism-lesson-match.mjs injection, prism-session-start.mjs digest). Returns
// the FIRST anchored **Rule:** line, matching prior behavior for the common
// single-rule case while no longer returning prose/title corruption.
function extractRule(content) {
  const all = extractRuleAll(content);
  return all.length ? all[0] : '';
}

function extractTriggers(content) {
  const m = content.match(/\*\*Triggers:\*\*\s*(.+)/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// ─── corpus scanners ─────────────────────────────────────────────────────────

function scanAdjudications(root) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseAdjFilename(name);
    if (!parsed) continue;
    const absPath = join(dir, name);
    const content = readFileSync(absPath, 'utf8');
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    results.push({
      absPath, relPath, name,
      dNum: parsed.dNum, ref: parsed.ref, slug: parsed.slug,
      type: 'adjudication',
      title: extractTitle(content, parsed.slug),
      status: extractStatus(content),
      rule: extractRule(content),
      rules: extractRuleAll(content),
      hash: sha1(content),
      content,
    });
  }
  results.sort((a, b) => a.dNum - b.dNum);
  return results;
}

function scanLessons(root) {
  const dir = join(root, 'docs', 'prism', 'lessons');
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseLessonFilename(name);
    const absPath = join(dir, name);
    const content = readFileSync(absPath, 'utf8');
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    const dateMatch = name.match(LESSON_DATE_RE);
    const sortDate = dateMatch
      ? dateMatch[1]
      : new Date(statSync(absPath).mtime).toISOString().slice(0, 10);
    results.push({
      absPath, relPath, name,
      ref: parsed.ref,
      type: 'lesson',
      title: extractTitle(content, name.replace(/\.md$/, '')),
      rule: extractRule(content),
      rules: extractRuleAll(content),
      sortDate,
      hash: sha1(content),
      content,
    });
  }
  results.sort((a, b) => (a.sortDate > b.sortDate ? -1 : a.sortDate < b.sortDate ? 1 : 0));
  return results;
}

// ─── output paths ─────────────────────────────────────────────────────────────

function getOutputPaths(root) {
  const refDir = join(root, '.claude', 'references');
  return {
    refDir,
    indexPath: join(refDir, 'knowledge-index.md'),
    manifestPath: join(refDir, '.knowledge-manifest.json'),
    keywordMapPath: join(refDir, '.knowledge-keyword-map.json'),
  };
}

// ─── manifest helpers ─────────────────────────────────────────────────────────

function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

function renderManifest(allEntries, now) {
  const files = {};
  for (const e of allEntries) {
    const entry = {hash: e.hash, type: e.type, ref: e.ref, title: e.title};
    if (e.type === 'adjudication' && e.status) entry.status = e.status;
    if (e.rule) entry.rule = e.rule;
    // Only emit `rules` when it adds information beyond the scalar `rule`
    // (i.e. a file has MORE than one header-style **Rule:** line) — keeps
    // the manifest diff minimal for the common single-rule case.
    if (e.rules && e.rules.length > 1) entry.rules = e.rules;
    files[e.relPath] = entry;
  }
  return {version: 1, generated_at: now || new Date().toISOString(), files};
}

// ─── index renderer ───────────────────────────────────────────────────────────

function renderIndex(adjudications, lessons, now) {
  const date = now ? now.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const lines = [
    '# PRISM knowledge index',
    '<!-- Generated by tools/prism-knowledge-index.mjs. Do not hand-edit. Rebuild: /prism-discover (knowledge); self-updates via /prism-clean append + session-start delta. -->',
    `_Last rebuilt: ${date} · ${adjudications.length} adjudications, ${lessons.length} lessons_`,
    '',
    '## Adjudications (locked design decisions)',
  ];
  if (adjudications.length === 0) {
    lines.push('_(none yet)_');
  } else {
    for (const a of adjudications) {
      const statusPart = a.status ? ` _(${a.status})_` : '';
      lines.push(`- [[${a.ref}]] ${a.slug} — ${a.title}${statusPart}`);
    }
  }
  lines.push('');
  lines.push('## Lessons');
  if (lessons.length === 0) {
    lines.push('_(none yet)_');
  } else {
    for (const l of lessons) {
      lines.push(`- [[lesson:${l.ref}]] ${l.title}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ─── keyword map builder ──────────────────────────────────────────────────────

async function buildKeywordMap(entries, keywordMapPath, now) {
  try {
    const tokenize = await getTokenize();
    const mapEntries = [];
    for (const e of entries) {
      // Tokenize ALL rule text (not just the first), so a prompt matching a
      // buried sub-lesson rule can still fire the search — same RULE_TOKEN_CAP
      // budget in buildEntryTokens still applies, so this cannot re-inflate
      // the D052/D053 keywordScore cap. Display (rule/rules below) is
      // unaffected — prism-lesson-match.mjs still shows the FIRST rule.
      const ruleText = (e.rules && e.rules.length) ? e.rules.join(' ') : (e.rule || '');
      const tokens = buildEntryTokens(tokenize, e.title, e.slug, e.ref, ruleText);
      const triggers = extractTriggers(e.content || '');
      mapEntries.push({
        ref: e.ref, type: e.type, title: e.title || '',
        relPath: e.relPath || '', rule: e.rule || '', status: e.status || '',
        ...(e.rules && e.rules.length > 1 ? {rules: e.rules} : {}),
        tokens, triggers,
      });
    }
    const map = {version: 1, generated_at: now || new Date().toISOString(), entries: mapEntries};
    atomicWrite(keywordMapPath, JSON.stringify(map, null, 2) + '\n');
  } catch {
    // Fail-open: keyword map is advisory
  }
}

// ─── diff computation (pure read) ─────────────────────────────────────────────

/**
 * computeDelta(root) — pure read, no writes.
 * Returns { added, changed, removed, entries } where entries is the full
 * current corpus array (useful if the caller wants to self-heal).
 */
export function computeDelta(root) {
  const absRoot = resolve(root);
  const {manifestPath} = getOutputPaths(absRoot);

  const adjudications = scanAdjudications(absRoot);
  const lessons = scanLessons(absRoot);
  const allCurrent = [...adjudications, ...lessons];

  const manifest = loadManifest(manifestPath);
  const noManifest = manifest === null;

  const added = [];
  const changed = [];
  const removed = [];

  if (noManifest) {
    for (const e of allCurrent) added.push(e.relPath);
  } else {
    const prevFiles = manifest.files || {};
    const currentPaths = new Set(allCurrent.map(e => e.relPath));
    const prevPaths = new Set(Object.keys(prevFiles));

    for (const e of allCurrent) {
      if (!prevPaths.has(e.relPath)) {
        added.push(e.relPath);
      } else if (prevFiles[e.relPath].hash !== e.hash) {
        changed.push(e.relPath);
      }
    }
    for (const p of prevPaths) {
      if (!currentPaths.has(p)) removed.push(p);
    }
  }

  return {added, changed, removed, entries: allCurrent};
}

// ─── apply delta (read + conditional write) ───────────────────────────────────

/**
 * applyDelta(root) — computes delta and, if the corpus changed (or manifest
 * is absent), writes index + manifest + keyword-map.  Returns the same
 * { added, changed, removed } summary as computeDelta.  Fully fail-open.
 */
export async function applyDelta(root) {
  try {
    const absRoot = resolve(root);
    const {refDir, indexPath, manifestPath, keywordMapPath} = getOutputPaths(absRoot);

    const {added, changed, removed, entries: allCurrent} = computeDelta(absRoot);
    const adjudications = allCurrent.filter(e => e.type === 'adjudication');
    const lessons = allCurrent.filter(e => e.type === 'lesson');

    const noManifest = !existsSync(manifestPath);
    const hasDelta = added.length > 0 || changed.length > 0 || removed.length > 0;

    if (hasDelta || noManifest) {
      ensureDir(refDir);
      const now = new Date().toISOString();
      const indexBody = renderIndex(adjudications, lessons, now);
      atomicWrite(indexPath, indexBody);
      const newManifest = renderManifest(allCurrent, now);
      atomicWrite(manifestPath, JSON.stringify(newManifest, null, 2) + '\n');
      await buildKeywordMap(allCurrent, keywordMapPath, now);
    }

    return {added, changed, removed};
  } catch {
    // Fail-open: never let this break a SessionStart
    return {added: [], changed: [], removed: []};
  }
}
