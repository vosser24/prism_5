#!/usr/bin/env node
// prism-sync — deterministic maintenance helper for /prism-sync (v3.11.0 Phase A.1).
//
// Conservative drift only in v3.11.0: every sync re-runs discovery/roster/health.
// --smart-drift is a stub that prints an EXPERIMENTAL warning and falls back to conservative.
//
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §5
//
// Subcommands:
//   prism-sync plan [--smart-drift]
//   prism-sync complete [--meta '<json>']
//
// All subcommands accept --root <path> and refuse to run without .git/ unless --no-git-guard.

import {existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {
  isPhaseCompleted,
  markPhaseCompleted,
  nowIso,
  readState,
  setSyncStamps,
  writeStateAtomic,
} from './lib/prism-state.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), smartDrift: false, noGitGuard: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--smart-drift') opts.smartDrift = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-sync <command> [args] [--root <path>] [--no-git-guard]

Commands:
  plan [--smart-drift]
  complete [--meta '<json>']
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

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
