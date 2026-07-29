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

import {writeFileSync, renameSync, unlinkSync, mkdirSync, readFileSync} from 'node:fs';
import {join, dirname, basename, isAbsolute, relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {logAdvisory} from './lib/prism-advisory-log.mjs';
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';

// D046 finding #3 — the old canonical-only regex (`^\d{4}-\d{2}-\d{2}-
// SESSION-HANDOFF\.md$`) silently missed any real handoff whose slug wasn't
// the generic "SESSION-HANDOFF" (e.g. the real, /prism-clean-authored
// "2026-06-04-distribution-fixes-handoff.md") — the file existed, but no
// pointer got written, so the next session's HANDOFF-RECALL block silently
// pointed at a STALE prior handoff (or nothing). Verified against the real
// corpus (docs/prism/plans + docs/prism/lessons, 39 files): the old regex
// matched 15/39; this one matches 39/39, with zero false positives among
// the 24 newly-caught files (each spot-checked as a genuine handoff).
const HANDOFF_BASENAME_RE = /^\d{4}-\d{2}-\d{2}-.*HANDOFF.*\.md$/i;
// A basename that mentions "handoff" but fails the canonical pattern above —
// e.g. a version-numbered doc like the real `docs/prism/HANDOFF-5.7.3-
// dispatch-memory-concurrency.md`, which predates the YYYY-MM-DD convention
// and is NOT caught even by the broadened regex. This is the residual class
// the near-miss signal below exists to surface, rather than silently drop.
const HANDOFF_LOOSE_RE = /handoff/i;
// Test/fixture marker — same convention as prism-session-start.mjs's
// HANDOFF-RECALL reconciliation scan (D046 finding #3, F3b design): a
// basename containing COTEST is a test fixture, never a real handoff, and
// must never fire ANY signal (pointer or near-miss).
const FIXTURE_MARKER_RE = /COTEST/i;
const DOCS_PRISM_RE = /[/\\]docs[/\\]prism[/\\]/i;

// Classifies a Write/Edit/MultiEdit target against the handoff-pointer
// contract:
//   'canonical' — under docs/prism/ AND matches the broadened pattern;
//                 pointer gets written.
//   'near-miss' — mentions "handoff" but is not a pointer-write target
//                 (either it fails the canonical pattern, or it is outside
//                 docs/prism/ entirely — task #16): no pointer, but a
//                 ledger line + best-effort stdout note (see run()).
//   'fixture'   — carries the COTEST marker; never a real handoff, silent.
//   'no'        — no "handoff" mention at all.
//
// Task #16 (D047 vacuous-signal class): the near-miss check used to sit
// DOWNSTREAM of the DOCS_PRISM_RE path gate, so a handoff-shaped file
// outside docs/prism/ (e.g. a real project's tasks/HANDOFF_*.md — measured
// as 48% of real *handoff* files across 3 external corpora) hit the gate
// first and returned 'no' — not even a near-miss. The ledger that exists
// specifically to make misses visible could not see the biggest miss,
// because it was scoped to the same gate it was meant to audit. The fix:
// the in-scope check (`inScope`) now gates ONLY the pointer-write
// ('canonical') branch, never the near-miss detection — so an out-of-scope
// handoff-shaped basename still reaches HANDOFF_LOOSE_RE and is classified
// 'near-miss' (ledger-visible, no pointer). Pointer-write behavior for
// in-scope files is unchanged: canonical still requires BOTH inScope AND
// HANDOFF_BASENAME_RE, exactly as before. DOCS_PRISM_RE itself is not
// widened — this is detection-only, per the task's explicit scope.
function classifyHandoffPath(p) {
  if (typeof p !== 'string' || !p) return 'no';
  const normalized = '/' + p.replace(/\\/g, '/');
  const inScope = DOCS_PRISM_RE.test(normalized);
  const bn = basename(p);
  if (FIXTURE_MARKER_RE.test(bn)) return 'fixture';
  if (inScope && HANDOFF_BASENAME_RE.test(bn)) return 'canonical';
  if (HANDOFF_LOOSE_RE.test(bn)) return 'near-miss';
  return 'no';
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
    // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY before
    // the unlink+rethrow below.
    renameWithRetry(renameSync, tmp, path);
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
  const kind = classifyHandoffPath(filePath);
  if (kind === 'no' || kind === 'fixture') return ok;

  if (kind === 'near-miss') {
    // DETECT -> LEDGER leg (D046 dominant-defect-shape): a handoff-shaped
    // write that the canonical pattern will NOT record. logAdvisory() is
    // itself fail-open (never throws), so no extra try/catch is needed here.
    const bn = basename(filePath);
    logAdvisory({event: 'handoff_pointer_near_miss', path: filePath, basename: bn, session_id: payload.session_id || null});
    // SURFACE-AT-CONSUMPTION leg: the canonical channel for this is
    // PostToolUse `hookSpecificOutput.additionalContext`, which requires
    // hooks/prism-posttooluse-dispatcher.mjs to merge a `context` field from
    // routed hooks — today it only concatenates plain stdout, which Claude
    // Code does NOT add to model context (transcript-only, same measured gap
    // as this hook's own existing success message below). That dispatcher
    // change is cross-cutting (all 8 routed hooks) and out of this fix's
    // scope. The stdout line below matches this hook's existing convention
    // and is real — visible in the raw transcript, and to any caller that
    // reads stdout directly (e.g. a test) — but does not yet reach the
    // agent's context on a live PostToolUse turn. The ledger line above is
    // the channel that works today.
    return {exit: 0, stdout: `[prism-handoff-pointer] NOT RECORDED: '${bn}' looks like a handoff but does not match <YYYY-MM-DD>-...HANDOFF...md — the next session will NOT be pointed at this file. Rename it to the canonical date-prefixed form now if this is a real session handoff.`, stderr: ''};
  }

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

// Standalone CLI shim — lets tools/prism-audit-runner.mjs (spawn + stdin)
// exercise this hook directly. Mirrors hooks/prism-anti-nesting-inject.mjs.
// The basename guard keeps it INERT when the module is imported in-process by
// hooks/prism-posttooluse-dispatcher.mjs (process.argv[1] is the dispatcher).
if (process.argv[1] && basename(process.argv[1]) === 'prism-handoff-pointer.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  try {
    const r = await run(input);
    if (r && r.stdout) process.stdout.write(r.stdout);
    process.exit((r && r.exit) || 0);
  } catch { process.exit(0); }
}
