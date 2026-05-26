#!/usr/bin/env node
// PRISM v4.4 OOB PHASE 1.5 Reviewer hook — SubagentStop matcher.
//
// Reads SubagentStop input (subagent name + output), checks roster.json for
// requires_phase_1_5 tag, and if set:
//   - extracts load-bearing claims from output (simple regex pass)
//   - reads panel.json (if exists) for matching Phase 0d challenges
//   - writes pending file via tools/lib/prism-verdict-flag.mjs
//   - invokes Anthropic API reviewer via built-in fetch() (async by default,
//     inline+block on flag)
//   - writes verdict result + appends log line
//
// Fail-open on every error path: hook NEVER blocks master on its own errors.
// Async mode = exit 0 immediately after spawn; reviewer runs in background
// and verdict picked up via SessionStart on next turn.
// Block mode (requires_phase_1_5_block: true) = wait for API call to complete
// + exit 2 with decision-block JSON containing verdict in reason.
//
// Kill switches:
//   - PRISM_DISABLE_OOB_REVIEW=1 env var → immediate exit 0
//   - roster.<agent>.requires_phase_1_5: false (or missing) → exit 0
//   - ANTHROPIC_API_KEY unset → exit 0 with stderr warn
//
// Test mode: PRISM_OOB_TEST_MOCK_SDK=1 → skip real API call, write stub
// verdict instead.
//
// No npm dependencies. Uses Node 18+ built-in fetch().

import {readFileSync, existsSync, mkdirSync, appendFileSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';
import {pathToFileURL} from 'url';
import {spawn} from 'child_process';

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

  // Real API call
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('PRISM OOB: ANTHROPIC_API_KEY unset; skipping review.\n');
    logEvent('no-api-key', {sha});
    return 0;
  }

  if (blockMode) {
    const verdict = await invokeReviewerInline(sha, flagLib);
    if (verdict && (verdict.summary.un_cited > 0 || verdict.summary.rejected > 0)) {
      // Block: decision-block JSON via stdout (Claude Code reads it)
      const reason = 'OOB PHASE 1.5 reviewer flagged ' + verdict.summary.un_cited + ' UN-CITED + ' + verdict.summary.rejected + ' REJECTED claims on @' + agentName + '. Verdict file: ~/.claude/.prism-phase-1-5-verdicts-' + sha + '.json. Bounce-ONCE per protocol.';
      process.stdout.write(JSON.stringify({decision: 'block', reason}));
      return 2;
    }
    return 0;
  } else {
    // Async: spawn child to invoke reviewer, return immediately
    spawnAsyncReviewer(sha);
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

async function invokeReviewerInline(sha, flagLib) {
  // Real API call — uses Node 18+ built-in fetch() against Anthropic API directly.
  // No @anthropic-ai/sdk dependency (PRISM is dep-free by design).
  // Skipped in test mode (handled above).
  try {
    const pending = flagLib.readPending(sha);
    if (!pending) return null;

    // Load reviewer system prompt from agent file
    let reviewerPrompt = 'You are an OOB PHASE 1.5 reviewer. Return JSON with a verdicts array.';
    try {
      const agentPath = join(H, '.claude', 'agents', 'phase-1-5-oob-reviewer.md');
      if (existsSync(agentPath)) {
        const raw = readFileSync(agentPath, 'utf-8');
        reviewerPrompt = raw.split('---').slice(2).join('---').trim() || reviewerPrompt;
      }
    } catch {}

    const userMessage = JSON.stringify(pending);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = 'claude-sonnet-4-6';
    const maxTokens = 2000;

    const t0 = Date.now();
    let body;
    try {
      body = await invokeReviewerHttp({apiKey, model, systemPrompt: reviewerPrompt, userMessage, maxTokens});
    } catch (e) {
      if (e && e.status === 529) {
        // single retry per 529 policy
        await new Promise(r => setTimeout(r, 5000));
        try {
          body = await invokeReviewerHttp({apiKey, model, systemPrompt: reviewerPrompt, userMessage, maxTokens});
        } catch (e2) {
          logEvent('api-failed', {sha, error: String(e2 && e2.message)});
          return null;
        }
      } else {
        logEvent('api-failed', {sha, error: String(e && e.message)});
        return null;
      }
    }

    const latency = Date.now() - t0;
    const text = body.content && body.content[0] && body.content[0].text || '';
    const parsed = parseVerdictJson(text);
    if (!parsed) {
      logEvent('parse-failed', {sha});
      return null;
    }
    parsed.session_id = pending.session_id;
    parsed.specialist_name = pending.specialist_name;
    parsed.reviewer_model = model;
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

async function invokeReviewerHttp({apiKey, model, systemPrompt, userMessage, maxTokens}) {
  // Node 18+ global fetch. Returns parsed response body or throws on non-2xx.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{role: 'user', content: userMessage}],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error('Anthropic API ' + res.status + ': ' + txt.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

function parseVerdictJson(text) {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function spawnAsyncReviewer(sha) {
  // Spawn detached child running this same script with --async-worker <sha>
  const child = spawn('node', [process.argv[1], '--async-worker', sha], {
    detached: true,
    stdio: 'ignore',
    env: {...process.env, PRISM_OOB_ASYNC_WORKER: '1'},
  });
  child.unref();
}

// Async-worker entry: invoked by spawnAsyncReviewer
if (process.argv[2] === '--async-worker' && process.argv[3]) {
  (async () => {
    const sha = process.argv[3];
    const libPath = join(H, '.claude', 'tools', 'lib', 'prism-verdict-flag.mjs');
    const flagLib = await import(pathToFileURL(existsSync(libPath) ? libPath : join(process.cwd(), 'tools', 'lib', 'prism-verdict-flag.mjs')).href);
    await invokeReviewerInline(sha, flagLib);
    process.exit(0);
  })();
} else {
  main().then(code => process.exit(code || 0)).catch(() => process.exit(0));
}
