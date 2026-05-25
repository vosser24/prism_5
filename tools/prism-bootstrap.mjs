#!/usr/bin/env node
// prism-bootstrap — deterministic phase-machine helper for /prism-bootstrap
// (the v3.10.0 unified bootstrap orchestrator).
//
// The slash command (commands/prism-bootstrap.md) drives the LLM-judged
// phases (identity audit, discover, roster reconcile, CLAUDE.md rewrite,
// health). This helper handles the deterministic ones (structure,
// conventions) plus state-file bookkeeping (plan, start-phase,
// complete-phase, fail-phase) so phase semantics are tested instead of
// reimplemented in prose every time.
//
// Locked design: docs/prism/adjudications/D001-bootstrap-unification.md,
//                docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md.
//
// Subcommands:
//
//   prism-bootstrap plan [--force] [--skip-discover]
//       Read state, print which phases need running. Exit 0 when there's
//       a non-empty plan, 0 + "all phases complete" when none.
//
//   prism-bootstrap status
//       Pretty-print current phase status table. Exit 0.
//
//   prism-bootstrap phase-structure [--dry-run]
//       Phase 3: create the .claude/{references,rules,agents,hooks}/,
//       docs/prism/{adjudications,deviations,smoke}/, tasks/ tree.
//       Idempotent. Marks phase=structure complete on success.
//
//   prism-bootstrap phase-conventions [--dry-run]
//       Phase 4: write .claude/rules/capture-conventions.md if absent.
//       Marks phase=conventions complete on success. (Conventions live
//       under the structure phase's metadata since the locked schema has
//       only five phases — see notes below.)
//
//   prism-bootstrap start-phase <name>
//       Set last_command="<name>" in state for crash-resume tracking.
//
//   prism-bootstrap complete-phase <name> [--meta '<json>']
//       Mark phase complete; clears last_command if it matches.
//
//   prism-bootstrap fail-phase <name> "<error message>"
//       Append to phase_failures (capped at 10).
//
//   prism-bootstrap init-state-if-missing <project-name>
//       If no state file, either synthesize from filesystem (v3.8.9
//       detect-and-adopt) or createInitialState. Idempotent: never
//       overwrites a valid existing state.
//
// All subcommands accept --root <path> (default cwd) and refuse to run
// in a directory without .git/ unless --no-git-guard is passed.
//
// Schema note: D001/D002 lock five phases — identity, structure,
// discovery, roster, health. The "conventions" step from D001's table
// (phase 4) is part of the structure phase: this helper records it
// under phases.structure.conventions_written = true.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {
  PHASES,
  createInitialState,
  getStatePath,
  isPhaseCompleted,
  markPhaseCompleted,
  markPhaseFailed,
  markPhaseStarted,
  readState,
  setLastCommand,
  synthesizeFromFilesystem,
  writeStateAtomic,
} from './lib/prism-state.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {
  root: process.cwd(),
  dryRun: false,
  force: false,
  skipDiscover: false,
  withDeepDive: false,
  noGitGuard: false,
};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--skip-discover') opts.skipDiscover = true;
  else if (a === '--with-deep-dive') opts.withDeepDive = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-bootstrap <command> [args] [--root <path>] [--dry-run] [--force] [--skip-discover] [--with-deep-dive] [--no-git-guard]

Commands:
  plan
  status
  phase-structure
  phase-conventions
  phase-plugin-validate
  phase-project-master
  start-phase <name>
  complete-phase <name> [--meta '<json>']
  fail-phase <name> "<error>"
  init-state-if-missing <project-name>

Phases (v2 schema): ${PHASES.join(' | ')}
project-master is opt-in: planner skips it unless --with-deep-dive is set.
`);
  exit(code);
}

// ------------------------------ guards ------------------------------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

// ------------------------------ phase plan ------------------------------

// Returns the ordered list of phases that still need to run for the given
// state. Honours --skip-discover and --force.
function planPhases(state) {
  const plan = [];
  for (const p of PHASES) {
    if (p === 'discovery' && opts.skipDiscover) continue;
    // D004 §3 + §4: project-master is opt-in. Default plan skips it; users
    // who want the deep-dive flow re-run with --with-deep-dive.
    if (p === 'project-master' && !opts.withDeepDive) continue;
    if (opts.force) {
      plan.push(p);
    } else if (!isPhaseCompleted(state, p)) {
      plan.push(p);
    }
  }
  return plan;
}

function summarizePhases(state) {
  return PHASES.map(p => {
    const ph = state.phases[p] || {};
    return {
      phase: p,
      completed_at: ph.completed_at || null,
      synthesized: !!ph.synthesized,
      meta: Object.fromEntries(Object.entries(ph).filter(([k]) => k !== 'completed_at')),
    };
  });
}

// ------------------------------ structure phase ------------------------------

// Full project scaffold. Scope locked by D003-bootstrap-scaffold-scope.md
// (supersedes the narrower D001 structure-phase table). The goal is that one
// /prism-bootstrap run produces every directory and seed file a PRISM project
// needs to track its own progress — no second command, no manual fill-in.

const STRUCTURE_DIRS = [
  // PRISM working knowledge
  '.claude/references',
  '.claude/rules',
  // Claude Code project-local conventions
  '.claude/agents',
  '.claude/hooks',
  '.claude/skills',
  '.claude/commands',
  // PRISM institutional memory
  'docs/prism/adjudications',
  'docs/prism/deviations',
  'docs/prism/lessons',
  'docs/prism/smoke',
  // Active work tracking
  'tasks',
];

const TASKS_TODO_BODY = `# Active work

Current tasks for this project. PRISM reads this at session start.

## In progress

## Up next

## Done
`;

const LESSONS_TACTICAL_BODY = `# Tactical lessons

Code-level patterns, gotchas, and fixes worth remembering across tasks.
Append entries as \`YYYY-MM-DD — <lesson>\`. \`/prism-clean\` promotes
durable findings here.
`;

const LESSONS_STRATEGIC_BODY = `# Strategic lessons

Architecture decisions and cross-cutting trade-off rationale.
Locked panel decisions belong in \`docs/prism/adjudications/\` instead —
this file is for lighter-weight strategic notes.
`;

const MCP_JSON_BODY = `{
  "mcpServers": {}
}
`;

const CLAUDE_LOCAL_BODY = `# Personal project notes

Git-ignored. Personal overrides and scratch notes for this project — not
shared with the team. See \`CLAUDE.md\` for the shared project memory.
`;

// Seed files: written only when absent. { relPath: body }
const STRUCTURE_FILES = {
  'tasks/todo.md': TASKS_TODO_BODY,
  'tasks/lessons-tactical.md': LESSONS_TACTICAL_BODY,
  'tasks/lessons-strategic.md': LESSONS_STRATEGIC_BODY,
  '.mcp.json': MCP_JSON_BODY,
  'CLAUDE.local.md': CLAUDE_LOCAL_BODY,
};

const GITIGNORE_BLOCK = `# --- PRISM ---
CLAUDE.local.md
.claude/settings.local.json
.claude/.prism-state.json
.claude/.prism-telemetry-rollup.json
.claude/tools-scan.json
# --- end PRISM ---
`;

const GITIGNORE_MARKER = '# --- PRISM ---';

// Idempotently ensure the project .gitignore carries the PRISM block.
// - no file        → create with the block
// - file w/o block → append the block
// - file w/ block  → no-op
function ensureGitignore() {
  const abs = join(opts.root, '.gitignore');
  if (!existsSync(abs)) {
    if (!opts.dryRun) writeFileSync(abs, GITIGNORE_BLOCK);
    return 'created';
  }
  const body = readFileSync(abs, 'utf8');
  if (body.includes(GITIGNORE_MARKER)) return 'present';
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  if (!opts.dryRun) writeFileSync(abs, body + sep + GITIGNORE_BLOCK);
  return 'merged';
}

function ensureStructure() {
  const dirsCreated = [];
  const dirsExisted = [];
  for (const rel of STRUCTURE_DIRS) {
    const abs = join(opts.root, rel);
    if (existsSync(abs)) {
      dirsExisted.push(rel);
    } else {
      if (!opts.dryRun) mkdirSync(abs, {recursive: true});
      dirsCreated.push(rel);
    }
  }
  const filesCreated = [];
  const filesExisted = [];
  for (const [rel, body] of Object.entries(STRUCTURE_FILES)) {
    const abs = join(opts.root, rel);
    if (existsSync(abs)) {
      filesExisted.push(rel);
    } else {
      if (!opts.dryRun) {
        mkdirSync(dirname(abs), {recursive: true});
        writeFileSync(abs, body);
      }
      filesCreated.push(rel);
    }
  }
  const gitignore = ensureGitignore();
  return {dirsCreated, dirsExisted, filesCreated, filesExisted, gitignore};
}

// ------------------------------ conventions phase ------------------------------

const CAPTURE_CONVENTIONS_PATH = '.claude/rules/capture-conventions.md';

const CAPTURE_CONVENTIONS_BODY = `# Capture conventions

When the session produces durable knowledge, write it under \`docs/prism/\`
in the right bucket. PRISM \`/prism-clean\` and the v3.10.0 archival path
expect this layout.

## Buckets

| Folder | What goes there | Example filename |
|--------|-----------------|------------------|
| \`adjudications/\` | Locked panel decisions, architecture call-outs | \`D003-postgres-vs-sqlite.md\` |
| \`deviations/\` | Agent/sub-agent reports of cases the rule did not fit | \`2026-05-06-agent-X-deviation.md\` |
| \`lessons/\` | Cross-task tactical lessons (created by \`/prism-clean\`) | \`2026-05-06-session-lessons.md\` |
| \`smoke/\` | Reusable smoke procedures, runbooks | \`smoke-postgres-restart.md\` |

## File-naming rules

- Adjudications: \`D###-<short-slug>.md\`, sequential, never re-used.
- Deviations: \`YYYY-MM-DD-<agent-name>-deviation.md\`.
- Lessons: \`YYYY-MM-DD-session.md\` (one per /prism-clean run).
- Smoke: \`smoke-<topic>.md\`.

## Required headers

Every captured file starts with:

\`\`\`markdown
# <one-line title>

**Status:** Locked | Proposed | Draft
**Date:** YYYY-MM-DD
**Captured by:** <session id or "manual">
**Related:** (optional links to other adjudications)
\`\`\`

## Locking

A file with \`Status: Locked\` is referenced in \`CLAUDE.md\` and may not be
edited in place. Subsequent design changes create a new file referencing
the locked one.
`;

function ensureCaptureConventions() {
  const abs = join(opts.root, CAPTURE_CONVENTIONS_PATH);
  if (existsSync(abs)) return {wrote: false, path: CAPTURE_CONVENTIONS_PATH};
  if (!opts.dryRun) {
    mkdirSync(join(opts.root, '.claude/rules'), {recursive: true});
    writeFileSync(abs, CAPTURE_CONVENTIONS_BODY);
  }
  return {wrote: true, path: CAPTURE_CONVENTIONS_PATH};
}

// ------------------------------ helpers ------------------------------

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

function loadStateOrDie() {
  const r = readState(opts.root);
  if (r.status === 'missing') {
    die('no state file. Run: prism-bootstrap init-state-if-missing <project-name>', 3);
  }
  if (r.status !== 'ok') {
    die(`state ${r.status}: ${r.errors.join('; ')}\nFix or rebuild before continuing.`, 4);
  }
  return r.state;
}

function ensurePhaseName(name) {
  if (!PHASES.includes(name)) {
    die(`unknown phase: ${name} (valid: ${PHASES.join(', ')})`, 5);
  }
}

function persistOrPrint(next, label) {
  if (opts.dryRun) {
    stdout.write(`DRY-RUN: would write state (${label})\n`);
    return;
  }
  writeStateAtomic(opts.root, next);
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'plan': {
      const state = loadStateOrDie();
      const plan = planPhases(state);
      stdout.write(JSON.stringify({
        project: state.project_name,
        force: opts.force,
        skip_discover: opts.skipDiscover,
        with_deep_dive: opts.withDeepDive,
        pending: plan,
        completed: PHASES.filter(p => isPhaseCompleted(state, p)),
        last_command: state.last_command,
        phase_failures: state.phase_failures,
      }, null, 2) + '\n');
      break;
    }

    case 'status': {
      const state = loadStateOrDie();
      const rows = summarizePhases(state);
      stdout.write(`project: ${state.project_name}\n`);
      stdout.write(`prism_version: ${state.prism_version} (schema v${state.schema_version})\n`);
      stdout.write(`initialized_at: ${state.initialized_at}\n`);
      stdout.write(`last_run: ${state.last_run}\n`);
      stdout.write(`last_sync_at: ${state.last_sync_at || '(never)'}\n\n`);
      stdout.write(`phase        | completed_at                 | notes\n`);
      stdout.write(`-------------|------------------------------|------\n`);
      for (const r of rows) {
        const ts = r.completed_at || '(pending)';
        const notes = [];
        if (r.synthesized) notes.push('synthesized');
        for (const [k, v] of Object.entries(r.meta)) {
          if (k === 'synthesized') continue;
          notes.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
        stdout.write(`${r.phase.padEnd(13)}| ${String(ts).padEnd(29)}| ${notes.join(', ')}\n`);
      }
      if (state.phase_failures.length) {
        stdout.write(`\nrecent failures:\n`);
        for (const f of state.phase_failures.slice(-5)) {
          stdout.write(`  - ${f.at} [${f.phase}] ${f.error}\n`);
        }
      }
      break;
    }

    case 'init-state-if-missing': {
      const name = positional[0];
      if (!name) die('init-state-if-missing requires <project-name>');
      const r = readState(opts.root);
      if (r.status === 'ok') {
        stdout.write(`state already initialized: ${getStatePath(opts.root)}\n`);
        break;
      }
      // Decide: synthesize or fresh?
      // If .claude/ already populated, prefer detect-and-adopt.
      const claudeDir = join(opts.root, '.claude');
      const hasClaudeContent = existsSync(claudeDir) && existsSync(join(opts.root, 'CLAUDE.md'));
      const seed = hasClaudeContent
        ? synthesizeFromFilesystem(opts.root, {projectName: name})
        : createInitialState(name);
      persistOrPrint(seed, 'init-state');
      const adopted = PHASES.filter(p => isPhaseCompleted(seed, p));
      stdout.write(`initialized state for "${name}".\n`);
      stdout.write(`mode: ${hasClaudeContent ? 'detect-and-adopt' : 'fresh'}\n`);
      if (adopted.length) stdout.write(`phases adopted from filesystem: ${adopted.join(', ')}\n`);
      break;
    }

    case 'phase-structure': {
      const state = loadStateOrDie();
      const r = ensureStructure();
      stdout.write(
        `structure phase: dirs created=${r.dirsCreated.length} existed=${r.dirsExisted.length}; ` +
        `files created=${r.filesCreated.length} existed=${r.filesExisted.length}; ` +
        `.gitignore ${r.gitignore}\n`
      );
      for (const d of r.dirsCreated) stdout.write(`  + ${d}/\n`);
      for (const f of r.filesCreated) stdout.write(`  + ${f}\n`);
      // Capture-conventions is part of structure phase metadata; do NOT
      // run it here unless caller invokes phase-conventions explicitly.
      const next = markPhaseCompleted(state, 'structure', {
        dirs_created: r.dirsCreated.length,
        dirs_existed: r.dirsExisted.length,
        files_created: r.filesCreated.length,
        files_existed: r.filesExisted.length,
        gitignore: r.gitignore,
      });
      persistOrPrint(next, 'phase-structure complete');
      break;
    }

    case 'phase-conventions': {
      const state = loadStateOrDie();
      const r = ensureCaptureConventions();
      stdout.write(`conventions phase: ${r.wrote ? 'wrote' : 'already present'} ${r.path}\n`);
      // Record under structure phase metadata (no separate phase in schema).
      const existing = state.phases.structure || {completed_at: null};
      const next = markPhaseCompleted(state, 'structure', {
        ...existing,
        conventions_written: true,
      });
      persistOrPrint(next, 'phase-conventions complete');
      break;
    }

    case 'phase-plugin-validate': {
      // v3.11.0 Phase B stub. The full implementation is Phase C
      // (/prism-validate-plugins) per D004 — this stub just registers a
      // sentinel so the 7-phase planner can advance past plugin-validate
      // when /prism-bootstrap runs idempotently. The slash command will
      // eventually wire `claude plugin list --json` here.
      const state = loadStateOrDie();
      const next = markPhaseCompleted(state, 'plugin-validate', {
        stub: true,
        note: 'Phase C will populate plugin reachability + version drift checks.',
      });
      persistOrPrint(next, 'phase-plugin-validate complete (stub)');
      stdout.write(`plugin-validate phase: stub (Phase C wires the real validator)\n`);
      break;
    }

    case 'phase-project-master': {
      // v3.11.0 Phase B stub. Opt-in only — refuse unless --with-deep-dive is
      // set, matching the planner. Phase D of D004 will replace this stub
      // with /prism-deep-dive + agent-factory --master-<slug> generation.
      if (!opts.withDeepDive) {
        die('phase-project-master is opt-in. Pass --with-deep-dive to run.', 6);
      }
      const state = loadStateOrDie();
      const next = markPhaseCompleted(state, 'project-master', {
        stub: true,
        note: 'Phase D will generate <project>/.claude/agents/master-<slug>.md.',
      });
      persistOrPrint(next, 'phase-project-master complete (stub)');
      stdout.write(`project-master phase: stub (Phase D wires agent-factory deep-dive)\n`);
      break;
    }

    case 'start-phase': {
      const name = positional[0];
      if (!name) die('start-phase requires <name>');
      ensurePhaseName(name);
      const state = loadStateOrDie();
      // v2 sentinel: mark the phase as in-progress AND set last_command for
      // crash-resume. Both writes happen in one atomic state update.
      const withSentinel = markPhaseStarted(state, name);
      const next = setLastCommand(withSentinel, `bootstrap:${name}`);
      persistOrPrint(next, `start-phase ${name}`);
      stdout.write(`last_command set to bootstrap:${name}\n`);
      break;
    }

    case 'complete-phase': {
      const name = positional[0];
      if (!name) die('complete-phase requires <name>');
      ensurePhaseName(name);
      const state = loadStateOrDie();
      let meta = {};
      if (named.meta) {
        try { meta = JSON.parse(named.meta); } catch (e) { die(`--meta is not valid JSON: ${e.message}`); }
      }
      const next = markPhaseCompleted(state, name, meta);
      persistOrPrint(next, `complete-phase ${name}`);
      stdout.write(`phase ${name} completed\n`);
      break;
    }

    case 'fail-phase': {
      const name = positional[0];
      if (!name) die('fail-phase requires <name>');
      ensurePhaseName(name);
      const errMsg = positional.slice(1).join(' ') || 'unspecified error';
      const state = loadStateOrDie();
      const next = markPhaseFailed(state, name, errMsg);
      persistOrPrint(next, `fail-phase ${name}`);
      stdout.write(`recorded failure for phase ${name}: ${errMsg}\n`);
      break;
    }

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
