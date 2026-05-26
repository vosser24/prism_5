// PRISM verdict-flag lib (v4.4 Layer B) — per-SHA pending/result files
// under ~/.claude/, append-only log at ~/.claude/.prism-phase-1-5-verdicts.jsonl.
//
// This is a SIBLING of tools/lib/prism-flag-file.mjs but operates on a
// different naming scheme: per-dispatch SHA (not per-project key). Used
// exclusively by the v4.4 OOB PHASE 1.5 reviewer hook.
//
// File layout:
//   ~/.claude/.prism-phase-1-5-pending-<sha>.json   — short-lived; written
//                                                      by SubagentStop hook,
//                                                      read by SDK reviewer
//                                                      child process.
//   ~/.claude/.prism-phase-1-5-verdicts-<sha>.json  — verdict result,
//                                                      written by SDK
//                                                      reviewer, read by
//                                                      SessionStart pickup.
//   ~/.claude/.prism-phase-1-5-verdicts.jsonl       — append-only log
//                                                      summarising every
//                                                      verdict for ratchet
//                                                      consumption.
//
// All writes are atomic (tempfile + rename, fallback to direct write).
// Reads are fail-open: corrupted file returns null rather than throwing.

import {writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, appendFileSync} from 'fs';
import {join} from 'path';

function home() {
  return process.env.HOME || process.env.USERPROFILE;
}

function dotClaudeDir() {
  const d = join(home(), '.claude');
  try { mkdirSync(d, {recursive: true}); } catch {}
  return d;
}

function pendingPath(sha) {
  if (!/^[a-f0-9]{8,64}$/i.test(sha)) throw new Error(`invalid sha: ${sha}`);
  return join(dotClaudeDir(), `.prism-phase-1-5-pending-${sha}.json`);
}

function resultPath(sha) {
  if (!/^[a-f0-9]{8,64}$/i.test(sha)) throw new Error(`invalid sha: ${sha}`);
  return join(dotClaudeDir(), `.prism-phase-1-5-verdicts-${sha}.json`);
}

function logPath() {
  return join(dotClaudeDir(), '.prism-phase-1-5-verdicts.jsonl');
}

function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      writeFileSync(path, content);
      return true;
    } catch (e) {
      process.stderr.write(`PRISM verdict-flag: write failed for ${path}: ${e && e.message}\n`);
      return false;
    }
  }
}

export function writePending(sha, payload) {
  const p = pendingPath(sha);
  const body = JSON.stringify({
    schema_version: 1,
    sha,
    created_at: new Date().toISOString(),
    ...payload,
  });
  const ok = atomicWrite(p, body);
  if (!ok) process.stderr.write(`PRISM verdict-flag: writePending failed for sha ${sha} — hook will proceed without pending file\n`);
  return p;
}

export function readPending(sha) {
  try {
    return JSON.parse(readFileSync(pendingPath(sha), 'utf-8'));
  } catch {
    return null;
  }
}

export function clearPending(sha) {
  try { unlinkSync(pendingPath(sha)); } catch {}
}

export function writeVerdict(sha, payload) {
  const p = resultPath(sha);
  const ts = new Date().toISOString();
  const body = JSON.stringify({
    schema_version: 1,
    sha,
    completed_at: ts,
    ...payload,
  });
  const ok = atomicWrite(p, body);
  if (!ok) process.stderr.write(`PRISM verdict-flag: writeVerdict failed for sha ${sha} — verdict will not be persisted\n`);
  // Append summary line to the log
  const logLine = JSON.stringify({
    sha,
    session_id: payload.session_id || null,
    specialist_name: payload.specialist_name,
    reviewer_model: payload.reviewer_model,
    summary: payload.summary,
    completed_at: ts,
  }) + '\n';
  try {
    appendFileSync(logPath(), logLine);
  } catch (e) {
    process.stderr.write(`PRISM verdict-flag: log append failed for sha ${sha}: ${e && e.message}\n`);
  }
  return p;
}

export function readVerdict(sha) {
  try {
    return JSON.parse(readFileSync(resultPath(sha), 'utf-8'));
  } catch {
    return null;
  }
}

export function clearVerdict(sha) {
  try { unlinkSync(resultPath(sha)); } catch {}
}

export function listPendingVerdicts() {
  const dir = dotClaudeDir();
  if (!existsSync(dir)) return [];
  const prefix = '.prism-phase-1-5-pending-';
  const suffix = '.json';
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  for (const f of entries) {
    if (!f.startsWith(prefix) || !f.endsWith(suffix)) continue;
    out.push(f.slice(prefix.length, f.length - suffix.length));
  }
  return out;
}

export function listCompletedVerdicts() {
  const dir = dotClaudeDir();
  if (!existsSync(dir)) return [];
  const prefix = '.prism-phase-1-5-verdicts-';
  const suffix = '.json';
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  for (const f of entries) {
    if (!f.startsWith(prefix) || !f.endsWith(suffix)) continue;
    out.push(f.slice(prefix.length, f.length - suffix.length));
  }
  return out;
}

export function readVerdictLog() {
  try {
    return readFileSync(logPath(), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}
