# D005 — Phase F nudge hooks: D004 §6 incompatible with Claude Code hook API

**Status:** Locked
**Date:** 2026-05-25
**Decision owner:** PRISM core (user adjudication mid-implementation)
**Target releases:** v4.0 (defer), v4.1 (new design)
**References:** [[D004-v4-product-vision]] §6, [[2026-05-25-phase-f-clean-nudge-hooks]] (plan, reverted)
**Adversarial review:** mid-implementation discovery via Claude Code hook docs at code.claude.com

## Context

[[D004-v4-product-vision]] §6 locked a two-hook design for v4.0:

- `SessionEnd[matcher=clear]` → emit `additionalContext`: "captured X panel decisions + Y deviations this session. Run /prism-clean first to archive?"
- `PreCompact` → same nudge before auto-compact at 95%

Phase F implementation was specced + executed end-to-end (9 commits, 7 tests, full sync to `~/.claude/`). All deterministic-surface tests passed (143/143 across 9 suites). Mock-tested hook produced correct stdout JSON.

User dog-food (Phase F Task 5) revealed: **no nudge appeared in real Claude Code sessions on `/clear`.** Triage of `~/.claude/.prism-routing.jsonl` showed no real-session hook fires — only my test-script invocations.

## Discovery

Claude Code's hook API documentation at https://code.claude.com/docs/en/hooks specifies decision-control categories per event. The exact finding:

| Hook event | Supports `additionalContext`? | Category per docs |
|---|---|---|
| `SessionStart` | ✅ | "Context only" |
| `Setup` | ✅ | "Context only" |
| `SubagentStart` | ✅ | "Context only" |
| `UserPromptSubmit` | ✅ | "Prompt-related" |
| `UserPromptExpansion` | ✅ | "Prompt-related" |
| `PreToolUse` | ✅ | "Tool-related" |
| `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` | ✅ | "Tool-related" |
| `SessionEnd` | ❌ | **"None. Used for side effects like logging or cleanup."** |
| `PreCompact` | ❌ | **"Top-level `decision: block` only — no context injection."** |
| `Stop` / `SubagentStop` / `ConfigChange` | ❌ | "Top-level `decision: block` only." |

Both events D004 §6 named are exactly the two that can't inject context. The matcher syntax (`"matcher": "clear"`) IS supported and works as a reason filter — that part of the design was correct. The hook DOES fire on /clear (confirmed via the routing log on PRISM's own logging path). But its stdout is silently discarded by the harness because SessionEnd is documented as side-effects-only.

`PreCompact` is even more restricted: its only `decision` is `"block"` (refuse to compact). Returning `decision: "block"` with a `reason` would surface the nudge text — but at the cost of refusing the compaction entirely, which is catastrophic UX (compaction must happen; we don't want to block it just to display text).

## Why D004 §6 missed this

D004's adversarial-review summary (claude-master, 2026-05-25) cites "all 7 load-bearing Claude Code feature claims verified against code.claude.com." The verification list for §6 (per the doc) covered:
- Two-event spec (vs three) — verified
- additionalContext mechanism existence — verified for some hooks
- Env-var off-switches — convention only, no API check needed
- PowerShell hook shell — verified

The specific claim *"SessionEnd / PreCompact support additionalContext emission"* was NOT explicitly verified. The reviewer probably checked that `additionalContext` IS a real hook output field (true for SessionStart and UserPromptSubmit) and inferred it works for SessionEnd / PreCompact too. **The decision-control matrix per-event was the missing diligence step.**

This is recorded as a process lesson: future hook-design adjudications must verify EVERY event-output combination against the per-event decision-control matrix, not just confirm the output field exists at the API level.

## Decision

**Defer Phase F to v4.1.** Phase F commits are reverted. v4.0 ships without nudge hooks. The /prism-clean workflow remains user-initiated (which it already was pre-D004 §6).

## v4.1 design proposal (research already done; see "Recommended next-shape" below)

The viable architecture (researched during the Phase F kill decision) for a future implementation:

### Recommended next-shape: flag-file + SessionStart pickup

1. **`SessionEnd[matcher=clear]` hook** → write `~/.claude/.prism-clean-nudge-pending` with `{ts, reason: 'clear'}`. The hook does only the side-effect (allowed for SessionEnd).

2. **`PreCompact` hook** → write the same flag with `{ts, reason: 'precompact'}`. Same architecture.

3. **`prism-session-start.mjs` (existing PRISM hook)** → on session start:
   - Check for the flag file.
   - If present, emit `hookSpecificOutput.additionalContext` with the nudge text (SessionStart **does** support `additionalContext`).
   - Delete the flag file.

4. **Off-switches** keep the same names: `PRISM_DISABLE_CLEAR_NUDGE=1` and `PRISM_DISABLE_PRECOMPACT_NUDGE=1`. Each off-switch is checked at the SessionEnd / PreCompact hook (flag-write phase), so if disabled, no flag is written and no nudge fires on next session.

5. **UX shift documented:** The nudge moves from "at /clear" to "at the start of the session that follows /clear." Same user value — the user can only act on the nudge AFTER /clear has completed anyway (running /prism-clean to capture lessons works fine in the new session).

### Alternative considered + rejected: UserPromptSubmit-based interception

A UserPromptSubmit hook that detects "did /clear or PreCompact just happen?" via a sentinel file. Rejected because:
- It taxes every prompt (per-turn cost), not just the rare events.
- The user pays cold-start on every prompt for a check that's near-always false.
- Conflicts with the existing PRISM principle of keeping UserPromptSubmit hooks lean.

### Alternative considered + rejected: PreCompact returning `decision: "block"` with reason text

The block reason gets surfaced to the user. But this PREVENTS compaction — destructive UX. Compaction must happen for the session to continue at low context budgets. Rejected as architecturally incompatible with the purpose (nudge, not refuse).

## Lock

v4.1 implementation must:
1. Verify the per-event decision-control matrix BEFORE writing any code.
2. Use the flag + SessionStart-pickup architecture above (or document why an alternative is better).
3. Re-use the env-var off-switch names from this design (`PRISM_DISABLE_CLEAR_NUDGE`, `PRISM_DISABLE_PRECOMPACT_NUDGE`) for continuity.

## Process lesson (added to v4.0 retrospective)

When a locked design names a specific hook event for a specific output behavior, the implementer MUST verify the event-output combination is supported by the harness, not just that the output field exists at the API level. Adversarial review should include this verification as a required gate, not a "feature claim verified" inference.

## Related

- D004-v4-product-vision.md §6 — original design (now superseded by this on the F row)
- D004-v4-product-vision.md §"v4.0 ship gates" rows for SessionEnd[clear] + PreCompact — UNREACHABLE; struck.
- docs/prism/plans/2026-05-25-phase-f-clean-nudge-hooks.md — implementation plan (reverted)
- docs/prism/lessons/2026-05-25-dev-install-inventory.md — Phase F sync entries are now invalid; will be cleaned up alongside the revert commit
