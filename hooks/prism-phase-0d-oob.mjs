#!/usr/bin/env node
// hooks/prism-phase-0d-oob.mjs
// v4.5 Layer 2 (A1) — Out-of-band Phase 0d panel-quality reviewer.
// Fires on PostToolUse matching Write to panel.json paths. Reads panel.json
// + master transcript tail + roster, spawns `claude -p` with the reviewer
// prompt, writes verdict to ~/.claude/.prism-phase-0d-verdicts-<sha>.json.
// Picked up by SessionStart hook (existing v4.4 path).
//
// Kill switches:
//   - PRISM_PHASE_0D_OOB_PROCESS=1 (set before spawning claude -p) → exit 0
//     (recursion guard prevents inner hook re-fires)
//   - PRISM_DISABLE_OOB_REVIEW=1 → exit 0
//
// Fail-open on every error path: hook NEVER blocks master on its own errors.
//
// v5.6 R4: run() is fire-and-forget — launches the reviewer in a detached
// child process so the PostToolUse dispatcher returns immediately. The MOCK
// path (PRISM_PHASE_0D_MOCK_VERDICT) stays synchronous to preserve test
// contracts. When invoked directly as a CLI process (invokedDirectly), the
// reviewer runs in-process synchronously (preserves the regression test
// contract where verdict must be written before the process exits).

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { renameWithRetry } from '../tools/lib/atomic-fs.mjs';
import { createHash } from 'node:crypto';
import { withRosterLock } from '../tools/lib/prism-roster-lock.mjs';
import { writeVerdict } from '../tools/lib/prism-verdict-flag.mjs';
import { resolveClaudeBin, OOB_REVIEWER_TIMEOUT_MS } from './lib/prism-oob-spawn.mjs';
import { extractDeliberation, resolveMaxBytes } from './lib/prism-transcript-extract.mjs';

const __filename = fileURLToPath(import.meta.url);
const __thisfile = __filename;
const repoRoot = dirname(dirname(__filename));
const PROMPT_PATH = join(repoRoot, 'agents', 'phase-0d-oob-reviewer.md');
// F7 Phase 3: widened 200 -> 600. On the hook-recorded (structural) panel path
// the panel.json carries STRUCTURE only — every position's challenges[] is empty
// by construction — so ALL challenge substance the reviewer grades now lives in
// this transcript window, not in the artifact. 200 lines routinely truncated the
// deliberation; 600 gives the reviewer enough to grade (or to correctly return
// INSUFFICIENT). The call is backgrounded + 240s-bounded, so the larger payload
// costs no master-session latency.
//
// F7 Phase 3 FOLLOW-UP: 600 lines here is only a SCAN WINDOW, no longer the raw
// payload. On a real long tool-heavy session 600 raw JSONL lines = ~1.2 MB
// (each line is a full event: tool_use inputs, tool_result outputs, system
// reminders) → `claude -p` returns "Prompt is too long" → severity:"ERROR" is
// surfaced by SessionStart (cry-wolf). We now feed this window through
// extractDeliberation() (assistant-turn text only) and hard-cap the transcript
// portion by BYTES (PHASE_0D_MAX_INPUT_BYTES) — the byte cap is the real
// guarantee that an oversized reviewer prompt is impossible.
const TRANSCRIPT_WINDOW_LINES = 600;

// Backstop byte cap on the transcript portion of the reviewer prompt. The
// dominant term (panel.json + roster are small on the structural path), so
// capping the transcript alone bounds the whole payload well under the model
// context window. Env-overridable via PRISM_PHASE_0D_MAX_INPUT_BYTES.
const PHASE_0D_MAX_INPUT_BYTES = resolveMaxBytes('PRISM_PHASE_0D_MAX_INPUT_BYTES');

// ─── pending-file helpers (verdict result goes through the shared lib) ───────

function dotClaudeDir() {
  const d = join(homedir(), '.claude');
  try { mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function atomicWrite(filePath, content) {
  try {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, content, 'utf-8');
    renameWithRetry(renameSync, tmp, filePath);
  } catch (renameErr) {
    try {
      writeFileSync(filePath, content, 'utf-8'); // direct fallback
      process.stderr.write(`[phase-0d-oob] atomic rename failed for ${filePath} (${(renameErr && renameErr.code) || 'unknown'}); wrote directly instead\n`);
    } catch (fallbackErr) {
      process.stderr.write(`[phase-0d-oob] write failed for ${filePath}: ${fallbackErr.message}\n`);
      throw fallbackErr;
    }
  }
}

// ─── stdin / payload helpers ──────────────────────────────────────────────────

async function readHookPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function panelPathFromToolInput(payload) {
  const fp = payload?.tool_input?.file_path;
  if (!fp) return null;
  if (!/\.prism-task-[^/\\]+[/\\]panel\.json$/.test(fp)) return null;
  return fp;
}

export function extractTaskSha(panelPath) {
  const m = panelPath.match(/\.prism-task-([^/\\]+)/);
  return m ? m[1] : null;
}

function readTranscriptTail(transcriptPath, lines) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const allLines = raw.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch { return ''; }
}

// ─── reviewer body (extracted verbatim from the old main(), minus the guards) ─

async function runReviewerInProcess(payload, panelPath, taskSha) {
  let panel;
  try {
    panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
  } catch (e) {
    process.stderr.write(`[phase-0d-oob] cannot parse panel.json: ${e.message}\n`);
    return;
  }

  // Roster snapshot — for specialists named in the panel
  const rosterPath = join(homedir(), '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  let roster = {};
  try { roster = JSON.parse(readFileSync(rosterPath, 'utf-8')); }
  catch { /* swallow; OOB tolerates missing roster */ }

  const relevantAgents = (panel.positions ?? [])
    .map(p => p.specialist)
    .filter(Boolean)
    .reduce((acc, spec) => {
      const key = spec.replace(/^@/, '');
      if (roster.agents?.[key]) acc[key] = roster.agents[key];
      return acc;
    }, {});

  // V1 — one-shot skip: if ANY panel specialist has skip_next_oob, skip this
  // Phase 0d review and atomically clear all such flags.
  const skipKeys = Object.keys(relevantAgents).filter(k => relevantAgents[k]?.skip_next_oob === true);
  if (skipKeys.length > 0) {
    try {
      await withRosterLock(rosterPath, async () => {
        const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
        let changed = false;
        for (const k of skipKeys) {
          if (r.agents?.[k]?.skip_next_oob) {
            delete r.agents[k].skip_next_oob;
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(rosterPath, JSON.stringify(r, null, 2), 'utf-8');
        }
      });
    } catch (e) { process.stderr.write(`[phase-0d-oob] failed to clear skip_next_oob: ${e.message}\n`); }
    process.stderr.write(`[phase-0d-oob] skip_next_oob honored for [${skipKeys.join(', ')}]; flags cleared\n`);
    return;
  }

  // Reviewer prompt
  let promptText = '';
  try {
    promptText = readFileSync(PROMPT_PATH, 'utf-8');
  } catch (e) {
    process.stderr.write(`[phase-0d-oob] cannot read reviewer prompt: ${e.message}\n`);
    return;
  }

  // S6 transcript hardening: transcript_path is load-bearing and not always
  // present on every event shape. Mirror phase-1-5-oob.mjs's fallback chain
  // (transcript_path || agent_transcript_path). The Stop-gated trigger already
  // refuses to fire when NO transcript exists (it logs no_transcript_path), so
  // by here we should have one; the fallback is defense-in-depth.
  const rawTranscriptWindow = readTranscriptTail(
    payload?.transcript_path || payload?.agent_transcript_path,
    TRANSCRIPT_WINDOW_LINES,
  );
  // Bound the payload: extract assistant-turn deliberation (drop tool_use /
  // tool_result / thinking / system-reminder noise) from the 600-line scan
  // window, then hard-cap by bytes. This is the F7 Phase 3 follow-up fix — the
  // byte cap makes a "Prompt is too long" reviewer failure impossible even on a
  // multi-MB long-session transcript. Fail-open: a parse failure inside
  // extractDeliberation falls back to a byte-capped raw tail.
  const transcriptTail = extractDeliberation(rawTranscriptWindow, {
    maxBytes: PHASE_0D_MAX_INPUT_BYTES,
  });

  const combinedInput = [
    '---PANEL.JSON---',
    JSON.stringify(panel, null, 2),
    '---MASTER TRANSCRIPT WINDOW---',
    transcriptTail,
    '---ROSTER SNAPSHOT---',
    JSON.stringify(relevantAgents, null, 2),
  ].join('\n\n');

  // Dispatch SHA — names the verdict/pending files.
  //   • Write path (model-authored panel.json): no caller sha → a per-dispatch
  //     unique sha (Date.now()) so concurrent writes don't collide.
  //   • Stop-gated path (F7 Phase 3): the caller supplies a STABLE per-latch sha
  //     (payload.stable_sha) so every turn-end fire OVERWRITES the same verdict
  //     file with a progressively richer review (final fire = post-challenge),
  //     instead of leaking one verdict file per turn.
  const suppliedSha = (typeof payload?.stable_sha === 'string' && /^[a-f0-9]{8,64}$/i.test(payload.stable_sha))
    ? payload.stable_sha
    : null;
  const dispatchSha = suppliedSha || createHash('sha256')
    .update(taskSha + Date.now() + panelPath)
    .digest('hex')
    .slice(0, 16);

  // Write pending flag immediately (consumed by SessionStart pickup even if
  // the reviewer process fails or times out)
  const pendingPath = join(dotClaudeDir(), `.prism-phase-0d-pending-${dispatchSha}.json`);
  try {
    atomicWrite(pendingPath, JSON.stringify({
      kind: 'phase_0d',
      task_sha: taskSha,
      dispatch_sha: dispatchSha,
      panel_path: panelPath,
      started_at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    process.stderr.write(`[phase-0d-oob] pending write failed: ${e.message}\n`);
  }

  // H4 mock-verdict short-circuit: if PRISM_PHASE_0D_MOCK_VERDICT is set,
  // parse it as the verdict and skip the real spawn. Flows into the existing
  // write block below (same `verdict` variable).
  let mockVerdict = null;
  if (process.env.PRISM_PHASE_0D_MOCK_VERDICT) {
    try {
      mockVerdict = JSON.parse(process.env.PRISM_PHASE_0D_MOCK_VERDICT);
    } catch {
      mockVerdict = { schema_version: 1, severity: 'EVIDENCED', headline_finding: 'mock' };
    }
  }

  // Spawn the reviewer via `claude -p` (Claude Code subscription auth — no
  // separate ANTHROPIC_API_KEY required per PRISM auth pattern).
  // PRISM_PHASE_0D_OOB_PROCESS=1 is the recursion guard: it prevents the
  // inner claude session from re-triggering this hook.
  const child = mockVerdict ? null : spawnSync(resolveClaudeBin(), ['-p', '--model', 'claude-sonnet-4-6'], {
    input: promptText + '\n\n' + combinedInput,
    env: { ...process.env, PRISM_PHASE_0D_OOB_PROCESS: '1' },
    timeout: OOB_REVIEWER_TIMEOUT_MS,
    encoding: 'utf-8',
    windowsHide: true,
  });

  let verdict;
  if (mockVerdict) {
    // H4: mock-verdict short-circuit — use injected verdict directly
    verdict = mockVerdict;
  } else if (child.status === 0 && child.stdout) {
    try {
      const jsonStart = child.stdout.indexOf('{');
      const jsonEnd = child.stdout.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        verdict = JSON.parse(child.stdout.slice(jsonStart, jsonEnd + 1));
      } else {
        verdict = {
          severity: 'ERROR',
          error: 'no JSON object found in reviewer output',
          raw_stdout: child.stdout.slice(0, 500),
        };
      }
    } catch (e) {
      verdict = {
        severity: 'ERROR',
        error: `parse failure: ${e.message}`,
        raw_stdout: child.stdout.slice(0, 500),
      };
    }
  } else {
    verdict = {
      severity: 'ERROR',
      error: child.error?.message ?? `non-zero exit ${child.status}`,
      stderr: (child.stderr ?? '').slice(0, 500),
    };
  }

  // Write result verdict via the shared verdict-flag lib, under roster lock
  // (prevents races with parallel panel writes). appendLog:false — phase-0d has
  // no jsonl reader (ISSUE-3); the per-SHA file is the only artifact. The lib's
  // resultPath('0d', sha) yields the same .prism-phase-0d-verdicts-<sha>.json
  // filename the SessionStart pickup scans for.
  await withRosterLock(rosterPath, async () => {
    try {
      writeVerdict('0d', dispatchSha, {
        task_sha: taskSha,
        dispatch_sha: dispatchSha,
        panel_path: panelPath,
        verdict,
      }, { appendLog: false });
    } catch (e) {
      process.stderr.write(`[phase-0d-oob] verdict write failed: ${e.message}\n`);
    }
  });

  // Clean up pending flag
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(pendingPath);
  } catch { /* swallow; pending file may already be gone */ }
}

// ─── exported run() — fire-and-forget for PostToolUse dispatcher ──────────────

export async function run(payload) {
  if (process.env.PRISM_PHASE_0D_OOB_PROCESS === '1') return { exit: 0, stdout: '', stderr: '' };
  if (process.env.PRISM_DISABLE_OOB_REVIEW === '1') return { exit: 0, stdout: '', stderr: '' };

  const panelPath = payload && panelPathFromToolInput(payload);
  if (!panelPath) return { exit: 0, stdout: '', stderr: '' };          // R2 early-exit

  const taskSha = extractTaskSha(panelPath);
  if (!taskSha) return { exit: 0, stdout: '', stderr: '[phase-0d-oob] cannot extract task_sha\n' };

  // MOCK path stays SYNCHRONOUS (preserves existing test contracts).
  if (process.env.PRISM_PHASE_0D_MOCK_VERDICT) {
    await runReviewerInProcess(payload, panelPath, taskSha);
    return { exit: 0, stdout: '', stderr: '' };
  }

  // PRODUCTION: R4 fire-and-forget. Re-invoke THIS file detached so the (blocking,
  // up-to-240s, OOB_REVIEWER_TIMEOUT_MS) claude -p reviewer runs in its own process; dispatcher returns now.
  // PRISM_PHASE_0D_OOB_CHILD=1 signals the detached child to run the reviewer body
  // exactly once. The existing PRISM_PHASE_0D_OOB_PROCESS=1 guard (set inside
  // runReviewerInProcess when spawning claude -p) prevents further hook re-fires
  // inside the inner claude session.
  try {
    const child = spawn(process.execPath, [__thisfile], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      env: { ...process.env, PRISM_PHASE_0D_OOB_CHILD: '1' },
    });
    child.stdin.write(JSON.stringify(payload)); child.stdin.end();
    child.unref();
  } catch (e) { return { exit: 0, stdout: '', stderr: `[phase-0d-oob] detached spawn failed: ${e.message}\n` }; }
  return { exit: 0, stdout: '', stderr: '' };
}

// ─── CLI entry point (invoked directly as a script) ───────────────────────────

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-phase-0d-oob.mjs';

if (invokedDirectly) {
  (async () => {
    // Recursion guard: if the inner claude -p session fires this hook again,
    // exit immediately (PRISM_PHASE_0D_OOB_PROCESS is set by runReviewerInProcess
    // when spawning claude -p).
    if (process.env.PRISM_PHASE_0D_OOB_PROCESS === '1') process.exit(0);

    const chunks = []; for await (const ch of process.stdin) chunks.push(ch);
    let payload = null; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'); } catch {}

    if (process.env.PRISM_PHASE_0D_OOB_CHILD === '1') {
      // We ARE the detached child — run the real reviewer here, exactly once.
      const panelPath = payload && panelPathFromToolInput(payload);
      if (panelPath) { const sha = extractTaskSha(panelPath); if (sha) await runReviewerInProcess(payload, panelPath, sha); }
      process.exit(0);
    }

    // Legacy direct-invocation path (regression tests, manual CLI use):
    // run the reviewer synchronously in-process so the verdict is written before
    // this process exits. This preserves the regression test contract.
    if (process.env.PRISM_DISABLE_OOB_REVIEW === '1') process.exit(0);

    const panelPath = payload && panelPathFromToolInput(payload);
    if (!panelPath) process.exit(0);

    const taskSha = extractTaskSha(panelPath);
    if (!taskSha) {
      process.stderr.write('[phase-0d-oob] cannot extract task_sha from panel path\n');
      process.exit(0);
    }

    await runReviewerInProcess(payload, panelPath, taskSha);
    process.exit(0);
  })().catch((e) => {
    process.stderr.write(`[phase-0d-oob] uncaught: ${e.message}\n`);
    process.exit(0); // never block master
  });
}
