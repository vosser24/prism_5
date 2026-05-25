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
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §6
//
// All subcommands accept --root <path> and refuse to run without .git/
// unless --no-git-guard is passed.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
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

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
