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

import {readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync, renameSync} from 'fs';
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';
import {join, dirname, basename} from 'path';
import {createHash} from 'crypto';
import {pathToFileURL} from 'url';
import {spawn} from 'child_process';
import {withRosterLock} from '../tools/lib/prism-roster-lock.mjs';
import {resolveClaudeBin, OOB_REVIEWER_TIMEOUT_MS} from './lib/prism-oob-spawn.mjs';
import {capBytesTail, resolveMaxBytes} from './lib/prism-transcript-extract.mjs';
import {prismHome} from './lib/prism-home.mjs';

// Shared payload-sizing backstop (F7 Phase 3 follow-up). phase-0d overflowed on
// a 600-raw-line transcript feed; phase-1-5 feeds a single subagent output, not
// a raw transcript window, so it is far less exposed — BUT input.output /
// input.last_assistant_message are unbounded in principle and flow whole into
// the pending payload → JSON.stringify(pending) → `claude -p` stdin. Cap the
// output by BYTES (keep the most recent tail) so an oversized subagent message
// can't reproduce the same "Prompt is too long" reviewer failure. The 4096-byte
// readTranscriptTail fallback below is already bounded; this covers the other
// two sources. Env-overridable via PRISM_PHASE_1_5_MAX_INPUT_BYTES.
const PHASE_1_5_MAX_INPUT_BYTES = resolveMaxBytes('PRISM_PHASE_1_5_MAX_INPUT_BYTES');

const H = prismHome();
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

// R2 F2: bounded tail-read of a transcript file, used as a last-resort output
// source when no direct output field is present on the SubagentStop payload
// (measured 2026-07-20: real payloads carry `last_assistant_message` and
// `transcript_path`/`agent_transcript_path`, not `output`/`tool_response`/
// `transcript`). Reads at most `maxBytes` from the END of the file. Fail-open:
// any error (missing path, unreadable file, etc.) returns ''.
function readTranscriptTail(path, maxBytes = 4096) {
  if (!path || typeof path !== 'string') return '';
  try {
    if (!existsSync(path)) return '';
    const {size} = statSync(path);
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

// Exported pure function — SubagentStop OOB Phase 1.5 review.
// Returns {exit, stdout, stderr}. Never calls process.exit().
// R4: async mode returns {exit:0} IMMEDIATELY after spawn().unref() — never awaits child.
export async function run(payload) {
  // Recursion guard: if we're running inside a Claude Code session that
  // was spawned by this hook (e.g., the OOB reviewer's own session),
  // bail out immediately. Without this, an inner SubagentStop would
  // refire the hook → spawn another claude → ad infinitum.
  if (process.env.PRISM_OOB_REVIEWER_PROCESS === '1') {
    logEvent('recursion-guard');
    return { exit: 0, stdout: '', stderr: '' };
  }

  // Kill switch
  if (process.env.PRISM_DISABLE_OOB_REVIEW === '1') {
    logEvent('killswitch-env');
    return { exit: 0, stdout: '', stderr: '' };
  }

  const input = payload;

  const agentName = String(input.agent_type || input.subagent_type || input.agent_name || input.agent || input.agent_id || '').replace(/^@/, '');
  if (!agentName) {
    logEvent('no-agent-name');
    return { exit: 0, stdout: '', stderr: '' };
  }

  const sessionId = input.session_id || 'anon';
  const rawOutput = input.output || (input.tool_response && (input.tool_response.output || input.tool_response.content)) || input.transcript || input.last_assistant_message || readTranscriptTail(input.transcript_path || input.agent_transcript_path) || '';
  // Byte-cap the reviewer-bound output (keep the most recent tail) — see the
  // PHASE_1_5_MAX_INPUT_BYTES note above. No-op for normal-sized outputs.
  const output = capBytesTail(rawOutput, PHASE_1_5_MAX_INPUT_BYTES);
  const taskBrief = input.task_brief || (input.tool_input && input.tool_input.prompt) || '';

  if (!output || typeof output !== 'string' || output.length < 10) {
    logEvent('no-output');
    return { exit: 0, stdout: '', stderr: '' };
  }

  // Read roster to check tag
  const rosterPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  let roster;
  try {
    roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  } catch {
    logEvent('roster-unreadable');
    return { exit: 0, stdout: '', stderr: '' };
  }

  const entry = roster.agents && roster.agents[agentName];
  let armReason = 'tagged';
  if (!entry || entry.requires_phase_1_5 !== true) {
    // D051 Part B: GATED-OFF alternative arming path for live panel seats.
    // Panel seats are ad-hoc general-purpose dispatches — never roster-tagged
    // requires_phase_1_5 — so today they are never OOB-reviewed. Default OFF:
    // with PRISM_PANEL_SEAT_OOB unset, behavior below is unchanged (bails
    // agent-not-tagged). Only when BOTH the env opt-in is set AND the current
    // session's turn-tier sentinel shows summon_panel:true do we arm the
    // review for this untagged seat too (measurement-first, D028/D042).
    let armedAsPanelSeat = false;
    if (process.env.PRISM_PANEL_SEAT_OOB === '1') {
      try {
        const sentinelPath = join(H, '.claude', `.prism-turn-tier-${sessionId}.json`);
        if (existsSync(sentinelPath)) {
          const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'));
          armedAsPanelSeat = sentinel.summon_panel === true;
        }
      } catch {}
    }
    if (!armedAsPanelSeat) {
      logEvent('agent-not-tagged', {agent: agentName});
      return { exit: 0, stdout: '', stderr: '' };
    }
    armReason = 'panel-seat';
  }
  // Untagged panel-seat arming has no roster entry to read further tag-scoped
  // fields (skip_next_oob / requires_phase_1_5_block / phase_1_5_lite_oob)
  // from — fall back to a plain object so those all read as unset/false.
  const effectiveEntry = entry || {};

  // V1 — one-shot skip
  if (effectiveEntry.skip_next_oob === true) {
    try {
      await withRosterLock(rosterPath, async () => {
        const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
        if (r.agents?.[agentName]?.skip_next_oob) {
          delete r.agents[agentName].skip_next_oob;
          writeFileSync(rosterPath + '.tmp', JSON.stringify(r, null, 2));
          renameWithRetry(renameSync, rosterPath + '.tmp', rosterPath);
        }
      });
    } catch (e) {
      // Already loud (stderr + logEvent below) — this is not the silent
      // D046 shape, but bounded retry (task #82/#88) still reduces how
      // often this catch is reached under transient Windows AV/indexer
      // handle-lock contention on the shared roster.json.
      process.stderr.write(`[oob] failed to clear skip_next_oob: ${e.message}\n`);
    }
    process.stderr.write(`[oob] skip_next_oob honored for '${agentName}'; flag cleared\n`);
    logEvent('skip-next-oob', {agent: agentName});
    return { exit: 0, stdout: '', stderr: '' };
  }

  const blockMode = effectiveEntry.requires_phase_1_5_block === true;

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
    return { exit: 0, stdout: '', stderr: '' };
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

  // R1 F57 — mock/synthetic marker: a same-day PRISM_OOB_TEST_MOCK_SDK or
  // PRISM_PHASE_1_5_MOCK_VERDICT fire (or a session_id that is itself
  // synthetic/test-labeled) must not be countable as a genuine live fire by
  // /prism-health Step 2 (F3 PASS-WITH-CONCERNS finding — a same-day mock
  // line flipped the verdict to a false GREEN with zero real fires). Additive
  // fields only — existing fields (agent/sha/claims_count/mode) unchanged.
  const isMockEnv = process.env.PRISM_OOB_TEST_MOCK_SDK === '1' || !!process.env.PRISM_PHASE_1_5_MOCK_VERDICT;
  const isSyntheticSession = /^(synthetic|test|mock)[-_]/i.test(String(sessionId));
  const mock = isMockEnv || isSyntheticSession;
  logEvent('pending-written', {agent: agentName, sha, session_id: sessionId, mock, claims_count: claims.length, mode: blockMode ? 'block' : 'async', arm_reason: armReason});

  // Test-mode short-circuit (PRISM_OOB_TEST_MOCK_SDK path — preserved verbatim)
  if (process.env.PRISM_OOB_TEST_MOCK_SDK === '1') {
    flagLib.writeVerdict('1-5', sha, {
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
    return { exit: 0, stdout: '', stderr: '' };
  }

  // Real invocation via claude -p (Claude Code subscription auth)
  const useLite = effectiveEntry.phase_1_5_lite_oob === true;
  if (blockMode) {
    const verdict = await invokeReviewerInline(sha, flagLib, useLite);
    if (verdict && (verdict.summary.un_cited > 0 || verdict.summary.rejected > 0)) {
      // Block: decision-block JSON via stdout (Claude Code reads it)
      const reason = 'OOB PHASE 1.5 reviewer flagged ' + verdict.summary.un_cited + ' UN-CITED + ' + verdict.summary.rejected + ' REJECTED claims on @' + agentName + '. Verdict file: ~/.claude/.prism-phase-1-5-verdicts-' + sha + '.json. Bounce-ONCE per protocol.';
      return { exit: 2, stdout: JSON.stringify({decision: 'block', reason}), stderr: '' };
    }
    return { exit: 0, stdout: '', stderr: '' };
  } else {
    // Async: spawn child to invoke reviewer, return immediately (R4: never await).
    spawnAsyncReviewer(sha, useLite);
    return { exit: 0, stdout: '', stderr: '' };
  }
}

async function main() {
  // Parse input from stdin
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    logEvent('malformed-input');
    process.exit(0);
  }

  const res = await run(input);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.exit);
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

    // H4 mock-verdict short-circuit: if PRISM_PHASE_1_5_MOCK_VERDICT is set,
    // parse it directly into `parsed` and skip the real spawn. Flows into the
    // same augment + writeVerdict path below.
    let parsed;
    if (process.env.PRISM_PHASE_1_5_MOCK_VERDICT) {
      try {
        parsed = JSON.parse(process.env.PRISM_PHASE_1_5_MOCK_VERDICT);
      } catch {
        parsed = { schema_version: 1, severity: 'EVIDENCED', headline_finding: 'mock' };
      }
      logEvent('verdict-mock-env', {sha});
    } else {
      let res;
      try {
        res = await invokeReviewerClaudeCode({
          model: reviewerModel,
          systemPrompt: reviewerPrompt,
          userMessage,
          // D064 remedy 2: root-caused 2026-07-22. All 9 prior `reviewer-failed`
          // ETIMEDOUT entries were `pending-written -> reviewer-failed` exactly
          // ~50.2-50.3s apart (routing log), i.e. the spawn was killed AT the
          // old 50_000ms ceiling, not stuck indefinitely. Manual reproduction
          // of this exact spawnSync(claude, ['-p','--model',...]) call, same
          // argv/env/stdio, against the real reviewer prompt + real orphaned
          // pending payloads (5.8KB-27KB), completed successfully 3/3 times
          // (exit 0, valid JSON verdict) in 80s, 100s, and 111s wall-clock —
          // never hanging, always finishing, always well past 50s. This is
          // genuine `claude -p` cold-start + payload latency on this
          // SMB-mounted home dir, not a blocked/hung child (hypothesis (a),
          // not (b)/(c)/(d) — see D064 remedy 2 update for the full writeup).
          // 240_000ms gives >2x margin over the worst observed run; this call
          // is always reached via the detached/unref'd async worker
          // (spawnAsyncReviewer), so a longer ceiling costs nothing in
          // master-session latency — it only bounds the background worker.
          timeoutMs: OOB_REVIEWER_TIMEOUT_MS,
        });
      } catch (e) {
        logEvent('reviewer-failed', {sha, error: String(e && e.message), code: e && e.code});
        // D064 remedy 3: symmetric with the parse-failed branch below — a
        // reviewer-failed pending file has no retry consumer anywhere in the
        // codebase (verified: listPendingVerdicts() is called only from a
        // test; SessionStart only picks up completed *verdicts*, never
        // *pending* payloads). Leaving it on disk did not preserve a retry
        // path — it only leaked state (9 orphaned
        // .prism-phase-1-5-pending-*.json files, D064). Clear it here so new
        // failures do not keep leaking; the 9 pre-existing orphans are left
        // untouched as evidence per D064's "Deliberately NOT doing" section.
        flagLib.clearPending(sha);
        return null;
      }
      const text = res.content && res.content[0] && res.content[0].text || '';
      parsed = parseVerdictJson(text);
    }

    const latency = Date.now() - t0;
    if (!parsed) {
      logEvent('parse-failed', {sha});
      flagLib.clearPending(sha);
      return null;
    }
    parsed.session_id = pending.session_id;
    parsed.specialist_name = pending.specialist_name;
    parsed.reviewer_model = reviewerModel;
    parsed.reviewer_latency_ms = latency;
    flagLib.writeVerdict('1-5', sha, parsed);
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

  const res = spawnSync(resolveClaudeBin(), ['-p', '--model', model], {
    input: combined,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env,
    windowsHide: true,
  });

  if (res.error) {
    // spawnSync fail: derive the real OS/spawn error code instead of assuming
    // "binary missing" for every failure mode (that assumption previously
    // masked real ETIMEDOUT failures as CLAUDE_BINARY_MISSING). Reserve
    // CLAUDE_BINARY_MISSING strictly for genuine ENOENT.
    const underlyingCode = res.error.code || res.error.errno || 'UNKNOWN';
    const err = new Error(`claude -p spawn failed (${underlyingCode}): ${res.error.message}`);
    err.code = underlyingCode === 'ENOENT' ? 'CLAUDE_BINARY_MISSING' : underlyingCode;
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
    windowsHide: true,
    env: {...process.env, PRISM_OOB_ASYNC_WORKER: '1', PRISM_OOB_USE_LITE: useLite ? '1' : '0'},
  });
  child.unref();
}

// Async-worker entry: invoked by spawnAsyncReviewer.
// Must remain outside the invokedDirectly guard — the async-worker path
// uses process.argv[2] === '--async-worker', not the script filename.
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
  // Guard: only run main() when invoked as a hook, NOT when imported by tests.
  const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-phase-1-5-oob.mjs';
  if (invokedDirectly) {
    main().catch(() => process.exit(0));
  }
}
