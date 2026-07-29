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
//   healMemoryPointers(projectRoot, {delta}) -> {addedDecisions, addedLessons, written}
//     Given the {added, changed, removed} relPath arrays returned by
//     tools/lib/knowledge-delta.mjs's computeDelta/applyDelta, upserts a
//     "- [[D###]] <title> _(<Status>)_" pointer (via C1's upsertUnderAnchor,
//     status suffix format matching tools/prism-knowledge-index.mjs's
//     renderIndex()) for every added/changed adjudication file, and a
//     "- [[lessons#<ref>]] <title>" pointer for every added/changed
//     docs/prism/lessons/*.md file. Titles come from each file's `# <title>`
//     H1. Idempotent (safe to call every
//     SessionStart) and fail-open (never throws — returns a no-op result on
//     any error, including a missing MEMORY.md/anchor, so a corrupted or
//     hand-edited router never breaks SessionStart).
//     `written` is tri-state and follows the F45 fix / the D086 proposal
//     ([[D086]], Status: Proposed, not ratified): `true` = the atomic
//     write landed, `false` = pointers were assembled but the write FAILED
//     (25 KB cap overflow or an fs error) so nothing reached disk, `null` =
//     no write was attempted because there was nothing to add. Before this,
//     the boolean from writeMemoryMdAtomicSafe() was discarded and a caller
//     reading addedDecisions/addedLessons could not tell a landed write from
//     a dropped one. A `memory_heal` telemetry record is emitted on the
//     failure path (see logMemoryHeal) because the production caller,
//     hooks/prism-session-start.mjs:552, discards the return value entirely —
//     the log, not the return, is what makes the failure observable there.
//
//   regenerateStandingRules(projectRoot, {cap = 35})
//       -> {count, changed, poolSize, retiredSkipped, evictedByCap,
//           evictedByBytes, tiered, written}
//     Scans docs/prism/adjudications/*.md for `**Status:** Locked` files,
//     extracts each `**Rule:** <text>` line (files with no Rule line are
//     skipped), splits the pool by `**Tier:** core` ([[D097]], see below),
//     orders the NON-core remainder newest-`**Date:**`-first (tiebreak:
//     D-number desc, unchanged), caps the non-core competition at `cap` minus
//     however many core rules exist, and writes `- **<D###>:** <rule text>`
//     lines (core rules first, then the surviving non-core ones) between
//     the `<!-- prism:standing-rules:start -->` / `:end` anchors in
//     .claude/agents/MEMORY.md (C3). Idempotent: only rewrites the file if
//     the rendered block actually changed (content-hash compare against
//     what's currently between the anchors). Respects the MEMORY.md 25 KB
//     hard cap — if the full candidate list would push the file over 25 KB,
//     drops the lowest-priority (oldest-Date) rules one at a time until it
//     fits. Fail-open: never throws.
//     F44/[[D046]] instrumentation: eviction is REPORTED, not silent. The
//     two causes are kept structurally separate because they demand
//     different responses — `evictedByCap` (the pool exceeded `cap`, a
//     policy choice, fixable by raising the cap) vs `evictedByBytes` (the
//     rendered file would exceed MEMORY_MD_HARD_CAP_BYTES, a genuine
//     capacity wall that raising the cap CANNOT fix). Both are arrays of
//     D-refs, oldest-first within each cause; `poolSize` is the ELIGIBLE
//     (non-retired) Locked-with-Rule population before any cut.
//     [[D093]] (Locked 2026-07-28) adds a THIRD, structurally separate cause:
//     `retiredSkipped` — files carrying a `**Retired:** <date> — <reason>`
//     header line. These never enter the pool, so they neither occupy a slot
//     nor evict anything, and their remedy differs from the other two (none —
//     retirement is an intentional owner act, not capacity pressure). They
//     stay fully scanned by tools/prism-knowledge-index.mjs and
//     keyword-injectable via hooks/prism-lesson-match.mjs: retirement means
//     "not always-on", NEVER "deleted" or "unreachable". The same facts are
//     emitted as a `memory_heal` telemetry record — required because the
//     production caller (hooks/prism-session-start.mjs:555) discards the
//     return value, so a return-only signal would still be unobservable.
//     [[D097]] (Locked 2026-07-28) adds the `Tier: core` mechanism: an
//     owner-designated core set of standing rules (membership decided
//     separately, outside this file — see the five adjudications this task
//     tagged) is ALWAYS injected and EXEMPT from the date-ordered sort that
//     evicts everyone else. `evictedByCap` can now ONLY ever name non-core
//     D-refs — core rules never compete for `cap` at all. `tiered` (array of
//     D-refs) reports which core rules actually rendered, computed AFTER the
//     byte-fit loop so it stays honest even in the (currently unmeasured)
//     case where a genuine capacity wall cuts into the core set itself.
//     Extraction is scoped to headerBlock(), same as Status/Date/Rule/
//     Retired, so a worked `**Tier:** core` example inside a body/fence
//     (e.g. this file's own docs, or a future adjudication documenting the
//     mechanism) can never tier the file that merely quotes it — this is the
//     exact D093 self-retirement shape, guarded up front for Tier instead of
//     being found the hard way a second time. Fail-open: an absent or
//     unrecognized Tier value competes normally (never an error, never an
//     exclusion).
//
// Both honor PRISM_DISABLE_MEMORY_HEAL=1 in spirit — the caller (SessionStart,
// C6) is expected to check the env var BEFORE calling either function, so
// these are simple no-ops to skip. They do not read the env var themselves
// so they stay trivially unit-testable without env-var plumbing.

import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {upsertUnderAnchor} from './memory-anchors.mjs';
import {renameWithRetry} from './atomic-fs.mjs';
import {logAdvisory} from '../../hooks/lib/prism-advisory-log.mjs';

const MEMORY_MD_HARD_CAP_BYTES = 25 * 1024;

const DECISION_ANCHOR = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
// NOTE ON THE ANCHOR TEXT vs WHAT IS ACTUALLY WRITTEN UNDER IT (F45 item 3):
// the anchor string still says `[[lessons-tactical#date]]`, but since [[D085]]
// decision 1a the manual /prism-clean path writes the lesson TEXT INLINE
// (`- [<date>] <text>`) — there is no `[[lessons-tactical#...]]` pointer any
// more, because that target never existed and is gitignored per [[D066]].
// The anchor STRING is deliberately frozen and must NOT be "corrected": D085
// 1a — "`LESSON_ANCHOR` was deliberately NOT changed — anchor matching is
// exact-text equality across three files (`prism-clean.mjs`,
// `memory-heal.mjs`, `prism-deep-dive.mjs`) plus the comment already sitting
// in MEMORY.md." Editing it would orphan every already-seeded MEMORY.md.
// The heal path below still writes a `[[lessons#<ref>]]` pointer for
// docs/prism/lessons/*.md files, which DO exist and are tracked — that is a
// different target from the dangling tasks/lessons-tactical.md one D085 removed.
const LESSON_ANCHOR = '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->';
// 20, raised from 10 by [[D085]] decision 1b. NOTE: tools/prism-clean.mjs has
// its OWN `POINTER_KEEP = 10` for the SAME anchors, so the effective window
// depends on which path wrote last (F45 item 1). D085 1b scopes its raise
// explicitly and only to this file — "**Chosen.** In
// `tools/lib/memory-heal.mjs`: `STANDING_RULES_CAP` 12 -> 30, `POINTER_KEEP`
// 10 -> 20." — and says nothing about prism-clean.mjs's constant either way,
// so the divergence was UNDOCUMENTED, not demonstrably deliberate.
//
// OWNER DECISION 2026-07-28 — REVIEWED AND DELIBERATELY LEFT DIVERGENT.
// This 10-vs-20 split is NOT an oversight to be tidied later; do not
// "reconcile" it. Reconciling upward has a measured byte-cap risk (MEMORY.md
// was 24,101/25,600 bytes on 2026-07-28, and prism-clean's
// writeMemoryMdAtomic die()s with exit 8 on overflow); reconciling downward
// would discard pointers this path is budgeted to keep. KNOWN CONSEQUENCE,
// accepted with eyes open: the decision anchor currently holds 17 bullets, so
// the next `/prism-clean append-decision` will trim it to 10. That loss is
// accepted BECAUSE it is no longer silent — upsertUnderAnchor logs every
// trimmed entry by name via `memory_anchor_trim`. See the mirrored note at
// tools/prism-clean.mjs's own POINTER_KEEP.
const POINTER_KEEP = 20;

// F44/F45 telemetry. Matches the project's existing advisory-log shape
// (hooks/lib/prism-advisory-log.mjs -> one JSONL line per record appended to
// ~/.claude/.prism-routing.jsonl) rather than inventing a second sink.
// Fail-open by construction — logAdvisory swallows its own errors.
function logMemoryHeal(event) {
  logAdvisory({event: 'memory_heal', ...event});
}

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

// F48 second-consumer audit (2026-07-28): unlike extractRule (line-anchored
// per D062) this had NO anchor at all, so it matched ANY "**Status:**"
// substring anywhere in the document, not just line-start. A corpus audit
// (87 files, JS regex with matchAll) found 3 files with a SECOND match in
// the body — D047, D086, D093 — all three inside worked examples/quoted
// text. None is currently exploitable: `.match()` (no `g` flag) returns only
// the FIRST occurrence, and capture-conventions.md's "Required headers"
// rule guarantees the genuine header is always first in document order —
// but that safety was a convention-order accident, not a structural
// guarantee in the code itself. Scoped to headerBlock() (see extractRetired
// below) for the same reason: fix the class, not just today's instance.
function extractStatus(content) {
  const m = headerBlock(content).match(/\*\*Status:\*\*\s*(\S+)/);
  return m ? m[1] : null;
}

// Same audit, same fix. 0 of 87 files had a second `**Date:**` match, so
// this was not even latently exploitable — scoped anyway for consistency
// with its header-block siblings above/below, since a future adjudication
// quoting a worked date example would otherwise reintroduce the same class.
function extractDate(content) {
  const m = headerBlock(content).match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Anchored to line-start (^...$/m) so this matches only a genuine
// header-style **Rule:** FIELD, never a mid-line mention inside prose or a
// TITLE (D062: the non-anchored version matched inside a title's own text
// and returned corrupted output — the same defect this fixes here).
// Scalar-only by design: unlike lesson files, every existing Locked
// adjudication carries at most ONE **Rule:** line (verified across all 38
// adjudications with a Rule line — none has a second), and this function
// feeds one Standing-rules line per D-file, so there is no truncation
// defect to fix here — only the corruption one.
// F48 second-consumer audit (2026-07-28): line-anchoring alone stops a
// MID-LINE mention (D062) but not a worked example that starts its own line
// inside a body code fence, the exact D093 self-retirement shape. Corpus
// audit found 0 of 87 files currently exploit this for Rule (no file's ONLY
// line-start Rule match sits in the body with no real header Rule line) —
// but scoped to headerBlock() anyway, for the same reason as Status/Date
// above: fix the class once, not each instance as it's independently found.
function extractRule(content) {
  const m = headerBlock(content).match(/^\*\*Rule:\*\*\s*(.+)$/m);
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
    // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY, before
    // falling back to the fail-open `return false` below.
    renameWithRetry(renameSync, tmp, path);
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
  // `written: null` = no write attempted (see the export doc above). It is
  // NOT `false`, so "nothing to do" can never be read as "the write failed".
  const result = {addedDecisions: [], addedLessons: [], written: null};
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
        // Status suffix mirrors tools/prism-knowledge-index.mjs's renderIndex()
        // format ( `_(${status})_` ) verbatim, so a reader sees the same
        // computed value in both places rather than a second, divergent
        // status representation (task #41/F29 — Proposed cited as settled).
        const status = extractStatus(content);
        const statusPart = status ? ` _(${status})_` : '';
        const line = `- [[D${info.dNum}]] ${title}${statusPart}`;
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
      // F45 item 2, matching what [[D086]] proposes (Status: Proposed, not
      // ratified): this boolean used to be DISCARDED. On a 25 KB
      // overflow or an fs error nothing reached disk, yet the function still
      // returned a populated addedDecisions/addedLessons — a plausible
      // success indistinguishable from a real one. The manual path for the
      // identical condition (tools/prism-clean.mjs writeMemoryMdAtomic) fails
      // loudly with die(..., 8); this path must stay fail-open (it runs
      // inside SessionStart) but must not stay SILENT.
      result.written = writeMemoryMdAtomicSafe(path, body);
      if (!result.written) {
        logMemoryHeal({
          op: 'heal_pointers',
          status: 'write_failed',
          bytes: Buffer.byteLength(body, 'utf8'),
          cap_bytes: MEMORY_MD_HARD_CAP_BYTES,
          dropped_decisions: result.addedDecisions,
          dropped_lessons: result.addedLessons,
        });
      }
    }
    return result;
  } catch {
    // Structurally distinct from a healthy no-op (per the D086 proposal,
    // rule 2 — Status: Proposed, not ratified): the
    // healthy shape carries `written: null`; this one carries no `written`
    // key at all, so a consumer testing `written === null` cannot absorb a
    // thrown fault into the "nothing to do" bucket.
    logMemoryHeal({op: 'heal_pointers', status: 'error'});
    return {addedDecisions: [], addedLessons: []};
  }
}

// ─── C2b: regenerateStandingRules ─────────────────────────────────────────

// F44/[[D093]] follow-up (found 2026-07-28 by re-measuring the corpus BY
// INVOCATION, not by trusting the mechanism): a bare `^...$/m` scan of the
// WHOLE FILE is not enough, unlike extractRule/extractStatus/extractDate
// above whose genuine header field always happens to precede any later body
// text in every file the corpus currently has. D093 ITSELF — the file that
// DEFINES the `**Retired:**` marker — quotes two worked examples of the
// exact line format inside fenced code blocks, each starting a line with
// literal `**Retired:** ...` text. A whole-file scan finds the FIRST such
// line anywhere in the document and returns it as if it were a real header
// field, so D093 was self-retiring: excluded from its own always-on slot by
// its own illustrative prose. Confirmed by invoking regenerateStandingRules
// against a scratch copy of the real corpus: D093 appeared in
// `retiredSkipped` although D093 carries NO genuine `**Retired:**` header
// line (grep confirms both matches are inside its `## Decision 1` code-fence
// examples, not its header block). Fix: bound the scan to the HEADER BLOCK —
// the region before the first `## ` section heading, per
// .claude/rules/capture-conventions.md's "Required headers" — so prose or
// worked examples in the BODY can never be mistaken for a live field.
function headerBlock(content) {
  const m = content.match(/^##\s/m);
  return m ? content.slice(0, m.index) : content;
}

// Line-anchored for the same reason extractRule is (D062): a non-anchored
// match would fire on a mid-line mention of "Retired" inside prose or a
// title and silently drop a live rule. Scoped to the header block (see
// headerBlock() above) so a worked example in the BODY can't do the same.
// Retirement is an OWNER edit — nothing in this file ever WRITES this field.
function extractRetired(content) {
  const m = headerBlock(content).match(/^\*\*Retired:\*\*\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// [[D097]] (Locked 2026-07-28): a `**Tier:** core` header field exempts an
// owner-designated core set of standing rules from the date-ordered sort —
// see regenerateStandingRules below. Scoped to headerBlock() from the start,
// same reasoning as Status/Date/Rule/Retired above: this file's own doc
// comments (and any future adjudication that DOCUMENTS the Tier mechanism,
// the way D093 documents Retired) will quote `**Tier:** core` as a worked
// example. Without header-block scoping that quoting would tier the file
// that merely explains the field — the exact D093 self-retirement shape,
// recurring here for Tier instead of Retired unless guarded up front.
// Fail-open by construction: an absent or unrecognized value returns null,
// which callers treat as "not core" (normal newest-first competition) —
// never an error, never an exclusion from the pool.
function extractTier(content) {
  const m = headerBlock(content).match(/^\*\*Tier:\*\*\s*(\S+)$/m);
  return m ? m[1].trim().toLowerCase() : null;
}

// Returns {rules, retiredSkipped} rather than a bare array: the retired set is
// a THIRD distinct cause of a rule's absence from the standing-rules block
// ([[D046]] — an omission nobody counts is indistinguishable from one that
// never happened), and it needs a different response from the other two
// (intentional; no action). Collapsing it into evictedByCap would make an
// owner's deliberate retirement look like capacity pressure.
function scanLockedRules(projectRoot) {
  const dir = join(projectRoot, 'docs', 'prism', 'adjudications');
  const empty = {rules: [], retiredSkipped: []};
  if (!existsSync(dir)) return empty;
  const out = [];
  const retiredSkipped = [];
  let names;
  try { names = readdirSync(dir); } catch { return empty; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(D_FILE_RE);
    if (!m) continue;
    const content = safeRead(join(dir, name));
    if (content === null) continue;
    if (extractStatus(content) !== 'Locked') continue;
    const rule = extractRule(content);
    if (!rule) continue; // no Rule line — nothing to surface
    const dRef = 'D' + m[1].padStart(3, '0');
    // Retired ([[D093]]): drop from the ALWAYS-ON block only. The file stays
    // Locked, stays in tools/prism-knowledge-index.mjs's scan, and stays
    // keyword-injectable via hooks/prism-lesson-match.mjs. Retirement must
    // never mean deleted or unreachable — only "not always-on".
    if (extractRetired(content)) { retiredSkipped.push(dRef); continue; }
    out.push({
      dNum: parseInt(m[1], 10),
      dRef,
      date: extractDate(content) || '',
      rule,
      tier: extractTier(content), // [[D097]]: 'core' or null; fail-open (null = not core)
    });
  }
  retiredSkipped.sort();
  return {rules: out, retiredSkipped};
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

export function regenerateStandingRules(projectRoot, {cap = 35} = {}) {
  try {
    const path = memoryMdPath(projectRoot);
    const body = safeRead(path);
    if (body === null) {
      // Fault records omit `count`/`poolSize` entirely (per the D086
      // proposal, rule 2 — Status: Proposed, not ratified): a
      // consumer tallying `count === 0` cannot absorb "could not run" into
      // "ran, kept nothing".
      logMemoryHeal({op: 'standing_rules', status: 'memory_md_missing'});
      return {count: 0, changed: false};
    }

    const existingBlock = currentStandingRulesBlock(body);
    if (existingBlock === null) {
      logMemoryHeal({op: 'standing_rules', status: 'anchors_missing'});
      return {count: 0, changed: false}; // anchors missing — fail open
    }

    const scanned = scanLockedRules(projectRoot);
    const retiredSkipped = scanned.retiredSkipped;
    // [[D097]]: split the eligible pool into the owner-designated CORE tier
    // (ALWAYS injected, EXEMPT from the date sort) and everyone else (who
    // still compete newest-first for the REMAINING slots under `cap`, exactly
    // as before — orderNewestFirst's tiebreak is untouched by this split).
    // Core rules are ordered by D-number only (never by Date) so their
    // rendering position is deterministic without reintroducing the very
    // sort this tier exists to bypass.
    const coreRules = scanned.rules
      .filter((r) => r.tier === 'core')
      .sort((a, b) => a.dNum - b.dNum);
    const nonCoreRules = orderNewestFirst(scanned.rules.filter((r) => r.tier !== 'core'));
    const poolSize = scanned.rules.length; // unchanged meaning: full eligible (non-retired) pool, core + non-core
    const remainingSlots = Math.max(0, cap - coreRules.length);
    const nonCoreCandidates = nonCoreRules.slice(0, remainingSlots);
    // Cause 1 — COUNT CAP. Only the non-core pool competes for `cap` and can
    // be evicted by it; core rules are ALWAYS injected (D097) and can never
    // appear here. Oldest last (nonCoreRules is already newest-first), so the
    // tail is the eviction set. Raising `cap` would admit these — but see
    // D097's "Rejected alternatives": that is explicitly not the fix.
    const evictedByCap = nonCoreRules.slice(remainingSlots).map((r) => r.dRef);
    let candidates = [...coreRules, ...nonCoreCandidates];

    // Fit under the 25 KB hard cap: drop lowest-priority (tail = oldest)
    // candidates one at a time until the full MEMORY.md body fits.
    // Cause 2 — BYTE FIT. Distinct from cause 1 and NOT fixable by raising
    // `cap`: these were inside the cap and were still cut because the
    // rendered file would breach MEMORY_MD_HARD_CAP_BYTES.
    const evictedByBytes = [];
    let lines = renderStandingRulesLines(candidates);
    let newBody = spliceStandingRules(body, lines);
    while (candidates.length > 0 && Buffer.byteLength(newBody, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) {
      evictedByBytes.unshift(candidates[candidates.length - 1].dRef);
      candidates = candidates.slice(0, -1);
      lines = renderStandingRulesLines(candidates);
      newBody = spliceStandingRules(body, lines);
    }

    // F44/[[D046]]: emit on EVERY completed regeneration, including the
    // zero-eviction case. A record that only appeared when something was
    // dropped would leave "nothing evicted" and "regeneration never ran"
    // looking identical from the log — the same omissive shape this closes.
    // Cause 3 — RETIRED ([[D093]]). Kept structurally separate from the other
    // two because the REMEDY differs: a retirement is intentional and needs no
    // action, a count-cap eviction is fixed by raising `cap`, and a byte-fit
    // eviction is a capacity wall `cap` cannot fix. `pool_size` counts only
    // the eligible (non-retired) pool, so `pool_size + retired_skipped.length`
    // is the full Locked-with-Rule population.
    // [[D097]]: names the core D-refs actually surviving in `candidates` —
    // computed from the post-byte-trim list, not the initial `coreRules`, so
    // this stays honest even in the (currently unmeasured, capacity-wall-only)
    // case where the byte-fit loop has to cut into the core set itself.
    const tiered = candidates.filter((r) => r.tier === 'core').map((r) => r.dRef);

    const evictionFacts = {
      op: 'standing_rules',
      pool_size: poolSize,
      cap,
      kept: candidates.length,
      tiered_core: tiered,
      retired_skipped: retiredSkipped,
      evicted_count_cap: evictedByCap,
      evicted_byte_fit: evictedByBytes,
      bytes: Buffer.byteLength(newBody, 'utf8'),
      cap_bytes: MEMORY_MD_HARD_CAP_BYTES,
    };

    const renderedBlock = lines.join('\n');
    if (hashOf(renderedBlock) === hashOf(existingBlock)) {
      logMemoryHeal({...evictionFacts, status: 'unchanged'});
      return {
        count: candidates.length, changed: false, written: null,
        poolSize, retiredSkipped, evictedByCap, evictedByBytes, tiered,
      };
    }

    const ok = writeMemoryMdAtomicSafe(path, newBody);
    logMemoryHeal({...evictionFacts, status: ok ? 'written' : 'write_failed'});
    return {
      count: candidates.length, changed: ok, written: ok,
      poolSize, retiredSkipped, evictedByCap, evictedByBytes, tiered,
    };
  } catch {
    logMemoryHeal({op: 'standing_rules', status: 'error'});
    return {count: 0, changed: false};
  }
}

export const STANDING_RULES_ANCHORS = {start: STANDING_RULES_START, end: STANDING_RULES_END};

// F45 (task #62): exported so tools/prism-deep-dive.mjs's seed-template
// headings can DERIVE their "(last N)" count from the real, currently-active
// value instead of a hard-coded literal that drifts out of sync (F45 root
// cause — the literal "10" in the seed template was never tied to either
// POINTER_KEEP constant in the first place). This is the value the AUTOMATED
// SessionStart heal path (`healMemoryPointers`, running every session) keeps
// the DECISION_ANCHOR/LESSON_ANCHOR windows trimmed to. It does NOT change
// the value itself — `tools/prism-clean.mjs:162` keeps its OWN, deliberately
// un-reconciled `POINTER_KEEP = 10` for its manual, occasional CLI path (see
// the "OWNER DECISION 2026-07-28" note above) — so the true keep-window at
// any moment is whichever of the two wrote last, not a single constant. This
// export surfaces the more-authoritative (every-session) one; it is not
// claimed to be the only one that can apply.
export {POINTER_KEEP};
