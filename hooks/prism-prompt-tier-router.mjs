#!/usr/bin/env node
// PRISM Prompt Tier Router (v3.8.0) — UserPromptSubmit
//
// v3.8.0: continuation detection — short follow-up messages (<8 words) or
// explicit approval phrases ("ok", "yes", "go", "proceed") that follow an
// opus/sonnet sentinel <5min old now INHERIT the previous tier instead of
// re-classifying as haiku. Eliminates the per-turn dispatch ceremony.
// PRISM_CONVERSATION_MODE=1 forces always-inherit for development sessions.
//
// v3.2.0: API classifier path removed (see hooks/lib/prism-opus-classifier.mjs).
// Keyword-floor regex is the sole classification mechanism. To compensate for
// regex's bluntness on ambiguous prompts, this hook now emits a SELF-OVERRIDE
// PROTOCOL directive in its additionalContext: the conversation model can
// correct keyword-floor by writing a corrected sentinel as its first action
// of the turn, before any work tools fire.
//
// The sentinel on disk keeps its prior shape so prism-parent-dispatch-guard
// continues to read it unchanged. The legacy {h, s, o, score, compound}
// fields are retained as zeros for compatibility; downstream code that
// routes off them should migrate to `rationale` / `source`.
//
// Decision chain: force-opus prefix → slash-command allowlist → 24h cache →
// keyword floor. No network calls.
//
// Modes (PRISM_PROMPT_ROUTER env var, defaults to hard):
//   hard: sentinel + advice that mentions enforcement
//   soft: sentinel + advice only
//   off:  no-op

import {readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {classifyPrompt, toSentinel} from './lib/prism-opus-classifier.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = String(process.env.PRISM_PROMPT_ROUTER ?? 'hard').toLowerCase();

// v5.2.5: detect the active project-master from the project's settings.json
// `agent` field. When the active agent is a master-<slug> (which loads the
// master-orchestrator skill), a panel turn must be CHAIRED BY THAT MASTER in
// the main loop — NOT delegated to a nested @master-orchestrator subagent, which
// the sole-dispatcher rule would stop from spawning the panel (→ role-play).
function detectActiveMaster(cwd) {
  try {
    const root = cwd || process.cwd();
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = join(root, '.claude', f);
      if (!existsSync(p)) continue;
      const agent = JSON.parse(readFileSync(p, 'utf-8')).agent;
      if (typeof agent === 'string' && /^master-/.test(agent)) return agent;
    }
  } catch {}
  return null;
}

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

// v3.8.0: continuation detection — short follow-up messages should inherit
// the previous turn's tier instead of re-classifying. Eliminates the
// "user types 'ok' → haiku → guards block everything" failure mode.
function shouldInheritPreviousTier(prompt, previousSentinel) {
  if (!previousSentinel || !previousSentinel.tier) return false;
  // PRISM_CONVERSATION_MODE=1: always inherit when a sentinel exists,
  // regardless of length / approval / age. Opt-in for dev sessions.
  if (String(process.env.PRISM_CONVERSATION_MODE || '') === '1') return true;
  if (previousSentinel.tier === 'haiku') return false; // already cheap, no need to inherit

  const trimmed = String(prompt || '').trim().toLowerCase();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // Short messages (<8 words) AND previous turn was opus/sonnet AND sentinel
  // is recent (<5min old) → inherit.
  const APPROVAL_PHRASES = /\b(ok|okay|yes|yep|yeah|go|proceed|ship|approve|approved|continue|next|fine|good|sure|do it|let's go|run it|execute)\b/i;
  const isApproval = APPROVAL_PHRASES.test(trimmed);
  const isShort = wordCount < 8;
  const ageMs = previousSentinel.ts ? (Date.now() - new Date(previousSentinel.ts).getTime()) : Infinity;
  const isFresh = ageMs < 5 * 60 * 1000; // 5 min

  // FIX-A (v5.x): an empty/whitespace prompt is a notification / non-user turn,
  // not a real continuation — never inherit (would otherwise re-lock a panel
  // turn on a turn the user never typed). v5.0 stress-test finding.
  if (wordCount === 0) return false;

  return (isShort || isApproval) && isFresh;
}

function gitSnapshot(cwd) {
  // Best-effort git context for the classifier. Each call is bounded to
  // 800ms; failure is non-fatal — classifier still runs with empty context.
  const out = {branch: '', headSha: '', dirty: false, recentCommits: [], stagedFiles: []};
  if (!cwd) return out;
  const run = (args) => {
    try {
      const r = spawnSync('git', args, {cwd, encoding: 'utf-8', timeout: 800, windowsHide: true});
      return r.status === 0 ? (r.stdout || '').trim() : '';
    } catch { return ''; }
  };
  out.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  out.headSha = run(['rev-parse', '--short', 'HEAD']);
  const status = run(['status', '--porcelain']);
  out.dirty = !!status;
  const log = run(['log', '-5', '--oneline']);
  out.recentCommits = log ? log.split('\n').filter(Boolean) : [];
  const staged = run(['diff', '--cached', '--name-only']);
  out.stagedFiles = staged ? staged.split('\n').filter(Boolean) : [];
  return out;
}

function buildOverrideDirective(tier, summonPanel, sessionId) {
  // v3.2.0 self-override protocol: emitted only when keyword-floor produced
  // the classification (the bluntest path). The conversation model gets a
  // chance to correct an obviously-wrong tier by READING then writing a
  // corrected sentinel as its FIRST action, before any work tools fire.
  // Skipped on allowlist/force-opus where intent is explicit.
  const sid = String(sessionId || 'anon');
  const sentinelName = `~/.claude/.prism-turn-tier-${sid}.json`;
  return [
    '',
    'PRISM TIER OVERRIDE PROTOCOL (v3.2.0):',
    `keyword-floor classified this prompt as ${tier}. If you (the conversation model) believe this is wrong for the actual task complexity, correct it as your FIRST action of this turn: Read \`${sentinelName}\` first (it already exists — the router rewrites it every turn, so the Write tool refuses without a prior Read), THEN Write or Edit it with corrected fields {"tier":"<correct>","summon_panel":<bool>,"source":"conversation-model-override","rationale":"<why>"}. Otherwise, proceed normally and the keyword-floor classification stands.`,
  ].join('\n');
}

function formatAdvice(tier, rationale, mode, summonPanel, source, sessionId, activeMaster) {
  // New format — intentionally simpler than v2.1.3 so LLMs don't need to
  // parse h=/s=/o= tokens. The old score fields are preserved in the
  // sentinel file for debugging but not echoed to the model context.
  //
  // v2.5.0: when summon_panel=true on opus tier, the advice becomes a hard
  // directive to spawn @master-orchestrator. Parent-dispatch-guard enforces
  // this by denying work tools until orchestrator_dispatched=true.
  // v2.7.2: Windows BOM note appended to every dispatch advice — subagents
  // should use Edit/Write (not Bash/PowerShell) to avoid the default
  // UTF-8-with-BOM from Set-Content/Out-File/`>` redirect.
  const isWin = process.platform === 'win32';
  let advice = `PRISM TIER ROUTER: ${tier}. ${rationale || '(no rationale)'}`;
  let emittedDispatchAdvice = false;
  // v5.3.1: on every everyday dispatch turn, remind the main loop to BATCH
  // independent subtasks. Only the main loop can fan out (dispatched workers
  // have no Agent tool), and it only parallelises Agent() calls that arrive in
  // ONE message — so the default "one dispatch per turn" silently serialises
  // parallelisable work. This closes the everyday-path gap (the rich
  // dispatch-shapes.md guidance only loads under a formal plan/orchestrator).
  const parallelBatchNote = `\nPARALLEL: if this splits into 2+ INDEPENDENT subtasks (different files/targets, no shared output), dispatch them as MULTIPLE Agent() tool_use blocks in ONE message — they run concurrently (wall-clock = max(each), not sum). Don't dispatch one-at-a-time across turns. Cap 4 per batch (PRISM_PARALLEL_CAP).`;
  if (tier === 'haiku') {
    advice += `\nDispatch via Agent({subagent_type:'general-purpose', model:'haiku', prompt:'<task>'}) instead of running tools directly in parent Opus.`;
    if (mode === 'hard') advice += ` Parent tools will be DENIED until you dispatch. Override: prefix user prompt with !opus-force:.`;
    advice += parallelBatchNote;
    emittedDispatchAdvice = true;
  } else if (tier === 'sonnet') {
    advice += `\nDispatch implementation via Agent({subagent_type:'general-purpose', model:'sonnet'}). Parent Opus should orchestrate, plan, review.`;
    if (mode === 'hard') advice += ` Parent non-dispatch tools will be DENIED until you dispatch or call TaskCreate. Override: !opus-force:.`;
    advice += parallelBatchNote;
    emittedDispatchAdvice = true;
  } else if (tier === 'opus' && summonPanel && activeMaster) {
    // v5.2.5: the active agent IS a project-master with the orchestrator skill.
    // It chairs the panel itself in the main loop (where it CAN dispatch real,
    // independent panel members) instead of nesting a @master-orchestrator
    // subagent that the sole-dispatcher rule would reduce to role-play.
    advice += `\n\nPANEL-SUMMONING TURN. You are the active project-master (${activeMaster}) and you load the master-orchestrator skill — so YOU chair this panel directly in the main loop. Do NOT dispatch a nested @master-orchestrator (it would run as a subagent and PRISM's sole-dispatcher rule would stop it spawning the panel → role-play). Instead:`;
    advice += `\n  1. Enumerate the rostered specialists relevant to this request.`;
    advice += `\n  2. Dispatch your expert panel members — 3–5 of them — as INDEPENDENT, parallel subagents (one Agent() block each, different biases).`;
    advice += `\n  3. Chair adversarial review (≥2 substantive challenges per position).`;
    advice += `\n  4. Synthesize the verdict yourself and relay it.`;
    if (mode === 'hard') advice += `\nParent Write/Edit/Bash stay blocked until you have dispatched at least one panel member (so a real panel happens, not role-play). Override: !opus-force:.`;
    emittedDispatchAdvice = true;
  } else if (tier === 'opus' && summonPanel) {
    advice += `\n\nPANEL-SUMMONING TURN. This is a novel architectural request. Spawn @master-orchestrator as your NEXT action — do NOT synthesize the plan yourself in parent context. The orchestrator will:`;
    advice += `\n  1. Enumerate available skills, notebooks, and rostered specialists (PHASE 0a).`;
    advice += `\n  2. Assemble a panel of 3–5 expert subagents with different biases.`;
    advice += `\n  3. Chair adversarial review (≥2 substantive challenges per position).`;
    advice += `\n  4. Return a synthesized phased plan with explicit exclusions for you to relay.`;
    advice += `\nUse: Agent({subagent_type:'master-orchestrator', model:'opus', prompt:'<original user request, verbatim>'})`;
    if (mode === 'hard') advice += `\nParent Write/Edit/Bash DENIED until orchestrator is dispatched. Override: !opus-force: (single-model Opus) or PRISM_DISPATCH_GUARD=off.`;
    emittedDispatchAdvice = true;
  }
  // v2.7.2 Windows note — only emit on turns where we're actually telling the
  // model to dispatch (not on plain opus parent-work turns).
  if (isWin && emittedDispatchAdvice) {
    advice += `\n\nWINDOWS NOTE: inside subagent prompts, instruct them to use the Edit/Write/MultiEdit tools for file changes — NOT Bash/PowerShell. PowerShell's Set-Content, Out-File, and \`>\` redirection default to UTF-8 with BOM, which mangles files and breaks downstream tools. The Edit/Write tools produce clean UTF-8 (no BOM). If Bash is genuinely needed for a write, append \`-Encoding UTF8NoBOM\` to Set-Content/Out-File.`;
  }
  // opus-tier without summon_panel: no dispatch advice needed. Direct parent work allowed.

  // v3.2.0: append self-override directive when keyword-floor classified this
  // prompt and the tier is not allowlist/force-opus (those are explicit intent
  // and should not be overrideable by the conversation model).
  //
  // v5.0.x: do NOT append it on hard-mode PANEL turns. On those turns the
  // parent-dispatch-guard denies the very Write the protocol instructs (Write is
  // not in the guard's ALWAYS_ALLOW set), so the sentinel-write self-override is
  // unfollowable there — and panels are deliberately human-gated. The panel
  // branch above already gives the correct escape (spawn @master-orchestrator,
  // or the human prefixes !opus-force: / sets PRISM_DISPATCH_GUARD=off), so the
  // v3.2.0 text would only contradict it. Suppressing it removes the
  // advertise-an-escape-the-guard-forbids contradiction.
  const panelHardBlocked = mode === 'hard' && tier === 'opus' && summonPanel;
  if (source === 'keyword-floor' && !panelHardBlocked) {
    advice += '\n' + buildOverrideDirective(tier, summonPanel, sessionId);
  }
  return advice;
}

export async function run(payload) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};

    const input = payload || {};
    const prompt = String(input.prompt || '');
    const sessionId = input.session_id || 'anon';
    const cwd = input.cwd || process.cwd();

    // v3.8.0: continuation detection — short/approval follow-ups inherit prev tier.
    const prevSentinel = readSentinel(sessionId);
    if (shouldInheritPreviousTier(prompt, prevSentinel)) {
      const inheritedSentinel = {
        ...prevSentinel,
        ts: new Date().toISOString(),
        source: 'continuation-inherit',
        rationale: `inherited from previous turn (${prevSentinel.tier}); short or approval-phrase`,
        dispatched: false, // reset dispatch flag for new turn
        // FIX-A (v5.x): inherit the (expensive) TIER to keep work going, but
        // NEVER re-summon a panel — the panel already fired on the original
        // turn; carrying it forward deadlocks approval/continuation turns.
        summon_panel: false,
        orchestrator_dispatched: false,
      };
      try {
        const p = sentinelPath(sessionId);
        mkdirSync(dirname(p), {recursive: true});
        const tmp = p + '.tmp';
        writeFileSync(tmp, JSON.stringify(inheritedSentinel, null, 2));
        renameSync(tmp, p);
      } catch {
        try {
          const p = sentinelPath(sessionId);
          writeFileSync(p, JSON.stringify(inheritedSentinel, null, 2));
        } catch {}
      }
      appendLog({
        schema_version: 4,
        event: 'prompt_tier_router',
        ts: inheritedSentinel.ts,
        session_id: sessionId,
        tier: inheritedSentinel.tier,
        source: 'continuation-inherit',
        rationale: inheritedSentinel.rationale,
        summon_panel: !!inheritedSentinel.summon_panel,
        force_opus: !!inheritedSentinel.force_opus,
        mode: MODE,
        phase_1_5: null,  // v4.4: extended by hooks/prism-phase-1-5-oob.mjs with {fired, variant, verdict_pre, verdict_post, agreement_rate}
      });
      const advice = `PRISM TIER ROUTER: ${inheritedSentinel.tier} (continuation-inherit from previous turn). Source: continuation-inherit`;
      const out = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: advice,
        },
      };
      return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
    }

    const git = gitSnapshot(cwd);
    const classification = await classifyPrompt({
      prompt,
      cwd,
      branch: git.branch,
      headSha: git.headSha,
      dirty: git.dirty,
      recentCommits: git.recentCommits,
      stagedFiles: git.stagedFiles,
    });

    const sentinel = toSentinel(classification, {
      session_id: sessionId,
      mode: MODE,
    });

    // v5.2.5: if a project-master is the active agent, a panel turn is self-chaired.
    const activeMaster = detectActiveMaster(cwd);
    if (activeMaster && classification.summon_panel && sentinel.tier === 'opus') {
      sentinel.self_chair = true;
      sentinel.active_master = activeMaster;
    }

    try {
      // v2.8.0: atomic write via tempfile + rename. Prevents truncated
      // sentinel JSON if the hook is killed mid-write. Readers
      // (dispatch-guard, mutation-guard, agent-model-guard, task-tier-advisor)
      // never see a partial file.
      const p = sentinelPath(sessionId);
      mkdirSync(dirname(p), {recursive: true});
      const tmp = p + '.tmp';
      writeFileSync(tmp, JSON.stringify(sentinel, null, 2));
      renameSync(tmp, p);
    } catch {
      // Fallback: direct write if rename fails (e.g., tempdir on different
      // filesystem from sentinel — shouldn't happen since they're siblings,
      // but defensive).
      try {
        const p = sentinelPath(sessionId);
        writeFileSync(p, JSON.stringify(sentinel, null, 2));
      } catch {}
    }

    // v4.6: additive event types phase_0d_challenge + dispatch_cap (actual_parallel, queue_depth).
    // schema_version is the writer's version; readers must ignore unknown fields.
    appendLog({
      schema_version: 4,
      event: 'prompt_tier_router',
      ts: sentinel.ts,
      session_id: sessionId,
      tier: sentinel.tier,
      source: classification.source,
      rationale: classification.rationale,
      summon_panel: classification.summon_panel,
      force_opus: sentinel.force_opus,
      cache_key: classification.cache_key,
      mode: MODE,
      phase_1_5: null,  // v4.4: extended by hooks/prism-phase-1-5-oob.mjs with {fired, variant, verdict_pre, verdict_post, agreement_rate}
    });

    const advice = formatAdvice(sentinel.tier, classification.rationale, MODE, classification.summon_panel, classification.source, sessionId, sentinel.self_chair ? sentinel.active_master : null);
    const out = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: advice,
      },
    };
    return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
  } catch (e) {
    appendLog({event: 'prompt_tier_router', error: String(e && e.message || e), phase_1_5: null});
    return {exit: 0, stdout: '', stderr: ''};
  }
}

import {basename as _basename} from 'node:path';
const invokedDirectly = process.argv[1] && _basename(process.argv[1]) === 'prism-prompt-tier-router.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch {}
    const res = await run(payload);
    if (res.stdout) process.stdout.write(res.stdout);
    process.exit(res.exit || 0);
  })();
}
