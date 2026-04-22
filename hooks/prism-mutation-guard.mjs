#!/usr/bin/env node
// PRISM Mutation Guard (v1.1.0 — 2.2.1)
//
// PreToolUse hook on Edit, Write, MultiEdit. When the parent (Opus) context
// calls a mutation tool directly — instead of dispatching the edit to a
// subagent — this guard emits a PRISM NOTICE and optionally blocks the call.
//
// The orchestrator pattern: Opus plans + evaluates; subagents execute.
// Direct Edit/Write in the parent context breaks that boundary.
//
// Detection: the PreToolUse payload carries `parent_tool_use_id` when the
// call originates inside a subagent. If that field is absent (or empty/null),
// the caller is the parent context.
//
// Modes (PRISM_MUTATION_GUARD env var):
//   hard (default, unset):  emit NOTICE + exit 2 (tool blocked)
//   soft:                   emit NOTICE + exit 0 (pass-through with nudge)
//   off:                    silent pass-through, exit 0
//
// Override: if the user prompt contains "!opus-force:", pass through silently.
//
// Bootstrap allowlist (v2.2.1): `/prism-init`, `/prism-update`, and
// `/prism-archive` are legitimate write contexts — these commands MUST
// write new project files by design. If the user's current prompt is one
// of these slash commands, the guard passes through. Previously users had
// to set `PRISM_MUTATION_GUARD=off` manually to run /prism-init.
//
// Logs to ~/.claude/.prism-routing.jsonl (same file as prism-agent-model-guard).

import {readFileSync, appendFileSync, mkdirSync, existsSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_MUTATION_GUARD !== undefined
  ? process.env.PRISM_MUTATION_GUARD
  : 'hard').toLowerCase();

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Bootstrap/write commands — these legitimately need to write project files.
// If the current turn was routed via the /prism-init, /prism-update, or
// /prism-archive allowlist entry (v2.2.1+), the sentinel's rationale will
// mention the command name. Pass through cleanly instead of blocking.
const BOOTSTRAP_COMMANDS = ['/prism-init', '/prism-update', '/prism-archive'];

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function isBootstrapTurn(input) {
  // Primary: check sentinel rationale (set by prism-prompt-tier-router /
  // prism-opus-classifier when the prompt hits the orchestration allowlist).
  const s = readSentinel(input.session_id);
  if (s && typeof s.rationale === 'string') {
    for (const cmd of BOOTSTRAP_COMMANDS) {
      if (s.rationale.includes(cmd)) return cmd;
    }
  }
  // Fallback: PreToolUse payloads sometimes carry the raw prompt. Sniff
  // directly in case the sentinel is missing (first turn, no UserPromptSubmit
  // event fired yet, or the sentinel write raced this hook).
  const p = String(input.user_prompt || input.prompt || '').trim().toLowerCase();
  for (const cmd of BOOTSTRAP_COMMANDS) {
    if (p.startsWith(cmd)) return cmd;
  }
  return null;
}

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function getFilePath(toolInput) {
  if (!toolInput) return '<unknown>';
  return toolInput.file_path || toolInput.path || '<unknown>';
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  const toolName = input.tool_name || '';
  if (!MUTATION_TOOLS.has(toolName)) process.exit(0);

  // Off mode: silent pass-through
  if (MODE === 'off') process.exit(0);

  const ti = input.tool_input || {};
  const filePath = getFilePath(ti);

  // Bootstrap command auto-bypass (v2.2.1): /prism-init, /prism-update,
  // /prism-archive must be able to write project files.
  const bootstrapCmd = isBootstrapTurn(input);
  if (bootstrapCmd) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'bootstrap-command-passthrough',
      command: bootstrapCmd,
    });
    process.exit(0);
  }

  // Subagent detection: parent_tool_use_id is present when called from inside Agent()
  const isSubagent = !!(input.parent_tool_use_id);

  if (isSubagent) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'subagent-caller-passthrough',
    });
    process.exit(0);
  }

  // Check for user override prefix
  const userPrompt = input.user_prompt || input.prompt || '';
  if (String(userPrompt).includes('!opus-force:')) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'opus-force-override',
      file_hash: sha256short(filePath),
    });
    process.exit(0);
  }

  // Parent context calling a mutation tool — enforce the boundary
  const notice = [
    `PRISM MUTATION-GUARD: ${toolName} called directly in the parent (Opus) context.`,
    `Dispatch via Agent({subagent_type:'general-purpose', model:'sonnet', prompt:'<paste your intended edit as a spec>'}).`,
    `Set PRISM_MUTATION_GUARD=off to disable, or prefix the user prompt with !opus-force: to override.`,
    `Tool: ${toolName}  File: ${filePath}`,
  ].join('\n');

  const blocked = (MODE === 'hard');

  appendLog({
    ts: new Date().toISOString(),
    event: 'mutation_guard',
    mode: MODE,
    tool: toolName,
    file: filePath,
    blocked,
    reason: blocked ? 'parent-context-blocked' : 'parent-context-nudge',
    file_hash: sha256short(filePath),
  });

  if (blocked) {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: notice,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(2);
  }

  // Soft mode: emit notice, pass through
  process.stdout.write(notice);
  process.exit(0);
}

main();
