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
//   git-stats --since <iso> [--root <path>]
//       Run git log + git diff to summarise activity since <iso>.
//       Prints JSON: {commits, files_changed, insertions, deletions}.
//
//   append-decision --slug <s> --d-number <NNN> --title <text>
//       Append a "- [[D###]] <title>" line to the "Recent decisions" section
//       of <root>/.claude/agents/MEMORY.md. Trims to last 10 pointers.
//       Refuses on missing MEMORY.md (exit 6) or >25 KB cap (exit 8).
//
//   append-lesson --slug <s> --date <YYYY-MM-DD> --title <text>
//       Append a "- [[lessons-tactical#<date>]] <title>" line to the
//       "Recent lessons" section of <root>/.claude/agents/MEMORY.md.
//       Same trim + cap behavior as append-decision.
//
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §6
//
// All subcommands accept --root <path> and refuse to run without .git/
// unless --no-git-guard is passed.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

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
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-clean <command> [args] [--root <path>] [--no-git-guard]

Commands:
  next-d-number
  git-stats --since <iso>
  append-decision --slug <s> --d-number <NNN> --title <text>
  append-lesson --slug <s> --date <YYYY-MM-DD> --title <text>
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
const POINTER_KEEP = 10;

function readMemoryMd(root) {
  const path = join(root, '.claude', 'agents', 'MEMORY.md');
  if (!existsSync(path)) {
    die(`refusing: MEMORY.md not found at ${path}. Run /prism-deep-dive first to seed it.`, 6);
  }
  return {path, body: readFileSync(path, 'utf8')};
}

function writeMemoryMdAtomic(path, body) {
  if (Buffer.byteLength(body, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) {
    die(`refusing: MEMORY.md would be ${Buffer.byteLength(body, 'utf8')} bytes (> 25 KB cap). ` +
        `Run /prism-deep-dive --upgrade <slug> to re-synthesize the router.`, 8);
  }
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

function appendUnderAnchor({body, anchor, newLine, pointerRe}) {
  const lines = body.split('\n');
  const anchorIdx = lines.findIndex((l) => l.trim() === anchor.trim());
  if (anchorIdx < 0) {
    die(`refusing: MEMORY.md is missing the expected anchor comment:\n  ${anchor}\n` +
        `The file may have been hand-edited. Re-seed with /prism-deep-dive --upgrade.`, 7);
  }
  // Find the end of the section: the next "## " heading after the anchor.
  let endIdx = lines.length;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { endIdx = i; break; }
  }
  // Collect existing pointer lines within the section, append the new one, trim.
  const sectionBody = lines.slice(anchorIdx + 1, endIdx);
  const nonPointer = []; // blank lines and any other content directly under anchor
  const pointers = [];
  for (const l of sectionBody) {
    if (pointerRe.test(l)) pointers.push(l);
    else if (pointers.length === 0) nonPointer.push(l); // preserve leading blanks
    // Any non-pointer line AFTER pointers begin is dropped (trailing whitespace etc).
  }
  pointers.push(newLine);
  const kept = pointers.slice(-POINTER_KEEP);
  // Ensure exactly one blank line of trailing separation before the next "## "
  const rebuilt = [...nonPointer, ...kept, ''];
  const newLines = [
    ...lines.slice(0, anchorIdx + 1),
    ...rebuilt,
    ...lines.slice(endIdx),
  ];
  return newLines.join('\n');
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

function gitStats(root, sinceIso) {
  // commits since the cutoff
  const logRes = spawnSync('git', ['-C', root, 'log', `--since=${sinceIso}`, '--oneline'], {encoding: 'utf8'});
  const commits = logRes.status === 0 && logRes.stdout
    ? logRes.stdout.trim().split('\n').filter(Boolean).length
    : 0;

  // diff stats against the commit at-or-before the cutoff
  let files_changed = 0, insertions = 0, deletions = 0;
  if (commits > 0) {
    // Try rev-list --before to find the boundary commit
    const revRes = spawnSync('git', ['-C', root, 'rev-list', '-n', '1', `--before=${sinceIso}`, 'HEAD'], {encoding: 'utf8'});
    const boundarySha = revRes.status === 0 ? revRes.stdout.trim() : '';
    if (boundarySha) {
      const diffRes = spawnSync('git', ['-C', root, 'diff', '--shortstat', `${boundarySha}..HEAD`], {encoding: 'utf8'});
      if (diffRes.status === 0) {
        ({files_changed, insertions, deletions} = parseShortstat(diffRes.stdout));
      }
    }
    // If no boundary commit (cutoff is before repo's first commit), all commits are "since"
    // but `git diff` against an empty tree isn't meaningful here — leave at zeros.
    // The commit count is the load-bearing signal for the classifier.
  }

  return {commits, files_changed, insertions, deletions};
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
  if (!/^\d{3,}$/.test(dNumber || '')) die('append-decision requires --d-number <NNN> (digits only)', 5);
  if (!title) die('append-decision requires --title <text>', 5);
  const {path, body} = readMemoryMd(root);
  const newLine = `- [[D${dNumber}]] ${title}`;
  const updated = appendUnderAnchor({
    body,
    anchor: DECISION_ANCHOR,
    newLine,
    pointerRe: /^- \[\[D\d{3,}\]\]/,
  });
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}

function appendLesson({root, slug, date, title}) {
  if (!slug) die('append-lesson requires --slug <s>', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    die('append-lesson requires --date <YYYY-MM-DD>', 5);
  }
  if (!title) die('append-lesson requires --title <text>', 5);
  const {path, body} = readMemoryMd(root);
  const newLine = `- [[lessons-tactical#${date}]] ${title}`;
  const updated = appendUnderAnchor({
    body,
    anchor: LESSON_ANCHOR,
    newLine,
    pointerRe: /^- \[\[lessons-tactical#\d{4}-\d{2}-\d{2}\]\]/,
  });
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

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
