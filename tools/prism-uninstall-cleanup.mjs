#!/usr/bin/env node
// PRISM uninstall cleanup (v4.3 Phase B).
//
// Removes agents whose roster entries are tagged `installed_via: "plugin"`,
// along with their on-disk artifacts. Pre-`/plugin remove` hygiene.
//
// Entries without `installed_via` are treated as "manual" and NEVER touched.
// This is the safe-default backfill rule — no data loss for legacy rosters.
//
// Usage:
//   node tools/prism-uninstall-cleanup.mjs                    → list-only default
//   node tools/prism-uninstall-cleanup.mjs --dry-run          → list-only, no writes
//   node tools/prism-uninstall-cleanup.mjs --mode=remove-all  → batch remove
//   node tools/prism-uninstall-cleanup.mjs --mode=keep-all    → exit 0, no changes
//   node tools/prism-uninstall-cleanup.mjs --home <path>      → sandbox HOME (tests)
//
// Exit codes:
//   0  ok (including "nothing to clean up")
//   1  unexpected error
//   2  invalid args or HOME unresolved
//   13 roster.json missing or unparseable

import {existsSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import { withRosterLock } from './lib/prism-roster-lock.mjs';

const args = process.argv.slice(2);
const opts = {dryRun: false, mode: null, home: null};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--mode=remove-all') opts.mode = 'remove-all';
  else if (a === '--mode=keep-all') opts.mode = 'keep-all';
  else if (a === '--mode=select') opts.mode = 'select';
  else if (a === '--home') opts.home = args[++i];
  else if (a === '-h' || a === '--help') {
    process.stdout.write(
      `Usage: prism-uninstall-cleanup [--dry-run] [--mode={remove-all|keep-all|select}] [--home <path>]\n`
    );
    process.exit(0);
  } else {
    process.stderr.write(`error: unknown arg "${a}"\n`);
    process.exit(2);
  }
}

const HOME = opts.home || process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  process.stderr.write('error: HOME/USERPROFILE unset and no --home passed\n');
  process.exit(2);
}

const ROSTER = join(HOME, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const AGENTS_DIR = join(HOME, '.claude', 'agents');

async function main() {
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

  const allAgents = (roster && roster.agents) || {};
  const pluginAgents = Object.entries(allAgents).filter(
    ([_, entry]) => entry && entry.installed_via === 'plugin'
  );

  if (pluginAgents.length === 0) {
    process.stdout.write('Nothing to clean up — no plugin-created agents found.\n');
    process.exit(0);
  }

  if (opts.dryRun) {
    process.stdout.write(`PRISM-tagged agents (would remove ${pluginAgents.length}):\n`);
    for (const [name, entry] of pluginAgents) {
      const created = entry.created_date || entry.created || '?';
      process.stdout.write(`  - @${name}  (created ${created})\n`);
    }
    process.stdout.write('\nNo changes made (--dry-run).\n');
    process.exit(0);
  }

  // Determine selection.
  let toRemove;
  if (opts.mode === 'remove-all') {
    toRemove = pluginAgents;
  } else if (opts.mode === 'keep-all') {
    process.stdout.write('Kept all plugin-tagged agents (--mode=keep-all).\n');
    process.exit(0);
  } else if (opts.mode === 'select') {
    // Interactive per-agent prompt — slash-command UX path. The Node tool
    // itself does not implement an interactive selector; the slash command
    // body composes --dry-run + an explicit --mode=remove-all call.
    process.stderr.write('error: --mode=select is reserved for the slash-command UX; use --mode=remove-all or --mode=keep-all from the CLI.\n');
    process.exit(2);
  } else {
    // No mode passed → list and exit. Safe default; never destructive
    // when called bare (so accidental invocation can't wipe agents).
    process.stdout.write(`PRISM-tagged agents (${pluginAgents.length}):\n`);
    for (const [name, entry] of pluginAgents) {
      const created = entry.created_date || entry.created || '?';
      process.stdout.write(`  - @${name}  (created ${created})\n`);
    }
    process.stdout.write('\nRe-run with --mode=remove-all to remove all, or --mode=keep-all to keep all.\n');
    process.exit(0);
  }

  // Remove on-disk artifacts.
  for (const [name, _entry] of toRemove) {
    const dir = join(AGENTS_DIR, name);
    const flat = join(AGENTS_DIR, name + '.md');
    if (existsSync(dir)) {
      try { rmSync(dir, {recursive: true, force: true}); }
      catch (e) { process.stderr.write(`warn: could not remove ${dir}: ${e.message}\n`); }
    }
    if (existsSync(flat)) {
      try { unlinkSync(flat); }
      catch (e) { process.stderr.write(`warn: could not remove ${flat}: ${e.message}\n`); }
    }
  }

  // Atomic roster write inside lock: read-modify-write protected from cross-process races.
  await withRosterLock(ROSTER, async () => {
    // Re-read roster under the lock so we have the freshest state.
    let lockedRoster;
    try {
      lockedRoster = JSON.parse(readFileSync(ROSTER, 'utf8'));
    } catch (e) {
      process.stderr.write(`error: cannot parse roster.json under lock: ${e.message}\n`);
      process.exit(13);
    }
    for (const [name] of toRemove) {
      delete lockedRoster.agents[name];
    }
    // Atomic roster write: tmp + rename.
    const tmp = ROSTER + '.tmp';
    writeFileSync(tmp, JSON.stringify(lockedRoster, null, 2));
    renameSync(tmp, ROSTER);
  });

  process.stdout.write(`Removed ${toRemove.length} plugin-tagged agent${toRemove.length === 1 ? '' : 's'}.\n`);
  process.stdout.write('Run /plugin remove prism to finish uninstall.\n');
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`error: unexpected failure: ${e.message}\n`);
  process.exit(1);
});
