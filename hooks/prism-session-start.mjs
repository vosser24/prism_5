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
import {join} from 'path';
import {spawnSync} from 'child_process';
import {pathToFileURL} from 'url';

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
    // spawnSync with 5s timeout. Audit is pure filesystem scanning —
    // should complete in <1s for a normal plugin cache.
    const res = spawnSync('node', [AUDIT_TOOL, '--json', '--cache'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      try { audit = JSON.parse(res.stdout); } catch {}
    }
    atomicWrite(LAST_FILE, String(now));
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
