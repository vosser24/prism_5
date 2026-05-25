#!/usr/bin/env node
// prism-deep-dive — deterministic helper for /prism-deep-dive (v4.0 Phase D).
//
// The LLM-judged surface (discovery synthesis, ≤5 clarifying AskUserQuestion
// turns, deviation handling) lives in commands/prism-deep-dive.md. This
// helper owns the four purely-deterministic operations:
//
//   slug-derive    Derive project slug from CLAUDE.md / basename / state.
//   agent-write    Write <project>/.claude/agents/master-<slug>.md.
//   memory-seed    Write the seeded MEMORY.md router (≤25 KB hard cap).
//   settings-write Atomically merge `agent: master-<slug>` into settings.json.
//
// Locked design: docs/prism/adjudications/D004-v4-product-vision.md §1, §3, §5.
//
// All subcommands accept --root <path> (default cwd) and refuse to run
// without .git/ unless --no-git-guard.

import {existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {nowIso, readState, writeStateAtomic} from './lib/prism-state.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), noGitGuard: false, force: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--source') named.source = args[++i];
  else if (a === '--slug') named.slug = args[++i];
  else if (a === '--orchestrator-protocol') named.protocol = args[++i];
  else if (a === '--profile') named.profile = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-deep-dive <command> [args] [--root <path>] [--no-git-guard]

Commands:
  slug-derive [--source <auto|claude-md|basename|prompt|state>]
  agent-write --slug <s> [--orchestrator-protocol <inline|skill-ref>] [--force]
  memory-seed --slug <s> --profile <json-file-or-inline>
  settings-write --slug <s>
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
