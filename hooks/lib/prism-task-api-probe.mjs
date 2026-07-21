// PRISM Task-API availability probe (detection only — NOT a fix for the cause).
//
// Plan: docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md
// Related: D018 (Task API adoption), D042 (both-paths proof), D045 (agent-teams
//          topology), D046 (make misses loud), D047 (tri-state, no vacuous green).
//
// WHY THIS EXISTS
// ---------------
// The Claude Code harness can refuse a granted tool with:
//   "Error: No such tool available: TaskCreate. TaskCreate exists but is not
//    enabled in this context. Use one of the available tools instead."
// When that happens to the Task tools, PRISM's whole task-carryover subsystem
// (prism-session-end -> .claude/.prism-open-tasks.json -> SessionStart
// TASK-RECALL) silently no-ops, and NOTHING reports it. Verified 2026-07-21:
// /prism-doctor contains no occurrence of "task" at all; the installer has no
// availability check; and the one advisory believed to cover this
// (task_snapshot_integrity's `degraded`) does NOT fire — a refusal row's
// `toolUseResult` sibling is the error STRING (non-null), so it is counted as a
// `structured_hit` by prism-task-snapshot.mjs:176. Measured, not reasoned.
//
// WHAT IS AND IS NOT POSSIBLE FROM HERE
// -------------------------------------
// A hook/CLI is a separate Node process with no tool channel: it CANNOT call
// TaskCreate to see what happens. A live "try it" probe is impossible. What IS
// possible — and what this module does — is DIRECT OBSERVATION of attempts that
// were actually made: the refusal leaves a structured artifact in the session
// transcript JSONL (an assistant `tool_use` named Task*, paired by
// `tool_use_id` with a user `tool_result` carrying `is_error:true`). That is
// evidence, not a proxy. Its honest boundary: if no Task call was made in the
// scanned window, this module knows NOTHING and says `unknown` — never
// `available`.
//
// D047 COMPLIANCE
// ---------------
// `unknown` is a first-class fourth state with a machine-readable `reason` that
// separates never-measured (`no_task_calls_in_window`) from could-not-measure
// (`transcript_missing` / `transcript_unreadable` / `no_transcript_path`).
// Every result carries `task_calls_observed` — the DENOMINATOR — and, for the
// file-reading entry point, `tail_truncated`, so a verdict is never printable
// without the scope it was computed over.
//
// KNOWN LIMITATIONS (measured 2026-07-21 by independent adversarial validation;
// documented here rather than left as folklore)
// ----------------------------------------------------------------------------
// 1. UTF-8 BOM swallows transcript LINE 1. A transcript written with a leading
//    BOM makes JSON.parse reject its first line, so this module silently loses
//    whatever Task activity that line carried. The failure DIRECTION is safe and
//    was verified: with a BOM file whose only Task activity sits on lines 1-2,
//    the verdict degrades to `unknown` — never to `available`. The probe
//    under-counts its own evidence; it does not fabricate a green. Real Claude
//    Code transcripts carry no BOM, so this is a hostile-input-only nuance and
//    is accepted, not fixed: stripping a BOM would change the scan window for a
//    condition never observed in production, and the safe direction already
//    holds. Regression: test 19 in tests/v3/state/test-prism-task-api-probe.mjs.
// 2. A `tool_result` carrying the refusal TEXT but lacking `is_error:true` is
//    scored as a SUCCESS. Never observed on the wire (every real refusal sets
//    `is_error:true`). Deliberately not defended against: a text-only fallback
//    would reintroduce the prose false-positive the structural join exists to
//    prevent (transcript 68125b7c quotes the refusal string in prose).
// 3. `no_transcript_path` vs `transcript_missing`: `transcript_missing` means
//    "the specific file I was handed does not exist"; `no_transcript_path` means
//    "no path was ever resolved" — which is what the CLI's auto-discovery
//    reports when the project directory is absent or holds no *.jsonl. Both are
//    `unknown` and both exit 2. Regression: test 20.
// 4. Window completeness: the capped tail (PRISM_TASKSCAN_MAXBYTES, default
//    20MB) means older refusals can fall outside the window. Disclosed, never
//    silently clipped, via `tail_truncated` on every file-path result.
//
// Dependency-free, pure, and non-throwing by construction.

import {statSync, openSync, readSync, closeSync} from 'node:fs';

// SCORING SET — only these drive the verdict.
//
// Deliberately EXCLUDES TaskGet, even though prism-task-snapshot.mjs:56 lists
// it as a Task tool. Measured across every transcript under ~/.claude/projects/
// on 2026-07-21: TaskGet 0 successes / 2 refusals; TodoWrite 0 successes /
// 2 refusals; against TaskCreate 308/7, TaskUpdate 592/1, TaskList 22/0.
// TaskGet is documented for the Agent SDK but is not exposed by the interactive
// CLI, so HEALTHY sessions refuse it routinely while the other three succeed
// (real example: session 4c544559 — 38 successes + 1 TaskGet refusal). Letting
// a known-never-available tool drive the verdict would report demonstrably
// healthy sessions as broken — a D042 stay-quiet-on-good-input failure on
// production data.
const SCORING_TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList']);

// Tools whose refusal is EXPECTED and carries no ill-health signal. Recorded in
// its own bucket so the information is not lost — never folded into `refused`.
// TodoWrite: removed in favour of the structured Task tools (D018).
// TaskGet: see above.
const EXPECTED_UNAVAILABLE_TOOLS = new Set(['TaskGet', 'TodoWrite']);

// The full Task surface, kept for callers that want the vocabulary.
const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

// The literal harness refusal shape, observed on disk 2026-07-21 in
// ~/.claude/projects/Y--Documents-utilities-projects-prism-3/{f128de77,a2017fb3}.jsonl.
// Matched ONLY against a tool_result block that is already structurally tied to
// a Task* tool_use — never against free text. A substring-only detector
// false-positives on transcript 68125b7c, which quotes this phrase in prose.
const NOT_ENABLED_RE = /No such tool available|is not enabled in this context/;

function bump(map, key) { map[key] = (map[key] || 0) + 1; }

function blank(status, reason) {
  return {
    status,
    reason: reason || null,
    // The DENOMINATOR OF THE VERDICT: calls to the scoring tools only. A
    // session that only ever called TaskGet has observed nothing decision-
    // relevant and must land in `unknown`, not in a verdict.
    task_calls_observed: 0,
    refused: 0,
    succeeded: 0,
    refused_tools: {},           // scoring tools refused -> real ill-health
    expected_unavailable: {},    // TaskGet / TodoWrite -> expected, never scored
    other_refused_tools: {},     // any other tool refused -> context only
    first_refusal: null,
  };
}

// The probe owns its OWN scan window rather than reusing readTaskScanLines().
//
// readTaskScanLines() prefilters on /Task|task/ AND /tool_use|toolUseResult/,
// which is correct for snapshot reconstruction but WRONG here: a successful
// Task result row whose payload happens not to contain the substring "task" is
// dropped, while the refusal rows always survive (the error text names the
// tool). That asymmetry biases the probe toward `unavailable` — a false
// positive in the dangerous direction. This filter keeps any tool-bearing line
// and lets the structural join do the selection. Same PRISM_TASKSCAN_MAXBYTES
// cap (default 20MB, read from EOF), so the cost stays bounded.
function readProbeScanLines(transcriptPath) {
  const capRaw = Number(process.env.PRISM_TASKSCAN_MAXBYTES);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 20 * 1024 * 1024;
  const size = statSync(transcriptPath).size;
  const start = Math.max(0, size - cap);
  const tail_truncated = start > 0;
  const fd = openSync(transcriptPath, 'r');
  let buf;
  try {
    buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
  } finally { closeSync(fd); }
  const lines = [];
  for (const l of buf.toString('utf-8').split(/\r?\n/)) {
    if (l.includes('tool_use') || l.includes('toolUseResult') || l.includes('tool_use_result')) lines.push(l);
  }
  return {lines, tail_truncated};
}

/**
 * Probe an array of raw transcript JSONL lines.
 * Never throws; malformed lines are skipped.
 */
function probeTaskApiLines(rawLines) {
  const out = blank('unknown', 'no_task_calls_in_window');
  if (!Array.isArray(rawLines)) return out;

  const pending = new Map(); // tool_use_id -> tool name (ANY tool, so non-Task
                             // refusals can be recorded as context)

  for (const line of rawLines) {
    if (typeof line !== 'string' || !line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    const m = obj.message;
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) continue;

    if (m.role === 'assistant') {
      for (const c of m.content) {
        if (c && c.type === 'tool_use' && c.id && typeof c.name === 'string') pending.set(c.id, c.name);
      }
    }

    for (const c of m.content) {
      if (!c || c.type !== 'tool_result' || !c.tool_use_id) continue;
      const name = pending.get(c.tool_use_id);
      if (!name) continue; // unmatched result — cannot attribute, do not guess
      pending.delete(c.tool_use_id);

      const text = typeof c.content === 'string'
        ? c.content
        : (Array.isArray(c.content) ? c.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join(' ') : '');
      const refused = c.is_error === true && NOT_ENABLED_RE.test(text);

      if (EXPECTED_UNAVAILABLE_TOOLS.has(name)) {
        // TaskGet / TodoWrite. A refusal here is the NORMAL, expected state and
        // must never move the verdict. A SUCCESS here is still positive
        // evidence the Task surface answered, so it is counted.
        if (refused) bump(out.expected_unavailable, name);
        else if (c.is_error !== true && TASK_TOOL_NAMES.has(name)) { out.task_calls_observed++; out.succeeded++; }
      } else if (SCORING_TASK_TOOLS.has(name)) {
        out.task_calls_observed++;
        if (refused) {
          out.refused++;
          bump(out.refused_tools, name);
          if (!out.first_refusal) out.first_refusal = {tool: name, tool_use_id: c.tool_use_id, message: text.slice(0, 400)};
        } else if (c.is_error !== true) {
          // A non-error Task result is positive evidence the API answered.
          // An `is_error` result that is NOT a not-enabled refusal (e.g. "task
          // 5 not found") is a legitimate API answer too, but conservatively
          // counts as neither — it is neither proof of health nor of refusal.
          out.succeeded++;
        }
      } else if (refused) {
        // Any other tool (Agent, SendMessage, ...). Context only, never scored.
        bump(out.other_refused_tools, name);
      }
    }
  }

  if (out.task_calls_observed === 0) { out.status = 'unknown'; out.reason = 'no_task_calls_in_window'; return out; }
  out.reason = null;
  if (out.refused > 0 && out.succeeded > 0) out.status = 'mixed';
  else if (out.refused > 0) out.status = 'unavailable';
  else if (out.succeeded > 0) out.status = 'available';
  else { out.status = 'unknown'; out.reason = 'task_results_inconclusive'; }
  return out;
}

/**
 * Probe a transcript file. Reuses readTaskScanLines() so the scan window (and
 * its PRISM_TASKSCAN_MAXBYTES cap) is IDENTICAL to the one prism-session-end
 * uses for the task snapshot — divergence between the two would be a bug.
 * Never throws.
 */
function probeTaskApiTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return {...blank('unknown', 'no_transcript_path'), transcript_path: null, scanned_lines: 0, tail_truncated: false, exists: false};
  }
  let lines = null, tail_truncated = false, exists = false;
  try { exists = statSync(transcriptPath).isFile(); } catch { exists = false; }
  if (!exists) {
    return {...blank('unknown', 'transcript_missing'), transcript_path: transcriptPath, scanned_lines: 0, tail_truncated: false, exists: false};
  }
  try {
    const res = readProbeScanLines(transcriptPath);
    lines = res.lines;
    tail_truncated = res.tail_truncated;
  } catch {
    return {...blank('unknown', 'transcript_unreadable'), transcript_path: transcriptPath, scanned_lines: 0, tail_truncated: false, exists: true};
  }
  if (!Array.isArray(lines)) {
    return {...blank('unknown', 'transcript_unreadable'), transcript_path: transcriptPath, scanned_lines: 0, tail_truncated, exists: true};
  }
  const out = probeTaskApiLines(lines);
  // `other_refused_tools` IS genuinely measured on this path — readProbeScanLines
  // keeps every tool-bearing line, not just Task-keyword ones (see its comment).
  // An earlier revision routed through readTaskScanLines and had to report
  // `null` here because the map could not have been populated; that shortcut is
  // gone along with the biased scan window.
  return {
    ...out,
    other_refused_tools_scanned: true,
    transcript_path: transcriptPath,
    scanned_lines: lines.length,
    tail_truncated,
    exists: true,
  };
}

export {
  probeTaskApiLines,
  probeTaskApiTranscript,
  TASK_TOOL_NAMES,
  SCORING_TASK_TOOLS,
  EXPECTED_UNAVAILABLE_TOOLS,
  NOT_ENABLED_RE,
};
