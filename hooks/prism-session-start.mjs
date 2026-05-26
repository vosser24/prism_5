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
import {writeFileSync, readFileSync, renameSync, mkdirSync, existsSync, copyFileSync} from 'fs';
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

  // ── Reset project-local turn counter (existing behavior) ──
  const cwd = process.cwd();
  const dir = join(cwd, '.claude');
  mkdirSync(dir, {recursive: true});
  atomicWrite(join(dir, '.prism-state.json'), JSON.stringify({turns: 0, session_start: new Date().toISOString()}));

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

  if (notices.length) process.stdout.write(notices.join('\n'));
} catch {}
process.exit(0);
