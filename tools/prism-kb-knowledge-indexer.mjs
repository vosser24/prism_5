#!/usr/bin/env node
// PRISM KB Knowledge Indexer — cross-project knowledge index (v5.0 F4 Phase B)
//
// Purpose: build the cross-project knowledge index at
//   ~/.claude/.prism-kb/knowledge-index.json  (schema version:1, kind "prism-kb-knowledge").
// It walks a project's SHARED corpus (per the project's .prism-kb-share.json opt-in marker)
// plus the always-on home-global verdict logs, stores DESCRIPTORS ONLY (bounded description
// + BM25 term-frequency postings — NEVER verbatim body prose), tags every entry with
// provenance, and merges this project's entries into the global index (replacing any prior
// entries for the same project_id), refreshing the always-on verdict entries each build.
//
// Dep-free: Node core only + three local imports (prism-kb-indexer, prism-kb-domains,
//           lib/prism-bm25). No external packages, no network, no API key.
// SYNCHRONOUS: no async/await anywhere — deterministic, fast, drain-at-Stop friendly.
//
// Design reference: docs/prism/plans/2026-05-29-F4-design.md
//   §3 (corpus + per-entry schema + index schema + provenance)
//   §4 (privacy: default-deny per-corpus-type opt-in, verdict exemption, secret pre-scan,
//        descriptor-not-body storage)
//   §6 (storage: ~/.claude/.prism-kb/, JSON, atomic write-then-rename, Windows/SMB safe)

import {
  readFileSync, writeFileSync, readdirSync, statSync, existsSync,
  mkdirSync, renameSync, realpathSync, unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { hostname } from 'os';

// Reused primitives (DO NOT duplicate):
//  - parseYamlFrontMatter(text) -> {raw, fields} and extractKeywords(text, topN) -> string[]
//    from tools/prism-kb-indexer.mjs (signatures fit exactly — frontmatter map + keyword bag).
//  - classifyEntry(entry) -> {domain, confidence, reason}
//    from tools/prism-kb-domains.mjs (consumes {name, description, keywords_top10, type}).
//  - tokenize(text) + termFrequencies(tokens) from tools/lib/prism-bm25.mjs for postings/df.
import { parseYamlFrontMatter, extractKeywords } from './prism-kb-indexer.mjs';
import { classifyEntry } from './prism-kb-domains.mjs';
import { tokenize, termFrequencies } from './lib/prism-bm25.mjs';

// ── exported constants ──────────────────────────────────────────────────────

export const KNOWLEDGE_INDEX_REL = '.prism-kb/knowledge-index.json'; // relative to home

export const SHAREABLE_TYPES = ['adjudication', 'lesson', 'plan', 'panel-rationale'];

// Description hard cap (§3) and posting vocab cap (§8 bounded-vocab guard).
const DESCRIPTION_MAX = 300;
const POSTINGS_CAP = 200;
const KEYWORDS_TOP = 10;
const REDACTION_PLACEHOLDER = '(redacted — possible secret)';

// Secret pre-scan patterns (§4.5 / invariant 2). Fail-closed: any match ⇒ redact.
const SECRET_PATTERNS = [
  /sk-[a-z0-9-]{8,}/i,
  /gho_[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(api[_-]?key|secret|password|token)\s*[=:]\s*\S{6,}/i,
];

// ── projectIdFor ──────────────────────────────────────────────────────────────
// Stable short hash of the realpath of the project root (12 hex chars).
export function projectIdFor(projectRoot) {
  let real = projectRoot;
  try { real = realpathSync(projectRoot); } catch { /* root may not exist; hash the literal */ }
  return createHash('sha1').update(real).digest('hex').slice(0, 12);
}

function machineId() {
  return createHash('sha1').update(String(hostname())).digest('hex').slice(0, 12);
}

// ── readShareMarker ────────────────────────────────────────────────────────────
// Reads <projectRoot>/.prism-kb-share.json. Returns {version, shared_types, shared_at}
// or null if absent / unreadable / invalid (default-deny — invariant 3).
export function readShareMarker(projectRoot) {
  const p = join(projectRoot, '.prism-kb-share.json');
  if (!existsSync(p)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.shared_types)) return null;
  return {
    version: parsed.version,
    shared_types: parsed.shared_types,
    shared_at: parsed.shared_at,
  };
}

// ── writeShareMarker ────────────────────────────────────────────────────────────
// Writes <projectRoot>/.prism-kb-share.json opting this project into cross-project
// sharing for the given corpus types (F4 §4.1 per-corpus-type opt-in).
//   types: array; empty/undefined ⇒ default to all SHAREABLE_TYPES.
//          each entry validated against SHAREABLE_TYPES (unknowns silently dropped).
// Atomic write (tmp + renameSync; Windows/SMB safe). Returns the written object.
export function writeShareMarker(projectRoot, types) {
  let list = Array.isArray(types) ? types.filter(t => SHAREABLE_TYPES.includes(t)) : [];
  if (list.length === 0) list = SHAREABLE_TYPES.slice();
  const obj = {
    version: 1,
    shared_types: list,
    shared_at: new Date().toISOString(),
  };
  const p = join(projectRoot, '.prism-kb-share.json');
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, p);
  return obj;
}

// ── removeShareMarker ───────────────────────────────────────────────────────────
// Unlinks <projectRoot>/.prism-kb-share.json. Returns true if removed, false if
// absent. Never throws.
export function removeShareMarker(projectRoot) {
  const p = join(projectRoot, '.prism-kb-share.json');
  if (!existsSync(p)) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

// ── scanSecrets ────────────────────────────────────────────────────────────────
// Returns {redacted:boolean}. true if text matches ANY secret pattern (fail-closed).
export function scanSecrets(text) {
  if (!text) return { redacted: false };
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { redacted: true };
  }
  return { redacted: false };
}

// ── internal helpers ────────────────────────────────────────────────────────

function safeStatMtimeSec(path) {
  try { return Math.floor(statSync(path).mtimeMs / 1000); } catch { return 0; }
}

function readText(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => join(dir, d.name));
}

// Recursively collect tasks/workspace/**/panel.json (best-effort; skip if dir absent).
function listPanelJson(workspaceDir, maxDepth = 6) {
  const out = [];
  if (!existsSync(workspaceDir)) return out;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile() && ent.name === 'panel.json') out.push(p);
    }
  };
  walk(workspaceDir, 0);
  return out;
}

function sanitizeSlug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function boundDescription(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
}

function firstHeading(body) {
  const m = body.match(/^\s*#+\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function firstNonHeadingLine(body) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (/^---\s*$/.test(line)) continue;
    return line;
  }
  return '';
}

// Strip the YAML front-matter block from a markdown body for title/desc/posting extraction.
function stripFrontMatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function boundedPostings(bodyText) {
  const tf = termFrequencies(tokenize(bodyText));
  const keys = Object.keys(tf);
  if (keys.length <= POSTINGS_CAP) return tf;
  // Keep top-N terms by tf to cap index size (§8 bounded-vocab guard).
  const top = keys.sort((a, b) => tf[b] - tf[a]).slice(0, POSTINGS_CAP);
  const out = Object.create(null);
  for (const k of top) out[k] = tf[k];
  return out;
}

// Build one descriptor entry from a markdown source file.
function buildMarkdownEntry({ filePath, type, projectId, projectLabel, indexedAt }) {
  const fullText = readText(filePath);
  const { fields } = parseYamlFrontMatter(fullText);
  const body = stripFrontMatter(fullText);

  const stem = basename(filePath).replace(/\.md$/i, '');
  const title = fields.name || firstHeading(body) || stem;

  const { redacted } = scanSecrets(fullText);

  let description;
  let postings;
  let keywords_top;
  if (redacted) {
    description = REDACTION_PLACEHOLDER;
    postings = {};
    keywords_top = [];
  } else {
    description = boundDescription(fields.description || firstNonHeadingLine(body));
    postings = boundedPostings(body);
    keywords_top = extractKeywords(`${title} ${body}`, KEYWORDS_TOP);
  }

  const entry = {
    id: `${projectId}:${type}:${sanitizeSlug(stem)}`,
    type,
    project_id: projectId,
    project_label: projectLabel,
    source_path: filePath,
    title,
    description,
    domain: '',
    domain_confidence: 0,
    keywords_top,
    postings,
    body_bytes: Buffer.byteLength(body, 'utf-8'),
    source_mtime_sec: safeStatMtimeSec(filePath),
    indexed_at: indexedAt,
    redacted,
  };
  const c = classifyEntry({ name: title, description: redacted ? '' : description, keywords_top10: keywords_top, type });
  entry.domain = c.domain;
  entry.domain_confidence = c.confidence;
  return entry;
}

// Build one descriptor entry from a panel.json source file.
function buildPanelEntry({ filePath, projectId, projectLabel, indexedAt }) {
  const fullText = readText(filePath);
  let parsed = null;
  try { parsed = JSON.parse(fullText); } catch { /* best-effort */ }

  const stem = basename(join(filePath, '..')) || 'panel';
  const title = (parsed && (parsed.title || parsed.topic || parsed.name)) || `panel:${stem}`;
  const rawDesc = parsed && (parsed.summary || parsed.rationale || parsed.verdict) || '';
  const { redacted } = scanSecrets(fullText);

  let description;
  let postings;
  let keywords_top;
  if (redacted) {
    description = REDACTION_PLACEHOLDER;
    postings = {};
    keywords_top = [];
  } else {
    description = boundDescription(typeof rawDesc === 'string' ? rawDesc : JSON.stringify(rawDesc));
    postings = boundedPostings(fullText);
    keywords_top = extractKeywords(`${title} ${description}`, KEYWORDS_TOP);
  }

  const entry = {
    id: `${projectId}:panel-rationale:${sanitizeSlug(stem)}`,
    type: 'panel-rationale',
    project_id: projectId,
    project_label: projectLabel,
    source_path: filePath,
    title: String(title),
    description,
    domain: '',
    domain_confidence: 0,
    keywords_top,
    postings,
    body_bytes: Buffer.byteLength(fullText, 'utf-8'),
    source_mtime_sec: safeStatMtimeSec(filePath),
    indexed_at: indexedAt,
    redacted,
  };
  const c = classifyEntry({ name: entry.title, description: redacted ? '' : description, keywords_top10: keywords_top, type: 'panel-rationale' });
  entry.domain = c.domain;
  entry.domain_confidence = c.confidence;
  return entry;
}

// Collect this project's shareable entries gated by the share marker (default-deny).
function collectProjectEntries({ projectRoot, projectId, projectLabel, indexedAt }) {
  const marker = readShareMarker(projectRoot);
  if (!marker) return []; // default-deny — no marker ⇒ index nothing for this project.
  const shared = new Set(marker.shared_types.filter(t => SHAREABLE_TYPES.includes(t)));
  const out = [];

  if (shared.has('adjudication')) {
    for (const f of listMarkdown(join(projectRoot, 'docs', 'prism', 'adjudications'))) {
      out.push(buildMarkdownEntry({ filePath: f, type: 'adjudication', projectId, projectLabel, indexedAt }));
    }
  }
  if (shared.has('lesson')) {
    for (const f of listMarkdown(join(projectRoot, 'docs', 'prism', 'lessons'))) {
      out.push(buildMarkdownEntry({ filePath: f, type: 'lesson', projectId, projectLabel, indexedAt }));
    }
  }
  if (shared.has('plan')) {
    for (const f of listMarkdown(join(projectRoot, 'docs', 'prism', 'plans'))) {
      out.push(buildMarkdownEntry({ filePath: f, type: 'plan', projectId, projectLabel, indexedAt }));
    }
  }
  if (shared.has('panel-rationale')) {
    for (const f of listPanelJson(join(projectRoot, 'tasks', 'workspace'))) {
      out.push(buildPanelEntry({ filePath: f, projectId, projectLabel, indexedAt }));
    }
  }
  return out;
}

// Collect home-global verdict entries (always-on, exempt from any share marker).
function collectVerdictEntries({ home, indexedAt }) {
  const out = [];
  // (a) the canonical jsonl — one JSON verdict per line.
  const jsonlPath = join(home, '.prism-phase-1-5-verdicts.jsonl');
  if (existsSync(jsonlPath)) {
    const mtime = safeStatMtimeSec(jsonlPath);
    const lines = readText(jsonlPath).split(/\r?\n/).filter(l => l.trim());
    lines.forEach((line, i) => {
      out.push(buildVerdictEntry({ rawText: line, sourcePath: jsonlPath, slug: `1-5-${i}`, mtime, indexedAt }));
    });
  }
  // (b) per-SHA verdict files: .prism-phase-*-verdicts-*.json
  let homeEntries = [];
  try { homeEntries = readdirSync(home, { withFileTypes: true }); } catch { homeEntries = []; }
  for (const ent of homeEntries) {
    if (!ent.isFile()) continue;
    if (!/^\.prism-phase-.*-verdicts-.*\.json$/.test(ent.name)) continue;
    const p = join(home, ent.name);
    const mtime = safeStatMtimeSec(p);
    const slug = ent.name.replace(/^\.prism-phase-/, '').replace(/\.json$/, '');
    out.push(buildVerdictEntry({ rawText: readText(p), sourcePath: p, slug, mtime, indexedAt }));
  }
  return out;
}

function buildVerdictEntry({ rawText, sourcePath, slug, mtime, indexedAt }) {
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch { /* keep raw */ }
  const title = (parsed && (parsed.verdict || parsed.kind)) ? `verdict:${parsed.verdict || parsed.kind}` : `verdict:${slug}`;
  const rawDesc = parsed && (parsed.note || parsed.reason || parsed.summary) || '';
  const { redacted } = scanSecrets(rawText);

  let description;
  let postings;
  let keywords_top;
  if (redacted) {
    description = REDACTION_PLACEHOLDER;
    postings = {};
    keywords_top = [];
  } else {
    description = boundDescription(typeof rawDesc === 'string' ? rawDesc : JSON.stringify(rawDesc));
    postings = boundedPostings(rawText);
    keywords_top = extractKeywords(`${title} ${description}`, KEYWORDS_TOP);
  }

  const entry = {
    id: `GLOBAL:verdict:${sanitizeSlug(slug)}`,
    type: 'verdict',
    project_id: 'GLOBAL',
    project_label: '(home-global)',
    source_path: sourcePath,
    title,
    description,
    domain: '',
    domain_confidence: 0,
    keywords_top,
    postings,
    body_bytes: Buffer.byteLength(rawText, 'utf-8'),
    source_mtime_sec: mtime,
    indexed_at: indexedAt,
    redacted,
  };
  const c = classifyEntry({ name: title, description: redacted ? '' : description, keywords_top10: keywords_top, type: 'verdict' });
  entry.domain = c.domain;
  entry.domain_confidence = c.confidence;
  return entry;
}

function readExistingIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (parsed && parsed.kind === 'prism-kb-knowledge' && Array.isArray(parsed.entries)) return parsed;
  } catch { /* corrupt ⇒ rebuild from scratch */ }
  return null;
}

// Recompute df (document-frequency per term across ALL entries' postings).
function computeDf(entries) {
  const df = Object.create(null);
  for (const e of entries) {
    for (const term of Object.keys(e.postings || {})) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  return df;
}

// ── buildKnowledgeIndex ──────────────────────────────────────────────────────
// SYNCHRONOUS. Merges this project's shared entries into the global index (replacing
// any prior entries for this project_id), always refreshes home-global verdict entries,
// recomputes df/doc_count/source_mtime_max over ALL entries, writes atomically, returns
// the index object.
export function buildKnowledgeIndex({ home, projectRoot, now } = {}) {
  const indexedAt = now || new Date().toISOString();
  const indexPath = join(home, KNOWLEDGE_INDEX_REL);
  const indexDir = join(home, '.prism-kb');
  mkdirSync(indexDir, { recursive: true });

  const projectId = projectIdFor(projectRoot);
  const projectLabel = basename(projectRoot);
  const marker = readShareMarker(projectRoot);

  const existing = readExistingIndex(indexPath);

  // Start from prior entries, dropping (a) this project's prior entries (replace, not append)
  // and (b) ALL prior verdict entries (always refreshed below).
  let entries = [];
  let projects = {};
  if (existing) {
    entries = existing.entries.filter(e => e.project_id !== projectId && e.type !== 'verdict');
    projects = { ...(existing.projects || {}) };
    delete projects[projectId];
  }

  // This project's shared corpus (default-deny if no marker).
  const projectEntries = collectProjectEntries({ projectRoot, projectId, projectLabel, indexedAt });
  entries.push(...projectEntries);

  // Record project provenance in the projects map only when it actually shares something.
  if (marker) {
    projects[projectId] = {
      label: projectLabel,
      root: projectRoot,
      shared_types: marker.shared_types,
      shared_at: marker.shared_at,
      entry_count: projectEntries.length,
    };
  }

  // Always-on home-global verdicts (refreshed every build).
  const verdictEntries = collectVerdictEntries({ home, indexedAt });
  entries.push(...verdictEntries);

  // Recompute corpus-level stats over ALL entries.
  const df = computeDf(entries);
  const sourceMtimeMax = entries.reduce((m, e) => Math.max(m, e.source_mtime_sec || 0), 0);

  const index = {
    version: 1,
    kind: 'prism-kb-knowledge',
    built_at: indexedAt,
    machine_id: machineId(),
    source_mtime_max: sourceMtimeMax,
    projects,
    df,
    doc_count: entries.length,
    entries,
  };

  // Atomic write: tmp + renameSync (Windows/SMB safe; no PowerShell redirection).
  const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, indexPath);

  return index;
}

// ── CLI entry (optional convenience; mirrors prism-kb-indexer.mjs pattern) ────
// Guard on the exact basename so importing the same-suffixed test file does NOT trigger it.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-kb-knowledge-indexer.mjs';
if (invokedDirectly) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const projectRoot = process.cwd();
  const idx = buildKnowledgeIndex({ home, projectRoot });
  console.log(`PRISM knowledge index built: ${idx.doc_count} entries (${Object.keys(idx.projects).length} project(s)).`);
  console.log(`Written: ${join(home, KNOWLEDGE_INDEX_REL)}`);
}
