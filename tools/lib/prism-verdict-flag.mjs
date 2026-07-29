// PRISM verdict-flag lib (v4.4 Layer B; v4.6 kind-generalized) — per-SHA
// pending/result files under ~/.claude/, append-only log per kind.
//
// Generalized over `kind` (e.g. '1-5' for OOB Phase 1.5, '0d' for OOB Phase 0d):
//   ~/.claude/.prism-phase-<kind>-pending-<sha>.json    — short-lived; written
//                                                          by the dispatch hook,
//                                                          read by the reviewer
//                                                          child process.
//   ~/.claude/.prism-phase-<kind>-verdicts-<sha>.json   — verdict result,
//                                                          read by SessionStart
//                                                          pickup.
//   ~/.claude/.prism-phase-<kind>-verdicts.jsonl        — append-only summary
//                                                          log for ratchet
//                                                          consumption.
//
// writeVerdict takes `kind` first — both callers (Phase 1.5 and Phase 0d) always
// specify it. The read/clear/pending helpers take `kind` LAST, defaulting to
// '1-5', to preserve the v4.4 Phase-1.5 callers that pass only a sha.
// Phase-0d passes { appendLog: false } — it has no jsonl reader (ISSUE-3).
//
// All writes are atomic (tempfile + rename, fallback to direct write).
// Reads are fail-open: corrupted/missing file returns null rather than throwing.

import {writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, appendFileSync} from 'fs';
import {join} from 'path';
import {prismHome} from '../../hooks/lib/prism-home.mjs';
import {renameWithRetry} from './atomic-fs.mjs';

function home() {
  return prismHome();
}

function dotClaudeDir() {
  const d = join(home(), '.claude');
  try { mkdirSync(d, {recursive: true}); } catch {}
  return d;
}

function assertSha(sha) {
  if (!/^[a-f0-9]{8,64}$/i.test(sha)) throw new Error(`invalid sha: ${sha}`);
  return sha;
}

function pendingPath(sha, kind = '1-5') {
  return join(dotClaudeDir(), `.prism-phase-${kind}-pending-${assertSha(sha)}.json`);
}

function resultPath(kind, sha) {
  return join(dotClaudeDir(), `.prism-phase-${kind}-verdicts-${assertSha(sha)}.json`);
}

function logPath(kind = '1-5') {
  return join(dotClaudeDir(), `.prism-phase-${kind}-verdicts.jsonl`);
}

function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameWithRetry(renameSync, tmp, path);
    return true;
  } catch (renameErr) {
    try {
      writeFileSync(path, content);
      process.stderr.write(`PRISM verdict-flag: atomic rename failed for ${path} (${(renameErr && renameErr.code) || 'unknown'}); wrote directly instead\n`);
      return true;
    } catch (e) {
      process.stderr.write(`PRISM verdict-flag: write failed for ${path}: ${e && e.message}\n`);
      return false;
    }
  }
}

export function writePending(sha, payload, kind = '1-5') {
  const p = pendingPath(sha, kind);
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

export function readPending(sha, kind = '1-5') {
  try {
    return JSON.parse(readFileSync(pendingPath(sha, kind), 'utf-8'));
  } catch {
    return null;
  }
}

export function clearPending(sha, kind = '1-5') {
  try { unlinkSync(pendingPath(sha, kind)); } catch {}
}

export function writeVerdict(kind, sha, payload, opts = {}) {
  const p = resultPath(kind, sha);
  const ts = new Date().toISOString();
  const body = JSON.stringify({
    schema_version: 1,
    kind,
    sha,
    completed_at: ts,
    ...payload,
  });
  const ok = atomicWrite(p, body);
  if (!ok) process.stderr.write(`PRISM verdict-flag: writeVerdict failed for ${kind}/${sha} — verdict will not be persisted\n`);
  // Append summary line to the per-kind log unless the caller opts out.
  // Phase-0d passes appendLog:false — it has no jsonl reader (ISSUE-3).
  if (opts.appendLog !== false) {
    const logLine = JSON.stringify({
      kind,
      sha,
      session_id: payload.session_id || null,
      specialist_name: payload.specialist_name,
      reviewer_model: payload.reviewer_model,
      summary: payload.summary,
      completed_at: ts,
    }) + '\n';
    try {
      appendFileSync(logPath(kind), logLine);
    } catch (e) {
      process.stderr.write(`PRISM verdict-flag: log append failed for ${kind}/${sha}: ${e && e.message}\n`);
    }
  }
  return p;
}

export function readVerdict(sha, kind = '1-5') {
  try {
    return JSON.parse(readFileSync(resultPath(kind, sha), 'utf-8'));
  } catch {
    return null;
  }
}

export function clearVerdict(sha, kind = '1-5') {
  try { unlinkSync(resultPath(kind, sha)); } catch {}
}

export function listPendingVerdicts(kind = '1-5') {
  const dir = dotClaudeDir();
  if (!existsSync(dir)) return [];
  const prefix = `.prism-phase-${kind}-pending-`;
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

export function listCompletedVerdicts(kind = '1-5') {
  const dir = dotClaudeDir();
  if (!existsSync(dir)) return [];
  const prefix = `.prism-phase-${kind}-verdicts-`;
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

export function readVerdictLog(kind = '1-5') {
  try {
    return readFileSync(logPath(kind), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}
