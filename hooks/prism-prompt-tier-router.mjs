#!/usr/bin/env node
// PRISM Prompt Tier Router (v2.2.0) — UserPromptSubmit
//
// BREAKING (vs v2.1.3): replaces the keyword score-classifier with an
// Opus-backed context classifier. Output format changed from
//   "PRISM TIER ROUTER: prompt scored N (X-tier, h=N s=N o=N)..."
// to
//   "PRISM TIER ROUTER: {tier}. {rationale}"
//
// The sentinel on disk keeps its prior shape so prism-parent-dispatch-guard
// continues to read it unchanged. The legacy {h, s, o, score, compound}
// fields are retained as zeros for compatibility; downstream code that
// routes off them should migrate to `rationale` / `source`.
//
// Fallback chain: force-opus prefix → slash-command allowlist → 24h cache →
// Opus API → Sonnet API → keyword floor. See hooks/lib/prism-opus-classifier.mjs.
//
// Modes (PRISM_PROMPT_ROUTER env var, defaults to hard):
//   hard: sentinel + advice that mentions enforcement
//   soft: sentinel + advice only
//   off:  no-op

import {readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {classifyPrompt, toSentinel} from './lib/prism-opus-classifier.mjs';

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

function gitSnapshot(cwd) {
  // Best-effort git context for the classifier. Each call is bounded to
  // 800ms; failure is non-fatal — classifier still runs with empty context.
  const out = {branch: '', headSha: '', dirty: false, recentCommits: [], stagedFiles: []};
  if (!cwd) return out;
  const run = (args) => {
    try {
      const r = spawnSync('git', args, {cwd, encoding: 'utf-8', timeout: 800});
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

function formatAdvice(tier, rationale, mode, summonPanel) {
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
  if (tier === 'haiku') {
    advice += `\nDispatch via Agent({subagent_type:'general-purpose', model:'haiku', prompt:'<task>'}) instead of running tools directly in parent Opus.`;
    if (mode === 'hard') advice += ` Parent tools will be DENIED until you dispatch. Override: prefix user prompt with !opus-force:.`;
    emittedDispatchAdvice = true;
  } else if (tier === 'sonnet') {
    advice += `\nDispatch implementation via Agent({subagent_type:'general-purpose', model:'sonnet'}). Parent Opus should orchestrate, plan, review.`;
    if (mode === 'hard') advice += ` Parent non-dispatch tools will be DENIED until you dispatch or call TaskCreate. Override: !opus-force:.`;
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
  return advice;
}

async function main() {
  try {
    if (MODE === 'off') process.exit(0);

    const raw = readFileSync(0, 'utf-8');
    const input = JSON.parse(raw || '{}');
    const prompt = String(input.prompt || '');
    const sessionId = input.session_id || 'anon';
    const cwd = input.cwd || process.cwd();

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

    appendLog({
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
    });

    const advice = formatAdvice(sentinel.tier, classification.rationale, MODE, classification.summon_panel);
    const out = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: advice,
      },
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (e) {
    appendLog({event: 'prompt_tier_router', error: String(e && e.message || e)});
    process.exit(0);
  }
}

main();
