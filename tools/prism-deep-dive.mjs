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

import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';
import {spawnSync} from 'node:child_process';

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
  agent-diff --slug <s> [--orchestrator-protocol <inline|skill-ref>]
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

// ------------------------------ agent-write templates ------------------------------

// D004 §3: Phase E (completed) migrated the orchestrator body to a skill at
// ~/.claude/skills/master-orchestrator/SKILL.md. agent-write defaults to
// --orchestrator-protocol=skill-ref so generated master-<slug> agents pick up
// the skill automatically. The --orchestrator-protocol=inline mode remains
// available for environments where the skill isn't installed (e.g., dev
// branches before re-sync); it emits the 5-rule fallback body verbatim.

const ORCH_PROTOCOL_INLINE = `## Operating protocol (inlined fallback; skill-ref is now the default — see ~/.claude/skills/master-orchestrator/SKILL.md)

You are this project's **principal solution architect** — a top-class senior
generalist who OWNS the design, not a router. You form the architectural
position, then convene experts to stress-test and sharpen it. Five unbreakable rules:

1. NEVER execute high-stakes work without user approval.
2. ALWAYS present options with pros/cons when alternatives exist.
3. ALWAYS enforce mandatory checkpoints on high-stakes tasks.
4. ALWAYS chair adversarial review (≥2 substantive challenges) before synthesis on NOVEL-tier work.
5. ALWAYS run PHASE 1.5 senior review on FULL-NOVEL and HIGH-STAKES work before specialist output ships.

**Knowledge-growth loop (you are a LEARNING architect):** before designing,
RECALL — read \`MEMORY.md\`, the codebase index in \`.claude/references/\`, and
\`/prism-recall\` for prior decisions. After meaningful work, ARCHIVE — fold new
learnings into the RAG via \`/prism-archive\` and update \`MEMORY.md\`. Your model
of this codebase compounds every session.

**You are the SOLE DISPATCHER.** Subagent dispatch is main-loop-only (STEP 0
spike: a dispatched agent has no Agent tool). As the session-level agent you are
the only context that can dispatch — you dispatch the expert seats AND the
workers they spec. Experts own PLANNING (they return specs + reviews and can
author/evolve domain skills); you own DISPATCH. You evaluate every specialist's
output before commit, and produce handoffs via \`/prism-clean\` before \`/clear\`.
`;

const ORCH_PROTOCOL_SKILL_REF = `## Operating protocol

Load skill: master-orchestrator
`;

// Canonical project-master capability baseline — single source of truth so EVERY
// bootstrap/deep-dive produces an identical, complete toolset. The project-master
// runs in the MAIN LOOP (session agent) and talks to the user directly, so it
// needs the full interactive + orchestration surface, not just the file/dispatch
// tools a dispatched subagent gets:
//   • Agent  — sole-dispatcher panel/worker convening
//   • Skill  — invoke runtime skills (brainstorming, etc.); the master-orchestrator
//              skill itself is frontmatter-preloaded via `skills:` (v5.2.7)
//   • AskUserQuestion — clarifying questions / plan approval / panel decisions; the
//              /prism-deep-dive + /prism-clean command bodies call it directly (v5.2.8)
//   • TodoWrite — orchestration / plan task tracking (v5.2.8)
// Keep this list in sync with the test in tests/v3/state/test-prism-deep-dive.mjs.
const PROJECT_MASTER_TOOLS = 'Read, Write, Edit, Bash, Grep, Glob, Agent, Skill, AskUserQuestion, TodoWrite';

function renderMasterAgent({slug, protocol, created}) {
  const today = created || new Date().toISOString().slice(0, 10);
  const protocolBody = protocol === 'skill-ref' ? ORCH_PROTOCOL_SKILL_REF : ORCH_PROTOCOL_INLINE;
  return `---
name: master-${slug}
description: >
  Principal solution architect + sole dispatcher for ${slug}. Session-level
  identity (set via .claude/settings.json agent: master-${slug}) — the only
  context that can dispatch subagents (subagent dispatch is main-loop-only).
  Owns the architecture; grows a durable model of this codebase (recall →
  design → archive); assembles and directs a team of persistent expert agents;
  dispatches every expert and worker; produces handoffs via /prism-clean.
tools: ${PROJECT_MASTER_TOOLS}
model: opus
maxTurns: 80
memory: project
skills: [master-orchestrator]
created: ${today}
prism_phase: D
---

# master-${slug} — project-master agent

This agent is generated by \`/prism-deep-dive\` (v4.0 Phase D). Edit MEMORY.md
adjacent to this file for project profile and pointers; edit this body only
for project-specific operating-protocol deviations.

${protocolBody}

## Project profile

See \`.claude/agents/MEMORY.md\` (auto-injected at session start, ≤25 KB
per Claude Code subagent memory rules).

## Specialists hired for this project

See MEMORY.md "Active specialists" section. Hire new specialists via
\`@agent-factory\` (do NOT hire them in this body — the roster is the
single source of truth).
`;
}

function writeMasterAgent({root, slug, protocol, force}) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `master-${slug}.md`);
  if (existsSync(path) && !force) {
    die(`refusing: ${path} already exists. Pass --force to overwrite.`, 7);
  }
  // Preserve the on-disk created: date when --force overwriting an existing
  // file, so /prism-deep-dive --upgrade doesn't silently bump the field on
  // every apply. Mirrors the symmetry promise from commit 9cb56ed (agent-diff).
  let created;
  if (existsSync(path)) {
    const onDisk = readFileSync(path, 'utf8');
    const m = onDisk.match(/^created:\s*(.+)$/m);
    if (m) created = m[1].trim();
  }
  const body = renderMasterAgent({slug, protocol, created});
  // Atomic write: tempfile + rename, same directory for same-volume rename.
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
  return path;
}

function diffMasterAgent({root, slug, protocol}) {
  const agentPath = join(root, '.claude', 'agents', `master-${slug}.md`);
  if (!existsSync(agentPath)) {
    die(`refusing: agent file not found at ${agentPath}. ` +
        `Run /prism-deep-dive first (no --upgrade) to seed it.`, 6);
  }
  // Preserve the on-disk created: date so diff shows only protocol/content changes,
  // not calendar drift from comparing against today.
  const onDisk = readFileSync(agentPath, 'utf8');
  const createdMatch = onDisk.match(/^created:\s*(.+)$/m);
  const created = createdMatch ? createdMatch[1].trim() : undefined;
  // Render what we WOULD write, into a temp path, then diff against on-disk.
  const newBody = renderMasterAgent({slug, protocol, created});
  // Write to a sibling .tmp file so git diff --no-index can compare.
  const tmpPath = agentPath + '.diff-preview';
  writeFileSync(tmpPath, newBody, 'utf8');
  try {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', agentPath, tmpPath], {
      encoding: 'utf8',
    });
    if (r.error) {
      die(`git diff --no-index spawn failed: ${r.error.message}`, 9);
    }
    // git diff --no-index: exit 0 = no diff, exit 1 = diff present
    if (r.status === 0) {
      return {hasDiff: false, diff: ''};
    } else if (r.status === 1) {
      return {hasDiff: true, diff: r.stdout || ''};
    } else {
      die(`git diff --no-index failed (status ${r.status}): ${r.stderr || '(no stderr)'}`, 9);
    }
  } finally {
    try { rmSync(tmpPath, {force: true}); } catch {}
  }
}

// ------------------------------ memory-seed ------------------------------

const MEMORY_MD_HARD_CAP_BYTES = 25 * 1024;  // D004 §5: hard validator at 25 KB.

function loadProfile(profileArg) {
  // Heuristic: if it parses as JSON, it's inline; otherwise treat as file path.
  let parsed;
  try { parsed = JSON.parse(profileArg); }
  catch {
    if (!existsSync(profileArg)) die(`--profile is neither valid JSON nor an existing file: ${profileArg}`, 5);
    const body = readFileSync(profileArg, 'utf8');
    try { parsed = JSON.parse(body); }
    catch (e) { die(`--profile file contains invalid JSON: ${e.message}`, 5); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`--profile must be a JSON object, got: ${JSON.stringify(parsed)}`, 5);
  }
  return parsed;
}

function renderMemoryMd({slug, profile}) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push(`# MEMORY.md — master-${slug} router`);
  lines.push('');
  lines.push(`<!-- Auto-injected at subagent start (first 200 lines or 25 KB per`);
  lines.push(`     https://code.claude.com/docs/en/sub-agents § Enable persistent memory).`);
  lines.push(`     This file is a ROUTER. Knowledge lives in linked files, not here.`);
  lines.push(`     Seeded by /prism-deep-dive on ${today}. -->`);
  lines.push('');
  lines.push('## Project profile');
  lines.push('');
  lines.push(`- **Stack**: ${profile.stack || '(not set — fill in via /prism-deep-dive --refresh)'}`);
  lines.push(`- **Datasources**: ${(profile.datasources || []).join(', ') || '(none indexed)'}`);
  lines.push(`- **Active workstreams**:`);
  for (const w of (profile.active_workstreams || [])) lines.push(`  - ${w}`);
  if ((profile.active_workstreams || []).length === 0) lines.push(`  - (none captured yet)`);
  lines.push('');
  lines.push('## Recent decisions (last 10, pointer-only)');
  lines.push('');
  lines.push('<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->');
  lines.push('');
  lines.push('## Recent lessons (last 10, pointer-only)');
  lines.push('');
  lines.push('<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->');
  lines.push('');
  lines.push('## Session log');
  lines.push('');
  lines.push('<!-- /prism-clean appends session-summary lines here. -->');
  lines.push('');
  lines.push('## Active specialists');
  lines.push('');
  for (const s of (profile.specialists || [])) lines.push(`- @${s}`);
  if ((profile.specialists || []).length === 0) lines.push('- (none hired yet — call @agent-factory to add)');
  lines.push('');
  lines.push('## Available plugin tools');
  lines.push('');
  lines.push('<!-- /prism-validate-plugins refreshes this section. -->');
  lines.push('- (run /prism-validate-plugins to populate)');
  lines.push('');
  return lines.join('\n');
}

function writeMemoryMd({root, slug, profile}) {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = renderMemoryMd({slug, profile});
  if (Buffer.byteLength(body, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) {
    die(`generated MEMORY.md is ${Buffer.byteLength(body, 'utf8')} bytes (> 25 KB cap). ` +
        `Trim the profile (fewer workstreams/specialists) or split into satellite files.`, 8);
  }
  const path = join(dir, 'MEMORY.md');
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
  return path;
}

// ------------------------------ settings-write ------------------------------

function writeSettingsAgent({root, slug}) {
  const dir = join(root, '.claude');
  mkdirSync(dir, {recursive: true});
  const path = join(dir, 'settings.json');
  let settings = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    try { settings = JSON.parse(raw); }
    catch (e) { die(`refusing: existing settings.json is invalid JSON: ${e.message}`, 9); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      die('refusing: existing settings.json is not an object', 9);
    }
  }
  settings.agent = `master-${slug}`;
  const body = JSON.stringify(settings, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
  return path;
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
    case 'agent-write': {
      if (!named.slug) die('agent-write requires --slug <s>', 5);
      const protocol = named.protocol || 'skill-ref';
      if (!['inline', 'skill-ref'].includes(protocol)) {
        die(`--orchestrator-protocol must be inline or skill-ref, got ${protocol}`, 5);
      }
      const path = writeMasterAgent({
        root: opts.root,
        slug: named.slug,
        protocol,
        force: opts.force,
      });
      stdout.write(`wrote ${path}\n`);
      break;
    }
    case 'agent-diff': {
      if (!named.slug) die('agent-diff requires --slug <s>', 5);
      const protocol = named.protocol || 'skill-ref';
      if (!['inline', 'skill-ref'].includes(protocol)) {
        die(`--orchestrator-protocol must be inline or skill-ref, got ${protocol}`, 5);
      }
      const r = diffMasterAgent({root: opts.root, slug: named.slug, protocol});
      if (r.hasDiff) {
        stdout.write(r.diff);
        exit(1);
      }
      // No diff: exit 0, silent.
      break;
    }
    case 'memory-seed': {
      if (!named.slug) die('memory-seed requires --slug <s>', 5);
      if (!named.profile) die('memory-seed requires --profile <json-file-or-inline>', 5);
      const profile = loadProfile(named.profile);
      const path = writeMemoryMd({root: opts.root, slug: named.slug, profile});
      stdout.write(`wrote ${path}\n`);
      break;
    }
    case 'settings-write': {
      if (!named.slug) die('settings-write requires --slug <s>', 5);
      const path = writeSettingsAgent({root: opts.root, slug: named.slug});
      stdout.write(`wrote ${path}\n`);
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
