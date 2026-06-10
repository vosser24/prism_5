#!/usr/bin/env node
// PRISM Agent Model Guard (v3.8.0)
//
// v3.8.0: explicit-opus-on-non-haiku exemption. When dispatch already specifies
// model:'opus' AND parent sentinel tier is non-haiku, pass through silently
// (no nudge even in soft mode). The user is being explicit about heavyweight
// model in heavyweight context — no guidance needed.
//
// v2.9.1 (TIER-DRIFT-001): split `hard` mode semantics. Previously any non-opus
// dispatch without an explicit model was denied under hard — that overshot the
// task-tier-advisor (advisory) and tier-router (sentinel) semantics. Now:
//   - soft (default): advisory nudge, exit 0 (unchanged).
//   - hard (NEW semantics): deny ONLY when tier=='opus' AND no explicit model.
//                           sonnet/haiku become advisory nudges (no deny).
//   - strict (NEW enum):    preserves the OLD hard behavior — deny ANY
//                           non-opus dispatch without explicit model.
// BREAKING CONTRACT for users who set PRISM_MODEL_GUARD=hard expecting the
// strict behavior: switch to `strict`. Migration notice emitted once by
// prism-session-start.mjs when hard is detected post-upgrade.
//
// v2.9.0: add three-path subagent-context bypass (parity with mutation-guard,
// parent-dispatch-guard, task-tier-advisor). Closes the parity gap that v2.8.0
// CHANGELOG claimed was already fixed ("all guards now treat subagent context
// identically") but wasn't. Paths: parent_tool_use_id / CLAUDE_CODE_ENTRYPOINT
// env / sentinel.dispatched.
//
// v2.7.0 changes:
//   - Sentinel-first: reads `~/.claude/.prism-turn-tier-<session>.json`
//     written by prism-prompt-tier-router.mjs on UserPromptSubmit. Uses
//     the sentinel's tier + summon_panel as authoritative. Only re-classifies
//     via classifyPrompt() when sentinel is absent (classifier failed
//     upstream) or when an explicit subagent description gives us a
//     stronger signal than the turn-level prompt did.
//   - Dynamic cost multipliers: loadCostMultipliers() reads pricing from
//     model-matrix.md at runtime instead of the hardcoded 1/5/15 constants.
//   - Split nudges: compound-verb triggers "SPLIT into retrieval+synthesis";
//     summon_panel triggers "spawn @master-orchestrator". Different
//     recommendations for semantically different signals.
//   - Divergence logging: when our classification disagrees with the
//     sentinel, logs a {event:'classifier_divergence'} record to
//     .prism-routing.jsonl so the weekly rollup surfaces systematic drift.
//
// PreToolUse on the `Agent` tool. When the parent spawns a subagent
// WITHOUT an explicit `model` field, use the sentinel tier to recommend
// haiku/sonnet/opus. Hard mode denies non-opus spawns without explicit model.
//
// Modes (PRISM_MODEL_GUARD env var):
//   soft (default): emit nudge on stdout, exit 0 (pass-through)
//   hard:           deny opus-tier calls without explicit model (v2.9.1 —
//                   sonnet/haiku become advisory; matches tier-advisor semantics)
//   strict:         deny ANY non-opus tier without explicit model (old-hard)

import {readFileSync, existsSync, appendFileSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';
import {classifyPrompt} from './lib/prism-opus-classifier.mjs';
import {detectCompound, loadCostMultipliers} from '../tools/lib/prism-tier-classify.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE_RAW = (process.env.PRISM_MODEL_GUARD || 'soft').toLowerCase();
// v2.9.1: accept soft|hard|strict. Unknown values fall back to soft (safe default).
const MODE = ['soft', 'hard', 'strict'].includes(MODE_RAW) ? MODE_RAW : 'soft';

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

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

// v5.7: dual-mode. run(input) returns {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the original
// wire behavior (byte-identical, verified by golden-master).
export async function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});

  if (input.tool_name !== 'Agent') return done(0);

  const ti = input.tool_input || {};
  const subagentType = ti.subagent_type || 'unknown';
  const hasModel = typeof ti.model === 'string' && ti.model.length > 0;
  const prompt = ti.prompt || '';
  const description = ti.description || '';
  const sessionId = input.session_id || 'anon';

  // v2.9.0: three-path subagent-context bypass (parity with mutation-guard v2.7.5,
  // dispatch-guard v2.2.1, task-tier-advisor v2.8.0). A subagent spawning another
  // subagent must not be gated by the parent-context rules — the parent has
  // already been classified on UserPromptSubmit; subagent-chain dispatches
  // inherit that classification. Without this, subagent-internal Agent() calls
  // get denied as "parent underspecified" when the real parent isn't in the
  // Agent-tool call chain at all.
  //
  // Three signals, any one satisfies:
  //   1. input.parent_tool_use_id set (Claude Code propagates for subagent calls)
  //   2. CLAUDE_CODE_ENTRYPOINT=subagent env var (some builds set this instead)
  //   3. sentinel.dispatched === true (tier-router marks after first dispatch)
  const isSubagentById = !!input.parent_tool_use_id;
  const isSubagentByEnv = String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  const sentinelEarly = readSentinel(sessionId);
  const isSubagentByDispatched = !!(sentinelEarly && sentinelEarly.dispatched === true);
  if (isSubagentById || isSubagentByEnv || isSubagentByDispatched) {
    appendLog({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Agent',
      subagent_type: subagentType,
      action: 'passthrough-subagent-context',
      reason: isSubagentById ? 'parent_tool_use_id' : isSubagentByEnv ? 'env' : 'sentinel.dispatched',
      prompt_hash: sha256short(prompt),
    });
    return done(0);
  }

  // Master-orchestrator dispatch is always allowed without extra classification.
  if (String(subagentType).toLowerCase() === 'master-orchestrator') {
    appendLog({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Agent',
      subagent_type: subagentType,
      action: 'passthrough-master-orchestrator',
    });
    return done(0);
  }

  // v3.8.0: if the dispatch already specifies model: opus AND parent sentinel
  // tier is non-haiku, don't even nudge. The user is being explicit about
  // using a heavyweight model in a heavyweight context — no guidance needed.
  if (input.tool_input && input.tool_input.model === 'opus' && sentinelEarly && sentinelEarly.tier !== 'haiku') {
    appendLog({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Agent',
      subagent_type: subagentType,
      action: 'passthrough-explicit-opus-on-non-haiku',
    });
    return done(0);
  }

  if (hasModel) {
    appendLog({
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: 'Agent',
      subagent_type: subagentType,
      action: 'passthrough-explicit-model',
      explicit_model: ti.model,
      prompt_hash: sha256short(prompt),
    });
    return done(0);
  }

  // v2.7.0: sentinel-first. Prefer the turn-level classification over
  // re-running the Opus classifier on the subagent description+prompt.
  const sentinel = readSentinel(sessionId);

  let tier, rationale, classifierSource, summonPanel;
  if (sentinel && sentinel.tier) {
    tier = sentinel.tier;
    rationale = sentinel.rationale || '(from sentinel)';
    classifierSource = `sentinel-${sentinel.source || 'unknown'}`;
    summonPanel = !!sentinel.summon_panel;
  } else {
    // Fallback: sentinel missing (classifier failed upstream or session has no
    // prompt-tier-router output). Re-classify locally.
    const cls = await classifyPrompt({
      prompt: `${description}\n${prompt}`.trim(),
      cwd: input.cwd || '',
      branch: '',
      headSha: '',
      dirty: false,
    });
    tier = cls.tier;
    rationale = cls.rationale || '(no rationale)';
    classifierSource = `fallback-${cls.source || 'unknown'}`;
    summonPanel = !!cls.summon_panel;
  }

  // Dynamic cost multipliers from model-matrix.md (fallback: hardcoded).
  const COST = loadCostMultipliers();
  const parentCost = COST.opus;
  const subCost = COST[tier] || 1;
  const mult = Math.max(1, Math.round(parentCost / subCost));

  const msg = [];
  if (tier === 'haiku' && mult > 1) {
    msg.push(`PRISM MODEL GUARD: spawning ${subagentType} without model override. HAIKU task detected (${rationale}) — add model:'haiku' to save ~${mult}x vs. Opus.`);
  } else if (tier === 'sonnet' && mult > 1) {
    msg.push(`PRISM MODEL GUARD: spawning ${subagentType} without model override. SONNET task detected (${rationale}) — consider model:'sonnet' to save ~${mult}x vs. Opus.`);
  }

  // v2.7.0: compound-verb and summon_panel are SEMANTICALLY DIFFERENT.
  // Compound = retrieval+synthesis → SPLIT into cheap retrieval + focused reasoning.
  // summon_panel = novel architecture → spawn @master-orchestrator for full panel.
  const compound = detectCompound(prompt, description);
  if (summonPanel) {
    msg.push(`PRISM MODEL GUARD: novel-architecture signal detected. Spawn @master-orchestrator (Agent({subagent_type:'master-orchestrator', model:'opus', prompt:'<user request>'})) for expert-panel assembly + adversarial review — not a single general-purpose call.`);
  } else if (compound) {
    msg.push(`PRISM MODEL GUARD: compound task detected (retrieval+synthesis in one call). Consider SPLITTING into two Agent() calls — (a) cheap retrieval (haiku), (b) reasoning/synthesis (opus) — cheaper and often higher-quality than one large call.`);
  }

  // v2.9.1 TIER-DRIFT-001: hard mode narrows to opus-only deny; strict keeps
  // the old broad deny. Rationale: task-tier-advisor's hard-mode semantics are
  // "block silent Opus drift" (sonnet/haiku are cheap — nudging is enough);
  // the old hard behavior overshot by denying every non-opus dispatch even
  // when the tier classification wanted a cheaper model.
  const shouldDeny =
    (MODE === 'hard'   && tier === 'opus') ||
    (MODE === 'strict' && tier !== 'opus');
  const action = shouldDeny ? 'deny' : (msg.length ? 'nudge' : 'passthrough');

  appendLog({
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool: 'Agent',
    subagent_type: subagentType,
    tier_detected: tier,
    summon_panel: summonPanel,
    compound_detected: compound,
    classifier_source: classifierSource,
    action,
    mode: MODE,
    prompt_hash: sha256short(prompt),
  });

  if (shouldDeny) {
    const retryTier = MODE === 'hard' ? 'opus' : tier;
    const denyMsg = msg.length
      ? `${msg.join(' ')} Retry with explicit model:'${retryTier}'.`
      : `PRISM MODEL GUARD (${MODE}): spawning ${subagentType} without explicit model. Retry with model:'${retryTier}'.`;
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMsg,
      },
    };
    write(JSON.stringify(deny));
    return done(0);
  }

  if (msg.length) write(msg.join('\n'));
  return done(0);
}

// Standalone shim — preserves original wire behavior + parse-error fail-open.
import {basename} from 'path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-agent-model-guard.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  run(input).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exit || 0);
  }).catch(() => process.exit(0));
}
