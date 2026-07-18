#!/usr/bin/env node
// prism-repair-open-tasks — dry-run repair for corrupted project-local
// .claude/.prism-open-tasks.json carryover pointers (Fix A slice 6).
//
// A pointer written by the pre-fix extractor can carry markup-bled subjects/
// descriptions, dropped tasks, and zombie completed tasks. The TRUE Task
// events still live in the project's session transcripts
// (~/.claude/projects/<munged>/*.jsonl, camelCase toolUseResult siblings), so
// the pointer is rebuilt by replaying the FIXED extractor — the EXACT same
// code the SessionEnd hook runs (hooks/lib/prism-task-snapshot.mjs; shared
// lib, divergence structurally impossible) — over every transcript in mtime
// order (later sessions win per task id), then gap-filling tasks that survive
// ONLY in per-session sidecars (~/.claude/.prism-sessions/*.tasks.json whose
// `project` matches).
//
// USAGE
//   node tools/prism-repair-open-tasks.mjs [projectDir] [--apply]
//        [--pointer <path>] [--claude-dir <dir>]
//
//   projectDir     project whose pointer to repair (default: cwd)
//   --apply        write the reconstructed pointer (atomic tmp+rename);
//                  DEFAULT IS DRY-RUN — prints the diff, writes nothing
//   --pointer      explicit pointer path (default <projectDir>/.claude/
//                  .prism-open-tasks.json). If the pointer carries a
//                  `project` field, that is used for transcript lookup —
//                  lets you dry-run a forensic COPY of a pointer.
//   --claude-dir   override ~/.claude (tests / forensic replays)
//
// E3 ruling: tasks with markup-bled or empty subject/description are FLAGGED
// for human review, NEVER auto-sanitized — the reconstructed text is written
// verbatim.
//
// EXIT CODES: 0 ok (diff printed / applied) · 1 failure · 3 no transcripts
// found for the project (distinct — nothing to reconstruct FROM, not an error
// in the tool).

import {readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync} from 'node:fs';
import {join, dirname, basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractTaskSnapshot, readTaskScanLines, foldTaskRecords} from '../hooks/lib/prism-task-snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── args (Karpathy-minimal: no speculative options) ─────────────────────────
const argv = process.argv.slice(2);
let projectDir = null, apply = false, pointerArg = null, claudeDirArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--apply') apply = true;
  else if (a === '--pointer') pointerArg = argv[++i];
  else if (a === '--claude-dir') claudeDirArg = argv[++i];
  else if (a === '--help' || a === '-h') { console.log('usage: prism-repair-open-tasks [projectDir] [--apply] [--pointer <path>] [--claude-dir <dir>]'); process.exit(0); }
  else if (!a.startsWith('--') && projectDir === null) projectDir = a;
  else { console.error(`unknown argument: ${a}`); process.exit(1); }
}
projectDir = resolve(projectDir || process.cwd());
const H = process.env.HOME || process.env.USERPROFILE || '';
const claudeDir = resolve(claudeDirArg || join(H, '.claude'));
const pointerPath = resolve(pointerArg || join(projectDir, '.claude', '.prism-open-tasks.json'));

// Same munging rule Claude Code uses for ~/.claude/projects/<dir> names.
const munge = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const normPath = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

// ── read the existing (possibly corrupted) pointer ──────────────────────────
let existing = null, existingParseError = null;
if (existsSync(pointerPath)) {
  try { existing = JSON.parse(readFileSync(pointerPath, 'utf-8')); }
  catch (err) { existingParseError = err.message; }
}
// A forensic pointer copy names its true project — prefer it for lookup.
const lookupProject = (existing && typeof existing.project === 'string' && existing.project)
  ? resolve(existing.project) : projectDir;

// ── locate transcripts ───────────────────────────────────────────────────────
const transcriptsDir = join(claudeDir, 'projects', munge(lookupProject));
let transcripts = [];
try {
  transcripts = readdirSync(transcriptsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => join(transcriptsDir, f))
    .filter(p => { try { return statSync(p).isFile(); } catch { return false; } })
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs); // oldest → newest
} catch {}
if (!transcripts.length) {
  console.error(`no transcript for ${lookupProject}\n  (looked in ${transcriptsDir}) — cannot reconstruct.`);
  process.exit(3);
}

// ── replay the FIXED extractor over every transcript, newest wins per id ────
// FIELD-WISE fold, via the SAME shared helper mergeOpenTasks uses
// (hooks/lib/prism-task-snapshot.mjs foldTaskRecords — single owner of the
// field-wise carry rule, D046 #4): extractTaskSnapshot() starts a FRESH
// per-transcript map, so a transcript that only touches a task's status
// (e.g. a status-only TaskUpdate) returns that task with subject/description/
// status/activeForm/blockedBy simply ABSENT for every field it never
// observed — not cleared. A wholesale fold.set() per transcript would let an
// unobserved-absent field silently blank a value an EARLIER transcript's
// TaskCreate established. foldTaskRecords(prev, next) instead carries every
// field `next` did not observe forward from `prev`, generic over the key
// union — no allowlist.
const fold = new Map(); // id -> task (final state, field-wise merged across transcripts)
const collidedIds = [];
const totals = {structured_hits: 0, regex_fallbacks: 0, unmatched_task_results: 0};
let anyTruncated = false;
for (const tx of transcripts) {
  const {lines, tail_truncated} = readTaskScanLines(tx);
  anyTruncated = anyTruncated || tail_truncated;
  const counters = {structured_hits: 0, regex_fallbacks: 0, unmatched_task_results: 0};
  // D048 (6.5.2): PROVENANCE, not a subject-diff heuristic. The prior
  // subject-conflict trigger fired on any two-transcript subject difference —
  // including an ordinary same-task rename, which is common and NOT a
  // collision. `created` records which ids THIS transcript's extractor
  // actually TaskCreate'd (see extractTaskSnapshot's createdIds out-param).
  // A collision is an id this transcript INDEPENDENTLY CREATED that an
  // earlier transcript's fold already populated — a rename (TaskUpdate only)
  // never adds to `created`, so it never flags. Merge still NOT suppressed
  // (foldTaskRecords unchanged) — a genuine cross-session rename is
  // data-indistinguishable from reuse at the field level, so the field-wise
  // carry stays intact either way; only the flag trigger is now precise.
  const created = new Set();
  for (const t of extractTaskSnapshot(lines, counters, created)) {
    const id = String(t.id);
    const prev = fold.get(id);
    if (prev) {
      if (created.has(id)) {
        collidedIds.push({id, prev_subject: prev.subject, next_subject: t.subject});
      }
      fold.set(id, foldTaskRecords(prev, t).merged);
    } else {
      fold.set(id, t);
    }
  }
  for (const k of Object.keys(totals)) totals[k] += counters[k];
}

const byIdNum = (a, b) => {
  const na = Number(a.id), nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a.id).localeCompare(String(b.id));
};
const isOpen = (t) => t.status === 'pending' || t.status === 'in_progress';
let reconstructed = Array.from(fold.values()).filter(isOpen);

// ── sidecar gap-fill: tasks surviving ONLY in per-session sidecars ──────────
// Never overrides transcript truth — only ids the transcripts never saw
// (rotated/deleted transcript, sidecar still present).
const sidecarFills = [];
try {
  const sessDir = join(claudeDir, '.prism-sessions');
  const sidecars = readdirSync(sessDir).filter(f => f.endsWith('.tasks.json'))
    .map(f => join(sessDir, f));
  const entries = [];
  for (const p of sidecars) {
    try {
      const payload = JSON.parse(readFileSync(p, 'utf-8'));
      if (payload && normPath(payload.project || '') === normPath(lookupProject) && Array.isArray(payload.open_tasks)) {
        entries.push({ts: Date.parse(payload.ts || '') || 0, session: payload.session_id || basename(p), open: payload.open_tasks});
      }
    } catch {}
  }
  entries.sort((a, b) => a.ts - b.ts);
  for (const e of entries) {
    for (const t of e.open) {
      if (!t || t.id == null || fold.has(String(t.id))) continue;
      if (reconstructed.some(x => String(x.id) === String(t.id))) {
        // a later sidecar refreshes an earlier sidecar-only task
        reconstructed = reconstructed.filter(x => String(x.id) !== String(t.id));
      }
      reconstructed.push({...t, id: String(t.id)});
      sidecarFills.push({id: String(t.id), session: e.session});
    }
  }
} catch {}
reconstructed.sort(byIdNum);

// ── E3 flags: surface for human review, never sanitize ──────────────────────
const MARKUP_RE = /<\/?(subject|parameter|invoke)\b/i;
const flags = [];
for (const t of reconstructed) {
  if (MARKUP_RE.test(t.subject || '')) flags.push({id: t.id, what: 'markup in subject', sample: (t.subject || '').slice(0, 120)});
  if (MARKUP_RE.test(t.description || '')) flags.push({id: t.id, what: 'markup in description', sample: (t.description || '').match(MARKUP_RE)[0]});
  if (!(t.subject || '').trim()) flags.push({id: t.id, what: 'empty subject'});
  if (!(t.description || '').trim()) flags.push({id: t.id, what: 'empty description'});
}
for (const c of collidedIds) {
  flags.push({id: c.id, what: 'cross-session id-reuse (id independently created in ≥2 sessions — flagged, merge NOT suppressed)', sample: `${JSON.stringify(c.prev_subject)} vs ${JSON.stringify(c.next_subject)}`});
}

// ── diff existing vs reconstructed ───────────────────────────────────────────
const FIELDS = ['subject', 'description', 'activeForm', 'status', 'blockedBy'];
const existingOpen = new Map(
  ((existing && Array.isArray(existing.open_tasks)) ? existing.open_tasks : [])
    .filter(t => t && t.id != null).map(t => [String(t.id), t]));
const label = (t) => `#${t.id} [${t.status || '?'}] ${(t.subject || '(no subject)').slice(0, 80)}`;

console.log(`pointer:      ${pointerPath}${existingParseError ? `  (UNPARSEABLE: ${existingParseError})` : existing ? '' : '  (missing)'}`);
console.log(`project:      ${lookupProject}`);
console.log(`transcripts:  ${transcripts.length} scanned in ${transcriptsDir}${anyTruncated ? '  [tail_truncated: oldest events beyond scan cap unseen]' : ''}`);
console.log(`extraction:   structured=${totals.structured_hits} regex_fallback=${totals.regex_fallbacks} unmatched=${totals.unmatched_task_results}`);
if (sidecarFills.length) console.log(`sidecar fill: ${sidecarFills.map(s => `#${s.id}<-${s.session}`).join(', ')}`);
console.log('');
console.log(`--- diff (existing pointer -> reconstructed) ---`);
let changes = 0;
for (const t of reconstructed) {
  const prev = existingOpen.get(String(t.id));
  if (!prev) { console.log(`+ ${label(t)}`); changes++; continue; }
  const diffs = FIELDS.filter(f => JSON.stringify(prev[f] ?? null) !== JSON.stringify(t[f] ?? null));
  if (diffs.length) { console.log(`~ ${label(t)}  (changed: ${diffs.join(', ')})`); changes++; }
}
for (const [id, prev] of existingOpen) {
  if (!reconstructed.some(t => String(t.id) === id)) { console.log(`- ${label(prev)}`); changes++; }
}
if (!changes) console.log('(no differences — pointer already matches reconstruction)');
console.log('');
if (flags.length) {
  console.log('--- FLAGS (E3: surfaced for human review, NOT auto-sanitized) ---');
  for (const f of flags) console.log(`FLAG #${f.id}: ${f.what}${f.sample ? ` — ${JSON.stringify(f.sample)}` : ''}`);
  console.log('');
}

// ── write (only with --apply) ────────────────────────────────────────────────
if (!apply) {
  console.log(`DRY RUN — no changes written. Re-run with --apply to write ${reconstructed.length} open task(s).`);
  process.exit(0);
}
const newestSession = basename(transcripts[transcripts.length - 1]).replace(/\.jsonl$/, '');
const payload = {
  session_id: newestSession,
  project: lookupProject,
  ts: new Date().toISOString(),
  git_sha: null, // unknown at repair time — SessionStart treats null as unresolvable, same as the hook does
  open_tasks: reconstructed.map(t => ({
    id: t.id, subject: t.subject ?? '', description: t.description ?? '',
    activeForm: t.activeForm ?? '', status: t.status, blockedBy: t.blockedBy ?? null,
  })),
  repaired: {
    tool: 'prism-repair-open-tasks',
    ts: new Date().toISOString(),
    transcripts: transcripts.length,
    sidecar_fills: sidecarFills.length,
    flags: flags.length,
  },
};
const tmp = pointerPath + '.tmp';
writeFileSync(tmp, JSON.stringify(payload, null, 2));
renameSync(tmp, pointerPath);
console.log(`APPLIED — wrote ${reconstructed.length} open task(s) to ${pointerPath}${flags.length ? `  (${flags.length} flag(s) above still need human review)` : ''}`);
process.exit(0);
