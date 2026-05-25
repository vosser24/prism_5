#!/usr/bin/env node
// PRISM Agent-Write Registrar (v3.11.0 Phase A.3) — PostToolUse
//
// Auto-registers newly-written Claude Code agents into the appropriate
// roster.json. Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §4.
//
// Trigger: PostToolUse for {Write, Edit, MultiEdit} where the target path
// matches `.../.claude/agents/<name>.md` (the filename is the agent's
// identifier; everything ahead of `.claude/agents/` decides scope).
//
// Routing:
//   ~/.claude/agents/<name>.md          → global roster at
//                                         ~/.claude/skills/prism-plan/references/roster.json
//   <project>/.claude/agents/<name>.md  → project roster at
//                                         <project>/.claude/agents/roster.json
//
// Schema: minimal stub per skills/prism-plan/references/roster.json
// _schema_example_agent. agent-factory / `/prism-roster --reconcile` fills
// the heavyweight fields (core_domains, projects_worked, escalation
// counters) later. This hook just makes sure the agent is *visible* to
// panel-guard and other consumers immediately.
//
// Idempotent: re-firing on the same agent file is a no-op.
//
// Off-switch: PRISM_DISABLE_AGENT_WRITE_HOOK=1
//
// Cost: ~50ms when an agent write fires; ~0ms otherwise (early exit on
// non-matching tool / path). User-visible: silent on the common path,
// emits one short stdout line on a real registration.

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname, sep} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE;
const GLOBAL_ROSTER = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');

// Matches `.../.claude/agents/<name>.md`. <name> is anything that isn't
// a directory separator. roster.json itself is excluded in isAgentPath().
const AGENT_RE = /[/\\]\.claude[/\\]agents[/\\]([^/\\]+)\.md$/i;

// ---------- helpers ----------

function collectPaths(ti) {
  const out = new Set();
  if (!ti) return [...out];
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.file_path === 'string') out.add(e.file_path);
    }
  }
  return [...out];
}

function isAgentPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.endsWith('roster.json')) return false;
  return AGENT_RE.test(p);
}

function agentName(p) {
  const m = p.match(AGENT_RE);
  return m ? m[1] : null;
}

// Returns {roster_path, scope}. Scope is 'global' if the agent lives directly
// under ~/.claude/agents/; otherwise 'project' and the roster path is the
// project's local .claude/agents/roster.json.
function locateRoster(agentPath) {
  const normalised = agentPath.split(/[\\/]/).join(sep);
  const expectedGlobal = join(H, '.claude', 'agents') + sep;
  if (normalised.startsWith(expectedGlobal)) {
    return {roster_path: GLOBAL_ROSTER, scope: 'global'};
  }
  // Project-local: the roster sits next to the agent file.
  // <root>/.claude/agents/<name>.md → <root>/.claude/agents/roster.json
  const agentsDir = dirname(agentPath);
  return {roster_path: join(agentsDir, 'roster.json'), scope: 'project'};
}

function freshRosterSkeleton() {
  return {
    version: '3.1.0',
    schema_version: '3.1.0',
    agents: {},
    skills: {},
    tools: {},
    mcps: {},
  };
}

function readRoster(path) {
  if (!existsSync(path)) return freshRosterSkeleton();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed.agents || typeof parsed.agents !== 'object') parsed.agents = {};
    return parsed;
  } catch {
    // Corrupt JSON: fall back to a fresh skeleton. We never want to hard-fail
    // a user's tool call from a hook. The user can recover from git if they
    // had a populated roster.
    return freshRosterSkeleton();
  }
}

// Atomic write via tempfile + rename. Same pattern as
// hooks/prism-memory-save-nudge.mjs (v2.9.1 ATOMIC-WRITE-001).
function writeRosterAtomic(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  try { renameSync(tmp, path); }
  catch {
    // Fallback: direct write. Same rationale as memory-save-nudge.
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }
}

// Parse a minimal YAML frontmatter block. Returns {name, description} with
// empty strings as defaults. We do NOT pull in a YAML library — just a
// fixed-format reader for the two fields we need.
function parseFrontmatter(body) {
  const out = {name: '', description: ''};
  if (!body.startsWith('---')) return out;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return out;
  const block = body.slice(3, end).split('\n');
  for (const line of block) {
    const m = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function registerAgent(agentPath) {
  const name = agentName(agentPath);
  if (!name) return {registered: false};

  const {roster_path, scope} = locateRoster(agentPath);
  const roster = readRoster(roster_path);

  if (roster.agents[name]) {
    return {registered: false, alreadyKnown: true, name, roster_label: scope};
  }

  let description = '';
  try {
    if (existsSync(agentPath)) {
      const fm = parseFrontmatter(readFileSync(agentPath, 'utf-8'));
      description = fm.description || '';
    }
  } catch { /* ignore */ }

  roster.agents[name] = {
    created: new Date().toISOString(),
    version: 1,
    core_domains: [],
    tools_known: [],
    projects_worked: [],
    total_tasks_completed: 0,
    total_corrections_received: 0,
    corrections_since_last_upgrade: 0,
    consecutive_successful_sonnet_tasks: 0,
    default_model: null,
    pending_upgrade: null,
    team_id: null,
    description,
    agent_path: agentPath,
    auto_registered: true,
  };

  writeRosterAtomic(roster_path, roster);
  return {registered: true, name, roster_label: scope};
}

// ---------- entry point ----------

function main() {
  if (process.env.PRISM_DISABLE_AGENT_WRITE_HOOK === '1') return;

  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { return; }

  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) return;

  const paths = collectPaths(input.tool_input);
  const agentWrites = paths.filter(isAgentPath);
  if (!agentWrites.length) return;

  const messages = [];
  for (const agentPath of agentWrites) {
    const result = registerAgent(agentPath);
    if (result.registered) {
      messages.push(`PRISM: registered ${result.name} → ${result.roster_label}`);
    } else if (result.alreadyKnown) {
      messages.push(`PRISM: ${result.name} already registered`);
    }
  }
  if (messages.length) process.stdout.write(messages.join('\n'));
}

// Defensive: any throw exits 0. We never want to fail a tool call from this hook.
try { main(); } catch { /* swallow */ }
process.exit(0);
