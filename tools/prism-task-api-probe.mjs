#!/usr/bin/env node
// PRISM Task-API availability probe (CLI).
//
// Plan: docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md
// Logic: hooks/lib/prism-task-api-probe.mjs (shared with the SessionEnd hook,
//        so tool/hook divergence is structurally impossible).
//
// Reports whether the Task API (TaskCreate/TaskUpdate/TaskList/TaskGet) was
// OBSERVED to work, OBSERVED to be refused, or was never exercised at all.
// It does NOT and CANNOT call the Task API itself (a CLI is a separate process
// with no tool channel) — it reads the evidence real calls left behind in the
// session transcript.
//
// Usage:
//   node tools/prism-task-api-probe.mjs
//   node tools/prism-task-api-probe.mjs --transcript <path/to/session.jsonl>
//   node tools/prism-task-api-probe.mjs --project-dir <dir> --json
//
// Exit codes:
//   0  available   — Task calls were observed to succeed, none refused
//   1  unavailable | mixed — at least one Task call was REFUSED
//   2  unknown     — nothing was measured (no Task calls in window, or no
//                    readable transcript). Deliberately NOT 0: "didn't check"
//                    must never read as "fine" (D047).

import {existsSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {probeTaskApiTranscript} from '../hooks/lib/prism-task-api-probe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const asJson = process.argv.includes('--json');

// Claude Code stores transcripts at ~/.claude/projects/<mangled-abs-path>/<session>.jsonl
// where the mangling replaces every non-alphanumeric run in the absolute path
// with '-'. Derived empirically from the live layout, e.g.
//   C:\dev\sample_repo
//     -> C--dev-sample-repo
function mangle(absPath) {
  return absPath.replace(/[\\/:_.]/g, '-');
}

function newestTranscriptFor(projectDir) {
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const dir = join(base, mangle(resolve(projectDir)));
  if (!existsSync(dir)) return {path: null, dir};
  let best = null, bestMtime = -1;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      let mt;
      try { mt = statSync(p).mtimeMs; } catch { continue; }
      if (mt > bestMtime) { bestMtime = mt; best = p; }
    }
  } catch { /* fail-open */ }
  return {path: best, dir};
}

const explicit = arg('--transcript');
const projectDir = arg('--project-dir') || process.cwd();
let transcript = explicit;
let searchedDir = null;
if (!transcript) {
  const found = newestTranscriptFor(projectDir);
  transcript = found.path;
  searchedDir = found.dir;
}

const result = probeTaskApiTranscript(transcript);
result.project_dir = resolve(projectDir);
result.transcript_source = explicit ? 'explicit' : 'auto-discovered';
if (searchedDir) result.searched_dir = searchedDir;

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const LABEL = {
    available: 'AVAILABLE   — Task calls were observed to succeed',
    unavailable: 'UNAVAILABLE — Task calls were REFUSED by the harness',
    mixed: 'MIXED       — some Task calls succeeded, some were REFUSED',
    unknown: 'UNKNOWN     — nothing measured (this is NOT a pass)',
  };
  process.stdout.write('PRISM Task-API probe\n');
  process.stdout.write(`  verdict            : ${LABEL[result.status] || result.status}\n`);
  if (result.reason) process.stdout.write(`  reason             : ${result.reason}\n`);
  // The denominator is printed on every run, next to the verdict, always (D047 §7).
  process.stdout.write(`  task calls observed: ${result.task_calls_observed}  (refused ${result.refused}, succeeded ${result.succeeded})\n`);
  process.stdout.write(`  scan window        : ${result.transcript_path || '(none)'}\n`);
  process.stdout.write(`                       ${result.scanned_lines || 0} lines scanned, tail_truncated=${result.tail_truncated}\n`);
  if (result.first_refusal) {
    process.stdout.write(`  first refusal      : ${result.first_refusal.tool} (${result.first_refusal.tool_use_id})\n`);
    process.stdout.write(`                       ${result.first_refusal.message}\n`);
  }
  const expKeys = Object.keys(result.expected_unavailable || {});
  if (expKeys.length) {
    process.stdout.write(`  expected-unavailable: ${expKeys.map(k => `${k}x${result.expected_unavailable[k]}`).join(', ')}\n`);
    process.stdout.write('                       (TaskGet/TodoWrite are not exposed by the CLI — refusal here is NORMAL and is not scored)\n');
  }
  const otherKeys = Object.keys(result.other_refused_tools || {});
  process.stdout.write(otherKeys.length
    ? `  other refused tools: ${otherKeys.map(k => `${k}x${result.other_refused_tools[k]}`).join(', ')} (context only — does not affect the verdict)\n`
    : '  other refused tools: none observed\n');
  if (result.status === 'unavailable' || result.status === 'mixed') {
    process.stdout.write('\n  The CAUSE is not determined by this probe and is currently UNPROVEN.\n');
    process.stdout.write('  See docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md §7.\n');
    process.stdout.write('  Impact: PRISM task carryover (.claude/.prism-open-tasks.json) silently\n');
    process.stdout.write('  no-ops for this session. Existing carried tasks are NOT destroyed.\n');
  }
  if (result.status === 'unknown' && result.reason === 'no_task_calls_in_window') {
    process.stdout.write('\n  No Task tool was called in the scanned window, so nothing could be\n');
    process.stdout.write('  measured. This is NOT evidence that the Task API works.\n');
  }
}

process.exit(result.status === 'available' ? 0 : (result.status === 'unknown' ? 2 : 1));
