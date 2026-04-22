#!/usr/bin/env node
// PRISM Parent Dispatch Guard (v2.2.0) — PreToolUse
//
// v2.2.0: classifier source changed (Opus-backed context scoring), sentinel
// shape preserved — this guard still reads {tier, force_opus, dispatched}
// and is unaffected by the new classifier internals. The deny message now
// surfaces the classifier's `rationale` when present for better debugging.
//
// Reads the per-session sentinel written by prism-prompt-tier-router.mjs.
// If the turn is haiku- or sonnet-tier AND we're in parent context AND the
// tool is a "work" tool (not an orchestration tool) AND no dispatch has
// happened yet this turn, DENY and tell Opus to dispatch first.
//
// Dispatch tools (Agent, TaskCreate) are ALWAYS allowed and flip sentinel
// .dispatched=true, unlocking subsequent parent-context tool calls for
// the same turn.
//
// Subagent-context calls (input.parent_tool_use_id present) always pass.
//
// Modes (PRISM_DISPATCH_GUARD env var, defaults to hard):
//   hard: deny blocked tools; exit 2 with deny JSON.
//   soft: emit NOTICE only; exit 0.
//   off:  pass-through.

import {readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = String(process.env.PRISM_DISPATCH_GUARD ?? 'hard').toLowerCase();

const ALWAYS_ALLOW = new Set([
  'Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'SendMessage', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  'ToolSearch', 'Skill', 'ScheduleWakeup', 'PushNotification',
  'EnterWorktree', 'ExitWorktree', 'Monitor', 'TeamCreate', 'TeamDelete',
  'CronCreate', 'CronDelete', 'CronList', 'TodoWrite',
]);

const DISPATCH_MARKERS = new Set(['Agent', 'TaskCreate']);

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function markDispatched(sessionId, sentinel) {
  try {
    sentinel.dispatched = true;
    sentinel.dispatched_ts = new Date().toISOString();
    writeFileSync(sentinelPath(sessionId), JSON.stringify(sentinel, null, 2));
  } catch {}
}

try {
  if (MODE === 'off') process.exit(0);

  const raw = readFileSync(0, 'utf-8');
  const input = JSON.parse(raw || '{}');
  const toolName = input.tool_name || '';
  const isSubagent = !!input.parent_tool_use_id;
  const sessionId = input.session_id || 'anon';

  if (isSubagent) process.exit(0);

  if (ALWAYS_ALLOW.has(toolName)) {
    if (DISPATCH_MARKERS.has(toolName)) {
      const sentinel = readSentinel(sessionId);
      if (sentinel && !sentinel.dispatched) markDispatched(sessionId, sentinel);
    }
    process.exit(0);
  }

  const sentinel = readSentinel(sessionId);
  if (!sentinel || sentinel.tier === 'opus' || sentinel.force_opus) process.exit(0);
  if (sentinel.dispatched) process.exit(0);

  const why = sentinel.rationale ? ` Reason: ${sentinel.rationale}` : '';
  const notice = [
    `PRISM DISPATCH-GUARD: ${toolName} denied in parent context — this turn routed to ${sentinel.tier}-tier.${why}`,
    `Dispatch the work first via Agent({subagent_type:'general-purpose', model:'${sentinel.tier}', prompt:'<task>'}) or TaskCreate/plan.`,
    `After one dispatch, subsequent parent tools are allowed. Override: prefix the user prompt with !opus-force: (or set PRISM_DISPATCH_GUARD=off).`,
  ].join('\n');

  appendLog({
    event: 'dispatch_guard',
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
    tier: sentinel.tier,
    score: sentinel.score,
    blocked: MODE === 'hard',
    mode: MODE,
  });

  if (MODE === 'hard') {
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

  process.stdout.write(notice);
  process.exit(0);
} catch {
  process.exit(0);
}
