// PRISM flag-file helper (v4.1 Phase A) — per-project, per-flag JSON
// records under ~/.claude/.prism-flags/.
//
// Why this exists: the Claude Code hook decision-control matrix forbids
// `additionalContext` injection from SessionEnd and PreCompact events
// (verified in D005-phase-f-hook-api-incompatibility). The flag-file
// pattern bridges that gap — a SessionEnd / PreCompact hook writes a
// side-effect flag (which IS allowed), then the next SessionStart hook
// (which DOES support additionalContext) reads + clears the flag and
// emits the nudge text.
//
// Callers:
//   - hooks/prism-clean-nudge-flag.mjs       (D005 Phase F bundle, /clear)
//   - hooks/prism-precompact-nudge-flag.mjs  (D005 Phase F bundle, PreCompact)
//   - hooks/prism-git-clean-nudge.mjs        (Phase A Q3, dirty tree)
//   - hooks/prism-prepush-review.mjs         (Phase A Q4, optional gate-mode flag)
//   - hooks/prism-session-start.mjs          (reads + clears all of the above)
//
// All writes are atomic (tempfile + rename, fallback to direct write —
// matches the v2.9.1 ATOMIC-WRITE-001 pattern in prism-session-start.mjs).
// Reads are fail-open: a corrupted flag returns null rather than throwing.
//
// Project keying: flag files are keyed by a SHA-256 hash of the absolute
// project root path (first 12 chars), prefixed with the directory
// basename for human-grep-ability. So a project at
// Y:\Documents\utilities_projects\prism_3 → prism_3__a1b2c3d4e5f6. This
// avoids cross-project contamination when the same user has multiple
// Claude Code windows open in different projects.

import {writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, statSync} from 'fs';
import {join, basename, resolve} from 'path';
import {createHash} from 'crypto';

const HOME = process.env.HOME || process.env.USERPROFILE;
const FLAGS_DIR = join(HOME, '.claude', '.prism-flags');

export function ensureFlagsDir() {
  try { mkdirSync(FLAGS_DIR, {recursive: true}); } catch {}
}

export function projectKey(cwd) {
  const abs = resolve(cwd || process.cwd());
  const base = basename(abs).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  return `${base}__${hash}`;
}

function flagPath(flagName, key) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(flagName)) {
    throw new Error(`invalid flag name: ${flagName}`);
  }
  return join(FLAGS_DIR, `${flagName}__${key}.json`);
}

function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, content); } catch {}
  }
}

export function writeFlag(flagName, cwd, payload) {
  ensureFlagsDir();
  const key = projectKey(cwd);
  const path = flagPath(flagName, key);
  const body = JSON.stringify({
    flag: flagName,
    project: key,
    cwd: resolve(cwd || process.cwd()),
    ts: new Date().toISOString(),
    ...payload,
  });
  atomicWrite(path, body);
  return path;
}

export function readAndClearFlag(flagName, cwd) {
  // Read-then-delete pattern, no TOCTOU guard: under multi-window Claude
  // Code (two sessions opening the same project simultaneously), two
  // readers can pass an existsSync check and both emit the nudge. Drop
  // the guard — readFileSync throwing is the natural absence signal.
  const key = projectKey(cwd);
  const path = flagPath(flagName, key);
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  try { unlinkSync(path); } catch {}
  return payload;
}

export function listPendingFlags(cwd) {
  if (!existsSync(FLAGS_DIR)) return [];
  const key = projectKey(cwd);
  const suffix = `__${key}.json`;
  const out = [];
  let entries;
  try { entries = readdirSync(FLAGS_DIR); } catch { return []; }
  for (const f of entries) {
    if (!f.endsWith(suffix)) continue;
    const flagName = f.slice(0, f.length - suffix.length);
    const path = join(FLAGS_DIR, f);
    let payload = null;
    try { payload = JSON.parse(readFileSync(path, 'utf-8')); } catch {}
    let mtime = null;
    try { mtime = statSync(path).mtime.toISOString(); } catch {}
    out.push({flag: flagName, path, mtime, payload});
  }
  return out;
}

export function clearAllFlagsForProject(cwd) {
  const flags = listPendingFlags(cwd);
  const cleared = [];
  for (const f of flags) {
    try { unlinkSync(f.path); cleared.push(f.flag); } catch {}
  }
  return cleared;
}

export const FLAGS_DIR_PATH = FLAGS_DIR;
