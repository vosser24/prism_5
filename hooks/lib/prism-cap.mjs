// hooks/lib/prism-cap.mjs
// v4.7 K1 — single source of truth for the parallel-dispatch cap.
//
// The cap bounds how many Agent() calls the orchestrator batches into one
// message (see skills/master-orchestrator/references/dispatch-shapes.md).
// Before v4.7 it was a hardcoded `4` in BOTH the dispatch-cap telemetry hook
// and the orchestrator prose. v4.7 promotes it to a real knob: set the env
// var PRISM_PARALLEL_CAP to override. Default stays 4 (no behavior change for
// anyone who doesn't set it).
//
// Both consumers — hooks/prism-dispatch-cap.mjs (telemetry) and
// hooks/prism-session-start.mjs (orchestrator injection) — resolve through
// this one function so the LOGGED cap and the cap the orchestrator OBEYS can
// never silently diverge (the "half-knob" trap).

export const DEFAULT_PARALLEL_CAP = 4;

// Resolve the active parallel cap from the environment.
// Strict parse: only a bare positive integer is honored. Anything else
// (empty, whitespace, non-numeric, partial-numeric like "8x", zero, negative)
// falls back to DEFAULT_PARALLEL_CAP so a typo never silently widens the cap.
// Accepts an explicit env bag for testability; defaults to process.env.
export function resolveParallelCap(env = process.env) {
  const raw = env && env.PRISM_PARALLEL_CAP;
  if (raw == null) return DEFAULT_PARALLEL_CAP;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return DEFAULT_PARALLEL_CAP;
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PARALLEL_CAP;
  return n;
}
