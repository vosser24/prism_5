# D001 — PRISM Bootstrap Unification

**Status:** Proposed
**Date:** 2026-05-05
**Decision owner:** PRISM core
**Target release:** v3.10.0
**Captured by:** Adversarial review session (Claude Opus 4.7, conversation 140ec270)

## Context

PRISM project setup currently fragments across 6+ commands the user must run in the right order to reach a fully-operational state:

1. `/prism-init` — identity, partial folder structure, CLAUDE.md template
2. (manual paste-prompt) — scaffold `docs/prism/{adjudications,deviations,smoke}/` and capture conventions
3. `/prism-discover` — codebase + DB + API scan into `.claude/references/`
4. `/prism-health` — verify wiring
5. `/prism-doctor` — symptom scan + propose fixes
6. `/prism-roster --reconcile` — register orphan agents

A live walkthrough on the **Nexus Reporting 3** project (Django + React + Postgres) confirmed the cost: a user discovered the `docs/prism/` scaffold was missing only by accident, and only after the panel-summoning hook had repeatedly fired notices that nothing enforced.

This is **historical accretion**, not principled architecture. Each command was added at a different point in PRISM's evolution; nobody refactored the union.

## Problem statement

PRISM has the right pieces but no integration layer. Specifically:

- The user must **know** which commands to run **and** their order. There is no error if they skip step 3 — only silent gaps.
- `/prism-init` is a half-implementation. A half-completing setup command is worse UX than none.
- Dependencies between phases are real (you cannot reconcile the roster until you have discovered the codebase) but the architecture pretends they are independent.
- New agents installed mid-project do not auto-register. Drift accumulates silently.
- Session learnings (panel decisions, deviation reports, smoke procedures) are only captured if the user manually invokes `/prism-archive` — which has never happened in any observed session.

## Decision

Consolidate to **two main commands** (`/prism-up`, `/prism-sync`) covering ~90% of normal use, three auto-firing hooks, and four specialist commands for rare cases. Total: **6 commands**, down from 15.

### `/prism-up` — first-run bootstrap (idempotent)

Brings any project from "no PRISM" to "fully operational" in one invocation. Re-running is safe — skips completed phases, fixes only new gaps.

**Phases:**

| # | Phase | Action | Gate |
|---|-------|--------|------|
| 1 | Detect | Read `.claude/.prism-state.json`. Decide what is needed. | — |
| 2 | Identity | Create CLAUDE.md if missing. Audit if present (line count, structure). | — (read-only audit) |
| 3 | Structure | Create `.claude/{references,rules,agents,hooks}/`, `docs/prism/{adjudications,deviations,smoke}/`, `tasks/`, `.prism-state.json`. | — (idempotent mkdir) |
| 4 | Conventions | Write `.claude/rules/capture-conventions.md` if absent. | — |
| 5 | Discover | Codebase + DB + API scan to `.claude/references/`. Parallelized. Skipped if last run < 24h unless `--force`. | — (read-only scan) |
| 6 | Roster | Reconcile orphan agents. Surface dual-form for user choice. | **gate: confirm before roster.json write** |
| 7 | CLAUDE.md update | Replace inline DB Tables / SPA Routes with pointers to discovered references. Re-check ≤200 line target. | **gate: show diff, confirm** |
| 8 | Health verify | Run health check. Report green/yellow/red. | — |
| 9 | Commit prompt | Show staged changes. Ask user to commit. | **gate: user runs git commit** |

**Flags:**
- `--dry-run` — print plan, write nothing
- `--interactive` — confirm between phases
- `--force` — re-run discovery even if recent
- `--skip-discover` — for projects without DB/API surface

### `/prism-sync` — ongoing maintenance

Detects drift and brings everything current. Cheap, runnable any time. Target: <30s on a typical project.

**Phases:**

| # | Phase | Detection |
|---|-------|-----------|
| 1 | Drift scan | Files in scanned dirs modified since last `.claude/references/` write? DB schema diff? New agents/skills installed in `~/.claude/`? |
| 2 | Refresh references | Re-scan only deltas. |
| 3 | Roster reconcile | Auto-register newly-installed agents/skills. Flag orphans. |
| 4 | Archive | If session has substantive work since last sync → write to `docs/prism/lessons/YYYY-MM-DD-session.md`. Pull from `.prism.db`. |
| 5 | Telemetry compact | Roll up `.prism.db` into `.prism-telemetry-rollup.json` if drift > threshold. |
| 6 | Audit | Lightweight hygiene check (orphans, dual-form, secrets). |
| 7 | Report | What was synced. What needs user attention. Suggest next sync date. |

### Auto-firing hooks

| Hook event | Action | Reason |
|------------|--------|--------|
| Agent file write (`~/.claude/agents/<name>/agent.md`) | Append to `roster.json` immediately | New agents register without manual reconcile |
| `Stop` (end of substantive session) | Run `/prism-sync --archive-only` silently | Capture lessons before context evaporates |
| `PreCompact` | Same — archive first, then allow compaction | Preserve institutional memory at the boundary |

Non-blocking. Silent. Write artifacts that future sessions read.

### State management

A single state file makes the system introspectable.

`.claude/.prism-state.json`:
```json
{
  "schema_version": "3.10.0",
  "project_name": "<project>",
  "initialized_at": "ISO-8601",
  "phases": {
    "identity":   { "completed_at": "...", "claude_md_lines": 245 },
    "structure":  { "completed_at": "..." },
    "discovery":  { "completed_at": "...", "references_count": 8 },
    "roster":     { "completed_at": "...", "agents_registered": 16, "orphans_remaining": 0 },
    "health":     { "completed_at": "...", "status": "green" }
  },
  "last_sync_at": "ISO-8601",
  "next_sync_recommended": "ISO-8601",
  "drift_signals": {
    "codebase_modified_since_last_discover": false,
    "schema_introspection_diff": false,
    "new_agent_files_pending_register": []
  }
}
```

Both commands read this file first. Both update it on success. A crash mid-phase means the next run resumes from the failed phase, not from scratch.

### Specialist commands (rare use, kept first-class)

| Command | Use case |
|---------|----------|
| `/prism-check` | Read-only diagnostic. Replaces `/prism-health` + `/prism-audit` + `/prism-doctor`. |
| `/prism-agent` | Create/retire/list project agents. Replaces `/prism-app-expert` + `/prism-retire` + parts of `/prism-roster`. |
| `/prism-recommend` | Tier 2 tool fit analysis. |
| `/prism-self-update` | Update PRISM the framework. Renamed from `/prism-update` for clarity. |

## Robustness principles

1. **Idempotency everywhere** — every phase reads state, skips completed work.
2. **Atomic writes** — each phase commits its state update at completion. Crash mid-phase = restart-safe.
3. **Dry-run universal** — every destructive command supports `--dry-run`.
4. **Failure isolation** — phase 6 (roster) failure does not roll back phase 5 (discovery) writes.
5. **Streaming progress** — long phases (discovery) stream "scanned 12/52 endpoints" for trust on first run.
6. **Telemetry on everything** — every phase logs to `.prism.db`.
7. **Self-healing re-run** — partial completion last time → next run picks up at unfinished phase.

## Implementation strategy

The existing 15 commands become **internal building blocks** of the orchestrator. No rewrite of underlying logic.

```
/prism-up   = prism-init + prism-scaffold + prism-discover
              + prism-roster --reconcile + prism-health
              + prism-doctor --safe-fixes-only + commit-prompt
              + state file management

/prism-sync = drift-detect + prism-discover --delta
              + prism-roster --reconcile
              + prism-archive --since-last-sync
              + prism-audit --quick
              + state update
```

## Migration path

**v3.10.0 release plan (~4–5 days focused work):**

1. Build `/prism-up` orchestration. ~1 day.
2. Build `/prism-sync` with drift detection. ~1.5 days. (Hardest part — "what changed since last run.")
3. Wire three auto-fire hooks. ~0.5 day.
4. Add `.prism-state.json` schema + helpers. ~0.5 day.
5. Deprecate (do not delete) the 8 subsumed commands. Deprecation notices for one release. ~0.5 day.
6. Update docs: README, CLAUDE.md template, `/prism-help` output. ~0.5 day.

## Risks

1. **Drift detection edge cases** — `/prism-sync`'s "what changed" logic is the highest-risk piece. Start conservative: re-run discovery if any tracked dir's mtime is newer than last discovery run. Optimize later.
2. **Migration friction** — users with muscle memory for `/prism-init` workflow. Mitigated by deprecation notices and one-release coexistence.
3. **State file corruption** — if `.prism-state.json` becomes invalid, both commands could refuse to run. Mitigated by validation + auto-rebuild from filesystem inspection.
4. **Auto-archive false positives** — Stop hook firing on trivial sessions creates noise files in `docs/prism/lessons/`. Threshold: only archive if session produced ≥1 PR or ≥1 panel decision.

## Alternatives considered

1. **Status quo** — leave 15 commands, document the order better. Rejected: documentation does not survive the user not reading it. The fragmentation is the failure mode, not the docs.
2. **Single mega-command** — one `/prism` with subcommands (`/prism up`, `/prism sync`, etc.). Rejected: breaks PRISM's `/prism-*` slash convention; would require all command renames.
3. **Auto-run on first prompt** — fire `/prism-up` automatically when entering a directory with no PRISM state. Rejected: violates user-consent norms; risks running discovery on directories the user did not intend to PRISM-ify.

## Decision

**Approved as the v3.10.0 priority. Proceed with implementation per the migration path.**

The accompanying retro (parent conversation) identified bootstrap unification as **higher-leverage than** the previously proposed project-local hard-gate hook, because unification makes the gate, the auto-archive, and the roster reconcile all invisible in one orchestrated flow.

## Related

- Parent retro: 14-flaw PRISM self-critique, items #1, #2, #6, #8, #10, #11
- Earlier proposal: project-local hard-gate hook (subsumed by Phase 6 gate of `/prism-up`)
- Prior art: `/prism-init` companion-tool installation flow already orchestrates a sub-sequence; this generalizes that pattern.

## Lock

This adjudication is locked when implementation begins. Subsequent design changes require a new D### entry referencing this one.
