# 2026-05-25 — Session handoff (PRISM v4.0 build kickoff)

**Status:** Locked
**Date:** 2026-05-25
**Captured by:** manual (since /prism-clean does not yet exist — meta-loop)
**Related:** [[D001]] [[D002]] [[D003]] [[D004]]

## One-sentence summary

D004 PRISM v4.0 "Project-Master Edition" locked; adversarial review by claude-master verified all load-bearing feature claims; 11-day split-release plan (v3.11.0 + v4.0) ready to start Phase A.1.

## What was decided

See `Y:/Documents/utilities_projects/prism_3/docs/prism/adjudications/D004-v4-product-vision.md` for the full locked plan. Critical decisions in summary:

- **Topology fix**: `master-<slug>` is the *session agent* (main thread), not a subagent. Avoids the docs-forbidden "subagents spawning subagents" pattern.
- **Master-orchestrator** demoted to a skill loaded by `master-<slug>`; agent file becomes a thin wrapper for backward compat.
- **7-phase bootstrap** with crash-safe sentinels (schema v1 → v2).
- **Cuts**: per-turn hooks (D-6, D-7), Phase I cross-file analyzer, ≥3 challenge bump — all deferred to v4.1 with telemetry justification.
- **Migration**: v3.10.0 → v4.0 is opt-in via `/prism-bootstrap --with-deep-dive`. No surprise deep-dive.

## What was built

1. `agents/claude-master.md` — top-tier Claude Code Windows expert (1376 lines, project-local, not installed)
2. `docs/prism/adjudications/D004-v4-product-vision.md` — locked plan (280 lines)
3. `Y:/Documents/utilities_projects/competition_agents/` — empty testbed dir

## What survived adversarial review (claude-master verdict)

ACCEPT WITH CHANGES. Cut list: D-6, D-7, third nudge, Phase I, ≥3 floor bump, per-quarter auto-resynth. Plan dropped 19d → 11d.

All 7 Claude Code feature claims verified against `code.claude.com`:
1. `SessionEnd[matcher=clear]` ✅
2. `memory: project` ✅
3. MEMORY.md 25KB injection cap ✅
4. `PreCompact` hook ✅
5. Project-scope subagent precedence over user-scope ✅
6. `UserPromptSubmit` additionalContext ✅
7. `claude plugin list --json` ✅

## Tactical lessons (worth keeping)

- **The "subagents can't spawn subagents" rule** is a docs constraint that's easy to miss. Confused me on first plan draft. Resolution: design from main-thread topology backward.
- **PS 5.1 hook spawn cost (~80-250ms cold start)** dominates the budget on Windows. Per-turn hooks that don't deliver >2× their cost in measured accuracy are speed-negative. Hooks belong on session-scoped events, not turn-scoped.
- **The statusline is more important than any new feature.** User flagged it as must-have. Audit before any settings-fragment edit.
- **Heuristics that misfire 20-40% (context-budget estimator) are worse than no estimator** — they erode user trust faster than they earn it back via the rare correct fire.
- **Adversarial review by a specialist agent saved this plan** — without it the v4.0 build would have shipped with an architecturally impossible D-1 (subagent-spawning-subagent dispatch hop).

## Strategic lessons (for future v4.x decisions)

- **Speed > completeness** — the user's stated priority, and consistent with PRISM's cognitive-tier ethos. Always cut features that tax every turn for occasional benefit.
- **Two-release split de-risks** big architectural changes. v3.11.0 foundation validates before v4.0 surface commits to it.
- **Citation discipline is load-bearing** — every Claude Code feature claim should cite `code.claude.com` or be marked "unverified". Without it, plans get built on training-data drift.
- **The /prism-clean meta-loop is itself a useful artifact** — manually writing a handoff exposes what /prism-clean must capture. This session is a fixture for future testing.

## Next action

`TaskList` then claim task 1 (Phase A.1 `/prism-sync`).
