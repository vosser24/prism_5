#!/usr/bin/env node
// PRISM Handoff Pointer (task #31) — PostToolUse
//
// Deterministic resume pointer for the /prism-clean Step 4b session-handoff
// doc. Step 4b writes a narrative handoff at
// docs/prism/plans/<YYYY-MM-DD>-SESSION-HANDOFF.md (or docs/prism/lessons/),
// but nothing pointed a resumed session at the LATEST one: memory-heal
// repoints only decisions/lessons/standing-rules, and SessionStart's
// TASK-RECALL consumes the .prism-open-tasks.json task sidecar — the richer
// narrative doc had only a hand-written, silently-staling MEMORY.md line.
//
// This hook records the pointer AT WRITE TIME, as a side-effect of the very
// Write/Edit that creates the handoff — never a second manual step (D040).
// It writes <cwd>/.claude/.prism-latest-handoff.json:
//   { path, ts, git_sha, session_id }
// git_sha is HEAD at write time (SHA-STAMP-001 pattern); SessionStart's
// HANDOFF-RECALL block surfaces the pointer with the same [CURRENT] /
// [STALE — N commits behind HEAD] staleness labeling the task sidecar gets.
//
// A SEPARATE sidecar (not folded into .prism-open-tasks.json) because
// SessionEnd rewrites that file wholesale and only on Task-API activity —
// the handoff pointer has an independent lifecycle (persists across sessions
// until a newer handoff replaces it) and must not be clobbered.
//
// docs/ is gitignored (public-mirror hygiene) — the handoff is an on-disk
// LOCAL artifact. The pointer is therefore purely on-disk too; the SHA stamp
// compares repo HEAD positions, which works fine for an untracked file.
//
// Trigger: PostToolUse {Write, Edit, MultiEdit} where the target basename is
// <YYYY-MM-DD>-SESSION-HANDOFF.md under a docs/prism/ path.
// Off-switch: PRISM_DISABLE_HANDOFF_POINTER=1
// Fail-open: any error returns exit 0 silently — never breaks PostToolUse.

import {writeFileSync, renameSync, unlinkSync, mkdirSync} from 'node:fs';
import {join, dirname, basename, isAbsolute, relative} from 'node:path';
import {spawnSync} from 'node:child_process';

const HANDOFF_BASENAME_RE = /^\d{4}-\d{2}-\d{2}-SESSION-HANDOFF\.md$/i;
const DOCS_PRISM_RE = /[/\\]docs[/\\]prism[/\\]/i;

function isHandoffPath(p) {
  if (typeof p !== 'string' || !p) return false;
  // Accept both an absolute path and a cwd-relative one like
  // "docs/prism/plans/2026-07-16-SESSION-HANDOFF.md" (no leading separator).
  const normalized = '/' + p.replace(/\\/g, '/');
  return HANDOFF_BASENAME_RE.test(basename(p)) && DOCS_PRISM_RE.test(normalized);
}

function gitHeadSha(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'],
      {encoding: 'utf-8', timeout: 2000, windowsHide: true});
    const sha = (r.stdout || '').trim();
    if (r.status === 0 && /^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch {}
  return null;
}

function atomicWrite(path, content) {
  const tmp = path + '.tmp-' + process.pid;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

export async function run(payload) {
  const ok = {exit: 0, stdout: '', stderr: ''};
  if (process.env.PRISM_DISABLE_HANDOFF_POINTER === '1') return ok;
  if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) return ok;

  const filePath = payload.tool_input && payload.tool_input.file_path;
  if (!isHandoffPath(filePath)) return ok;

  try {
    const cwd = payload.cwd || process.cwd();
    // Store the pointer path relative to the project root when it is under
    // it, so the sidecar survives a repo relocation; keep absolute otherwise.
    let ptrPath = filePath;
    if (isAbsolute(filePath)) {
      const rel = relative(cwd, filePath);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) ptrPath = rel.replace(/\\/g, '/');
    } else {
      ptrPath = filePath.replace(/\\/g, '/');
    }

    const pointer = {
      path: ptrPath,
      ts: new Date().toISOString(),
      git_sha: gitHeadSha(cwd), // SHA-STAMP-001 — null when not resolvable
      session_id: payload.session_id || null,
    };
    const projClaudeDir = join(cwd, '.claude');
    mkdirSync(projClaudeDir, {recursive: true});
    atomicWrite(join(projClaudeDir, '.prism-latest-handoff.json'), JSON.stringify(pointer, null, 2));
    const shortSha = pointer.git_sha ? pointer.git_sha.slice(0, 8) : 'no-git';
    return {exit: 0, stdout: `[prism-handoff-pointer] latest-handoff pointer recorded: ${ptrPath} @ ${shortSha}`, stderr: ''};
  } catch {
    return ok;
  }
}
