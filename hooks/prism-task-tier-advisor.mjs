#!/usr/bin/env node
// PRISM Task Tier Advisor (v2.2.0) — PostToolUse: TaskCreate
//
// v2.2.0: classifier source changed from keyword scoring to Opus-backed
// context scoring. The advisor still emits a soft nudge on each TaskCreate
// and can deny in hard mode for opus-tier tasks that lack tier_ack="opus".
// DB logging shape preserved so prism-rollup-weekly's Plan-Tier Adherence
// section keeps working.
//
// Matcher: "TaskCreate" — does NOT match TaskUpdate (avoids recursion loop
// because the advisor never calls TaskUpdate itself).
//
// Modes:
//   soft  (default):                  emit nudge, exit 0
//   hard  (PRISM_TASK_TIER=hard):     if Opus-tier detected AND description
//                                      lacks metadata.tier_ack="opus", deny
//                                      the tool call. Forces explicit
//                                      acknowledgement of Opus subtasks
//                                      rather than drift into them.

import {readFileSync} from 'fs';
import {pathToFileURL} from 'url';
import {join} from 'path';
import {classifyPrompt} from './lib/prism-opus-classifier.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const MODE = (process.env.PRISM_TASK_TIER || 'soft').toLowerCase();
const DB_HELPER_URL = pathToFileURL(join(H, '.claude', 'tools', 'prism-db.mjs')).href;

// Rough cost multiplier used only for the nudge text (e.g. "~15x cheaper").
// Not used for routing — the classifier decides tier.
const COST_MULTIPLIER = {haiku: 1, sonnet: 5, opus: 15};

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
  const classPrompt = `${subject}\n${description}`.trim();

  // Task-scoped classifier call. Uses the same Opus pipeline as the prompt
  // router but without git context (tasks aren't tied to a repo state in
  // the same way). Cache still applies on identical prompt strings.
  const cls = await classifyPrompt({
    prompt: classPrompt,
    cwd: input.cwd || '',
    branch: '',
    headSha: '',
    dirty: false,
  });

  const tier = cls.tier;
  const rationale = cls.rationale || '(no rationale)';
  const subjShort = subjectSlice(subject);
  const parentCost = COST_MULTIPLIER.opus;
  const subCost = COST_MULTIPLIER[tier] || 1;
  const mult = Math.max(1, Math.round(parentCost / subCost));

  // Hard-mode deny for opus-tier tasks without explicit acknowledgement.
  if (MODE === 'hard' && tier === 'opus' && metadata.tier_ack !== 'opus') {
    await logAdvice({
      ts: new Date().toISOString(),
      session_id: input.session_id || null,
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
        hookEventName: 'PostToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `PRISM TIER task "${subjShort}": OPUS detected (${rationale}). Hard mode requires metadata.tier_ack:"opus" to acknowledge. Retry with acknowledgement, or split into smaller sub-tasks.`,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(0);
  }

  // Soft-mode nudge.
  const lines = [];
  const idLabel = taskId ? `task ${taskId}` : 'task';
  if (tier === 'haiku') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": haiku — consider Agent({model:'haiku'}) (~${mult}x cheaper than Opus; ${rationale})`);
  } else if (tier === 'sonnet') {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": sonnet — consider Agent({model:'sonnet'}) (~${mult}x cheaper than Opus; ${rationale})`);
  } else {
    lines.push(`PRISM TIER ${idLabel} "${subjShort}": opus (${rationale})`);
  }
  if (cls.summon_panel) {
    lines.push(`PRISM TIER: classifier flagged this task as a candidate for expert-panel debate (novel architecture). Consider /prism-plan or summoning the blueprint-prompt panel.`);
  }

  await logAdvice({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
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
