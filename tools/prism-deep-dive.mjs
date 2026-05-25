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

const GENERIC_NAMES = new Set(['repo', 'code', 'project', 'app', 'temp', 'untitled', 'src', 'main']);
const CLAUDE_MD_NAME_RE = /^##\s+Project Identity\s*$[\s\S]*?^\s*name\s*:\s*(.+?)\s*$/m;

function kebabCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isGenericName(slug) {
  return GENERIC_NAMES.has(slug);
}

function deriveFromClaudeMd(root) {
  const path = join(root, 'CLAUDE.md');
  if (!existsSync(path)) return null;
  const body = readFileSync(path, 'utf8');
  const m = body.match(CLAUDE_MD_NAME_RE);
  if (!m) return null;
  const slug = kebabCase(m[1]);
  if (!slug) return null;
  return slug;
}

function deriveFromBasename(root) {
  return kebabCase(basename(root));
}

function deriveFromState(root) {
  const r = readState(root);
  if (r.status !== 'ok') return null;
  return r.state.project_slug || null;
}

function deriveSlug(root, source) {
  switch (source) {
    case 'claude-md': {
      const slug = deriveFromClaudeMd(root);
      if (!slug) die('no ## Project Identity / name: in CLAUDE.md', 6);
      return {slug, source: 'claude-md'};
    }
    case 'basename': {
      const slug = deriveFromBasename(root);
      if (!slug) die(`basename ${basename(root)} yields empty slug`, 6);
      if (isGenericName(slug)) {
        die(JSON.stringify({slug: null, source: 'basename', reason: `${slug} is generic; ask user`}), 6);
      }
      return {slug, source: 'basename'};
    }
    case 'state': {
      const r = readState(root);
      if (r.status === 'missing') die('no .prism-state.json (run /prism-bootstrap first)', 6);
      if (r.status !== 'ok') die(`state file error (${r.status}): ${(r.errors || []).join('; ')}`, 6);
      const slug = r.state.project_slug || null;
      if (!slug) die('project_slug not set in .prism-state.json (run /prism-deep-dive first)', 6);
      return {slug, source: 'state'};
    }
    case 'prompt': {
      // Helper does not prompt; caller (slash command) handles AskUserQuestion.
      die(JSON.stringify({slug: null, source: 'prompt', reason: 'helper cannot prompt; caller must AskUserQuestion'}), 6);
      return null;  // unreachable
    }
    case 'auto':
    default: {
      // Precedence: state → claude-md → basename → prompt
      const stateSlug = deriveFromState(root);
      if (stateSlug) return {slug: stateSlug, source: 'state'};
      const claudeSlug = deriveFromClaudeMd(root);
      if (claudeSlug) return {slug: claudeSlug, source: 'claude-md'};
      const baseSlug = deriveFromBasename(root);
      if (baseSlug && !isGenericName(baseSlug)) return {slug: baseSlug, source: 'basename'};
      die(JSON.stringify({slug: null, source: 'prompt', reason: `${baseSlug || basename(root)} is generic; ask user`}), 6);
      return null;  // unreachable
    }
  }
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'slug-derive': {
      const source = named.source || 'auto';
      const result = deriveSlug(opts.root, source);
      stdout.write(JSON.stringify({...result, reason: `derived via ${result.source}`}) + '\n');
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
