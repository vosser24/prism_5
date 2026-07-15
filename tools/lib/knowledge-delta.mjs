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
  renameSync(tmp, path);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

// ─── filename parsers ────────────────────────────────────────────────────────

const ADJ_FILE_RE = /^D(\d{3,})-(.+)\.md$/;
function parseAdjFilename(name) {
  const m = name.match(ADJ_FILE_RE);
  if (!m) return null;
  return {dNum: parseInt(m[1], 10), slug: m[2], ref: 'D' + m[1]};
}

const LESSON_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
function parseLessonFilename(name) {
  const stem = name.replace(/\.md$/, '');
  const m = stem.match(LESSON_DATE_RE);
  return {ref: m ? m[1] : stem};
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

function extractRule(content) {
  const m = content.match(/\*\*Rule:\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
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
      const seedText = (e.title || '') + ' ' + (e.slug || '') + ' ' + (e.ref || '');
      const tokens = [...new Set(tokenize(seedText))];
      const triggers = extractTriggers(e.content || '');
      mapEntries.push({
        ref: e.ref, type: e.type, title: e.title || '',
        relPath: e.relPath || '', rule: e.rule || '', status: e.status || '',
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
