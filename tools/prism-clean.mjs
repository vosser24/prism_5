#!/usr/bin/env node
// prism-clean — deterministic helper for /prism-clean (v3.11.0 Phase A.2).
//
// The 5-level importance classifier + selection UX is LLM-judged and lives
// in commands/prism-clean.md. This helper owns the two purely-deterministic
// operations the slash command needs:
//
// Subcommands:
//   next-d-number [--root <path>]
//       Scan <root>/docs/prism/adjudications/ for D### files; print the
//       next number zero-padded to 3 digits (e.g. "005"). Empty or missing
//       directory prints "001".
//
//   git-stats --since <iso|sha> [--root <path>]
//       Run git log + git diff to summarise activity since a baseline.
//       Accepts TWO formats for --since (F50, D046 omissive class, task #68):
//         - ISO 8601 date/time, e.g. "2026-07-28T13:45:00Z" — passed to
//           `git log --since=<iso>` and `git rev-list --before=<iso>`.
//         - A git revision — full 40-char SHA or an unambiguous 7+ char
//           prefix — detected by shape (/^[0-9a-f]{7,40}$/i) and verified
//           via `git rev-parse --verify <val>^{commit}` BEFORE use. When it
//           resolves, stats are computed as `<val>..HEAD` directly (NOT
//           passed to git as a date). A value that merely looks SHA-shaped
//           but does not resolve to a real commit is refused with a non-null
//           `warning` naming the expected formats — it is never silently
//           reinterpreted as a date. (Previously any bare string, SHA
//           included, was passed straight to `--since=<value>`; git parses
//           an unrecognised string as a no-op date filter rather than
//           erroring, so a SHA baseline silently produced full-repo-history
//           stats with warning: null — see docs/prism/adjudications
//           F50 reproduction: 291 vs 5 commits for a SHA that was misread.)
//       Prints JSON: {commits, files_changed, insertions, deletions,
//       boundary_sha, warning}. Tri-state contract (D046 finding #7 / Fix
//       B): commits/files_changed/insertions/deletions are each EITHER a
//       real measured number (0 included) OR null when the underlying git
//       command failed and that field could not be measured — 0 never
//       means "the command failed and we defaulted". warning is non-null
//       whenever any field is null, OR whenever a revision-shaped --since
//       fails to resolve, OR whenever the resolved boundary_sha diverges
//       from a supplied revision-shaped argument — and names the git
//       command to re-run for a manual check. See commands/prism-clean.md
//       Step 1 for how the LLM classifier is required to read this shape.
//
//   append-decision --slug <s> --d-number <NNN> --title <text>
//       Append a "- [[D###]] <title>" line to the "Recent decisions" section
//       of <root>/.claude/agents/MEMORY.md. Trims to last 10 pointers.
//       Refuses on missing MEMORY.md (exit 6), missing anchor (exit 7), or >25 KB cap (exit 8).
//       Refuses on a Git Bash / MSYS path-converted --title, e.g. a leading
//       "/" title rewritten to "C:/Program Files/Git/..." (exit 9) — see
//       rejectIfMsysPathConverted() below. Re-run with MSYS_NO_PATHCONV=1.
//
//   append-lesson --slug <s> --date <YYYY-MM-DD> --title <text>
//       Append a "- [<date>] <title>" line to the "Recent lessons" section of
//       <root>/.claude/agents/MEMORY.md — the lesson TEXT itself (the one-line
//       **Rule:** imperative), inlined directly. D083 (owner-approved
//       2026-07-28): this used to write a "[[lessons-tactical#<date>]]"
//       POINTER instead, on the assumption that the full lesson body would
//       also be appended to tasks/lessons-tactical.md and later resolved from
//       the pointer. That second append never existed, so the pointer always
//       resolved to nothing (present-tense dual-write gap, not historical —
//       see .claude/agents/MEMORY.md's pre-fix "Recent lessons" section for
//       9 dangling pointers from the 2026-07-27 /prism-clean run). Inlining
//       removes the thing that needed resolving in the first place. Format
//       mirrors append-summary's existing "- [<date>] <text>" convention.
//       Same trim + cap + anchor + MSYS path-conversion guard as
//       append-decision (exits 6/7/8/9). Pre-existing legacy
//       "[[lessons-tactical#...]]" pointer bullets already sitting in
//       MEMORY.md are NOT migrated by this — they are ordinary "- " bullets
//       to upsertUnderAnchor, so they coexist with new inline entries and
//       age out through the same last-10 trim window as everything else.
//
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §6
//
// All subcommands accept --root <path> and refuse to run without .git/
// unless --no-git-guard is passed.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';
import {fileURLToPath} from 'node:url';
import {upsertUnderAnchor} from './lib/memory-anchors.mjs';
import {renameWithRetry} from './lib/atomic-fs.mjs';
import {prismHome} from '../hooks/lib/prism-home.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), noGitGuard: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--since') named.since = args[++i];
  else if (a === '--slug') named.slug = args[++i];
  else if (a === '--d-number') named.d_number = args[++i];
  else if (a === '--date') named.date = args[++i];
  else if (a === '--title') named.title = args[++i];
  else if (a === '--summary') named.summary = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-clean <command> [args] [--root <path>] [--no-git-guard]

Commands:
  next-d-number
  git-stats --since <iso|sha>   (ISO 8601 date/time, or a git revision SHA/prefix)
  append-decision --slug <s> --d-number <NNN> --title <text>
  append-lesson --slug <s> --date <YYYY-MM-DD> --title <text>
  append-summary --slug <s> --date <YYYY-MM-DD> --summary <text>

append-decision/append-lesson/append-summary exit 9 if --title/--summary was
mangled by Git Bash / MSYS path-conversion (a leading "/" rewritten into a
Windows Git-install path). Re-run with MSYS_NO_PATHCONV=1 set.
`);
  exit(code);
}

// ------------------------------ guards ------------------------------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

// ------------------------------ helpers ------------------------------

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

const D_NUMBER_RE = /^D(\d{3,})-.+\.md$/;

const MEMORY_MD_HARD_CAP_BYTES = 25 * 1024;

const DECISION_ANCHOR = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
const LESSON_ANCHOR = '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->';
const SUMMARY_ANCHOR = '<!-- /prism-clean appends session-summary lines here. -->';
// TWO CAPS ON THE SAME ANCHORS (F45 item 1) — read before changing this.
// tools/lib/memory-heal.mjs has its own `POINTER_KEEP = 20` and writes the
// SAME DECISION_ANCHOR / LESSON_ANCHOR via the same upsertUnderAnchor, so the
// effective window is whichever path wrote last: a /prism-clean append after
// a SessionStart heal trims a 20-entry window back to 10.
// This divergence is UNDOCUMENTED, not established as deliberate. [[D085]]
// decision 1b scopes its raise to the other file only — "**Chosen.** In
// `tools/lib/memory-heal.mjs`: `STANDING_RULES_CAP` 12 -> 30, `POINTER_KEEP`
// 10 -> 20." — and neither changes nor defends this constant; there is no
// comment here predating it either, so there is no Chesterton's fence to
// quote ([[D057]]).
//
// OWNER DECISION 2026-07-28 — REVIEWED AND DELIBERATELY LEFT DIVERGENT.
// The 10-vs-20 split against tools/lib/memory-heal.mjs is now a settled owner
// call, NOT an oversight to be tidied later; do not "reconcile" it. KNOWN
// CONSEQUENCE, accepted with eyes open: the decision anchor currently holds 17
// bullets, so the NEXT `/prism-clean append-decision` will trim it to 10. That
// loss is accepted BECAUSE it is no longer silent — every dropped entry is
// logged by name via `memory_anchor_trim`. See the mirrored note at
// tools/lib/memory-heal.mjs's own POINTER_KEEP.
//
// The original reasoning, retained: raising it grows MEMORY.md on a path
// whose overflow behaviour is a HARD die(exit 8) (writeMemoryMdAtomic below),
// and MEMORY.md measured 24,101 of 25,600 bytes on 2026-07-28 — ~1.5 KB of
// headroom against up to 20 extra bullets. The trim is no longer silent:
// upsertUnderAnchor now emits a `memory_anchor_trim` record naming every
// dropped entry, so the effective-window difference is measurable first.
// ALSO NOTE what is written under LESSON_ANCHOR: since [[D085]] decision 1a
// appendLesson() writes the lesson TEXT INLINE (`- [<date>] <text>`), NOT a
// `[[lessons-tactical#date]]` pointer. The anchor string still says
// "lessons-tactical#date" and must stay byte-identical (D085 1a froze it —
// anchor matching is exact-text equality across three files plus every
// already-seeded MEMORY.md); only this comment describes reality.
const POINTER_KEEP = 10;

// Git Bash / MSYS path-conversion guard (task 12, 2nd occurrence).
//
// MSYS rewrites ANY CLI argument that looks like a leading-slash POSIX path
// before Node ever sees it, by replacing the leading "/" with the Windows
// path to the Git install root (e.g. "C:/Program Files/Git"). This bites
// `--title "/prism-health is an LLM protocol..."` — the whole free-text
// string starts with "/", so MSYS "helpfully" turns it into
// "C:/Program Files/Git/prism-health is an LLM protocol..." before argv even
// reaches this script. That corrupted string was then written verbatim into
// MEMORY.md (hand-repaired once already — this guard is the actual fix).
//
// Detect the shape rather than trying to reverse it: a free-text value that
// now starts with a Windows drive-letter path whose last segment before the
// rest of the text is literally "Git" is essentially never a legitimate
// title/summary — it is almost certainly a mangled leading-slash token.
// Recovering the original by stripping the prefix would require guessing
// exactly which prefix MSYS used (it varies by Git install location) and
// would silently reintroduce a different corruption if the guess is wrong,
// so this rejects with a clear remediation instead of attempting recovery.
const MSYS_PATHCONV_RE = /^[A-Za-z]:[\\/](?:[^\\/]*[\\/])*Git[\\/]/;

function rejectIfMsysPathConverted(value, flagName) {
  if (typeof value === 'string' && MSYS_PATHCONV_RE.test(value)) {
    die(
      `refusing: --${flagName} looks like it was mangled by Git Bash / MSYS path-conversion ` +
      `(it now starts with a Windows Git-install path: "${value.slice(0, 60)}${value.length > 60 ? '...' : ''}"). ` +
      `This happens when the intended value began with "/" (e.g. "/prism-health ...") — MSYS rewrote ` +
      `the leading slash into the Git install path before Node saw the argument. ` +
      `Re-run with MSYS_NO_PATHCONV=1 set, e.g.:\n` +
      `  MSYS_NO_PATHCONV=1 node tools/prism-clean.mjs ... --${flagName} "..."`,
      9,
    );
  }
}

function readMemoryMd(root) {
  const path = join(root, '.claude', 'agents', 'MEMORY.md');
  if (!existsSync(path)) {
    die(`refusing: MEMORY.md not found at ${path}. Run /prism-deep-dive first to seed it.`, 6);
  }
  return {path, body: readFileSync(path, 'utf8')};
}

function writeMemoryMdAtomic(path, body) {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MEMORY_MD_HARD_CAP_BYTES) {
    die(`refusing: MEMORY.md would be ${bytes} bytes (> 25 KB cap). ` +
        `Run /prism-deep-dive --upgrade <slug> to re-synthesize the router.`, 8);
  }
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY (AV/indexer
  // handle collision). A bare renameSync here used to abort the whole
  // /prism-clean capture and throw away the already-synthesized body.
  renameWithRetry(renameSync, tmp, path);
}

// Thin wrapper over the shared tools/lib/memory-anchors.mjs upsert (C1,
// recall-hardening spec) — translates its ANCHOR_NOT_FOUND throw into this
// CLI's die()/exit-7 convention. pointerRe is accepted for call-site
// symmetry with the old inline helper but is no longer needed: the shared
// upsertUnderAnchor treats every `- ` bullet line in the anchor's section as
// a managed pointer, which is exactly what each of the three sections here
// already contains.
function appendUnderAnchor({body, anchor, newLine}) {
  try {
    return upsertUnderAnchor(body, anchor, newLine, {keep: POINTER_KEEP});
  } catch (e) {
    if (e && e.code === 'ANCHOR_NOT_FOUND') {
      die(`refusing: MEMORY.md is missing the expected anchor comment:\n  ${anchor}\n` +
          `The file may have been hand-edited. Re-seed with /prism-deep-dive --upgrade.`, 7);
    }
    throw e;
  }
}

function nextDNumber(root) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  if (!existsSync(dir)) return '001';
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = name.match(D_NUMBER_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return String(max + 1).padStart(3, '0');
}

// git's well-known empty-tree object hash — present in every repository
// without needing to exist as a commit. Used below as the diff boundary
// when `--since` predates the first commit: "everything since before
// commit #1" IS "everything since the empty repo", so diffing against it
// is the semantically correct answer, not a fallback hack.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// D046 finding #7 (Fix B) — tri-state contract: every numeric field is
// either a real measured number (including a genuine 0) or `null` when it
// could not be measured at all. A `0` NEVER means "the git command failed
// and we defaulted" — that ambiguity is exactly the defect this replaces
// (58 real commits previously reported as `{files_changed: 0, insertions: 0,
// deletions: 0}`, indistinguishable from a session with zero changes, which
// let /prism-clean's LLM classifier read real work as L1 NOISE). `warning`
// is non-null only when at least one field is `null`, and names the exact
// git command to re-run for a manual check. `boundary_sha` is a real git
// object (a commit sha, or EMPTY_TREE_SHA when the window covers the
// repo's entire history) whenever it is knowable, and `null` only when the
// git command that would determine it failed outright.
// git's own message for "this branch has no commits yet" — the ONE non-zero
// `git log` exit that is a genuine, known zero (an empty repo has exactly
// zero commits in every window, by definition) rather than a real failure.
// Every OTHER non-zero exit (bad --since format, corrupt repo, git missing,
// permissions) is treated as truly unmeasured.
const EMPTY_REPO_RE = /does not have any commits yet/i;

// F50 (D046 omissive class, task #68) — `--since` is passed straight to
// `git log --since=<value>`, which interprets ANY bare string as a DATE
// expression. A caller who reasonably passes a commit SHA as the baseline
// (e.g. "use the session-boundary commit") gets no error: git silently
// fails to parse the SHA as a date, `--since` becomes a no-op, and the
// command reports full-repo-history stats with `warning: null` — a
// fully-populated, plausible, WRONG answer (filed reproduction: 291 vs 5
// commits, boundary_sha resolved to a different commit than supplied).
// Detect a revision-shaped value up front and resolve it as a REVISION
// (`<sha>..HEAD`) instead of a date, per the F50 "(a)+(c)" fix direction:
// (a) accept the ergonomic SHA form via `git rev-parse --verify`, and
// (c) make any resolution divergence a loud `warning` instead of a silent
// wrong answer. A value that merely LOOKS SHA-shaped but does not resolve
// to a real commit is refused outright (loud warning naming the expected
// formats) rather than silently falling through to the broken date path —
// that fallthrough is exactly the bug being fixed here.
const REVISION_SHAPED_RE = /^[0-9a-f]{7,40}$/i;

function gitStats(root, sinceIso) {
  const unmeasured = (commits, boundary_sha, warning) =>
    ({commits, files_changed: null, insertions: null, deletions: null, boundary_sha, warning});

  if (REVISION_SHAPED_RE.test(sinceIso)) {
    return gitStatsFromRevision(root, sinceIso, unmeasured);
  }

  // commits since the cutoff
  const logRes = spawnSync('git', ['-C', root, 'log', `--since=${sinceIso}`, '--oneline'], {encoding: 'utf8'});
  if (logRes.status !== 0) {
    if (EMPTY_REPO_RE.test(logRes.stderr || '')) {
      return {commits: 0, files_changed: 0, insertions: 0, deletions: 0, boundary_sha: null, warning: null};
    }
    return unmeasured(null, null,
      `git log --since=${sinceIso} failed (exit ${logRes.status}): ${(logRes.stderr || '').trim().slice(0, 200)} — ` +
      `commit count could NOT be measured. This is UNKNOWN, not zero — do not classify as NOISE from this result.`);
  }
  const commits = logRes.stdout ? logRes.stdout.trim().split('\n').filter(Boolean).length : 0;

  if (commits === 0) {
    // Genuinely zero commits in the window: the diff is trivially zero too,
    // and that IS a measured fact, not a degraded read.
    return {commits: 0, files_changed: 0, insertions: 0, deletions: 0, boundary_sha: null, warning: null};
  }

  // commits > 0: find the boundary commit (at-or-before the cutoff) to diff against.
  const revRes = spawnSync('git', ['-C', root, 'rev-list', '-n', '1', `--before=${sinceIso}`, 'HEAD'], {encoding: 'utf8'});
  if (revRes.status !== 0) {
    return unmeasured(commits, null,
      `commits=${commits} since ${sinceIso}, but git rev-list failed (exit ${revRes.status}) — diff stats ` +
      `could NOT be measured. This is UNKNOWN, not zero. Verify with: git log --stat --since=${sinceIso}`);
  }
  // Empty stdout means no commit exists before the cutoff (the window covers
  // the repo's entire history) — use the empty-tree boundary (see above),
  // NOT a silent zero.
  const boundarySha = revRes.stdout.trim() || EMPTY_TREE_SHA;
  const diffRes = spawnSync('git', ['-C', root, 'diff', '--shortstat', `${boundarySha}..HEAD`], {encoding: 'utf8'});
  if (diffRes.status !== 0) {
    return unmeasured(commits, boundarySha,
      `commits=${commits} since ${sinceIso}, boundary=${boundarySha}, but git diff failed (exit ${diffRes.status}) — ` +
      `diff stats could NOT be measured. This is UNKNOWN, not zero. Verify with: git log --stat --since=${sinceIso}`);
  }
  const {files_changed, insertions, deletions} = parseShortstat(diffRes.stdout);
  return {commits, files_changed, insertions, deletions, boundary_sha: boundarySha, warning: null};
}

// F50 revision path: `sinceRev` matched REVISION_SHAPED_RE (7-40 hex chars).
// Resolve it as an actual git revision — never as a date — and diff
// `<resolved>..HEAD` directly, mirroring gitStats' tri-state contract.
function gitStatsFromRevision(root, sinceRev, unmeasured) {
  const verifyRes = spawnSync('git', ['-C', root, 'rev-parse', '--verify', `${sinceRev}^{commit}`], {encoding: 'utf8'});
  if (verifyRes.status !== 0) {
    // SHA-shaped but does not resolve to a real commit. Do NOT fall through
    // to the date path — that fallthrough is the exact bug this guards
    // against (git would silently fail to parse it as a date too, and
    // report full-history stats with warning: null). Fail loud instead.
    return unmeasured(null, null,
      `--since "${sinceRev}" looks like a git revision (7-40 hex chars) but does not resolve to a commit ` +
      `(git rev-parse --verify ${sinceRev}^{commit} failed: ${(verifyRes.stderr || '').trim().slice(0, 200)}) — ` +
      `refusing to reinterpret it as a date. Pass a valid commit SHA (full or unambiguous prefix), or an ` +
      `ISO 8601 date/time (e.g. 2026-07-28T13:45:00Z) if a date was intended.`);
  }
  const boundarySha = verifyRes.stdout.trim();
  // (c) — make any echo divergence loud instead of silent. Given resolution
  // is via `git rev-parse --verify <sinceRev>^{commit}` on the literal input,
  // the resolved sha is always an extension of the supplied prefix; this is
  // a defensive backstop, not expected to ever fire.
  const divergenceWarning = boundarySha.toLowerCase().startsWith(sinceRev.toLowerCase())
    ? null
    : `boundary_sha "${boundarySha}" does not match the supplied revision "${sinceRev}" — resolution diverged ` +
      `unexpectedly. Verify manually with: git rev-parse --verify ${sinceRev}^{commit}`;

  const logRes = spawnSync('git', ['-C', root, 'log', `${boundarySha}..HEAD`, '--oneline'], {encoding: 'utf8'});
  if (logRes.status !== 0) {
    return unmeasured(null, boundarySha,
      `git log ${boundarySha}..HEAD failed (exit ${logRes.status}): ${(logRes.stderr || '').trim().slice(0, 200)} — ` +
      `commit count could NOT be measured. This is UNKNOWN, not zero.`);
  }
  const commits = logRes.stdout ? logRes.stdout.trim().split('\n').filter(Boolean).length : 0;

  const diffRes = spawnSync('git', ['-C', root, 'diff', '--shortstat', `${boundarySha}..HEAD`], {encoding: 'utf8'});
  if (diffRes.status !== 0) {
    return unmeasured(commits, boundarySha,
      `commits=${commits}, boundary=${boundarySha}, but git diff failed (exit ${diffRes.status}) — diff stats ` +
      `could NOT be measured. This is UNKNOWN, not zero. Verify with: git log --stat ${boundarySha}..HEAD`);
  }
  const {files_changed, insertions, deletions} = parseShortstat(diffRes.stdout);
  return {commits, files_changed, insertions, deletions, boundary_sha: boundarySha, warning: divergenceWarning};
}

function parseShortstat(text) {
  // " 3 files changed, 47 insertions(+), 12 deletions(-)" — any piece may be absent
  let files_changed = 0, insertions = 0, deletions = 0;
  const mFiles = text.match(/(\d+)\s+files?\s+changed/);
  const mIns = text.match(/(\d+)\s+insertions?\(\+\)/);
  const mDel = text.match(/(\d+)\s+deletions?\(-\)/);
  if (mFiles) files_changed = parseInt(mFiles[1], 10);
  if (mIns) insertions = parseInt(mIns[1], 10);
  if (mDel) deletions = parseInt(mDel[1], 10);
  return {files_changed, insertions, deletions};
}

function appendDecision({root, slug, dNumber, title}) {
  if (!slug) die('append-decision requires --slug <s>', 5);
  // Accept any digit string (e.g. "1" derived from "D001") and zero-pad to the
  // canonical 3-digit form. The old /^\d{3,}$/ rejected "1" with a misleading
  // "(digits only)" message — "1" IS digits — forcing callers to pre-pad.
  if (!/^\d+$/.test(dNumber || '')) die('append-decision requires --d-number <N> (digits only, e.g. 1 or 001)', 5);
  if (!title) die('append-decision requires --title <text>', 5);
  if (/[\n\r]/.test(title)) die('append-decision: --title must not contain newlines', 5);
  rejectIfMsysPathConverted(title, 'title');
  const padded = String(dNumber).padStart(3, '0');
  const {path, body} = readMemoryMd(root);
  const newLine = `- [[D${padded}]] ${title}`;
  const updated = appendUnderAnchor({body, anchor: DECISION_ANCHOR, newLine});
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}

function appendLesson({root, slug, date, title}) {
  if (!slug) die('append-lesson requires --slug <s>', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    die('append-lesson requires --date <YYYY-MM-DD>', 5);
  }
  if (!title) die('append-lesson requires --title <text>', 5);
  if (/[\n\r]/.test(title)) die('append-lesson: --title must not contain newlines', 5);
  rejectIfMsysPathConverted(title, 'title');
  const {path, body} = readMemoryMd(root);
  // D083 inline decision: the lesson TEXT goes straight in — no
  // "[[lessons-tactical#...]]" pointer (see the header comment above for why).
  const newLine = `- [${date}] ${title}`;
  const updated = appendUnderAnchor({body, anchor: LESSON_ANCHOR, newLine});
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}

function appendSummary({root, slug, date, summary}) {
  if (!slug) die('append-summary requires --slug <s>', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    die('append-summary requires --date <YYYY-MM-DD>', 5);
  }
  if (!summary) die('append-summary requires --summary <text>', 5);
  if (/[\n\r]/.test(summary)) die('append-summary: --summary must not contain newlines', 5);
  rejectIfMsysPathConverted(summary, 'summary');
  const {path, body} = readMemoryMd(root);
  const newLine = `- [${date}] ${summary}`;
  const updated = appendUnderAnchor({body, anchor: SUMMARY_ANCHOR, newLine});
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'next-d-number': {
      stdout.write(nextDNumber(opts.root) + '\n');
      break;
    }

    case 'git-stats': {
      if (!named.since) die('git-stats requires --since <iso>', 5);
      const stats = gitStats(opts.root, named.since);
      stdout.write(JSON.stringify(stats) + '\n');
      break;
    }

    case 'append-decision': {
      const r = appendDecision({
        root: opts.root,
        slug: named.slug,
        dNumber: named.d_number,
        title: named.title,
      });
      stdout.write(JSON.stringify({appended: true, ...r}) + '\n');
      break;
    }
    case 'append-lesson': {
      const r = appendLesson({
        root: opts.root,
        slug: named.slug,
        date: named.date,
        title: named.title,
      });
      stdout.write(JSON.stringify({appended: true, ...r}) + '\n');
      break;
    }
    case 'append-summary': {
      const r = appendSummary({
        root: opts.root,
        slug: named.slug,
        date: named.date,
        summary: named.summary,
      });
      stdout.write(JSON.stringify({appended: true, ...r}) + '\n');
      break;
    }

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}

// v4.4: invoke evidence-discipline ratchet at end-of-session hygiene.
// Fail-open: missing tool or any error is silently ignored.
// Suppress "No ratchet changes." to keep output clean.
try {
  const ratchetCwd = resolve(dirname(fileURLToPath(import.meta.url)));
  const fallback = join(ratchetCwd, 'prism-roster.mjs');
  const H = prismHome();
  const installed = join(H, '.claude', 'tools', 'prism-roster.mjs');
  const tool = existsSync(installed) ? installed : (existsSync(fallback) ? fallback : null);
  if (tool) {
    const r = spawnSync('node', [tool, '--apply-ratchet'], {encoding: 'utf-8', timeout: 10000});
    if (r.stdout && !/No ratchet changes/.test(r.stdout) && !/No verdict log/.test(r.stdout)) {
      stdout.write(`\nEvidence-discipline ratchet:\n${r.stdout}`);
    }
  }
} catch {}
