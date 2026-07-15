// tools/lib/memory-heal.mjs — deterministic MEMORY.md freshness (C2,
// recall-hardening spec — docs/prism/plans/2026-07-13-IMPL-SPEC-recall-hardening.md).
//
// Root cause being closed: MEMORY.md's "Recent decisions" / "Recent lessons"
// pointer windows and the "Standing rules" block are only ever updated by a
// manual LLM step (/prism-clean's append-decision / append-lesson calls, or
// a hand-authored Standing-rules edit). If that manual step is skipped —
// which is exactly what happened to D038 — recall silently falls behind the
// corpus with no self-heal. This module gives SessionStart (hooks/
// prism-session-start.mjs, C6 — NOT owned by this file) two deterministic,
// fail-open functions to call every session so MEMORY.md reconciles itself
// against docs/prism/adjudications/*.md before it gets injected.
//
// Exports:
//   healMemoryPointers(projectRoot, {delta}) -> {addedDecisions, addedLessons}
//     Given the {added, changed, removed} relPath arrays returned by
//     tools/lib/knowledge-delta.mjs's computeDelta/applyDelta, upserts a
//     "- [[D###]] <title>" pointer (via C1's upsertUnderAnchor) for every
//     added/changed adjudication file, and a "- [[lessons#<ref>]] <title>"
//     pointer for every added/changed docs/prism/lessons/*.md file. Titles
//     come from each file's `# <title>` H1. Idempotent (safe to call every
//     SessionStart) and fail-open (never throws — returns a no-op result on
//     any error, including a missing MEMORY.md/anchor, so a corrupted or
//     hand-edited router never breaks SessionStart).
//
//   regenerateStandingRules(projectRoot, {cap = 12}) -> {count, changed}
//     Scans docs/prism/adjudications/*.md for `**Status:** Locked` files,
//     extracts each `**Rule:** <text>` line (files with no Rule line are
//     skipped), orders newest-`**Date:**`-first (tiebreak: D-number desc),
//     caps at `cap`, and writes `- **<D###>:** <rule text>` lines between
//     the `<!-- prism:standing-rules:start -->` / `:end` anchors in
//     .claude/agents/MEMORY.md (C3). Idempotent: only rewrites the file if
//     the rendered block actually changed (content-hash compare against
//     what's currently between the anchors). Respects the MEMORY.md 25 KB
//     hard cap — if the full candidate list would push the file over 25 KB,
//     drops the lowest-priority (oldest-Date) rules one at a time until it
//     fits. Fail-open: never throws.
//
// Both honor PRISM_DISABLE_MEMORY_HEAL=1 in spirit — the caller (SessionStart,
// C6) is expected to check the env var BEFORE calling either function, so
// these are simple no-ops to skip. They do not read the env var themselves
// so they stay trivially unit-testable without env-var plumbing.

import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {upsertUnderAnchor} from './memory-anchors.mjs';

const MEMORY_MD_HARD_CAP_BYTES = 25 * 1024;

const DECISION_ANCHOR = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
const LESSON_ANCHOR = '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->';
const POINTER_KEEP = 10;

const STANDING_RULES_START = '<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->';
const STANDING_RULES_END = '<!-- prism:standing-rules:end -->';

const D_FILE_RE = /^D(\d{3,})-(.+)\.md$/;

function memoryMdPath(projectRoot) {
  return join(projectRoot, '.claude', 'agents', 'MEMORY.md');
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function extractH1(content, fallback) {
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

function extractDate(content) {
  const m = content.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function extractRule(content) {
  const m = content.match(/\*\*Rule:\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
}

// Atomic write with the same 25 KB hard-cap guard prism-clean.mjs enforces,
// but fail-open (return false) instead of die()/exit — this runs inside a
// SessionStart hook, which must never break the session.
function writeMemoryMdAtomicSafe(path, body) {
  try {
    if (Buffer.byteLength(body, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) return false;
    const tmp = path + '.tmp';
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// ─── C2a: healMemoryPointers ──────────────────────────────────────────────

function relPathType(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const adjM = norm.match(/^docs\/prism\/adjudications\/([^/]+\.md)$/);
  if (adjM) {
    const fm = adjM[1].match(D_FILE_RE);
    if (fm) return {kind: 'adjudication', dNum: fm[1].padStart(3, '0'), fileName: adjM[1]};
    return null;
  }
  const lesM = norm.match(/^docs\/prism\/lessons\/([^/]+)\.md$/);
  if (lesM) return {kind: 'lesson', ref: lesM[1]};
  return null;
}

export function healMemoryPointers(projectRoot, {delta} = {}) {
  const result = {addedDecisions: [], addedLessons: []};
  try {
    if (!delta) return result;
    const path = memoryMdPath(projectRoot);
    let body = safeRead(path);
    if (body === null) return result; // no MEMORY.md yet — nothing to heal

    const touched = [...(delta.added || []), ...(delta.changed || [])];
    if (!touched.length) return result;

    let changedAny = false;
    for (const relPath of touched) {
      const info = relPathType(relPath);
      if (!info) continue;

      if (info.kind === 'adjudication') {
        const absPath = join(projectRoot, 'docs', 'prism', 'adjudications', info.fileName);
        const content = safeRead(absPath);
        if (content === null) continue;
        const title = extractH1(content, info.fileName.replace(/\.md$/, ''));
        const line = `- [[D${info.dNum}]] ${title}`;
        try {
          body = upsertUnderAnchor(body, DECISION_ANCHOR, line, {keep: POINTER_KEEP});
          changedAny = true;
          result.addedDecisions.push(`D${info.dNum}`);
        } catch {
          // ANCHOR_NOT_FOUND or any other issue — skip this pointer, keep going.
        }
      } else if (info.kind === 'lesson') {
        const absPath = join(projectRoot, 'docs', 'prism', 'lessons', `${info.ref}.md`);
        const content = safeRead(absPath);
        if (content === null) continue;
        const title = extractH1(content, info.ref);
        const line = `- [[lessons#${info.ref}]] ${title}`;
        try {
          body = upsertUnderAnchor(body, LESSON_ANCHOR, line, {keep: POINTER_KEEP});
          changedAny = true;
          result.addedLessons.push(info.ref);
        } catch {
          // ANCHOR_NOT_FOUND or any other issue — skip this pointer, keep going.
        }
      }
    }

    if (changedAny) {
      writeMemoryMdAtomicSafe(path, body);
    }
    return result;
  } catch {
    return {addedDecisions: [], addedLessons: []};
  }
}

// ─── C2b: regenerateStandingRules ─────────────────────────────────────────

function scanLockedRules(projectRoot) {
  const dir = join(projectRoot, 'docs', 'prism', 'adjudications');
  if (!existsSync(dir)) return [];
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(D_FILE_RE);
    if (!m) continue;
    const content = safeRead(join(dir, name));
    if (content === null) continue;
    if (extractStatus(content) !== 'Locked') continue;
    const rule = extractRule(content);
    if (!rule) continue; // no Rule line — nothing to surface
    out.push({
      dNum: parseInt(m[1], 10),
      dRef: 'D' + m[1].padStart(3, '0'),
      date: extractDate(content) || '',
      rule,
    });
  }
  return out;
}

function orderNewestFirst(rules) {
  return [...rules].sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1; // newest Date first
    return b.dNum - a.dNum; // tiebreak: higher D-number first
  });
}

function renderStandingRulesLines(rules) {
  return rules.map((r) => `- **${r.dRef}:** ${r.rule}`);
}

function hashOf(s) {
  return createHash('sha1').update(s).digest('hex');
}

// Replace the content strictly between the standing-rules start/end anchors
// (inclusive of the anchor lines themselves, which are preserved verbatim).
// Returns null if either anchor is missing (caller fails open).
function spliceStandingRules(body, lines) {
  const src = body.replace(/\r\n/g, '\n').split('\n');
  const startIdx = src.findIndex((l) => l.trim() === STANDING_RULES_START.trim());
  if (startIdx < 0) return null;
  const endIdx = src.findIndex((l, i) => i > startIdx && l.trim() === STANDING_RULES_END.trim());
  if (endIdx < 0) return null;
  const rebuilt = [
    ...src.slice(0, startIdx + 1),
    ...lines,
    ...src.slice(endIdx),
  ];
  return rebuilt.join('\n');
}

function currentStandingRulesBlock(body) {
  const src = body.replace(/\r\n/g, '\n').split('\n');
  const startIdx = src.findIndex((l) => l.trim() === STANDING_RULES_START.trim());
  if (startIdx < 0) return null;
  const endIdx = src.findIndex((l, i) => i > startIdx && l.trim() === STANDING_RULES_END.trim());
  if (endIdx < 0) return null;
  return src.slice(startIdx + 1, endIdx).join('\n');
}

export function regenerateStandingRules(projectRoot, {cap = 12} = {}) {
  try {
    const path = memoryMdPath(projectRoot);
    const body = safeRead(path);
    if (body === null) return {count: 0, changed: false};

    const existingBlock = currentStandingRulesBlock(body);
    if (existingBlock === null) return {count: 0, changed: false}; // anchors missing — fail open

    const all = orderNewestFirst(scanLockedRules(projectRoot));
    let candidates = all.slice(0, cap);

    // Fit under the 25 KB hard cap: drop lowest-priority (tail = oldest)
    // candidates one at a time until the full MEMORY.md body fits.
    let lines = renderStandingRulesLines(candidates);
    let newBody = spliceStandingRules(body, lines);
    while (candidates.length > 0 && Buffer.byteLength(newBody, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) {
      candidates = candidates.slice(0, -1);
      lines = renderStandingRulesLines(candidates);
      newBody = spliceStandingRules(body, lines);
    }

    const renderedBlock = lines.join('\n');
    if (hashOf(renderedBlock) === hashOf(existingBlock)) {
      return {count: candidates.length, changed: false};
    }

    const ok = writeMemoryMdAtomicSafe(path, newBody);
    return {count: candidates.length, changed: ok};
  } catch {
    return {count: 0, changed: false};
  }
}

export const STANDING_RULES_ANCHORS = {start: STANDING_RULES_START, end: STANDING_RULES_END};
