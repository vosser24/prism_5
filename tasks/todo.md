# PRISM v2.9.1 — Audit Hardening Patch

Blueprint source: blueprint-prompt skill invocation, 2026-04-24.
Scope: apply 2 in-scope audit findings from the v2.8.2 fresh-eyes audit, plus changelog Known Gaps subsection for the 6 deferred findings.

## Execution Plan

### Group A — Hook hardening (can run in parallel: disjoint files)

- [ ] [sonnet] [pgroup=1] Apply TIER-DRIFT-001 to `hooks/prism-agent-model-guard.mjs` — done when: hard-mode deny fires ONLY on sentinel.tier=='opus' AND no explicit model; sonnet/haiku become advisory nudges; new enum value `strict` preserves the old behavior (deny any non-opus without explicit model); header version bumped to v2.9.1; MODE parsing accepts `soft|hard|strict`.

- [ ] [sonnet] [pgroup=1] Apply ATOMIC-WRITE-001 to `hooks/prism-memory-save-nudge.mjs` — done when: every writeFileSync call writing to `~/.claude/.prism-memory-save-counter-*.json` uses tempfile+renameSync pattern with catch-fallback to direct writeFileSync (matching v2.8.0 shape in `hooks/prism-parent-dispatch-guard.mjs` lines 90-107); header version note added.

- [ ] [sonnet] [pgroup=1] Apply ATOMIC-WRITE-001 to `hooks/prism-session-start.mjs` — done when: every state write (context-audit dot, session-turn-counter, classifier-floor hint counter) uses tempfile+renameSync pattern with catch-fallback; header version note added.

### Group B — Migration hygiene (depends on Group A — same-session settings tracking)

- [ ] [sonnet] Add v2.9.1 session-start migration notice for strict-mode change to `hooks/prism-session-start.mjs` — done when: one-time notice emits when PRISM_MODEL_GUARD=hard is in env AND installed version first hits v2.9.1 AND notice hasn't been shown; suppressed thereafter via `~/.claude/.prism-v2.9.1-migration-shown` flag.

### Group C — Metadata + shipment (sequential after A+B)

- [ ] [haiku] Bump `manifest.json` version 2.9.0 → 2.9.1 — done when: JSON valid, version string updated.

- [ ] [haiku] Bump `scripts/install-merge.mjs` internal log label v2.9.0 → v2.9.1 — done when: log line matches.

- [ ] [sonnet] Write `CHANGELOG.md` v2.9.1 section — done when: Added/Fixed subsections for the 3 hook fixes; explicit "Known gaps (tracked for v3.0+ / v2.10)" subsection enumerating INSTALL-MERGE-001, DOCTRINE-DRIFT-001, SCHEMA-VERSIONING-001, CONFIG-GUARD-DRIFT-001, DEAD-REFERENCE-001, DEPENDENCY-MANIFEST-001 each with 1-line description + target version + severity; breaking-contract note on PRISM_MODEL_GUARD=hard with migration instructions loudly highlighted.

- [ ] [opus] Local verify: `node scripts/install-merge.mjs && node scripts/verify.mjs` — done when: install-merge stamps update-log 2.9.0 → 2.9.1; verify reports 77 manifest entries clean; all modified hook files pass `node --check`.

- [ ] [opus] Commit + push `claude/audit-pending-pushes-Rg1p8` — done when: single commit with well-formed message per PRISM convention; pushed to origin; commit SHA captured.

## Risks & Blockers

- **PRISM_MODEL_GUARD=hard contract change.** Users who set hard mode deliberately to catch silent Opus drift will see Sonnet/Haiku dispatches pass through on v2.9.1. Mitigation: `strict` enum value preserves old behavior + loud session-start migration notice + CHANGELOG breaking-contract marker.
- **Atomic-write Windows edge case.** renameSync EBUSY under antivirus scans. Mitigation: catch-fallback to direct writeFileSync matches v2.8.0 pattern exactly.
- **Scope creep temptation.** 6 other audit findings exist. Mitigation: Known Gaps subsection in CHANGELOG enumerates them with target versions; no code changes for them in this patch.

## Hand-off

Execution-heavy → dispatch `@master-orchestrator` with this todo.md as context. Orchestrator owns panel expansion, parallel dispatch of Group A, sequential Group B/C, and PHASE 1.5 senior review before commit.
