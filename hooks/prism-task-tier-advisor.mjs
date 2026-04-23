#!/usr/bin/env node
// PRISM Task Tier Advisor (v2.7.0) — PreToolUse: TaskCreate
//
// v2.7.0 changes:
//   - Matcher moved from PostToolUse → PreToolUse. Wrong-tier tasks can
//     now be blocked before they enter the plan, not just nudged after.
//   - Sentinel-first classification: reads
//     ~/.claude/.prism-turn-tier-<session>.json as authoritative. Re-
//     classifies via classifyPrompt() only when the sentinel is absent
//     OR when the task description carries explicit plan-level metadata
//     (tier_override, [tier=haiku|sonnet|opus] annotation) that contradicts
//     the sentinel — in which case the plan wins.
//   - Plan-tier annotation: if the task description includes
//     "[haiku]", "[sonnet]", or "[opus]" (blueprint/workflow convention),
//     use THAT as the primary signal. Planner intent > classifier.
//   - Dynamic cost multipliers: loadCostMultipliers() reads pricing from
//     model-matrix.md at runtime.
//   - Divergence logging: mismatch between sentinel tier and detected
//     task tier → log {event:'task_tier_divergence'} to .prism-routing.jsonl
//     for weekly rollup analysis.
//
// Matcher: "TaskCreate" — does NOT match TaskUpdate (avoids recursion).
//
// Modes:
//   soft  (default):             emit nudge, exit 0
//   hard  (PRISM_TASK_TIER=hard): if opus-tier detected AND description
//                                  lacks metadata.tier_ack="opus" AND no
//                                  [opus] plan annotation, deny the
//                                  TaskCreate. Forces explicit opus
//                                  acknowledgement.

import {readFileSync, existsSync, appendFileSync, mkdirSync} from 'fs';
import {pathToFileURL} from 'url';
import {join, dirname} from 'path';
import {classifyPrompt} from './lib/prism-opus-classifier.mjs';
import {loadCostMultipliers} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_TASK_TIER || 'soft').toLowerCase();
const DB_HELPER_URL = pathToFileURL(join(H, '.claude', 'tools', 'prism-db.mjs')).href;

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

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf-8')); }
  catch { return null; }
}

function extractTaskFields(input) {
  const ti = input.tool_input || {};
  const subject = ti.subject || ti.title || ti.name || '';
  const description = ti.description || ti.prompt || ti.body || '';
  const taskId = ti.id || null;  // PreToolUse: no tool_response yet
  const metadata = ti.metadata || {};
  return {subject, description, taskId, metadata};
}

// Extract an explicit [haiku|sonnet|opus] annotation from the task
// description/subject. Blueprint + workflow-orchestration write these on
// every plan step; the planner's intent should authoritative when present.
function extractPlanTier(subject, description) {
  const hay = `${subject} ${description}`;
  const m = hay.match(/\[(haiku|sonnet|opus)\]/i);
  return m ? m[1].toLowerCase() : null;
}

function subjectSlice(subject) {
  const s = String(subject || '').trim();
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

async function logAdvice(row) {
  try {
    const mod = await import(DB_HELPER_URL);
    const db = mod.openDb();
    mod.appendTaskTierAdvice(db, row);
    mod.close(db);
  } catch {}
}

async function main() {
  const input = readStdin();
  if (!input) process.exit(0);
  if (input.tool_name !== 'TaskCreate') process.exit(0);

  const {subject, description, taskId, metadata} = extractTaskFields(input);
  const classPrompt = `${subject}\n${description}`.trim();
  const sessionId = input.session_id || 'anon';

  // v2.7.0: three-source tier resolution, in priority order.
  //   1. Plan annotation — [haiku|sonnet|opus] in description → planner intent wins
  //   2. Turn sentinel — written by prompt-tier-router on UserPromptSubmit
  //   3. Fallback classifier — re-classify the task description locally
  const planTier = extractPlanTier(subject, description);
  const sentinel = readSentinel(sessionId);
  const sentinelTier = sentinel && sentinel.tier ? sentinel.tier : null;

  let tier, rationale, source, summonPanel;
  if (planTier) {
    tier = planTier;
    rationale = `plan annotation [${planTier}]`;
    source = 'plan-annotation';
    summonPanel = sentinel ? !!sentinel.summon_panel : false;
  } else if (sentinelTier) {
    tier = sentinelTier;
    rationale = sentinel.rationale || '(from sentinel)';
    source = `sentinel-${sentinel.source || 'unknown'}`;
    summonPanel = !!sentinel.summon_panel;
  } else {
    // Last resort: re-classify locally. Cache on identical prompt strings
    // still applies.
    const cls = await classifyPrompt({
      prompt: classPrompt,
      cwd: input.cwd || '',
      branch: '',
      headSha: '',
      dirty: false,
    });
    tier = cls.tier;
    rationale = cls.rationale || '(no rationale)';
    source = `fallback-${cls.source || 'unknown'}`;
    summonPanel = !!cls.summon_panel;
  }

  // Divergence logging — planner or classifier disagrees with sentinel.
  if (sentinelTier && planTier && planTier !== sentinelTier) {
    appendLog({
      event: 'task_tier_divergence',
      ts: new Date().toISOString(),
      session_id: sessionId,
      task_subject: subjectSlice(subject),
      plan_tier: planTier,
      sentinel_tier: sentinelTier,
      resolution: 'plan-annotation-wins',
    });
  }

  // Dynamic cost multipliers.
  const COST = loadCostMultipliers();
  const parentCost = COST.opus;
  const subCost = COST[tier] || 1;
  const mult = Math.max(1, Math.round(parentCost / subCost));

  const subjShort = subjectSlice(subject);

  // Hard-mode deny for opus-tier tasks without explicit acknowledgement
  // AND without an explicit plan annotation (the annotation itself counts
  // as acknowledgement — the planner knowingly wrote [opus]).
  if (MODE === 'hard' && tier === 'opus'
      && metadata.tier_ack !== 'opus'
      && planTier !== 'opus') {
    await logAdvice({
      ts: new Date().toISOString(),
      session_id: sessionId,
      task_id: taskId,
      subject: subjShort,
      tier,
      reason: rationale,
      compound: false,
      h: 0, s: 0, o: 0,
      mode: MODE,
    });
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `PRISM TIER task "${subjShort}": OPUS detected (${rationale}). Hard mode requires either metadata.tier_ack:"opus" OR a "[opus]" plan annotation in the task description. Retry with one of those, or split into smaller sub-tasks.`,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(0);
  }

  // Soft-mode nudge.
  const lines = [];
  const idLabel = taskId ? `task ${taskId}` : 'task';
  if (tier === 'haiku') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": haiku — consider Agent({model:'haiku'}) (~${mult}x cheaper than Opus; source=${source}; ${rationale})`);
  } else if (tier === 'sonnet') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": sonnet — consider Agent({model:'sonnet'}) (~${mult}x cheaper than Opus; source=${source}; ${rationale})`);
  } else {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": opus (source=${source}; ${rationale})`);
  }
  if (summonPanel) {
    lines.push(`PRISM TIER: classifier flagged panel-worthy (novel architecture). Consider spawning @master-orchestrator instead of a single general-purpose Agent() call.`);
  }

  await logAdvice({
    ts: new Date().toISOString(),
    session_id: sessionId,
    task_id: taskId,
    subject: subjShort,
    tier,
    reason: rationale,
    compound: false,
    h: 0, s: 0, o: 0,
    mode: MODE,
  });

  if (lines.length) process.stdout.write(lines.join('\n'));
  process.exit(0);
}

main().catch(() => process.exit(0));
