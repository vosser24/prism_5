#!/usr/bin/env node
// PRISM Prompt Tier Router (v1.0.0) — UserPromptSubmit
//
// Classifies each user prompt with classifyWithScore, writes a per-session
// sentinel file, and injects a routing directive into the model's context
// via hookSpecificOutput.additionalContext.
//
// The sentinel is consumed by prism-parent-dispatch-guard.mjs (PreToolUse)
// which enforces the "dispatch before using work tools" boundary.
//
// Modes (PRISM_PROMPT_ROUTER env var, defaults to hard):
//   hard: sentinel + advice that mentions enforcement
//   soft: sentinel + advice only
//   off:  no-op

import {readFileSync, writeFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {classifyWithScore} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = String(process.env.PRISM_PROMPT_ROUTER ?? 'hard').toLowerCase();

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

try {
  if (MODE === 'off') process.exit(0);

  const raw = readFileSync(0, 'utf-8');
  const input = JSON.parse(raw || '{}');
  const prompt = String(input.prompt || '');
  const sessionId = input.session_id || 'anon';

  const forceOpus = prompt.includes('!opus-force:');
  const cls = classifyWithScore(prompt, '');
  const tier = forceOpus ? 'opus' : cls.tier_by_score;

  const sentinel = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    tier,
    score: cls.score,
    h: cls.h, s: cls.s, o: cls.o,
    compound: !!cls.compound,
    force_opus: forceOpus,
    dispatched: false,
    mode: MODE,
  };

  try {
    const p = sentinelPath(sessionId);
    mkdirSync(dirname(p), {recursive: true});
    writeFileSync(p, JSON.stringify(sentinel, null, 2));
  } catch {}

  appendLog({event: 'prompt_tier_router', ...sentinel});

  let advice = '';
  if (tier === 'haiku') {
    advice = `PRISM TIER ROUTER: prompt scored ${cls.score} (haiku-tier, h=${cls.h} s=${cls.s} o=${cls.o}). ` +
      `Dispatch via Agent({subagent_type:'general-purpose', model:'haiku', prompt:'<task>'}) instead of running tools directly in parent Opus.`;
    if (MODE === 'hard') advice += ` Parent tools (Bash/Read/Grep/Glob/WebFetch/WebSearch/Edit/Write) will be DENIED until you dispatch. Override: prefix user prompt with !opus-force:.`;
  } else if (tier === 'sonnet') {
    advice = `PRISM TIER ROUTER: prompt scored ${cls.score} (sonnet-tier, h=${cls.h} s=${cls.s} o=${cls.o}${cls.compound ? ', compound' : ''}). ` +
      `Dispatch implementation via Agent({subagent_type:'general-purpose', model:'sonnet'}). Parent Opus should orchestrate, plan, review.`;
    if (MODE === 'hard') advice += ` Parent non-dispatch tools will be DENIED until you dispatch or call TaskCreate. Override: !opus-force:.`;
  } else {
    advice = `PRISM TIER ROUTER: prompt scored ${cls.score} (opus-tier${forceOpus ? ', force-opus override' : ''}). Direct parent work allowed.`;
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: advice,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  appendLog({event: 'prompt_tier_router', error: String(e)});
  process.exit(0);
}
