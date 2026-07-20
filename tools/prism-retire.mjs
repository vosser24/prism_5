#!/usr/bin/env node
// PRISM agent retire (v5.0 §6.C hardening).
//
// Archives one agent and removes its roster entry SAFELY. Replaces the old
// skill-prose path where the model hand-edited roster.json (no lock, no atomic
// write, no validation, no path-traversal guard). Mirrors
// prism-uninstall-cleanup.mjs: parse roster BEFORE touching disk, mutate the
// roster under withRosterLock with an atomic tmp+rename, and guard the
// (user-supplied) agent name against path traversal.
//
// The on-disk agent is MOVED to ~/.claude/agents-archive/<name>/ (reversible),
// never deleted. The user-confirmation prompt + CLAUDE.md count update remain
// in the /prism-retire slash command (UX / project-specific); this tool owns
// only the dangerous roster + filesystem mutation.
//
// Usage:
//   node tools/prism-retire.mjs <agent-name> [--dry-run] [--home <path>] [--project]
//   (a leading '@' on the name is accepted and stripped)
//
// --project (R3 F7 / UAT #43): retires a PROJECT-scoped agent instead of the
// global one. A project agent lives at <cwd>/.claude/agents/<name>.md with its
// own roster at <cwd>/.claude/agents/roster.json (archived to
// <cwd>/.claude/agents-archive/). This is opt-in ONLY — no auto-guessing
// between global and project scope, so the ambiguity is always surfaced to
// the caller explicitly. Without --project, behavior is byte-for-byte
// identical to before (global paths under HOME). All existing safety (name
// validation, parse-before-touch, withRosterLock atomic write, --dry-run)
// applies unchanged to the project paths — same code, just different dirs.
//
// Exit codes:
//   0  ok
//   1  unexpected error
//   2  invalid args / unsafe name / HOME unresolved
//   3  agent not found (absent from roster AND from disk). If found instead at
//      the project-scoped paths (and --project was not passed), the message
//      hints to re-run with --project.
//   13 roster.json missing or unparseable

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withRosterLock } from './lib/prism-roster-lock.mjs';

const args = process.argv.slice(2);
const opts = { name: null, dryRun: false, home: null, project: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--project') opts.project = true;
  else if (a === '--home') opts.home = args[++i];
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: prism-retire <agent-name> [--dry-run] [--home <path>] [--project]\n');
    process.exit(0);
  } else if (a.startsWith('-')) {
    process.stderr.write(`error: unknown arg "${a}"\n`);
    process.exit(2);
  } else if (opts.name === null) {
    opts.name = a;
  } else {
    process.stderr.write(`error: unexpected extra arg "${a}"\n`);
    process.exit(2);
  }
}

// Normalise + validate the name. A leading '@' is UX sugar (/prism-retire @foo).
let name = (opts.name || '').trim();
if (name.startsWith('@')) name = name.slice(1);
// Path-traversal guard: the name builds filesystem paths, so it must be a bare
// segment — no separators, no dot-only names. Rejects ../evil, .., a/b, a\b.
if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
  process.stderr.write(`error: invalid agent name "${opts.name}" (expected a bare name; got separators or empty)\n`);
  process.exit(2);
}

const HOME = opts.home || process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  process.stderr.write('error: HOME/USERPROFILE unset and no --home passed\n');
  process.exit(2);
}

const CWD = process.cwd();
const GLOBAL_ROSTER = join(HOME, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const GLOBAL_AGENTS_DIR = join(HOME, '.claude', 'agents');
const GLOBAL_ARCHIVE_DIR = join(HOME, '.claude', 'agents-archive');
// Project-scoped paths (R3 F7 / UAT #43): a project agent lives at
// <cwd>/.claude/agents/<name>.md with its own roster.json alongside it.
const PROJECT_ROSTER = join(CWD, '.claude', 'agents', 'roster.json');
const PROJECT_AGENTS_DIR = join(CWD, '.claude', 'agents');
const PROJECT_ARCHIVE_DIR = join(CWD, '.claude', 'agents-archive');

// --project selects the project-scoped triad; default (no flag) is IDENTICAL
// to pre-F7 behavior — no auto-guessing between scopes.
const ROSTER = opts.project ? PROJECT_ROSTER : GLOBAL_ROSTER;
const AGENTS_DIR = opts.project ? PROJECT_AGENTS_DIR : GLOBAL_AGENTS_DIR;
const ARCHIVE_DIR = opts.project ? PROJECT_ARCHIVE_DIR : GLOBAL_ARCHIVE_DIR;

async function main() {
  // 1. roster must exist + parse BEFORE we touch any file (fail-safe: a corrupt
  //    roster must never leave a half-archived agent behind).
  if (!existsSync(ROSTER)) {
    process.stderr.write(`error: roster.json not found at ${ROSTER}\n`);
    process.exit(13);
  }
  let roster;
  try {
    roster = JSON.parse(readFileSync(ROSTER, 'utf8'));
  } catch (e) {
    process.stderr.write(`error: cannot parse roster.json: ${e.message}\n`);
    process.exit(13);
  }

  const agents = (roster && roster.agents) || {};
  const inRoster = Object.prototype.hasOwnProperty.call(agents, name);
  const dir = join(AGENTS_DIR, name);
  const flat = join(AGENTS_DIR, name + '.md');
  const dirExists = existsSync(dir);
  const flatExists = existsSync(flat);

  if (!inRoster && !dirExists && !flatExists) {
    // R3 F7 / UAT #43: before giving up, check whether the name is actually a
    // PROJECT-scoped agent (only relevant when we were looking at the GLOBAL
    // paths — i.e. --project was not passed). No auto-guessing/auto-retry —
    // just surface the hint so the caller can explicitly re-run with --project.
    if (!opts.project) {
      let projectAgents = {};
      try {
        const projectRoster = JSON.parse(readFileSync(PROJECT_ROSTER, 'utf8'));
        projectAgents = (projectRoster && projectRoster.agents) || {};
      } catch {}
      const inProjectRoster = Object.prototype.hasOwnProperty.call(projectAgents, name);
      const projectDirExists = existsSync(join(PROJECT_AGENTS_DIR, name));
      const projectFlatExists = existsSync(join(PROJECT_AGENTS_DIR, name + '.md'));
      if (inProjectRoster || projectDirExists || projectFlatExists) {
        process.stderr.write(
          `error: agent "${name}" not found in the global roster, but found in the PROJECT roster at ${PROJECT_ROSTER} — re-run with --project\n`
        );
        process.exit(3);
      }
    }
    process.stderr.write(`error: agent "${name}" not found (absent from roster and from ${AGENTS_DIR})\n`);
    process.exit(3);
  }

  if (opts.dryRun) {
    const where = [inRoster && 'roster', dirExists && 'dir', flatExists && 'flat .md'].filter(Boolean).join(' + ');
    process.stdout.write(`Would archive @${name} (${where}) → ${join(ARCHIVE_DIR, name)} and remove its roster entry.\nNo changes made (--dry-run).\n`);
    process.exit(0);
  }

  // 2. Archive on-disk artifacts (MOVE, reversible). Never clobber a prior
  //    archive of the same name — suffix on collision.
  function archiveMove(src, destBase) {
    if (!existsSync(src)) return;
    try { mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch {}
    let dest = destBase;
    if (existsSync(dest)) dest = `${destBase}-${Date.now()}`;
    try { renameSync(src, dest); }
    catch (e) { process.stderr.write(`warn: could not archive ${src}: ${e.message}\n`); }
  }
  archiveMove(dir, join(ARCHIVE_DIR, name));
  archiveMove(flat, join(ARCHIVE_DIR, name + '.md'));

  // 3. Remove the roster entry under the lock with an atomic tmp+rename write.
  await withRosterLock(ROSTER, async () => {
    let locked;
    try {
      locked = JSON.parse(readFileSync(ROSTER, 'utf8'));
    } catch (e) {
      process.stderr.write(`error: cannot parse roster.json under lock: ${e.message}\n`);
      process.exit(13);
    }
    if (locked.agents && Object.prototype.hasOwnProperty.call(locked.agents, name)) {
      delete locked.agents[name];
    }
    const tmp = ROSTER + '.tmp';
    writeFileSync(tmp, JSON.stringify(locked, null, 2));
    renameSync(tmp, ROSTER);
  });

  process.stdout.write(
    `Archived @${name}. It won't be loaded or appear in the roster.\n` +
    `Restore with: mv ${join(ARCHIVE_DIR, name)} ${join(AGENTS_DIR, name)}\n`
  );
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`error: unexpected failure: ${e.message}\n`);
  process.exit(1);
});
