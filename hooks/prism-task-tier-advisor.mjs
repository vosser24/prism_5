#!/usr/bin/env node
// ATLAS Task Tier Advisor (Phase 5a.2)
//
// PostToolUse hook on TaskCreate. Classifies the new task's subject +
// description and emits a visible nudge recommending haiku/sonnet/opus.
// Writes an advice row to ~/.claude/.prism.db task_tier_advice for
// downstream rollup analysis (Phase 5a.4).
//
// Matcher: "TaskCreate" — does NOT match TaskUpdate (avoids recursion loop
// because the advisor never calls TaskUpdate itself).
//
// Modes:
//   soft  (default):                  emit nudge, exit 0
//   hard  (PRISM_TASK_TIER=hard):     if Opus-tier detected AND description
//                                      lacks `metadata.tier_ack: "opus"`, deny
//                                      the tool call. Design intent: force
//                                      explicit acknowledgement of Opus-tier
//                                      subtasks rather than drift into them.
//
// Compound-verb nudge: if detectCompound() returns true, recommend splitting
// into Haiku extract + Opus synthesize as two Agent() calls.

import {readFileSync} from 'fs';
import {pathToFileURL} from 'url';
import {join} from 'path';
import {classifyTier, detectCompound, COST_MULTIPLIER} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const MODE = (process.env.PRISM_TASK_TIER || 'soft').toLowerCase();
const DB_HELPER_URL = pathToFileURL(join(H, '.claude', 'tools', 'prism-db.mjs')).href;

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf-8')); }
  catch { return null; }
}

function extractTaskFields(input) {
  const ti = input.tool_input || {};
  const tr = input.tool_response || {};
  const subject = ti.subject || ti.title || ti.name || '';
  const description = ti.description || ti.prompt || ti.body || '';
  const taskId = tr.task_id || tr.id || ti.id || null;
  const metadata = ti.metadata || {};
  return {subject, description, taskId, metadata};
}

function subjectSlice(subject) {
  const s = String(subject || '').trim();
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
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
  const {tier, reason, h, s, o} = classifyTier(subject, description);
  const compound = detectCompound(subject, description);
  const subjShort = subjectSlice(subject);

  // Hard-mode deny for Opus-tier without acknowledgement
  if (MODE === 'hard' && tier === 'opus' && metadata.tier_ack !== 'opus') {
    await logAdvice({
      ts: new Date().toISOString(),
      session_id: input.session_id || null,
      task_id: taskId,
      subject: subjShort,
      tier, reason, compound, h, s, o,
      mode: MODE,
    });
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `PRISM TIER task "${subjShort}": OPUS detected (${reason}). Hard mode requires metadata.tier_ack:"opus" to acknowledge. Retry with acknowledgement, or split into smaller sub-tasks.`,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(0);
  }

  // Soft-mode nudge (default)
  const parentCost = COST_MULTIPLIER.opus;
  const subCost = COST_MULTIPLIER[tier] || 1;
  const mult = Math.max(1, Math.round(parentCost / subCost));

  const lines = [];
  const idLabel = taskId ? `task ${taskId}` : 'task';
  if (tier === 'haiku') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": haiku — consider Agent({model:'haiku'}) (~${mult}x cheaper than Opus; ${reason})`);
  } else if (tier === 'sonnet') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": sonnet — consider Agent({model:'sonnet'}) (~${mult}x cheaper than Opus; ${reason})`);
  } else {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": opus (${reason})`);
  }
  if (compound) {
    lines.push(`PRISM TIER compound task detected — consider splitting into two Agent() calls: (a) haiku extract, (b) opus synthesize.`);
  }

  await logAdvice({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    task_id: taskId,
    subject: subjShort,
    tier, reason, compound, h, s, o,
    mode: MODE,
  });

  if (lines.length) process.stdout.write(lines.join('\n'));
  process.exit(0);
}

main().catch(() => process.exit(0));
