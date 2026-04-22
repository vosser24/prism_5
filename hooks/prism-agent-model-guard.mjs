#!/usr/bin/env node
// ATLAS Agent Model Guard (v2.1.27 Phase 3b)
//
// PreToolUse hook on the `Agent` tool. When the parent spawns a subagent
// WITHOUT an explicit `model` field, classify the prompt's cognitive load
// and emit a nudge recommending Haiku / Sonnet / Opus. Optionally runs in
// "hard" mode (PRISM_MODEL_GUARD=hard) to deny the call, forcing the
// parent to retry with a model set.
//
// Classification is score-based, NOT verb-match:
//   Haiku signals: bounded output (return/list/count/extract/find all/JSON),
//                  verbatim tasks (quote/copy/dump), schema outputs.
//   Sonnet signals: cross-file pattern recognition, refactor identification,
//                   test writing from spec, doc lookup + reformulation.
//   Opus signals: architecture decisions, trade-off analysis, root-cause
//                 diagnosis, design, decide whether, multi-stakeholder
//                 synthesis, security review with reasoning.
//
// Max-tier wins. Ties round UP (prefer over-pay to under-perform).
//
// Modes:
//   soft (default): emit nudge on stdout, exit 0 (pass-through)
//   hard (PRISM_MODEL_GUARD=hard): deny call with a reason
//
// Cascading: this hook fires on every Agent() call from any nesting depth.

import {readFileSync, appendFileSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';
import {classifyTier, detectCompound, COST_MULTIPLIER} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_MODEL_GUARD || 'soft').toLowerCase();

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  if (input.tool_name !== 'Agent') process.exit(0);

  const ti = input.tool_input || {};
  const subagentType = ti.subagent_type || 'unknown';
  const hasModel = typeof ti.model === 'string' && ti.model.length > 0;
  const prompt = ti.prompt || '';
  const description = ti.description || '';

  if (hasModel) {
    appendLog({
      ts: new Date().toISOString(),
      session_id: input.session_id || null,
      tool: 'Agent',
      subagent_type: subagentType,
      action: 'passthrough-explicit-model',
      explicit_model: ti.model,
      prompt_hash: sha256short(prompt),
    });
    process.exit(0);
  }

  const {tier, reason} = classifyTier(prompt, description);
  const compound = detectCompound(prompt, description);

  const msg = [];
  const parentCost = COST_MULTIPLIER.opus;
  const subCost = COST_MULTIPLIER[tier];
  const mult = Math.round(parentCost / subCost);

  if (tier === 'haiku' && mult > 1) {
    msg.push(`ATLAS MODEL GUARD: spawning ${subagentType} without model override. ${tier.toUpperCase()} task detected (${reason}) — add model:'${tier}' to save ~${mult}x vs. Opus.`);
  } else if (tier === 'sonnet' && mult > 1) {
    msg.push(`ATLAS MODEL GUARD: spawning ${subagentType} without model override. ${tier.toUpperCase()} task detected (${reason}) — consider model:'${tier}' to save ~${mult}x vs. Opus.`);
  }

  if (compound) {
    msg.push(`ATLAS MODEL GUARD: compound task detected. Consider SPLITTING into two Agent() calls — (a) cheap retrieval (haiku), (b) reasoning/synthesis (opus) — cheaper and often higher-quality than one large call.`);
  }

  const action = MODE === 'hard' && tier !== 'opus' ? 'deny' : (msg.length ? 'nudge' : 'passthrough');

  appendLog({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    tool: 'Agent',
    subagent_type: subagentType,
    tier_detected: tier,
    compound_detected: compound,
    action,
    mode: MODE,
    prompt_hash: sha256short(prompt),
  });

  if (MODE === 'hard' && tier !== 'opus') {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${msg.join(' ')} Retry with explicit model:'${tier}'.`,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(0);
  }

  if (msg.length) process.stdout.write(msg.join('\n'));
  process.exit(0);
}

main();
