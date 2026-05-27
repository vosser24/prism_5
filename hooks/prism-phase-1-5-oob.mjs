#!/usr/bin/env node
// PRISM v4.4 OOB PHASE 1.5 Reviewer hook — SubagentStop matcher.
//
// Reads SubagentStop input (subagent name + output), checks roster.json for
// requires_phase_1_5 tag, and if set:
//   - extracts load-bearing claims from output (simple regex pass)
//   - reads panel.json (if exists) for matching Phase 0d challenges
//   - writes pending file via tools/lib/prism-verdict-flag.mjs
//   - invokes reviewer via `claude -p` (Claude Code subscription auth)
//   - writes verdict result + appends log line
//
// Fail-open on every error path: hook NEVER blocks master on its own errors.
// Async mode = exit 0 immediately after spawn; reviewer runs in background
// and verdict picked up via SessionStart on next turn.
// Block mode (requires_phase_1_5_block: true) = wait for claude -p call to
// complete + exit 2 with decision-block JSON containing verdict in reason.
//
// Kill switches:
//   - PRISM_DISABLE_OOB_REVIEW=1 env var → immediate exit 0
//   - roster.<agent>.requires_phase_1_5: false (or missing) → exit 0
//   - PRISM_OOB_REVIEWER_PROCESS=1 (set by this hook before spawning
//     claude -p) → immediate exit 0 (recursion guard)
//
// Test mode: PRISM_OOB_TEST_MOCK_SDK=1 → skip real claude -p call, write stub
// verdict instead.
//
// No npm dependencies. Uses spawnSync('claude', ['-p', ...]) via Claude Code
// subscription auth (no separate ANTHROPIC_API_KEY required).

import {readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';
import {pathToFileURL} from 'url';
import {spawn} from 'child_process';
import {withRosterLock} from '../tools/lib/prism-roster-lock.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');

function appendRoutingLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function logEvent(event, extra) {
  appendRoutingLog({
    ts: new Date().toISOString(),
    event: 'phase_1_5_oob',
    action: event,
    ...extra,
  });
}

async function main() {
  // Recursion guard: if we're running inside a Claude Code session that
  // was spawned by this hook (e.g., the OOB reviewer's own session),
  // bail out immediately. Without this, an inner SubagentStop would
  // refire the hook → spawn another claude → ad infinitum.
  if (process.env.PRISM_OOB_REVIEWER_PROCESS === '1') {
    logEvent('recursion-guard');
    return 0;
  }

  // Kill switch
  if (process.env.PRISM_DISABLE_OOB_REVIEW === '1') {
    logEvent('killswitch-env');
    return 0;
  }

  // Parse input
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    logEvent('malformed-input');
    return 0;
  }

  const agentName = String(input.agent_name || input.agent || input.subagent_type || '').replace(/^@/, '');
  if (!agentName) {
    logEvent('no-agent-name');
    return 0;
  }

  const sessionId = input.session_id || 'anon';
  const output = input.output || (input.tool_response && (input.tool_response.output || input.tool_response.content)) || input.transcript || '';
  const taskBrief = input.task_brief || (input.tool_input && input.tool_input.prompt) || '';

  if (!output || typeof output !== 'string' || output.length < 10) {
    logEvent('no-output');
    return 0;
  }

  // Read roster to check tag
  const rosterPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  let roster;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  } catch {
    logEvent('roster-unreadable');
    return 0;
  }

  const entry = roster.agents && roster.agents[agentName];
  if (!entry || entry.requires_phase_1_5 !== true) {
    logEvent('agent-not-tagged', {agent: agentName});
    return 0;
  }

  // V1 — one-shot skip
  if (entry.skip_next_oob === true) {
    try {
      await withRosterLock(rosterPath, async () => {
        const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
        if (r.agents?.[agentName]?.skip_next_oob) {
          delete r.agents[agentName].skip_next_oob;
          writeFileSync(rosterPath + '.tmp', JSON.stringify(r, null, 2));
          const {renameSync} = await import('fs');
          renameSync(rosterPath + '.tmp', rosterPath);
        }
      });
    } catch (e) { process.stderr.write(`[oob] failed to clear skip_next_oob: ${e.message}\n`); }
    process.stderr.write(`[oob] skip_next_oob honored for '${agentName}'; flag cleared\n`);
    logEvent('skip-next-oob', {agent: agentName});
    return 0;
  }

  const blockMode = entry.requires_phase_1_5_block === true;

  // Compute per-dispatch SHA
  const sha = createHash('sha256')
    .update(sessionId + Date.now() + agentName + output.slice(0, 100))
    .digest('hex')
    .slice(0, 16);

  // Load verdict-flag lib (sibling tools/lib/)
  let flagLib;
  try {
    const libPath = join(H, '.claude', 'tools', 'lib', 'prism-verdict-flag.mjs');
    if (!existsSync(libPath)) {
      // dev install: fall back to repo path
      flagLib = await import(pathToFileURL(join(process.cwd(), 'tools', 'lib', 'prism-verdict-flag.mjs')).href);
    } else {
      flagLib = await import(pathToFileURL(libPath).href);
    }
  } catch (e) {
    logEvent('lib-load-failed', {error: String(e && e.message)});
    return 0;
  }

  // Extract load-bearing claims (simple regex pass — anything that looks like an assertion)
  const claims = extractClaims(output);

  // Read panel.json for cross-link (if exists)
  const taskId = input.task_id || (roster.current_task_id) || null;
  let phase0dChallenges = [];
  if (taskId) {
    const panelPath = join(H, '.claude', '.prism-task-' + taskId, 'panel.json');
    try {
      if (existsSync(panelPath)) {
        const panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
        for (const pos of (panel.positions || [])) {
          if (pos.specialist === '@' + agentName || pos.specialist === agentName) {
            phase0dChallenges = phase0dChallenges.concat(pos.challenges || []);
          }
        }
      }
    } catch {}
  }

  // Write pending
  flagLib.writePending(sha, {
    session_id: sessionId,
    specialist_name: '@' + agentName,
    task_brief: taskBrief,
    specialist_output: output,
    phase_0d_challenges: phase0dChallenges,
    extracted_claims: claims,
    block_master: blockMode,
  });

  logEvent('pending-written', {agent: agentName, sha, claims_count: claims.length, mode: blockMode ? 'block' : 'async'});

  // Test-mode short-circuit
  if (process.env.PRISM_OOB_TEST_MOCK_SDK === '1') {
    flagLib.writeVerdict(sha, {
      session_id: sessionId,
      specialist_name: '@' + agentName,
      reviewer_model: 'claude-sonnet-4-6-MOCK',
      verdicts: claims.map((c, i) => ({
        claim_id: 'claim-' + (i + 1),
        class: 'correctness',
        verdict: 'EVIDENCED',
        taxonomy_row: 'Correctness',
        evidence_required: '',
        reasoning: 'MOCK MODE',
      })),
      challenges_addressed: [],
      summary: {total: claims.length, evidenced: claims.length, un_cited: 0, rejected: 0},
      reviewer_latency_ms: 1,
    });
    flagLib.clearPending(sha);
    logEvent('verdict-mock', {sha});
    return 0;
  }

  // Real invocation via claude -p (Claude Code subscription auth)
  const useLite = entry.phase_1_5_lite_oob === true;
  if (blockMode) {
    const verdict = await invokeReviewerInline(sha, flagLib, useLite);
    if (verdict && (verdict.summary.un_cited > 0 || verdict.summary.rejected > 0)) {
      // Block: decision-block JSON via stdout (Claude Code reads it)
      const reason = 'OOB PHASE 1.5 reviewer flagged ' + verdict.summary.un_cited + ' UN-CITED + ' + verdict.summary.rejected + ' REJECTED claims on @' + agentName + '. Verdict file: ~/.claude/.prism-phase-1-5-verdicts-' + sha + '.json. Bounce-ONCE per protocol.';
      process.stdout.write(JSON.stringify({decision: 'block', reason}));
      return 2;
    }
    return 0;
  } else {
    // Async: spawn child to invoke reviewer, return immediately
    spawnAsyncReviewer(sha, useLite);
    return 0;
  }
}

function extractClaims(output) {
  // Naive extraction: each non-trivial sentence becomes a claim.
  // Production hook can use a more sophisticated extractor.
  const sentences = output.split(/(?<=[.!?])\s+/).filter(s => s.length > 20 && s.length < 300);
  return sentences.slice(0, 10).map((s, i) => ({
    id: 'claim-' + (i + 1),
    claim_text: s.trim(),
    claim_class_hint: hintClass(s),
    source_line: i + 1,
  }));
}

function hintClass(s) {
  if (/\b(fast|slow|scales|performance|latency|throughput|cheap|expensive)\b/i.test(s)) return 'performance';
  if (/\b(secure|safe|threat|vulnerability|owasp|cwe)\b/i.test(s)) return 'security';
  if (/\b(compatible|works on|version|supports)\b/i.test(s)) return 'compatibility';
  if (/\b(covers|complete|exhaustive|all cases)\b/i.test(s)) return 'completeness';
  return 'correctness';
}

async function invokeReviewerInline(sha, flagLib, useLite = false) {
  // Invokes the OOB reviewer via `claude -p` (Claude Code subscription auth).
  // Prompt delivered via stdin to avoid Windows ENAMETOOLONG on >32KB payloads.
  // useLite: when true (roster.phase_1_5_lite_oob === true), use the shorter
  // LITE reviewer prompt instead of the full one.
  try {
    const pending = flagLib.readPending(sha);
    if (!pending) return null;

    // Read reviewer agent file for the model + system prompt
    const REVIEWER_FILE_FULL = join(H, '.claude', 'agents', 'phase-1-5-oob-reviewer.md');
    const REVIEWER_FILE_LITE = join(H, '.claude', 'agents', 'phase-1-5-oob-reviewer-lite.md');
    const reviewerFile = (useLite && existsSync(REVIEWER_FILE_LITE)) ? REVIEWER_FILE_LITE : REVIEWER_FILE_FULL;
    let reviewerPrompt = 'You are an OOB PHASE 1.5 reviewer. Return JSON with a verdicts array.';
    let reviewerModel = 'claude-sonnet-4-6';
    try {
      const raw = readFileSync(reviewerFile, 'utf-8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const modelMatch = fmMatch[1].match(/^model:\s*(\S+)/m);
        if (modelMatch) reviewerModel = modelMatch[1];
        reviewerPrompt = raw.split('---').slice(2).join('---').trim() || reviewerPrompt;
      }
    } catch {}

    const userMessage = JSON.stringify(pending);
    const t0 = Date.now();
    let res;
    try {
      res = await invokeReviewerClaudeCode({
        model: reviewerModel,
        systemPrompt: reviewerPrompt,
        userMessage,
        timeoutMs: 50_000,
      });
    } catch (e) {
      logEvent('reviewer-failed', {sha, error: String(e && e.message), code: e && e.code});
      return null;
    }
    const latency = Date.now() - t0;
    const text = res.content && res.content[0] && res.content[0].text || '';
    const parsed = parseVerdictJson(text);
    if (!parsed) {
      logEvent('parse-failed', {sha});
      flagLib.clearPending(sha);
      return null;
    }
    parsed.session_id = pending.session_id;
    parsed.specialist_name = pending.specialist_name;
    parsed.reviewer_model = reviewerModel;
    parsed.reviewer_latency_ms = latency;
    flagLib.writeVerdict(sha, parsed);
    flagLib.clearPending(sha);
    logEvent('verdict-written', {sha, latency_ms: latency, summary: parsed.summary});
    return parsed;
  } catch (e) {
    logEvent('reviewer-exception', {sha, error: String(e && e.message)});
    return null;
  }
}

async function invokeReviewerClaudeCode({model, systemPrompt, userMessage, timeoutMs}) {
  const {spawnSync} = await import('node:child_process');
  // Combine system + user into one prompt since `claude -p` via stdin
  // doesn't have a separate system-prompt slot.
  const combined = [
    '=== SYSTEM (reviewer prompt) ===',
    systemPrompt,
    '',
    '=== USER (dispatched payload to review) ===',
    userMessage,
    '',
    '=== INSTRUCTIONS ===',
    'Return ONLY the JSON verdict per the schema in the system block above.',
    'No prose preamble, no markdown fences.',
  ].join('\n');

  const env = {
    ...process.env,
    PRISM_OOB_REVIEWER_PROCESS: '1', // recursion guard for any inner hook fires
  };

  const res = spawnSync('claude', ['-p', '--model', model], {
    input: combined,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env,
    windowsHide: true,
  });

  if (res.error) {
    // spawnSync fail: claude binary not on PATH, OS-level error
    const err = new Error(`claude binary not available: ${res.error.message}`);
    err.code = 'CLAUDE_BINARY_MISSING';
    throw err;
  }
  if (res.signal === 'SIGTERM') {
    const err = new Error('claude -p timed out');
    err.code = 'CLAUDE_TIMEOUT';
    throw err;
  }
  if (res.status !== 0) {
    const err = new Error(`claude -p exit ${res.status}: ${(res.stderr || '').slice(0, 200)}`);
    err.code = 'CLAUDE_NONZERO';
    err.status = res.status;
    throw err;
  }

  // Return a shape that parseVerdictJson can consume (preserving the same
  // {content: [{text: '...'}]} contract as the old fetch() path).
  return {content: [{text: res.stdout}]};
}

function parseVerdictJson(text) {
  try {
    // Scan for first { / last } — robust against prose-wrapped reviewer responses
    const start = text.indexOf('{');
    if (start === -1) return null;
    const end = text.lastIndexOf('}');
    if (end < start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function spawnAsyncReviewer(sha, useLite = false) {
  // Spawn detached child running this same script with --async-worker <sha>
  const child = spawn('node', [process.argv[1], '--async-worker', sha], {
    detached: true,
    stdio: 'ignore',
    env: {...process.env, PRISM_OOB_ASYNC_WORKER: '1', PRISM_OOB_USE_LITE: useLite ? '1' : '0'},
  });
  child.unref();
}

// Async-worker entry: invoked by spawnAsyncReviewer
if (process.argv[2] === '--async-worker' && process.argv[3]) {
  (async () => {
    const sha = process.argv[3];
    const libPath = join(H, '.claude', 'tools', 'lib', 'prism-verdict-flag.mjs');
    const flagLib = await import(pathToFileURL(existsSync(libPath) ? libPath : join(process.cwd(), 'tools', 'lib', 'prism-verdict-flag.mjs')).href);
    const useLite = process.env.PRISM_OOB_USE_LITE === '1';
    await invokeReviewerInline(sha, flagLib, useLite);
    process.exit(0);
  })().catch(() => process.exit(0));
} else {
  main().then(code => process.exit(code || 0)).catch(() => process.exit(0));
}
