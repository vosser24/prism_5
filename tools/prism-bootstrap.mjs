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
//       Phase 2: create the .claude/{references,rules,agents,hooks}/,
//       docs/prism/{adjudications,deviations,smoke}/, tasks/ tree.
//       Idempotent. Marks phase=structure complete on success.
//
//   prism-bootstrap phase-conventions [--dry-run]
//       Sub-step of Phase 2 (structure): write .claude/rules/capture-conventions.md
//       if absent. Conventions live under the structure phase's metadata
//       rather than as their own phase — the locked 7-phase schema treats
//       capture-conventions as part of scaffold creation (see notes below).
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
// Schema note: D004 §B locks seven phases — identity, structure,
// plugin-validate, discovery, roster, project-master, health. (D001/D002
// originally locked five; the schema v1→v2 migration in Phase B added
// plugin-validate and project-master.) The "conventions" step from
// D001's original table is part of the structure phase: this helper
// records it under phases.structure.conventions_written = true.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {argv, env, exit, stderr, stdout} from 'node:process';
import {fileURLToPath} from 'node:url';

import {renameWithRetry} from './lib/atomic-fs.mjs';
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
  setProjectSlug,
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
  noMaster: false,
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
  else if (a === '--with-deep-dive') opts.withDeepDive = true;  // v5.1: accepted no-op (project-master is now default-on)
  else if (a === '--no-master') opts.noMaster = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--no-telemetry') opts.noTelemetry = true;
  else if (a === '--python') opts.python = true;
  else if (a === '--no-python') opts.python = false;
  else if (a === '--no-create') opts.noCreate = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '--home') named.home = args[++i];
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
  detect-statusline [--home <path>]
  install-statusline [--home <path>] [--dry-run] [--force]
  detect-telemetry-consent [--home <path>]
  set-telemetry-consent <on|off> [--home <path>]

Phases (v2 schema): ${PHASES.join(' | ')}
project-master is DEFAULT-ON (v5.1): bootstrap auto-creates master-<slug> as the
session agent (the prerequisite for real dispatched panels). Pass --no-master to
opt out. --with-deep-dive is an accepted no-op.
Statusline + telemetry-consent commands bypass the .git/ guard (they
operate on $HOME/.claude/, not a project root). The --no-telemetry flag
flips set-telemetry-consent's default during the bootstrap health phase.
`);
  exit(code);
}

// ------------------------------ guards ------------------------------

// statusline commands touch $HOME/.claude/settings.json, not a project root,
// so they bypass the git guard. All other commands require .git/ unless
// --no-git-guard is set.
const STATUSLINE_COMMANDS = new Set(['detect-statusline', 'install-statusline']);
const TELEMETRY_CONSENT_COMMANDS = new Set(['detect-telemetry-consent', 'set-telemetry-consent']);
const HOME_ONLY_COMMANDS = new Set([...STATUSLINE_COMMANDS, ...TELEMETRY_CONSENT_COMMANDS]);
if (!opts.noGitGuard && !HOME_ONLY_COMMANDS.has(cmd) && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

// ------------------------------ phase plan ------------------------------

// Returns the ordered list of phases that still need to run for the given
// state. Honours --skip-discover and --force.
function planPhases(state) {
  const plan = [];
  for (const p of PHASES) {
    if (p === 'discovery' && opts.skipDiscover) continue;
    // v5.1: project-master is DEFAULT-ON (prerequisite for real dispatched
    // panels — STEP 0). --no-master opts out. (--with-deep-dive kept as an
    // accepted no-op for back-compat.)
    if (p === 'project-master' && opts.noMaster) continue;
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
.claude/.prism-turn-state.json
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

## Verify ground truth before you capture "it works"

Deployed ≠ wired ≠ works. A green component/unit suite does NOT prove the
component is wired into its dispatcher or that the end-to-end path works —
add an integration assertion for each critical path. Before capturing a lesson
or adjudication that claims something "works", confirm ground truth: the files
changed (\`git status --porcelain\`), the claimed paths exist, and the relevant
tests pass. Never trust a subagent's usage counter as a work/completion signal —
a delegating worker reports \`tool_uses=1\` while the real work lives in its
child's separate transcript. Measure artifacts, not counters or relayed prose.
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

// ------------------------------ statusline helpers ------------------------------
// Statusline install is a GLOBAL config change (writes to ~/.claude/settings.json),
// not a project-local one. See scripts/install-statusline-only.sh for the canonical
// pattern this matches — same JSON shape, same atomic-write discipline.

function resolveStatuslineHome() {
  // --home override exists primarily for tests (sandbox to a temp dir).
  // Production: $HOME (Unix) or $USERPROFILE (Windows Git-Bash).
  if (named.home) return resolve(named.home);
  const home = env.HOME || env.USERPROFILE;
  if (!home) die('cannot determine home directory (HOME and USERPROFILE both unset)', 9);
  return home;
}

function detectStatusline(home) {
  const settingsPath = join(home, '.claude', 'settings.json');
  const sourceScript = join(home, '.claude', 'statusline-command.sh');
  const result = {
    settings_path: settingsPath,
    settings_exists: existsSync(settingsPath),
    settings_parse_error: null,
    installed: false,
    source_script_path: sourceScript,
    source_script_exists: existsSync(sourceScript),
  };
  if (result.settings_exists) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      result.installed =
        settings && typeof settings === 'object' && !Array.isArray(settings) &&
        Object.prototype.hasOwnProperty.call(settings, 'statusLine');
    } catch (e) {
      result.settings_parse_error = e.message;
    }
  }
  return result;
}

function installStatusline({home, dryRun, force}) {
  const detect = detectStatusline(home);
  if (detect.settings_parse_error) {
    die(`refusing: ${detect.settings_path} is not valid JSON (${detect.settings_parse_error}). Fix it or remove it before installing the statusline.`, 9);
  }
  if (detect.installed && !force) {
    die(`statusLine key already present in ${detect.settings_path}. Pass --force to overwrite (the existing value will be replaced).`, 11);
  }
  if (!detect.source_script_exists) {
    die(`refusing: ${detect.source_script_path} not found. Either do a full PRISM install (so the statusline script is copied) or run scripts/install-statusline-only.sh first.`, 12);
  }
  let settings = {};
  if (detect.settings_exists) {
    settings = JSON.parse(readFileSync(detect.settings_path, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      die(`refusing: existing ${detect.settings_path} is not a JSON object`, 9);
    }
  }
  settings.statusLine = {
    type: 'command',
    command: `bash ${detect.source_script_path}`,
    padding: 0,
  };
  if (dryRun) return detect.settings_path;
  mkdirSync(dirname(detect.settings_path), {recursive: true});
  const body = JSON.stringify(settings, null, 2) + '\n';
  const tmp = detect.settings_path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY.
  renameWithRetry(renameSync, tmp, detect.settings_path);
  return detect.settings_path;
}

// ─────────── v4.1 Phase C: telemetry consent (prism-policy.json) ───────────
//
// Canonical opt-in state lives at ~/.claude/prism-policy.json under
// `telemetry.opt_in`. The existing /prism-telemetry --opt-in / --opt-out
// slash command reads + writes the same file (commands/prism-telemetry.md).
// We're adding deterministic detect + set subcommands so /prism-bootstrap's
// health phase can prompt + persist the user's choice in one CLI call.
//
// detect-telemetry-consent returns:
//   { policy_path, policy_exists, opt_in: true|false|null,
//     asked_at: ISO|null, parse_error: string|null }
// opt_in: null  →  policy file absent OR telemetry block absent: user has
//                  not been asked yet. Health phase should prompt.
// opt_in: true  →  user opted in.
// opt_in: false →  user opted out.
//
// set-telemetry-consent writes the policy file atomically. Preserves any
// other top-level keys the user (or future tools) added. Stamps asked_at
// to the current ISO time.

function telemetryPolicyPath(home) {
  return join(home, '.claude', 'prism-policy.json');
}

function detectTelemetryConsent(home) {
  const path = telemetryPolicyPath(home);
  const result = {
    policy_path: path,
    policy_exists: existsSync(path),
    opt_in: null,
    asked_at: null,
    parse_error: null,
  };
  if (!result.policy_exists) return result;
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    result.parse_error = e.message;
    return result;
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    result.parse_error = 'policy file is not a JSON object';
    return result;
  }
  const t = policy.telemetry;
  if (t && typeof t === 'object' && typeof t.opt_in === 'boolean') {
    result.opt_in = t.opt_in;
    result.asked_at = typeof t.asked_at === 'string' ? t.asked_at : null;
  }
  return result;
}

function setTelemetryConsent(home, optIn) {
  const path = telemetryPolicyPath(home);
  let policy = {};
  if (existsSync(path)) {
    try {
      policy = JSON.parse(readFileSync(path, 'utf8'));
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        die(`refusing: ${path} is not a JSON object — fix or remove it`, 9);
      }
    } catch (e) {
      die(`refusing: ${path} is not valid JSON (${e.message})`, 9);
    }
  }
  if (!policy.schema_version) policy.schema_version = '3.1.0';
  policy.telemetry = {
    ...(policy.telemetry || {}),
    opt_in: optIn,
    asked_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), {recursive: true});
  const body = JSON.stringify(policy, null, 2) + '\n';
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  try { renameSync(tmp, path); } catch { writeFileSync(path, body, 'utf8'); }
  return {policy_path: path, opt_in: optIn, asked_at: policy.telemetry.asked_at};
}

// ------------------------------ venv detection ------------------------------
// A project is "Python" when any of these markers exist at root or one level
// deep (e.g. backend/). Drives the ensure-venv decision when no flag is given.
function detectPython(root) {
  const markers = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg', 'manage.py'];
  if (markers.some((m) => existsSync(join(root, m)))) return true;
  try { if (readdirSync(root).some((f) => f.endsWith('.py'))) return true; } catch {}
  try {
    for (const d of readdirSync(root, {withFileTypes: true})) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') {
        if (markers.some((m) => existsSync(join(root, d.name, m)))) return true;
      }
    }
  } catch {}
  return false;
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

    case 'ensure-venv': {
      const name = positional[0];
      if (!name) die('ensure-venv requires <project-name>');
      const wantFlag = opts.python === true ? true : opts.python === false ? false : null;
      // Load existing state, or initialize it in-memory (ensure-venv may run
      // standalone before the rest of bootstrap; persisted below once decided).
      const rs = readState(opts.root);
      let state;
      if (rs.status === 'ok') state = rs.state;
      else if (rs.status === 'missing') {
        const claudeDir = join(opts.root, '.claude');
        const hasClaudeContent = existsSync(claudeDir) && existsSync(join(opts.root, 'CLAUDE.md'));
        state = hasClaudeContent
          ? synthesizeFromFilesystem(opts.root, {projectName: name})
          : createInitialState(name);
      } else {
        die(`state ${rs.status}: ${(rs.errors || []).join('; ')}`, 4);
      }
      let isPy = state.python_project;
      if (isPy === undefined || isPy === null) {
        if (wantFlag !== null) isPy = wantFlag;
        else if (detectPython(opts.root)) isPy = true;
        else {
          stdout.write('needs-prompt: no Python detected — ask "Will this be a Python project? Create a .venv?", then re-invoke ensure-venv with --python or --no-python.\n');
          exit(7);
        }
      }
      state.python_project = isPy;
      if (!opts.dryRun) writeStateAtomic(opts.root, state);
      stdout.write(`ensure-venv: python_project=${isPy}\n`);
      if (!isPy) break;

      // .gitignore hygiene — ignore `.venv/`, exactly once.
      const giPath = join(opts.root, '.gitignore');
      let gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
      if (!/^\.venv\/?$/m.test(gi)) {
        gi = gi.replace(/\s*$/, '') + (gi.trim() ? '\n' : '') + '.venv/\n';
        if (!opts.dryRun) writeFileSync(giPath, gi);
      }

      // SessionStart venv PATH hook (Git Bash): prepend .venv/Scripts to PATH via
      // $CLAUDE_ENV_FILE using project-relative ${CLAUDE_PROJECT_DIR}. Best-effort
      // accelerator; the CLAUDE.md convention (slash command) is the guarantee.
      const settingsPath = join(opts.root, '.claude', 'settings.json');
      if (!opts.dryRun) {
        mkdirSync(join(opts.root, '.claude'), {recursive: true});
        let st = {};
        try { st = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
        if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
        st.hooks = st.hooks || {};
        st.hooks.SessionStart = st.hooks.SessionStart || [];
        const venvHookCmd = 'if [ -n "$CLAUDE_ENV_FILE" ] && [ -d "$CLAUDE_PROJECT_DIR/.venv/Scripts" ]; then echo "export PATH=\\"$(cygpath -u \\"$CLAUDE_PROJECT_DIR\\")/.venv/Scripts:$PATH\\"" >> "$CLAUDE_ENV_FILE"; fi';
        const already = JSON.stringify(st.hooks.SessionStart).includes('CLAUDE_ENV_FILE');
        if (!already) st.hooks.SessionStart.push({hooks: [{type: 'command', command: venvHookCmd}]});
        writeFileSync(settingsPath, JSON.stringify(st, null, 2) + '\n');
      }

      // venv creation (skipped by tests via --no-create; fail-soft if no Python).
      if (!opts.noCreate && !opts.dryRun) {
        const venvDir = join(opts.root, '.venv');
        if (!existsSync(venvDir)) {
          const py = process.platform === 'win32' ? 'python' : 'python3';
          const res = spawnSync(py, ['-m', 'venv', venvDir], {cwd: opts.root, encoding: 'utf8'});
          if (res.status !== 0) {
            const why = (res.stderr || (res.error && res.error.message) || '').toString().trim();
            stdout.write(`ensure-venv: WARN could not create .venv (${why}); create it manually: ${py} -m venv .venv\n`);
          } else {
            stdout.write('ensure-venv: created .venv\n');
          }
        }
      }
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
      // v5.1: DEFAULT-ON. The project-master is the prerequisite for real
      // dispatched panels (STEP 0: dispatch is main-loop-only). Bootstrap
      // creates master-<slug> fully non-interactively (slug-derive +
      // agent-write + memory-seed + settings-write). --no-master opts out.
      // --with-deep-dive is an accepted no-op (back-compat). slug-derive exit 6
      // (generic basename, no CLAUDE.md identity) still falls back to
      // /prism-deep-dive, which can prompt.
      if (opts.noMaster) {
        stdout.write('project-master phase: skipped via --no-master\n');
        break;
      }
      const state = loadStateOrDie();
      const markStarted = markPhaseStarted(state, 'project-master');
      writeStateAtomic(opts.root, setLastCommand(markStarted, 'bootstrap:project-master'));

      // Resolve the deep-dive helper relative to this file's own dir. Use
      // fileURLToPath so Windows drive letters resolve correctly (raw .pathname
      // yields "/Y:/..." which Node mis-resolves to "Y:\Y:\...").
      const helperPath = fileURLToPath(new URL('./prism-deep-dive.mjs', import.meta.url));
      const dd = (...a) => spawnSync(process.execPath, [helperPath, ...a, '--root', opts.root], {encoding: 'utf8'});

      const slugRes = dd('slug-derive', '--source', 'auto');
      if (slugRes.status === 6) {
        // Generic basename or no identity → the slash command must drive (it can prompt).
        stdout.write(
          `project-master phase: slug needs user prompting (basename is generic, no CLAUDE.md identity).\n` +
          `  Run /prism-deep-dive to complete this phase interactively.\n`
        );
        break;  // do NOT mark complete — the slash command will close it
      }
      if (slugRes.status !== 0) {
        die(`slug-derive failed: ${slugRes.stderr || slugRes.stdout}`, 1);
      }
      const slugInfo = JSON.parse(slugRes.stdout);
      const slug = slugInfo.slug;

      // Create the agent file. exit 7 = already exists → idempotent skip; in
      // that case we MUST NOT re-seed MEMORY.md (it may carry learned knowledge).
      const agentRes = dd('agent-write', '--slug', slug);
      const freshlyCreated = agentRes.status === 0;
      if (agentRes.status !== 0 && agentRes.status !== 7) {
        die(`agent-write failed: ${agentRes.stderr || agentRes.stdout}`, 1);
      }

      // Seed MEMORY.md ONLY on first creation — never clobber a learned router.
      // Profile is tiny → pass inline (spawnSync args array, no shell mangling).
      let memorySeeded = false;
      if (freshlyCreated) {
        const profile = JSON.stringify({stack: '', datasources: [], active_workstreams: [], specialists: []});
        const memRes = dd('memory-seed', '--slug', slug, '--profile', profile);
        if (memRes.status !== 0) {
          die(`memory-seed failed: ${memRes.stderr || memRes.stdout}`, 1);
        }
        memorySeeded = true;
      }

      // Wire the session agent (idempotent merge — safe on re-run).
      const setRes = dd('settings-write', '--slug', slug);
      if (setRes.status !== 0) {
        die(`settings-write failed: ${setRes.stderr || setRes.stdout}`, 1);
      }

      const withSlug = setProjectSlug(loadStateOrDie(), slug);
      const next = markPhaseCompleted(withSlug, 'project-master', {
        slug,
        source: slugInfo.source,
        agent_created: freshlyCreated,
        memory_seeded: memorySeeded,
        completed_via: 'phase-project-master (non-interactive: agent-write + memory-seed + settings-write)',
      });
      persistOrPrint(next, `phase-project-master complete (master-${slug} wired as session agent)`);
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

    case 'detect-statusline': {
      const home = resolveStatuslineHome();
      stdout.write(JSON.stringify(detectStatusline(home), null, 2) + '\n');
      break;
    }

    case 'install-statusline': {
      const home = resolveStatuslineHome();
      const path = installStatusline({home, dryRun: opts.dryRun, force: opts.force});
      stdout.write(opts.dryRun
        ? `DRY-RUN: would write statusLine block to ${path}\n`
        : `statusLine block written to ${path}\n`);
      break;
    }

    case 'detect-telemetry-consent': {
      const home = resolveStatuslineHome();
      const result = detectTelemetryConsent(home);
      // Industry-standard opt-out env vars override file state. We return
      // the file state untouched so callers can see what was persisted,
      // PLUS a forced_off_by_env field naming the env var responsible.
      // bootstrap's Step 7b branches on this to skip the prompt.
      const envVar = process.env.DISABLE_TELEMETRY === '1' ? 'DISABLE_TELEMETRY'
                   : process.env.DO_NOT_TRACK === '1' ? 'DO_NOT_TRACK'
                   : null;
      if (envVar) {
        result.forced_off_by_env = envVar;
        result.effective_opt_in = false;
      }
      stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    case 'set-telemetry-consent': {
      const value = positional.shift();
      if (value !== 'on' && value !== 'off') {
        die(`set-telemetry-consent requires 'on' or 'off' (got ${JSON.stringify(value)})`, 22);
      }
      const home = resolveStatuslineHome();
      let effectiveOptIn = value === 'on';
      const envVar = process.env.DISABLE_TELEMETRY === '1' ? 'DISABLE_TELEMETRY'
                   : process.env.DO_NOT_TRACK === '1' ? 'DO_NOT_TRACK'
                   : null;
      if (envVar && effectiveOptIn) {
        stderr.write(
          `PRISM telemetry: ${envVar}=1 in environment — ` +
          `forcing opt_in:false regardless of CLI arg '${value}' ` +
          `(industry-standard opt-out honored).\n`,
        );
        effectiveOptIn = false;
      }
      const result = setTelemetryConsent(home, effectiveOptIn);
      if (envVar) result.forced_off_by_env = envVar;
      stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
