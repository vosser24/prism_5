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

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { withRosterLock } from '../tools/lib/prism-roster-lock.mjs';
import { writeVerdict } from '../tools/lib/prism-verdict-flag.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));
const PROMPT_PATH = join(repoRoot, 'agents', 'phase-0d-oob-reviewer.md');
const TRANSCRIPT_WINDOW_LINES = 200;

// H4: resolve the claude executable to an absolute path. On Windows, spawnSync
// without shell:true does not append PATHEXT (.cmd/.exe), so a bare 'claude'
// silently fails. Probe PATH for claude(.cmd|.exe). Falls back to 'claude'.
function resolveClaudeBin() {
  if (process.env.PRISM_CLAUDE_BIN) return process.env.PRISM_CLAUDE_BIN;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const cand = join(dir, 'claude' + ext);
      try { if (existsSync(cand)) return cand; } catch {}
    }
  }
  return 'claude';
}

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
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, content, 'utf-8'); // direct fallback
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

function panelPathFromToolInput(payload) {
  const fp = payload?.tool_input?.file_path;
  if (!fp) return null;
  if (!/\.prism-task-[^/\\]+[/\\]panel\.json$/.test(fp)) return null;
  return fp;
}

function extractTaskSha(panelPath) {
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

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Recursion guard: prevent the reviewer process from re-triggering this hook
  if (process.env.PRISM_PHASE_0D_OOB_PROCESS === '1') process.exit(0);

  // Kill switch
  if (process.env.PRISM_DISABLE_OOB_REVIEW === '1') process.exit(0);

  const payload = await readHookPayload();
  const panelPath = payload && panelPathFromToolInput(payload);
  if (!panelPath) process.exit(0);

  const taskSha = extractTaskSha(panelPath);
  if (!taskSha) {
    process.stderr.write('[phase-0d-oob] cannot extract task_sha from panel path\n');
    process.exit(0);
  }

  let panel;
  try {
    panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
  } catch (e) {
    process.stderr.write(`[phase-0d-oob] cannot parse panel.json: ${e.message}\n`);
    process.exit(0);
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
    process.exit(0);
  }

  // Reviewer prompt
  let promptText = '';
  try {
    promptText = readFileSync(PROMPT_PATH, 'utf-8');
  } catch (e) {
    process.stderr.write(`[phase-0d-oob] cannot read reviewer prompt: ${e.message}\n`);
    process.exit(0);
  }

  const transcriptTail = readTranscriptTail(payload?.transcript_path, TRANSCRIPT_WINDOW_LINES);

  const combinedInput = [
    '---PANEL.JSON---',
    JSON.stringify(panel, null, 2),
    '---MASTER TRANSCRIPT WINDOW---',
    transcriptTail,
    '---ROSTER SNAPSHOT---',
    JSON.stringify(relevantAgents, null, 2),
  ].join('\n\n');

  // Per-dispatch SHA (unique enough for concurrent panel writes in same session)
  const dispatchSha = createHash('sha256')
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
  // separate ANTHROPIC_API_KEY required per PRISM auth pattern)
  const child = mockVerdict ? null : spawnSync(resolveClaudeBin(), ['-p', '--model', 'claude-sonnet-4-6'], {
    input: promptText + '\n\n' + combinedInput,
    env: { ...process.env, PRISM_PHASE_0D_OOB_PROCESS: '1' },
    timeout: 90_000,
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

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[phase-0d-oob] uncaught: ${e.message}\n`);
  process.exit(0); // never block master
});
