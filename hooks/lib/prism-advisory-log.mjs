// hooks/lib/prism-advisory-log.mjs
// Shared append-only telemetry for advisory (non-blocking) hooks.
//
// WHY THIS EXISTS: before this, PRISM had no record of advisory emissions
// anywhere — a 90%-wrong advisory and a 100%-dead advisory looked identical
// from the outside (both silent in the routing log), because nothing logged
// the "evaluated, found nothing" case, only side effects like blocks did.
// That is exactly how prism-skill-equip-nudge.mjs's low top-1 precision and
// prism-skill-trigger-guard.mjs's total parse failure both went unnoticed —
// see docs/prism/2026-07-14-advisory-precision.md.
//
// logAdvisory() appends one JSONL line to ~/.claude/.prism-routing.jsonl for
// EVERY advisory evaluation — including the zero-match case — so fire-rate
// and precision become measurable going forward instead of invisible.
// Dep-free, fail-open (telemetry must never break the advisory it logs).

import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {prismHome} from './prism-home.mjs';

// Perf (task #77): mkdirSync(..., {recursive:true}) was run on EVERY call, even
// though the directory only needs creating once it exists. That is pure waste
// on every subsequent call in-process — this was the dominant cost added by
// D083 Phase 1 (b9e6067be) to this hot path. Cache readiness PER RESOLVED
// DIRECTORY (a Set, not a single boolean) rather than a single module flag:
// prismHome() is deliberately re-resolved at call time so tests can flip
// HOME/USERPROFILE mid-process (see hooks/lib/prism-home.mjs) — a single
// boolean would wrongly skip mkdir for a second, different, not-yet-created
// directory. Keyed caching stays correct under that flip while still skipping
// the syscall on every repeat call to an already-ready path.
//
// appendFileSync (open+write+close per call) is deliberately left as-is: the
// write itself must stay synchronous — D085 requires every invocation logged,
// and a synchronous per-call append is what makes that durable with no
// buffering, no exit-flush, and no way to lose a record. An open-handle-reused
// design was considered and rejected: it would only help repeated calls
// *within one process*, but this hook is a short-lived CLI process invoked
// once per user prompt in production, so the amortization opportunity is the
// mkdirSync removal above, not the FD lifecycle.
const _dirReady = new Set();

export function logAdvisory(event) {
  try {
    const H = prismHome();
    const logPath = join(H, '.claude', '.prism-routing.jsonl');
    const dir = dirname(logPath);
    if (!_dirReady.has(dir)) {
      mkdirSync(dir, {recursive: true});
      _dirReady.add(dir);
    }
    appendFileSync(logPath, JSON.stringify({ts: new Date().toISOString(), ...event}) + '\n');
  } catch {
    // Telemetry is best-effort — never let a logging failure break the
    // advisory hook that called it.
  }
}
