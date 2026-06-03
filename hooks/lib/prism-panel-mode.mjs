// hooks/lib/prism-panel-mode.mjs
// v5.x — single source of truth for the panel dispatch-mode knob.
//
// PRISM_PANEL_MODE selects how the master assembles a PHASE 0d panel:
//   "dispatch" (default) — real per-seat Agent() dispatch (independent experts,
//                          separate context windows; see phase-0d-adversarial.md)
//   "roleplay"           — opt-in fast mode: one model voices every seat in-context
//                          (the legacy behaviour; cost/latency escape)
//
// Both the master doctrine and prism-panel-guard.mjs treat "dispatch" as the
// default. This resolver lets a user force the role-play fast mode for
// cost/latency, surfaced into the session by prism-session-start.mjs (mirrors
// the PRISM_PARALLEL_CAP knob in prism-cap.mjs).

export const DEFAULT_PANEL_MODE = 'dispatch';
export const VALID_PANEL_MODES = ['dispatch', 'roleplay'];

// Strict parse: only the exact tokens "dispatch"/"roleplay" (case-insensitive,
// trimmed) are honored. Anything else — empty, whitespace, typo, unknown word —
// falls back to DEFAULT_PANEL_MODE. This fails toward the RIGOROUS mode: a
// fat-finger never silently degrades a real dispatched panel into role-play.
// Accepts an explicit env bag for testability; defaults to process.env.
export function resolvePanelMode(env = process.env) {
  const raw = env && env.PRISM_PANEL_MODE;
  if (raw == null) return DEFAULT_PANEL_MODE;
  const s = String(raw).trim().toLowerCase();
  if (!VALID_PANEL_MODES.includes(s)) return DEFAULT_PANEL_MODE;
  return s;
}
