# D008 — Freshness sweep may auto-archive project-orphaned agents (bends "execute manually")

**Status:** Locked
**Date:** 2026-06-03
**Captured by:** brainstorming → design (v5.2.0)
**Related:** [[D002]] (sweep-drift scope), [[D004]] (§1 project_slug lock), [[D007]] (agent-creator vs factory), design: `docs/prism/plans/2026-06-03-agent-scope-survival-design.md`

## Context

PRISM's locked operating principle (D002 §, command-consolidation): **automate cheap, deterministic DETECTION (nudge-only); keep mutating EXECUTION manual** (LLM-judged / mutating / installing / blocking). The SessionStart freshness sweep (`hooks/lib/prism-freshness-sweep.mjs`) has, until now, been **entirely nudge-only** — every check returns a NOTICE string; the lone "execution" (A5 KB index rebuild) only regenerates a derived cache, never user content.

The v5.2.0 *scope-aware agent survival* feature introduces an explicit user-chosen exception: when a `scope:"project"` agent's **home project is gone or stale**, the sweep **auto-archives** the agent (moves its file to `~/.claude/agents/retired/`, marks the roster entry `archived`). This is the first sweep action that mutates **user-facing agent state** without a confirmation.

## Decision

**Permit the mutating auto-archive in the sweep**, scoped strictly to project-orphaned agents, BECAUSE it is gated by these non-negotiable safety rails:

1. **Reversible, never destructive** — the agent file is *moved* to `retired/` (not deleted) and the roster entry is *retained* with `archived/archived_at/archived_reason`. Fully restorable.
2. **SMB / offline guard** — a project is "absent" only when its parent path is reachable but the project dir is missing. If the whole mount/parent is offline (`unreachable`), the agent is NOT archived. Prevents mass false-archiving when `//grhqecomm/…` is unmounted.
3. **Safe default + broad protection** — only an explicit `scope:"project"` agent is eligible. Missing/unknown scope ⇒ treated `broad` ⇒ never auto-archived. Existing agents (no scope) are untouched on rollout.
4. **Notify-after** — the sweep surfaces what it archived and the restore path; the action is automatic but never silent.
5. **Throttled** — rides the existing 24h sweep; no new hot-path cost.

The user explicitly chose auto-archive over nudge-only and two-stage, accepting the aggressiveness in exchange for keeping the global pool clean of dead project specialists.

## Consequences

- The "sweep is purely nudge-only" invariant no longer holds in the absolute. Future sweep checks still default to nudge-only; mutation requires the same reversibility + guard bar set here.
- `freshnessSweepDryRun` stays read-only: the survival check takes an `apply` flag (false in dry-run → decision-only notice).
- A first-class restore (`/prism-roster --restore`) is deferred; v1 restore is a documented manual move + flag-clear.
