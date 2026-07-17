#!/usr/bin/env node
// PRISM SessionStart (v3.6.0) — reset project turn counter + run once-per-day
// context-tax audit + v2.9.1 strict-mode migration notice + v3.6.0 plugin
// reference-file bootstrap.
//
// v3.6.0 (PLUGIN-BOOTSTRAP-001): when running under a plugin install
// (Claude Code sets ${CLAUDE_PLUGIN_ROOT}), copy critical reference files
// from the plugin payload into ~/.claude/skills/prism-plan/references/ so
// downstream skills (prism-plan, master-orchestrator) can read them at the
// expected path. Idempotent via a flag file; preserves user-owned
// roster.json on re-runs. Manual installs (no CLAUDE_PLUGIN_ROOT) skip the
// bootstrap entirely — install.sh already places the files. Fail-open on
// errors: any I/O failure logs to stderr and does NOT block session start.
//
// v3.2.0: removed the "classifier is running in keyword-floor-only mode"
// notice. Keyword-floor is now the standard classification mode, not a
// degraded one (the API classifier path was removed in v3.2.0). See
// hooks/lib/prism-opus-classifier.mjs and hooks/prism-prompt-tier-router.mjs.
//
// v2.9.1 (ATOMIC-WRITE-001): every state write now uses tempfile + renameSync
// with catch-fallback to direct writeFileSync. Matches v2.8.0 sentinel-write
// pattern in prism-parent-dispatch-guard.mjs:90-107. Covers: project
// .prism-state.json, context-audit .prism-context-audit.last, floor-hint
// .prism-floor-hint.last. Prevents truncated state on crash during write.
//
// v2.9.1 migration notice: when PRISM_MODEL_GUARD=hard is in env AND the
// one-time flag ~/.claude/.prism-v2.9.1-migration-shown is absent, emit a
// 3-line notice about the hard-mode contract change (see agent-model-guard).
//
// v2.1.25 Gap 1 closure baseline:
//
// [WHY] Every session Claude Code dumps ~10k tokens of plugin skill
// descriptions before your first prompt (~$0.15 on Opus input). Users
// couldn't see this tax because nothing surfaced it. This hook runs
// ~/.claude/tools/prism-context-audit.mjs once per day and emits a compact
// one-line notice with the top "disable X to save Yt" recommendation.
// Output is throttled to once per 24h so it doesn't itself become noise.
import {writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync, appendFileSync} from 'fs';
import {join, isAbsolute} from 'path';
// detached spawn (audit block) uses a dynamic import. The git-sha staleness
// check below uses async execFile — deliberately NOT the blocking sync
// child_process call — because this file was hardened after a prior
// incident (E-P4: a blocking synchronous spawn in the context-audit path
// added multi-second latency to every SessionStart); see
// tests/v3/hooks/test-session-start-async-audit.mjs's structural guard,
// which asserts zero blocking-sync-spawn calls anywhere in this source.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'url';

const execFileAsync = promisify(execFile);

const H = process.env.HOME || process.env.USERPROFILE;
const LAST_FILE = join(H, '.claude', '.prism-context-audit.last');
const CACHE_FILE = join(H, '.claude', '.prism-context-audit.json');
const AUDIT_TOOL = join(H, '.claude', 'tools', 'prism-context-audit.mjs');
const MIGRATION_FLAG = join(H, '.claude', '.prism-v2.9.1-migration-shown');
const PLUGIN_BOOTSTRAP_FLAG = join(H, '.claude', '.prism-plugin-bootstrap-done-v3.6');
const THROTTLE_SECONDS = 24 * 60 * 60;  // 24h
const NOTICE_TOKEN_FLOOR = 5000;         // only nag when tax is meaningful

// v3.6.0 PLUGIN-BOOTSTRAP-001: when Claude Code runs PRISM as a plugin it
// sets CLAUDE_PLUGIN_ROOT to the unpacked plugin directory. The plugin
// payload ships skills/prism-plan/references/* but downstream skills look
// at the user-scoped path ~/.claude/skills/prism-plan/references/. This
// helper copies the critical files across on first plugin session, then
// gates on a flag file so re-runs are no-ops. Manual installs (no env
// var) skip entirely. Fail-open: any error writes a stderr warning and
// returns — never blocks session start.
function bootstrapPluginReferences() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return;                         // manual install — skip
  if (existsSync(PLUGIN_BOOTSTRAP_FLAG)) return;   // already bootstrapped

  // Copy-without-overwrite for roster.json (preserves user data).
  // Copy-with-overwrite for the registry/template files (they are the
  // canonical PRISM-owned content and must track the shipped version).
  const overwriteFiles = [
    'adversarial-review.md',
    'model-matrix.md',
    'prompt-templates.md',
    'tools-registry.md',
    'mcp-registry.md',
  ];
  const preserveFiles = ['roster.json'];

  const srcDir = join(pluginRoot, 'skills', 'prism-plan', 'references');
  const dstDir = join(H, '.claude', 'skills', 'prism-plan', 'references');

  if (!existsSync(srcDir)) {
    process.stderr.write(`PRISM WARN: plugin bootstrap skipped — source dir not found: ${srcDir}\n`);
    return;
  }

  try {
    mkdirSync(dstDir, {recursive: true});
  } catch (e) {
    process.stderr.write(`PRISM WARN: plugin bootstrap could not create ${dstDir}: ${e && e.message}\n`);
    return;
  }

  let copied = 0;
  for (const f of overwriteFiles) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    if (!existsSync(src)) continue;
    // Bootstrap only if missing — preserve any user customisation that
    // post-dates the plugin payload. Re-bootstrap of newer payloads is
    // gated by the flag-file version (.prism-plugin-bootstrap-done-v3.6
    // → bump on next bootstrap-changing release).
    if (existsSync(dst)) continue;
    try { copyFileSync(src, dst); copied++; }
    catch (e) { process.stderr.write(`PRISM WARN: plugin bootstrap copy failed for ${f}: ${e && e.message}\n`); }
  }
  for (const f of preserveFiles) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) continue;  // never overwrite user roster.json
    try { copyFileSync(src, dst); copied++; }
    catch (e) { process.stderr.write(`PRISM WARN: plugin bootstrap copy failed for ${f}: ${e && e.message}\n`); }
  }

  // Mark bootstrap done regardless of copied count — if the source dir
  // existed and we got this far, the plugin is responsible for any
  // subsequent updates. (A future plugin payload that needs to re-seed
  // bumps the flag-file version.)
  try { writeFileSync(PLUGIN_BOOTSTRAP_FLAG, new Date().toISOString() + ` files_copied=${copied}\n`); }
  catch (e) { process.stderr.write(`PRISM WARN: plugin bootstrap flag write failed: ${e && e.message}\n`); }
}

// v2.9.1 ATOMIC-WRITE-001: tempfile + renameSync with catch-fallback to direct
// writeFileSync. Matches v2.8.0 sentinel-write pattern in
// prism-parent-dispatch-guard.mjs:90-107. Prevents truncated state JSON from
// crashes mid-write (disk-full, antivirus, process kill). Readers downstream
// either see the previous valid file or the new one — never a partial.
function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch {
    // Fallback: direct write. Windows EBUSY under antivirus can break rename;
    // direct write keeps state advancing. Readers have try/catch guards.
    try { writeFileSync(path, content); } catch {}
  }
}

// ── SHA-STAMP-001 (recall-hardening v6.2.0, Task #2) ────────────────────────
// Reads the current git HEAD sha for `cwd` so a handoff pointer's stamped
// git_sha (written by hooks/prism-session-end.mjs) can be compared against
// it. Fail-open by construction: no git binary, cwd not a repo, detached
// HEAD, or a shallow clone all just yield null (`git rev-parse HEAD` still
// resolves fine in a detached/shallow state, so those aren't actually
// failure cases — only a genuinely missing/broken git is). `timeout` bounds
// the call so a hung git process can never block SessionStart. Async
// (execFile, not spawnSync) — see the import-block comment above. Callers
// gate this behind "pointer already carries a git_sha" so it never runs on
// a hot path taken every session.
async function getGitHeadSha(cwd) {
  try {
    const {stdout} = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {timeout: 2000, encoding: 'utf-8'});
    const sha = (stdout || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch {}
  return null;
}

// Cheap commit-distance lookup, only ever called after a sha mismatch is
// already confirmed (see TASK-RECALL below) — a second, equally
// timeout-bounded async call, never a hot-path cost. Any failure (unrelated
// histories, shallow clone missing the old sha, etc.) yields null and the
// caller falls back to a plain STALE label with no count.
async function getCommitDistance(cwd, fromSha, toSha) {
  try {
    const {stdout} = await execFileAsync('git', ['-C', cwd, 'rev-list', '--count', `${fromSha}..${toSha}`], {timeout: 2000, encoding: 'utf-8'});
    const n = parseInt((stdout || '').trim(), 10);
    if (Number.isFinite(n)) return n;
  } catch {}
  return null;
}

try {
  // ── v3.6.0: plugin reference-file bootstrap (idempotent, fail-open) ──
  // Runs first so downstream PRISM skills that fire later in this session
  // see the references at ~/.claude/skills/prism-plan/references/*. No-op
  // for manual installs (CLAUDE_PLUGIN_ROOT unset).
  try { bootstrapPluginReferences(); }
  catch (e) { try { process.stderr.write(`PRISM WARN: plugin bootstrap unexpected error: ${e && e.message}\n`); } catch {} }

  // ── Reset project-local turn counter ──
  // MUST be .prism-turn-state.json, NOT .prism-state.json: the latter is the
  // BOOTSTRAP state machine owned by tools/lib/prism-state.mjs (schema_version,
  // phases, project_slug…). Writing the turn-counter shape here used to clobber
  // it every session start, breaking /prism-deep-dive --refresh, /prism-sync,
  // and /prism-doctor across restarts (v5.1.3 UAT fix).
  const cwd = process.cwd();
  const dir = join(cwd, '.claude');
  mkdirSync(dir, {recursive: true});
  atomicWrite(join(dir, '.prism-turn-state.json'), JSON.stringify({turns: 0, session_start: new Date().toISOString()}));

  // ── v2.1.25 Gap 1: context tax audit (throttled 1/day) ──
  const now = Math.floor(Date.now() / 1000);
  let last = 0;
  try {
    if (existsSync(LAST_FILE)) last = parseInt(readFileSync(LAST_FILE, 'utf-8').trim(), 10) || 0;
  } catch {}

  const dueForFreshAudit = (now - last) >= THROTTLE_SECONDS;
  let audit = null;

  if (dueForFreshAudit && existsSync(AUDIT_TOOL)) {
    // Fire-and-forget: launch the audit as a detached child so the hook
    // exits immediately without blocking on the ~350ms–5s audit run.
    // The fresh result lands in CACHE_FILE for the NEXT session to read.
    // All three flags are required on Windows: detached+stdio:'ignore'+unref()
    // so the parent process can exit before the child finishes.
    try {
      const {spawn} = await import('node:child_process');
      const child = spawn(process.execPath, [AUDIT_TOOL, '--json', '--cache'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch {}
    atomicWrite(LAST_FILE, String(now));
    // Read the PREVIOUS cached result this session for the notice (may be
    // null on first-ever run — acceptable; fresh result lands next session).
    if (existsSync(CACHE_FILE)) {
      try { audit = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {}
    }
  } else if (existsSync(CACHE_FILE)) {
    // Not due — reuse last measurement if present (we won't emit a notice
    // from stale data; just keeps the variable reachable for future code).
    try { audit = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {}
  }

  // Only emit notice on a FRESH audit that crossed the threshold.
  const notices = [];
  if (dueForFreshAudit && audit && audit.total_tokens_est >= NOTICE_TOKEN_FLOOR && audit.top_suggestion) {
    notices.push(`PRISM NOTICE: SessionStart context tax ~${audit.total_tokens_est.toLocaleString()}t (~$${audit.total_cost_opus_usd}/session on Opus). ${audit.top_suggestion}. Full breakdown: node ~/.claude/tools/prism-context-audit.mjs`);
  }

  // ── v3.2.0: keyword-floor is now the standard classification mode (no API
  // path). The previous "classifier-floor visibility" notice has been removed
  // because there is no degraded mode to warn about anymore.

  // ── v2.9.1: strict-mode migration notice (one-shot) ──
  // When PRISM_MODEL_GUARD=hard is in env, hard-mode semantics CHANGED in
  // v2.9.1: hard now denies ONLY opus-tier dispatches without explicit model
  // (matches task-tier-advisor). The old broad behavior moved to `strict`.
  // Show this notice once per host, then never again.
  if (String(process.env.PRISM_MODEL_GUARD || '').toLowerCase() === 'hard' && !existsSync(MIGRATION_FLAG)) {
    notices.push(
      'PRISM v2.9.1 NOTICE: PRISM_MODEL_GUARD=hard semantics changed — hard now denies ONLY opus-tier spawns without explicit model (sonnet/haiku become advisory). ' +
      'To keep the old broad deny behavior, switch to PRISM_MODEL_GUARD=strict. ' +
      'See CHANGELOG.md §v2.9.1 breaking-contract note for details.'
    );
    atomicWrite(MIGRATION_FLAG, new Date().toISOString());
  }

  // ── v4.1 Phase A: flag-file pickup (D005 Phase F bundle + git-clean) ──
  // SessionEnd / PreCompact hooks write side-effect flags (they can't
  // emit additionalContext per D005's verified hook decision-control
  // matrix). We read + clear them here and emit the actual nudges.
  // Fail-open: any error skips this block entirely.
  try {
    const flagHelper = await import(pathToFileURL(join(H, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href).catch(() => null);
    if (flagHelper) {
      const cwd = process.cwd();
      const cleanNudge = flagHelper.readAndClearFlag('clean-nudge', cwd);
      if (cleanNudge) {
        const trigger = cleanNudge.reason === 'precompact' ? 'context compaction' : '/clear';
        notices.push(`PRISM NUDGE: previous session ended via ${trigger}. Run /prism-clean to capture lessons before they're lost. (Set PRISM_DISABLE_CLEAR_NUDGE=1 or PRISM_DISABLE_PRECOMPACT_NUDGE=1 to suppress.)`);
      }
      const gitDirty = flagHelper.readAndClearFlag('git-dirty', cwd);
      if (gitDirty && gitDirty.count) {
        const sample = (gitDirty.sample || []).slice(0, 3).join(', ');
        const more = gitDirty.count > 3 ? ` (+${gitDirty.count - 3} more)` : '';
        notices.push(`PRISM NUDGE: previous session left ${gitDirty.count} uncommitted change${gitDirty.count === 1 ? '' : 's'} in the working tree: ${sample}${more}. Review with \`git status\`; commit or stash before risky operations. (Set PRISM_DISABLE_GIT_CLEAN_NUDGE=1 to suppress.)`);
      }
    }
  } catch {}

  // ── v4.4 Layer B: OOB PHASE 1.5 verdict pickup ──
  // Reads completed verdict files and surfaces UN-CITED/REJECTED items as
  // [Prior turn] prefixed notices. Severity-filtered: all-EVIDENCED is silent.
  // Supports two schemas:
  //   • Legacy (v4.4): {verdicts:[{verdict,class,reasoning}], specialist_name}
  //   • New (v4.5):    {verdict:{severity,headline_finding}, task_sha}
  // Strategy: try verdictLib first (handles legacy schema via SHA registry);
  // fall through to direct filesystem scan for new-schema files in either case.
  const phase1_5Cleared = new Set();  // track SHAs already cleared to avoid double-delete
  try {
    const verdictLib = await import(pathToFileURL(join(H, '.claude', 'tools', 'lib', 'prism-verdict-flag.mjs')).href).catch(() => null);
    if (verdictLib) {
      const completed = verdictLib.listCompletedVerdicts();
      for (const sha of completed.slice(0, 5)) {  // cap surface area
        const v = verdictLib.readVerdict(sha);
        if (!v) continue;
        if (Array.isArray(v.verdicts)) {
          // Legacy schema: verdicts[] array
          const flagged = v.verdicts.filter(c => c.verdict === 'UN-CITED' || c.verdict === 'REJECTED');
          if (flagged.length > 0) {
            const sample = flagged.slice(0, 3).map(c => `${c.verdict} (${c.class}): ${c.reasoning.slice(0, 80)}`).join('; ');
            const more = flagged.length > 3 ? ` (+${flagged.length - 3} more)` : '';
            notices.push(`[Prior turn] OOB PHASE 1.5 reviewer flagged ${flagged.length} claim${flagged.length === 1 ? '' : 's'} on ${v.specialist_name}: ${sample}${more}. Verdict: ~/.claude/.prism-phase-1-5-verdicts-${sha}.json. Master should reconcile per phase-1-5-senior-review.md.`);
          }
        } else if (v.verdict && v.verdict.severity) {
          // New schema: single verdict object with severity + headline_finding
          const sev = v.verdict.severity;
          if (sev === 'UN-CITED' || sev === 'REJECTED') {
            const taskRef = v.task_sha ? ` on task ${v.task_sha}` : '';
            const detail = v.verdict.headline_finding ? ` — ${v.verdict.headline_finding.slice(0, 120)}` : '';
            notices.push(`[Prior turn] OOB PHASE 1.5 reviewer flagged${taskRef}: ${sev}${detail}. Verdict: ~/.claude/.prism-phase-1-5-verdicts-${sha}.json. Master should reconcile per phase-1-5-senior-review.md.`);
          }
        }
        verdictLib.clearVerdict(sha);  // clear after pickup
        phase1_5Cleared.add(sha);
      }
    }
  } catch {}

  // ── v4.5 Layer 2: direct scan for phase_1_5 new-schema verdict files ──
  // Handles cases where verdictLib is absent (sandbox, fresh install) or the
  // file uses the new single-verdict schema not covered by the lib's enumeration.
  try {
    const claudeDir15 = join(H, '.claude');
    if (existsSync(claudeDir15)) {
      let entries15 = [];
      try { entries15 = readdirSync(claudeDir15); } catch {}
      const phase1_5Files = entries15
        .filter(f => f.startsWith('.prism-phase-1-5-verdicts-') && f.endsWith('.json'))
        .slice(0, 5);
      for (const f of phase1_5Files) {
        const sha = f.slice('.prism-phase-1-5-verdicts-'.length, f.length - '.json'.length);
        if (phase1_5Cleared.has(sha)) continue;  // already handled by verdictLib
        const filePath = join(claudeDir15, f);
        let v = null;
        try { v = JSON.parse(readFileSync(filePath, 'utf-8')); } catch {}
        if (!v) { try { unlinkSync(filePath); } catch {} continue; }
        // Only handle new-schema files here; legacy verdicts[] is covered by verdictLib above
        if (v.verdict && v.verdict.severity && !Array.isArray(v.verdicts)) {
          const sev = v.verdict.severity;
          if (sev === 'UN-CITED' || sev === 'REJECTED') {
            const taskRef = v.task_sha ? ` on task ${v.task_sha}` : '';
            const detail = v.verdict.headline_finding ? ` — ${v.verdict.headline_finding.slice(0, 120)}` : '';
            notices.push(`[Prior turn] OOB PHASE 1.5 reviewer flagged${taskRef}: ${sev}${detail}. Verdict: ~/.claude/${f}. Master should reconcile per phase-1-5-senior-review.md.`);
          }
        }
        try { unlinkSync(filePath); } catch {}  // clear after pickup
      }
    }
  } catch {}

  // ── v4.5 Layer 2: OOB PHASE 0d verdict pickup ──
  // Reads completed phase-0d verdict files written by prism-phase-0d-oob.mjs
  // and surfaces REJECTED/ERROR items as [Prior turn] prefixed notices.
  // Schema: {kind:'phase_0d', verdict:{severity, headline_finding}, ...}
  // Fail-open: any error skips this block entirely.
  try {
    const claudeDir = join(H, '.claude');
    if (existsSync(claudeDir)) {
      let entries = [];
      try { entries = readdirSync(claudeDir); } catch {}
      const phase0dFiles = entries
        .filter(f => f.startsWith('.prism-phase-0d-verdicts-') && f.endsWith('.json'))
        .slice(0, 5);  // cap surface area
      for (const f of phase0dFiles) {
        const filePath = join(claudeDir, f);
        let v = null;
        try { v = JSON.parse(readFileSync(filePath, 'utf-8')); } catch {}
        if (!v) { try { unlinkSync(filePath); } catch {} continue; }
        const severity = v.verdict && v.verdict.severity;
        const headline = v.verdict && v.verdict.headline_finding;
        if (severity === 'REJECTED' || severity === 'ERROR') {
          const taskRef = v.task_sha ? ` (task ${v.task_sha})` : '';
          notices.push(`[Prior turn] OOB PHASE 0d reviewer flagged${taskRef}: ${severity}${headline ? ' — ' + headline.slice(0, 120) : ''}. Verdict: ~/.claude/${f}. Master should reconcile before continuing.`);
        }
        try { unlinkSync(filePath); } catch {}  // clear after pickup
      }
    }
  } catch {}

  // ── K4 — master-override pickup: drain .prism-override-pending-*.json into the
  // routing log, count them, and advise. SessionStart cannot hard-block (exit-2
  // ignored), so PRISM_OVERRIDE_GATE=strict only escalates wording (ISSUE-4).
  try {
    const claudeDir = join(H, '.claude');
    const routingLog = join(claudeDir, '.prism-routing.jsonl');
    const pend = readdirSync(claudeDir).filter(f => f.startsWith('.prism-override-pending-') && f.endsWith('.json'));
    let overrides = 0;
    for (const f of pend) {
      const fp = join(claudeDir, f);
      let ev;
      try { ev = JSON.parse(readFileSync(fp, 'utf8')); } catch { ev = null; }
      if (ev) {
        const line = JSON.stringify({ ts: new Date().toISOString(), event: 'master_override', schema_version: 4,
          verdict_sha: ev.verdict_sha ?? null, kind: ev.kind ?? null, reviewer_severity: ev.reviewer_severity ?? null,
          master_verdict: ev.master_verdict ?? null, task_sha: ev.task_sha ?? null, specialist_name: ev.specialist_name ?? null }) + '\n';
        try { appendFileSync(routingLog, line); } catch {}
        overrides++;
      }
      try { unlinkSync(fp); } catch {}
    }
    if (overrides > 0) {
      const strict = process.env.PRISM_OVERRIDE_GATE === 'strict';
      notices.push(strict
        ? `[OVERRIDE GATE — strict] You overrode ${overrides} reviewer verdict(s) last session. Review each override and confirm intent before continuing.`
        : `[Prior turn] You overrode ${overrides} reviewer verdict(s) last session. Logged to .prism-routing.jsonl (event: master_override).`);
    }
  } catch (e) { process.stderr.write(`[session-start/override] ${e.message}\n`); }

  // ── v4.1 Phase B: daily freshness sweep ──
  // One throttled (24h) pass closes 6 audit questions (plugin drift,
  // stale agents, update-log age, CLAUDE.md mtime, tools-registry
  // rotations). Off-switch: PRISM_DISABLE_FRESHNESS_SWEEP=1.
  // Fail-open: any error skips silently.
  if (String(process.env.PRISM_DISABLE_FRESHNESS_SWEEP || '') !== '1') {
    try {
      const sweep = await import(pathToFileURL(join(H, '.claude', 'hooks', 'lib', 'prism-freshness-sweep.mjs')).href).catch(() => null);
      if (sweep && typeof sweep.runFreshnessSweep === 'function') {
        // cwd lets the C3 version-lag check compare the installed version
        // against a PRISM clone when the session opens inside one.
        const r = sweep.runFreshnessSweep({home: H, cwd: process.cwd()});
        if (r && Array.isArray(r.notices)) {
          for (const n of r.notices) notices.push(n);
        }
      }
    } catch {}
  }

  // ── v4.7 K1: surface an OVERRIDDEN parallel-dispatch cap to the orchestrator ──
  // The dispatch-cap hook LOGS the cap, but the orchestrator (running as the
  // model, reading dispatch-shapes.md) only obeys what it sees in context. At
  // the default (4) the prose already says 4, so we inject nothing — no
  // per-session token noise. Only when PRISM_PARALLEL_CAP overrides the default
  // do we inject the active value, so telemetry and doctrine stay in sync.
  // Fail-open: if the resolver can't load, skip silently (orchestrator keeps
  // the prose default).
  try {
    const capRaw = process.env.PRISM_PARALLEL_CAP;
    if (capRaw != null && String(capRaw).trim() !== '') {
      const capLib = await import(pathToFileURL(join(H, '.claude', 'hooks', 'lib', 'prism-cap.mjs')).href).catch(() => null);
      if (capLib && typeof capLib.resolveParallelCap === 'function') {
        const cap = capLib.resolveParallelCap();
        if (cap !== capLib.DEFAULT_PARALLEL_CAP) {
          notices.push(`PRISM: active parallel-dispatch cap is ${cap} (overridden via PRISM_PARALLEL_CAP; default ${capLib.DEFAULT_PARALLEL_CAP}). Honor this cap — not the doc default — when batching parallel Agent() dispatches.`);
        }
      }
    }
  } catch {}

  // v5.3.1 — standing PARALLEL-BATCH reminder. Everyday multi-step work tends to
  // serialise: only the main loop can fan out (dispatched workers have no Agent
  // tool), and the rich dispatch-shapes.md guidance only loads under a formal
  // plan/orchestrator. One concise always-on line keeps the batch-fan-out
  // default in context from turn one. Suppress: PRISM_DISABLE_PARALLEL_REMINDER=1.
  if (process.env.PRISM_DISABLE_PARALLEL_REMINDER !== '1') {
    notices.push(`PRISM: when a request has 2+ INDEPENDENT subtasks (different files/targets, no shared output), dispatch them as MULTIPLE Agent() tool_use blocks in ONE message — they run concurrently (wall-clock = max(each), not sum). Only the main loop can fan out, so batch — don't serialise across turns. (Suppress: PRISM_DISABLE_PARALLEL_REMINDER=1.)`);
  }

  // v5.x — surface the active PANEL MODE when overridden to role-play. Mirrors
  // the parallel-cap pattern: inject only on the non-default (roleplay) so a
  // default-"dispatch" session carries no extra token noise. Fail-open.
  try {
    const pmRaw = process.env.PRISM_PANEL_MODE;
    if (pmRaw != null && String(pmRaw).trim() !== '') {
      const pmLib = await import(pathToFileURL(join(H, '.claude', 'hooks', 'lib', 'prism-panel-mode.mjs')).href).catch(() => null);
      if (pmLib && typeof pmLib.resolvePanelMode === 'function') {
        const mode = pmLib.resolvePanelMode();
        if (mode !== pmLib.DEFAULT_PANEL_MODE) {
          notices.push(`PRISM: active panel mode is ${mode} (overridden via PRISM_PANEL_MODE; default ${pmLib.DEFAULT_PANEL_MODE}). Honor this mode — assemble the PHASE 0d panel as ${mode} AND write \`dispatch_mode: "${mode}"\` in the panel.json (the panel-guard enforces the written value).`);
        }
      }
    }
  } catch {}

  // ── v5.7 — self-healing claude-mem performance guard ──
  // claude-mem auto-updates silently and, on Windows, its hooks (a) ran a ~1s
  // login-shell PATH probe on every tool call and (b) bound a deterministic
  // worker port (37777) that ghosts on abnormal exit and blocks every restart.
  // This guard idempotently neutralizes the probe in the active hooks.json and
  // pins the worker to a fresh port in claude-mem's own settings.json, re-
  // asserting both after every claude-mem update. Config-only (manages no
  // processes); fail-open. Off-switch: PRISM_DISABLE_CLAUDE_MEM_GUARD=1.
  try {
    const cmGuard = await import(pathToFileURL(join(H, '.claude', 'hooks', 'lib', 'prism-claude-mem-guard.mjs')).href).catch(() => null);
    if (cmGuard && typeof cmGuard.healClaudeMem === 'function') {
      const r = await cmGuard.healClaudeMem({home: H});
      if (r && Array.isArray(r.notices)) { for (const n of r.notices) notices.push(n); }
    }
  } catch {}

  // ── ACL SessionStart digest (F-WS-F): surface "PRISM learned: ..." once ──────
  // The Autonomous Capability Loop writes created/upgraded capability names to
  // .prism-acl-digest.json; fold that one line into this SessionStart's notices.
  // (v5.9.4: wired here — prism-acl-notify.mjs was deployed but previously
  //  UNWIRED, so the digest never surfaced.) Off-switch: PRISM_DISABLE_ACL_NOTIFY=1.
  try {
    if (process.env.PRISM_DISABLE_ACL_NOTIFY !== '1') {
      const aclNotify = await import(pathToFileURL(join(H, '.claude', 'hooks', 'prism-acl-notify.mjs')).href).catch(() => null);
      if (aclNotify && typeof aclNotify.getNotice === 'function') {
        const learned = aclNotify.getNotice(H);
        if (learned) notices.push(learned);
      }
    }
  } catch {}

  // ── knowledge delta: surface adjudications/lessons added since last session ──
  // In-process via tools/lib/knowledge-delta.mjs (applyDelta). No subprocess.
  // If added/changed entries exist, emits a compact digest as additionalContext.
  // Off-switch: PRISM_DISABLE_KNOWLEDGE_DELTA=1.
  if (process.env.PRISM_DISABLE_KNOWLEDGE_DELTA !== '1') {
    try {
      const deltaLibPath = join(H, '.claude', 'tools', 'lib', 'knowledge-delta.mjs');
      const deltaLib = await import(pathToFileURL(deltaLibPath).href).catch(() => null);
      if (deltaLib && typeof deltaLib.applyDelta === 'function') {
        const projectDir = process.cwd();
        const kd = await deltaLib.applyDelta(projectDir).catch(() => null);

        // ── C6 (recall-hardening v6.2.0): MEMORY.md freshness heal ──────────
        // Runs immediately after applyDelta (right here, per the spec's wiring
        // point) and BEFORE the MEMORY-INJECT block further down, so the
        // {added, changed} delta just computed above can upsert any missing
        // MEMORY.md pointer (the D038-style silent-miss this closes) and the
        // Standing-rules block can regenerate from Locked adjudication
        // **Rule:** lines — all before MEMORY.md gets read for injection this
        // same session. Both CORE functions (tools/lib/memory-heal.mjs) are
        // fail-open by construction; this call site wraps them in its own
        // try/catch too, belt-and-suspenders. Off-switch:
        // PRISM_DISABLE_MEMORY_HEAL=1.
        if (process.env.PRISM_DISABLE_MEMORY_HEAL !== '1') {
          try {
            const healLibPath = join(H, '.claude', 'tools', 'lib', 'memory-heal.mjs');
            const healLib = await import(pathToFileURL(healLibPath).href).catch(() => null);
            if (healLib) {
              if (typeof healLib.healMemoryPointers === 'function') {
                healLib.healMemoryPointers(projectDir, {delta: kd || {added: [], changed: [], removed: []}});
              }
              if (typeof healLib.regenerateStandingRules === 'function') {
                healLib.regenerateStandingRules(projectDir);
              }
            }
          } catch {}
        }

        if (kd) {
          // D023: fire ONLY when corpus actually changed (added/changed non-empty).
          // Emit nothing when unchanged. Cap to 3 items. Prefer rule line over title.
          const changed = [].concat(kd.added || [], kd.changed || []);
          if (changed.length > 0) {
            const cap = changed.slice(0, 3);
            const more = changed.length > 3 ? ` (+${changed.length - 3} more)` : '';
            const digest = cap.map(e => {
              // applyDelta returns plain relPath strings in added/changed arrays.
              if (typeof e === 'string') return `[${e}]`;
              // Prefer rule line; fall back to title.
              const label = (e.rule && e.rule.trim()) ? e.rule.trim()
                : (e.title ? `${e.ref ? '[' + e.ref + '] ' : ''}${e.title}` : `[${e.ref || e.file || JSON.stringify(e)}]`);
              return label;
            }).join('; ');
            notices.push(`PRISM knowledge delta since last session: ${digest}${more}.`);
          }
          // If changed is empty (corpus unchanged), emit nothing — no noise.
        }
      }
    } catch {}
  }

  // ── v5.12.2 — project-master MEMORY.md loader (MEMORY-INJECT-001) ──────────
  // The project-master agent (master-<slug>, set via .claude/settings.json
  // {"agent": ...}) runs as the SESSION-LEVEL / main-session agent, NOT as a
  // dispatched subagent. Per https://code.claude.com/docs/en/sub-agents the
  // `memory:` frontmatter MEMORY.md injection is documented only for the
  // dispatched-subagent path ("Enable persistent memory" + "What loads at
  // startup"); the main-session-agent path (`--agent` / `agent` setting) is
  // documented to load only "CLAUDE.md files and project memory through the
  // normal message flow" — `memory:` is NOT listed among the fields with
  // main-session behavior (unlike `initialPrompt`, `mcpServers`, `hooks`).
  // So when master-<slug> is the session agent, its seeded MEMORY.md is NOT
  // guaranteed to be injected by the platform. This loader reads the seeded
  // file and emits it as SessionStart additionalContext so the profile reaches
  // the agent regardless of the platform path. Belt-and-suspenders: harmless
  // even if the platform also injects it (content is idempotent profile data).
  //
  // The deep-dive memory-seed subcommand writes to <project>/.claude/agents/
  // MEMORY.md (adjacent to the agent def). We read from process.cwd() because
  // the hook runs with the project root as cwd. Off-switch:
  // PRISM_DISABLE_MEMORY_INJECT=1. Fail-open: any error skips silently.
  if (process.env.PRISM_DISABLE_MEMORY_INJECT !== '1') {
    try {
      const memPath = join(process.cwd(), '.claude', 'agents', 'MEMORY.md');
      if (existsSync(memPath)) {
        let mem = readFileSync(memPath, 'utf-8');
        // Mirror the platform cap: first 200 lines or 25 KB, whichever is
        // smaller (per the sub-agents "Enable persistent memory" doc).
        const lines = mem.split('\n');
        if (lines.length > 200) mem = lines.slice(0, 200).join('\n');
        const CAP_BYTES = 25 * 1024;
        if (Buffer.byteLength(mem, 'utf8') > CAP_BYTES) {
          // Trim by bytes (UTF-8 safe-ish: slice on a generous char count then
          // re-check). Profile content is ASCII-dominant so chars≈bytes.
          while (Buffer.byteLength(mem, 'utf8') > CAP_BYTES && mem.length > 0) {
            mem = mem.slice(0, Math.floor(mem.length * 0.95));
          }
        }
        if (mem.trim()) {
          const recallGate =
            '<RECALL-GATE priority=highest> Before ANY design, planning, ' +
            'brainstorming, or build action this session, you MUST read and ' +
            'apply the Standing Rules and recent decisions below (from ' +
            '.claude/agents/MEMORY.md), and cite the relevant rule when one ' +
            'applies. Do NOT jump to brainstorming or new construction without ' +
            'first checking (a) these rules and (b) whether existing ' +
            'tools/agents/skills already cover the need. </RECALL-GATE>';
          notices.push(`${recallGate}\n${mem.trim()}`);
        }
      }
    } catch {}
  }

  // ── C6 (recall-hardening v6.2.0): TASK-RECALL — open-task carryover ────────
  // Reads the project-local pointer SessionEnd's C5 snapshot writes to
  // <cwd>/.claude/.prism-open-tasks.json. If present with a non-empty
  // open_tasks array, injects a high-priority additionalContext block that
  // directs the agent to recall EVERY open task, re-hydrate each one via
  // TaskCreate (preserving the FULL description) before proceeding, and then
  // reconcile against current repo state (some carried tasks may already be
  // done). Off-switch: PRISM_DISABLE_TASK_RECALL=1. Fail-open: a missing or
  // malformed pointer file is skipped silently — never breaks SessionStart.
  if (process.env.PRISM_DISABLE_TASK_RECALL !== '1') {
    try {
      const openTasksPath = join(process.cwd(), '.claude', '.prism-open-tasks.json');
      if (existsSync(openTasksPath)) {
        let pointer = null;
        try { pointer = JSON.parse(readFileSync(openTasksPath, 'utf-8')); } catch {}
        if (pointer && Array.isArray(pointer.open_tasks) && pointer.open_tasks.length > 0) {
          const n = pointer.open_tasks.length;
          const tsLabel = pointer.ts || '(unknown time)';

          // ── SHA-STAMP-001: staleness label ──────────────────────────────
          // Only runs a git call at all when the pointer actually carries a
          // git_sha — older pointers written before this change have none,
          // so they get no label and no git call (fail-open). A second git
          // call (commit distance) only fires once a mismatch is already
          // confirmed. "Presence != currency": an untagged pointer is
          // unverifiable, not implicitly trusted.
          let staleTag = '';
          if (pointer.git_sha) {
            const currentSha = await getGitHeadSha(process.cwd());
            if (currentSha) {
              if (currentSha === pointer.git_sha) {
                staleTag = ' [CURRENT]';
              } else {
                const dist = await getCommitDistance(process.cwd(), pointer.git_sha, currentSha);
                staleTag = dist !== null
                  ? ` [STALE — ${dist} commit${dist === 1 ? '' : 's'} behind HEAD]`
                  : ' [STALE — HEAD has moved since this was captured]';
              }
            }
          }

          // ── PAYLOAD-CUT-001 (2026-07-14 audit) — cap by COUNT, never by
          // truncating content. The audit found this block averages ~1,673
          // bytes/task (D040 §5 anti-brevity, working as designed) with NO
          // cap on task COUNT — unlike every other D040-protected recall
          // surface (Standing rules / Recent decisions / Recent lessons all
          // use a fixed 10-12-item window). Left uncapped, open-task count
          // alone made this section unbounded (flagged in the audit as a
          // D040 conflict, routed to the architect rather than resolved by
          // the auditor). Architect's ruling: TASK-RECALL is a CACHE of the
          // Task API, not the system of record — every open task is one
          // TaskList call away, so the task COUNT may be capped, but the
          // EXISTENCE of anything deferred may never go silent (a "+N more —
          // call TaskList" pointer line is mandatory whenever anything is
          // held back). Hard invariant: an in_progress task is NEVER the one
          // deferred — only pending tasks can be deferred — and a shown
          // task's description is NEVER truncated: a task is either injected
          // whole or pointed to, never partially. [AMENDED — Slice 5, panel-53
          // E2 pre-ship gate: the count cap alone left total chars unbounded
          // (3 huge descriptions could still flood context), so a per-task
          // description char cap (PRISM_TASK_RECALL_DESC_MAXCHARS, default
          // 1000) now bounds the block at ~4KB worst case. The amendment keeps
          // the ruling's spirit: truncation is LOUD — an explicit marker
          // stating how many chars were cut and naming the repair (TaskGet) —
          // so nothing ever goes silent.] Default cap 3 (in_progress
          // first, then most recent by task id — ids are assigned
          // sequentially by TaskCreate, verified against hooks/prism-
          // session-end.mjs's own id-ascending sort, so id-descending is a
          // recency proxy without needing a timestamp field this payload
          // doesn't carry). Override: PRISM_TASK_RECALL_MAX (positive int).
          const rawMax = Number.parseInt(process.env.PRISM_TASK_RECALL_MAX, 10);
          const maxFull = (Number.isFinite(rawMax) && rawMax > 0) ? rawMax : 3;

          const inProgressTasks = pointer.open_tasks.filter((t) => t.status === 'in_progress');
          const otherTasksByRecency = pointer.open_tasks
            .filter((t) => t.status !== 'in_progress')
            .sort((a, b) => {
              const na = Number(a.id), nb = Number(b.id);
              if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
              return String(b.id).localeCompare(String(a.id));
            });
          const remainingSlots = Math.max(0, maxFull - inProgressTasks.length);
          const fullSet = [...inProgressTasks, ...otherTasksByRecency.slice(0, remainingSlots)];
          const deferredCount = n - fullSet.length;

          // Slice 5 (E2 size cap): bound each injected description; the
          // truncation marker is loud + evidence-carrying (chars cut, repair
          // action) per the E1 fail-loud contract.
          const rawDescMax = Number.parseInt(process.env.PRISM_TASK_RECALL_DESC_MAXCHARS, 10);
          const descMax = (Number.isFinite(rawDescMax) && rawDescMax > 0) ? rawDescMax : 1000;
          const taskLines = fullSet.map((t) => {
            const full = t.description || '(no description)';
            const desc = full.length > descMax
              ? `${full.slice(0, descMax)} …[truncated ${full.length - descMax} more chars — run TaskGet #${t.id} for the full description]`
              : full;
            return `#${t.id} [${t.status}] ${t.subject || '(no subject)'} — ${desc}`;
          });
          const deferredLine = deferredCount > 0
            ? `\n+${deferredCount} more open task${deferredCount === 1 ? '' : 's'} — call TaskList`
            : '';

          // ── Slice 5 (panel-53 E1/F1 SURFACE leg): self-clearing integrity
          // line. Derived from the pointer being consumed RIGHT NOW (state,
          // not event — no sticky flag): fires only while the artifact is
          // degraded (Finding-1 shape miss), tail-truncated, or carrying
          // prior-session tasks; disappears on the first healthy SessionEnd.
          // Evidence-carrying (the counts) + ONE named repair (run TaskList).
          // A pre-meta pointer (older SessionEnd) gets no parse-counts clause
          // — counts are never fabricated.
          const integMeta = (pointer.meta && typeof pointer.meta === 'object') ? pointer.meta : null;
          const carriedCount = pointer.open_tasks.filter((t) => t && t.carried_from).length;
          const integDegraded = !!(integMeta && integMeta.degraded);
          const integTailTrunc = !!(pointer.tail_truncated || (integMeta && integMeta.tail_truncated));
          let integrityLine = '';
          if (integDegraded || integTailTrunc || carriedCount > 0) {
            const structured = integMeta ? (integMeta.structured_hits | 0) : 0;
            const seenTotal = integMeta
              ? structured + (integMeta.regex_fallbacks | 0) + (integMeta.unmatched_task_results | 0)
              : 0;
            const parsedClause = integMeta ? `; parsed ${structured}/${seenTotal} structurally` : '';
            integrityLine =
              `\nTASK-RECALL: ${n} open (${carriedCount} carried from prior sessions)` +
              parsedClause + (integTailTrunc ? ', tail truncated' : '') +
              ` — if this looks wrong, run TaskList.`;
          }
          const recallDirective = deferredCount > 0
            ? `Full-fidelity detail below for ${fullSet.length} of ${n} (in-progress tasks are never deferred): ` +
              `re-hydrate via TaskCreate before proceeding, preserving each FULL description; ` +
              `then reconcile against current repo state (some may already be done).`
            : `Recall ALL of them: re-hydrate via TaskCreate before proceeding, preserving each FULL description; ` +
              `then reconcile against current repo state (some may already be done).`;

          const taskRecall =
            `<TASK-RECALL priority=high> ${n} open task(s) carried over from last session (${tsLabel})${staleTag}. ` +
            recallDirective + ` Tasks:\n` +
            taskLines.join('\n') +
            deferredLine +
            integrityLine +
            `\n</TASK-RECALL>`;
          notices.push(taskRecall);
        }
      }
    } catch {}
  }

  // ── Task #31: HANDOFF-RECALL — latest /prism-clean Step 4b handoff doc ────
  // Reads <cwd>/.claude/.prism-latest-handoff.json, written deterministically
  // by hooks/prism-handoff-pointer.mjs (PostToolUse) as a side-effect of the
  // Write/Edit that produces docs/prism/plans/<date>-SESSION-HANDOFF.md —
  // never a manual step. Surfaces the pointer with the same SHA-STAMP-001
  // staleness labeling TASK-RECALL uses ([CURRENT] / [STALE — N commits
  // behind HEAD]). The handoff doc is gitignored local state, so this is a
  // pure on-disk pointer; the SHA stamp compares repo HEAD positions, which
  // works fine for an untracked file. Off-switch:
  // PRISM_DISABLE_HANDOFF_RECALL=1. Fail-open: missing/malformed pointer or
  // a deleted handoff doc is skipped silently.
  if (process.env.PRISM_DISABLE_HANDOFF_RECALL !== '1') {
    try {
      const handoffPtrPath = join(process.cwd(), '.claude', '.prism-latest-handoff.json');
      if (existsSync(handoffPtrPath)) {
        let hp = null;
        try { hp = JSON.parse(readFileSync(handoffPtrPath, 'utf-8')); } catch {}
        if (hp && typeof hp.path === 'string' && hp.path) {
          const handoffAbs = isAbsolute(hp.path) ? hp.path : join(process.cwd(), hp.path);
          if (existsSync(handoffAbs)) {
            let staleTag = '';
            if (hp.git_sha) {
              const currentSha = await getGitHeadSha(process.cwd());
              if (currentSha) {
                if (currentSha === hp.git_sha) {
                  staleTag = ' [CURRENT]';
                } else {
                  const dist = await getCommitDistance(process.cwd(), hp.git_sha, currentSha);
                  staleTag = dist !== null
                    ? ` [STALE — ${dist} commit${dist === 1 ? '' : 's'} behind HEAD]`
                    : ' [STALE — HEAD has moved since this was captured]';
                }
              }
            }
            const handoffRecall =
              `<HANDOFF-RECALL priority=high> Latest session handoff (written ${hp.ts || '(unknown time)'})${staleTag}: ` +
              `${hp.path} — before resuming multi-session work, READ this doc for the narrative context ` +
              `(next steps, branch state, evidence pointers) that the task list alone does not carry.` +
              (staleTag.includes('STALE')
                ? ` HEAD has moved since it was written — verify its claims against current repo state before acting on them.`
                : '') +
              ` </HANDOFF-RECALL>`;
            notices.push(handoffRecall);
          }
        }
      }
    } catch {}
  }

  // ── Package G — always-on CAPABILITY CATALOG (CAPABILITY-CATALOG-001) ──────
  // Inject a compact NAME + one-line-purpose index of every installed agent,
  // skill, plugin skill, tool, and MCP (from roster.json's unified resource-
  // index) so the orchestrator always KNOWS what capabilities exist and routes
  // tasks to an existing one instead of building new on the fly. Rides as
  // SessionStart additionalContext — independent of the native skill-listing
  // budget, which silently drops least-used skill descriptions. Separate notice;
  // does NOT touch the RECALL-GATE / MEMORY.md block above. Off-switch:
  // PRISM_DISABLE_CAPABILITY_CATALOG=1. Fail-open: any error skips silently.
  //
  // PAYLOAD-CUT-001 (2026-07-14 session-start payload audit, docs/prism/
  // 2026-07-14-session-start-payload-audit.md): the catalog's "Skills" and
  // "Plugin skills" subsections were measured at 8,740B — 78% of the catalog,
  // ~30% of the ENTIRE SessionStart payload — and verified by direct text
  // comparison to be near-verbatim duplicate of the native skill-listing the
  // harness already injects every session (independent of PRISM). Agents and
  // Tools are NOT part of that native listing and stay genuinely unique — kept
  // in full. Governing principle (architect ruling): inject what cannot be
  // retrieved, point to what can — the native listing already retrieves
  // skills, so PRISM doesn't need to pay for a second copy. D037 (which
  // created this catalog) is Status: Proposed, not Locked, so this cut has no
  // D040 tension (that check was made explicitly before cutting, not assumed).
  // Implemented at the CALL SITE (an empty `skills` object fed to the shared,
  // separately-tested buildCapabilityCatalog) rather than by changing the
  // library's own default — hooks/lib/prism-capability-catalog.mjs has its
  // own governing test (tests/v3/capability-catalog.test.mjs) asserting the
  // full 5-section catalog by default; that contract is left alone.
  // Kill-switch to restore the pre-cut full catalog (Skills + Plugin skills
  // included): PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP=1.
  try {
    const catLib = await import(pathToFileURL(join(H, '.claude', 'hooks', 'lib', 'prism-capability-catalog.mjs')).href).catch(() => null);
    if (catLib && typeof catLib.buildCapabilityCatalog === 'function'
        && (typeof catLib.capabilityCatalogEnabled !== 'function' || catLib.capabilityCatalogEnabled(process.env))) {
      const rosterPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
      if (existsSync(rosterPath)) {
        let roster = null;
        try { roster = JSON.parse(readFileSync(rosterPath, 'utf-8')); } catch {}
        if (roster) {
          const dedupSkills = process.env.PRISM_DISABLE_CAPABILITY_CATALOG_DEDUP !== '1';
          const catalogRoster = dedupSkills ? {...roster, skills: {}} : roster;
          const catalog = catLib.buildCapabilityCatalog(catalogRoster);
          if (catalog && catalog.trim()) notices.push(catalog);
        }
      }
    }
  } catch {}

  if (notices.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: notices.join('\n'),
      },
    }));
  }
} catch {}
process.exit(0);
