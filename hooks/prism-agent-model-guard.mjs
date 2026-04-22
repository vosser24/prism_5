#!/usr/bin/env node
// PRISM Agent Model Guard (v2.2.0)
//
// v2.2.0: classifier source changed from keyword scoring to Opus-backed
// context scoring. Otherwise behaves identically to v2.1.3: emits a
// soft nudge when Agent() is spawned without an explicit `model` field,
// or denies in hard mode.
//
// PreToolUse on the `Agent` tool. When the parent spawns a subagent
// WITHOUT an explicit `model` field, classify the prompt's cognitive load
// and emit a nudge recommending Haiku / Sonnet / Opus. In hard mode
// (PRISM_MODEL_GUARD=hard), deny the call, forcing the parent to retry
// with a model set.
//
// Modes:
//   soft (default): emit nudge on stdout, exit 0 (pass-through)
//   hard (PRISM_MODEL_GUARD=hard): deny call with a reason

import {readFileSync, appendFileSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';
import {classifyPrompt} from './lib/prism-opus-classifier.mjs';
import {detectCompound} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_MODEL_GUARD || 'soft').toLowerCase();

// Cost multipliers for the nudge text (e.g. "~15x cheaper").
const COST_MULTIPLIER = {haiku: 1, sonnet: 5, opus: 15};

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

async function main() {
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

  const cls = await classifyPrompt({
    prompt: `${description}\n${prompt}`.trim(),
    cwd: input.cwd || '',
    branch: '',
    headSha: '',
    dirty: false,
  });
  const tier = cls.tier;
  const rationale = cls.rationale || '(no rationale)';
  const msg = [];
  const parentCost = COST_MULTIPLIER.opus;
  const subCost = COST_MULTIPLIER[tier];
  const mult = Math.round(parentCost / subCost);

  if (tier === 'haiku' && mult > 1) {
    msg.push(`PRISM MODEL GUARD: spawning ${subagentType} without model override. HAIKU task detected (${rationale}) — add model:'haiku' to save ~${mult}x vs. Opus.`);
  } else if (tier === 'sonnet' && mult > 1) {
    msg.push(`PRISM MODEL GUARD: spawning ${subagentType} without model override. SONNET task detected (${rationale}) — consider model:'sonnet' to save ~${mult}x vs. Opus.`);
  }

  // Compound-verb detection via legacy regex — a tight, cheap check for
  // prompts that mix retrieval + synthesis in one call. The classifier's
  // `summon_panel` is a related but broader signal (novel architecture).
  // Emit the split suggestion when either fires; the text retains the
  // "compound task detected" + "SPLITTING" markers that tooling greps for.
  const compound = detectCompound(prompt, description);
  if (compound || cls.summon_panel) {
    const why = compound ? 'compound task detected' : 'novel architecture signal';
    msg.push(`PRISM MODEL GUARD: ${why}. Consider SPLITTING into two Agent() calls — (a) cheap retrieval (haiku), (b) reasoning/synthesis (opus) — cheaper and often higher-quality than one large call.`);
  }

  const action = MODE === 'hard' && tier !== 'opus' ? 'deny' : (msg.length ? 'nudge' : 'passthrough');

  appendLog({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    tool: 'Agent',
    subagent_type: subagentType,
    tier_detected: tier,
    classifier_source: cls.source,
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

main().catch(() => process.exit(0));
