// hooks/lib/prism-panel-latch.mjs
// F7 Phase 1 — panel-active LATCH.
//
// THE GAP THIS CLOSES: prism-panel-name-guard.mjs used to fire only when the
// CURRENT-turn sentinel had summon_panel===true. But summon_panel is a
// one-turn flag: the tier-router resets it to false on the post-approval /
// continuation turn (hooks/prism-prompt-tier-router.mjs:354), and a fresh
// non-panel follow-up prompt re-classifies to summon=false anyway. A real
// self-chaired panel dispatches its seats on THAT later turn — by which point
// summon_panel is already false — so the name-guard silently no-op'd and
// `panel_name_guard` never fired once in production (routing-log count = 0,
// F7 investigation 2026-07-24).
//
// The latch decouples "a panel is in progress" from the per-turn sentinel: the
// tier-router writes it (separate sidecar file, NOT wiped by the per-turn
// sentinel rewrite) when a self-chaired panel-summon turn is classified; the
// name-guard fires while the latch is live even after summon_panel resets.
//
// DELIBERATE DESIGN CHOICE — TTL is the ONLY deterministic clear. Detecting
// "synthesis done" / "approval" / "unrelated new topic" mechanically would
// reintroduce exactly the trust-based fragility F7 removes (it would rely on
// the model self-signaling), so we do NOT attempt it. The TTL bounds the
// false-positive window instead. The guard is advisory-only, so a stray nudge
// inside the window costs one line, never a block. The latch is re-armed
// (TTL refreshed) on every subsequent summon turn.
//
// Path resolution uses prismHome() at USE time (not captured at module load)
// so the tier-router writer and the name-guard reader resolve the SAME file
// even when a test flips HOME between calls — the same seam the sibling guards
// and their harnesses rely on.

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {prismHome} from './prism-home.mjs';
import {renameWithRetry} from '../../tools/lib/atomic-fs.mjs';
import {logAdvisory} from './prism-advisory-log.mjs';

// Default 45 min. Panels span multiple turns with dispatch waits (the F7
// co-test panel ran ~12 min end-to-end); 45 min covers a slow real-dispatch
// panel with margin without leaving the latch armed for a whole session.
// Override with PRISM_PANEL_LATCH_TTL_MS (positive integer ms).
export const PANEL_LATCH_TTL_MS = (() => {
  const raw = parseInt(process.env.PRISM_PANEL_LATCH_TTL_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45 * 60 * 1000;
})();

export function panelLatchPath(sessionId) {
  return join(prismHome(), '.claude', `.prism-panel-active-${sessionId || 'anon'}.json`);
}

// Arm (or re-arm) the latch. Atomic write (tempfile + rename); fail-open — a
// latch-write failure must never break the tier-router's own turn.
export function writePanelLatch(sessionId, extra = {}) {
  const now = Date.now();
  const latch = {
    session_id: sessionId || 'anon',
    opened_ts: new Date(now).toISOString(),
    until_ts: new Date(now + PANEL_LATCH_TTL_MS).toISOString(),
    ...extra,
  };
  const p = panelLatchPath(sessionId);
  const body = JSON.stringify(latch, null, 2);
  try {
    mkdirSync(dirname(p), {recursive: true});
    const tmp = p + '.tmp';
    writeFileSync(tmp, body);
    try {
      renameWithRetry(renameSync, tmp, p);
    } catch (renameErr) {
      try {
        writeFileSync(p, body);
        logAdvisory({event: 'panel_latch_write', session_id: sessionId,
          status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
      } catch (fallbackErr) {
        logAdvisory({event: 'panel_latch_write', session_id: sessionId,
          status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
      }
    }
  } catch { /* fail-open */ }
  return latch;
}

export function readPanelLatch(sessionId) {
  try {
    const p = panelLatchPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Live iff a latch exists AND its until_ts is still in the future.
export function isPanelLatchLive(sessionId, now = Date.now()) {
  const latch = readPanelLatch(sessionId);
  if (!latch || !latch.until_ts) return false;
  const until = Date.parse(latch.until_ts);
  return Number.isFinite(until) && until > now;
}
