#!/usr/bin/env node
// PRISM SessionStart (v2.1.25) — reset project turn counter + run once-per-day
// context-tax audit (Gap 1 closure).
//
// [WHY] Every session Claude Code dumps ~10k tokens of plugin skill
// descriptions before your first prompt (~$0.15 on Opus input). Users
// couldn't see this tax because nothing surfaced it. This hook runs
// ~/.claude/tools/prism-context-audit.mjs once per day and emits a compact
// one-line notice with the top "disable X to save Yt" recommendation.
// Output is throttled to once per 24h so it doesn't itself become noise.
import {writeFileSync, readFileSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';
import {spawnSync} from 'child_process';

const H = process.env.HOME || process.env.USERPROFILE;
const LAST_FILE = join(H, '.claude', '.prism-context-audit.last');
const CACHE_FILE = join(H, '.claude', '.prism-context-audit.json');
const AUDIT_TOOL = join(H, '.claude', 'tools', 'prism-context-audit.mjs');
const THROTTLE_SECONDS = 24 * 60 * 60;  // 24h
const NOTICE_TOKEN_FLOOR = 5000;         // only nag when tax is meaningful

try {
  // ── Reset project-local turn counter (existing behavior) ──
  const cwd = process.cwd();
  const dir = join(cwd, '.claude');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.prism-state.json'), JSON.stringify({turns: 0, session_start: new Date().toISOString()}));

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
    try { writeFileSync(LAST_FILE, String(now)); } catch {}
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

  // ── v2.8.0 Gap: classifier-floor visibility (once per session) ──
  // When ANTHROPIC_API_KEY isn't visible to hook subprocesses, the tier-
  // router silently falls to the keyword floor on every prompt. Users had
  // no signal that the expensive Opus classifier was unreachable. Emit a
  // one-time hint at session start; throttle to once per 24h (same as the
  // audit) so it doesn't spam.
  //
  // Detection: the classifier writes source='keyword-floor' in its
  // sentinel + log when it falls through. We don't read the log here
  // (cheap); instead we probe env and filesystem:
  //   - If process.env.ANTHROPIC_API_KEY is missing AND no ~/.claude/prism.env
  //     ANTHROPIC_API_KEY line: floor-only guaranteed
  //   - Otherwise: may be reaching API; skip hint
  const floorHintFile = join(H, '.claude', '.prism-floor-hint.last');
  let lastFloorHint = 0;
  try {
    if (existsSync(floorHintFile)) lastFloorHint = parseInt(readFileSync(floorHintFile, 'utf-8').trim(), 10) || 0;
  } catch {}
  if ((now - lastFloorHint) >= THROTTLE_SECONDS) {
    const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
    let hasEnvFileKey = false;
    try {
      const envFile = join(H, '.claude', 'prism.env');
      if (existsSync(envFile)) {
        const txt = readFileSync(envFile, 'utf-8');
        if (/^\s*ANTHROPIC_API_KEY\s*=/m.test(txt)) hasEnvFileKey = true;
      }
    } catch {}
    if (!hasEnvKey && !hasEnvFileKey) {
      notices.push(
        'PRISM NOTICE: Classifier is running in keyword-floor-only mode — ANTHROPIC_API_KEY not set for hook subprocesses. ' +
        'Tier decisions will use regex signals only (less accurate on ambiguous prompts). ' +
        'To enable the Opus classifier, set ANTHROPIC_API_KEY system-wide or add a line to ~/.claude/prism.env. ' +
        'See INSTALL.md §2.7 for Windows/POSIX setup.'
      );
      try { writeFileSync(floorHintFile, String(now)); } catch {}
    }
  }

  if (notices.length) process.stdout.write(notices.join('\n'));
} catch {}
process.exit(0);
