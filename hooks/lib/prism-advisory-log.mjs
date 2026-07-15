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

export function logAdvisory(event) {
  try {
    const H = prismHome();
    const logPath = join(H, '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(logPath), {recursive: true});
    appendFileSync(logPath, JSON.stringify({ts: new Date().toISOString(), ...event}) + '\n');
  } catch {
    // Telemetry is best-effort — never let a logging failure break the
    // advisory hook that called it.
  }
}
