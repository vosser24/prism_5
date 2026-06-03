---
name: prism-help
description: Curated index of PRISM slash commands and skills. Lists active commands by workflow, notes which legacy commands are subsumed by /prism-bootstrap but still callable.
---

# /prism-help — PRISM command index

This is the user-facing index for PRISM as of v5.0. Commands are grouped by
workflow; the most common entry points come first.

Active version: **v5.0** — the cross-project knowledge index (F4): opt-in, dep-free, offline BM25 retrieval + default-on `claude -p` re-rank (silent BM25 fallback), default-deny per-corpus-type sharing via `/prism-recall --share-project`, consumed explicitly via `/prism-recall --cross-project`, plus a stable `queryKnowledge()` API. Builds on v4.7 (the `PRISM_PARALLEL_CAP` knob + C3/E1/E2 freshness nudges). The verdict-regression scanner (A5) that consumes the index is deferred to v5.1. For migration see [`docs/prism/MIGRATION.md`](../docs/prism/MIGRATION.md).

---

## Daily workflow

| Command | What it does |
|---|---|
| `/prism-bootstrap` | One-command setup. Runs the 7-phase state machine (identity → structure → plugin-validate → discovery → roster → project-master → health). Idempotent. The project-master phase is **default-on** (v5.1); pass `--no-master` to opt out (`--with-deep-dive` is an accepted no-op). |
| `/prism-sync` | Refresh PRISM's project index — re-runs discovery, roster reconcile, and health checks. Stamps `last_sync_at`. Conservative drift detection (always re-scans). |
| `/prism-clean` | Capture durable session knowledge into `docs/prism/`. Applies a 5-level importance classifier; surfaces candidates as a checklist; writes approved artifacts with locked headers. Use before `/clear` or at session end. |
| `/prism-recall <query>` | Unified recall across PRISM knowledge base (semantic), session state, and spend/metrics (analytical). Auto-routes to the right tier. |

## Project-master (v4.0 surface)

| Command | What it does |
|---|---|
| `/prism-deep-dive` | Generate this project's `master-<slug>` agent. Discovery + ≤5 clarifying questions; writes `<project>/.claude/agents/master-<slug>.md`, seeded `MEMORY.md`, and `settings.json` `agent:` field. Manual entry point; `/prism-bootstrap` also creates the project-master by default (v5.1). |

The `master-orchestrator` skill (Phase E) is loaded automatically by every
`master-<slug>` agent — no slash command needed. Its navigation index lives at
`~/.claude/skills/master-orchestrator/SKILL.md`; detailed protocols are in
`~/.claude/skills/master-orchestrator/references/` (v4.4 refactor — 10 focused
reference files replacing the previous 770-line monolith).

> **Where agents live (Q7 clarification, v4.1).** `@agent-factory` writes domain specialists to `~/.claude/agents/<name>.md` (global, reusable across all projects). Only `master-<slug>` agents (v4.0 Phase D, via `/prism-deep-dive`) are written to `<project>/.claude/agents/master-<slug>.md` — they're project-scoped by definition. Every other factory mode is global-write.

## Agent management

| Command | What it does |
|---|---|
| `/prism-app-expert` | Create or update an app expert agent for a specific application. |
| `/prism-roster` | Display the PRISM agent talent pool. Modes: default (table), `--team <id>` (filter by team), `--by-domain` (v4.1 — group by domain tag, reads `roster.domain_groups`). The `--reconcile` mode is now part of `/prism-bootstrap`'s roster phase. |
| `/prism-retire` | Archive an unused PRISM agent. |
| `/prism-recommend` | Scan project and recommend external tools with fit-scoring. |

## Validation + diagnostics

| Command | What it does |
|---|---|
| `/prism-validate-plugins` | Audit installed Claude Code plugins for broken hooks, missing manifests, skill-name conflicts. Report-only in v3.11.0; `--fix` deferred to v3.12.0. |
| `/prism-audit` | Fast hygiene scan of PRISM's own configuration surface. |
| `/prism-audit-full` | Comprehensive end-to-end audit; runs synthetic scenarios via `tools/prism-audit-runner.mjs`. Multi-minute deep audit with timing/coverage/trigger-correlation matrix. |
| `/prism-doctor` | Symptom-driven PRISM diagnostic + guided fix. Reads recent routing log; checks env, roster integrity, settings.json wiring, hook syntax. Confirms before applying any fix. |
| `/prism-deps` | Scan system for PRISM optional dependencies; report status; offer installs. |

## Knowledge + telemetry

| Command | What it does |
|---|---|
| `/prism-archive` | Consolidate agent learnings into RAG-queryable sources. |
| `/prism-index` | Scan installed agents, skills, tools, and MCPs; populate the unified resource-index in `roster.json`. Run to make the orchestrator and `blueprint-prompt` aware of resources not created via `agent-factory`. |
| `/prism-telemetry` | Local-only telemetry aggregation. Aggregates `~/.claude/.prism-routing.jsonl` into a structured rollup. **No network** — export-to-JSON for manual sharing only. |

### Installer tools

These are CLI tools for install/upgrade/verify. Run directly from the repo root or the installed copy. All subcommands accept `--target <dir>` (v4.5) to point at a `.claude/` directory other than `~/.claude/`.

- `node tools/prism-installer.mjs verify [--target <dir>]` — check that all manifest files are present and hooks are wired in `settings.json`. **First diagnostic to run** when PRISM feels broken. Exit 0 = healthy; exit 1 = prints which files or hooks are missing.
- `node tools/prism-installer.mjs detect [--target <dir>]` — print JSON of current install state (files found, hooks registered, roster schema version, `.prism-version` marker). No changes.
- `node tools/prism-installer.mjs install [--target <dir>] [--dry-run]` — install/upgrade PRISM. Idempotent. Writes a `.prism-version` marker (v4.5) on success.
- `node tools/prism-installer.mjs update [--target <dir>] [--dry-run]` — *(v4.5)* detect + backup + install in one command. No-op when installed version matches shipped (`Already at vX; nothing to do.`).
- `node tools/prism-installer.mjs uninstall [--target <dir>] [--purge-state] [--yes]` — uninstall. By default preserves `roster.json`, `MEMORY.md`, routing/spend/telemetry logs. `--purge-state` *(v4.5)* additionally wipes those; `--yes` skips the confirmation prompt.
- `bash install.sh` / `pwsh .\install.ps1` — full install/upgrade from repo root. Idempotent.

Backup *(v4.5)*: every install creates a full snapshot under `<target>/.prism-install-backup-<timestamp>/` covering shipped files (`agents/`, `hooks/`, `tools/`, `commands/`, `skills/`) **plus** user state (`MEMORY.md`, `prism-policy.json`, `.prism-routing.jsonl`, `.prism-spend.jsonl`, `.prism-phase-1-5-verdicts.jsonl`, `.prism-telemetry-rollup.json`). Restore via `uninstall --restore-backup <dir>`.

### v4.4 OOB PHASE 1.5 tools

These are CLI tools (not slash commands). Run directly from the terminal or via `/prism-clean` (ratchet is auto-invoked):

- `node ~/.claude/tools/prism-phase-1-5-verdicts.mjs` — query verdict log; flags `--agent <name>`, `--since <YYYY-MM-DD>`, `--json`, `--uncited-rate`.
- `node ~/.claude/tools/prism-roster.mjs --apply-ratchet` — apply evidence-discipline ratchet from verdict log. Auto-invoked by `/prism-clean`.
- `node ~/.claude/tools/prism-roster.mjs --tag-1-5 @<agent>` — opt agent into OOB PHASE 1.5 review.
- `node ~/.claude/tools/prism-roster.mjs --untag-1-5 @<agent>` — remove OOB PHASE 1.5 review from agent.
- `node ~/.claude/tools/prism-roster.mjs --reset-model @<agent>` — manual deescalation reset (clears `default_model` + counters).
- `node ~/.claude/tools/prism-roster.mjs --skip-next-oob @<agent>` *(v4.5)* — set one-shot OOB skip on a specialist; the next SubagentStop bypasses Phase 1.5 review for that agent only.
- `node ~/.claude/tools/prism-roster.mjs --set-model @<agent> <haiku|sonnet|opus>` *(v4.6)* — set an agent's `default_model` (K2 calibration apply target).
- `node ~/.claude/tools/prism-roster.mjs --clear-pending-upgrade @<agent>` *(v4.6)* — clear a stale `pending_upgrade` flag (K3 calibration apply target).
- `node ~/.claude/tools/prism-telemetry-aggregate.mjs --phase-1-5-agreement` — per-agent reviewer agreement signal (requires telemetry opt-in).
- `node ~/.claude/tools/prism-telemetry-aggregate.mjs --recommend-calibration` *(v4.6)* — on-demand calibration engine: reads routing + verdict logs, prints threshold-change recommendations (K1 cap report-only, K2 escalate-model, K3 auto-clear, K4 override gate) + apply commands. Recommend-then-apply — never mutates a default. Degrades to "insufficient data" below 15 samples; output also to `~/.claude/.prism-calibration-<date>.json`. Env `PRISM_OVERRIDE_GATE=strict` escalates the SessionStart override advisory.

## Lifecycle

| Command | What it does |
|---|---|
| `/prism-update` | Run the 15-day PRISM self-update cycle. |

---

## Subsumed commands (hidden from this index per D002 §3, still functional)

These commands remain callable for backward compatibility, but their
workflow is now part of `/prism-bootstrap`. New users should not invoke
them directly:

| Legacy command | Subsumed by | Notes |
|---|---|---|
| `/prism-discover` | `/prism-bootstrap` (discovery phase) | Codebase + DB + API scan |
| `/prism-roster --reconcile` | `/prism-bootstrap` (roster phase) | Orphan-agent reconciliation. `/prism-roster` itself stays visible for display modes. |
| `/prism-health` | `/prism-bootstrap` (health phase) | Wiring health check |

Per D002, these will be removed in v3.12.0+ after a usage soak.

---

## Hooks (auto-activated; no slash command)

PRISM ships hooks that fire on Claude Code lifecycle events. None of
these have a slash-command entry point; they run automatically. Off-
switches let you suppress individual nudges via env vars.

| Event | Hook | What it does | Off-switch |
|---|---|---|---|
| SessionStart | `prism-session-start.mjs` | Resets project turn counter, runs once-per-day context-tax audit, picks up + emits pending flag-file nudges (v4.1 Phase A), runs daily freshness sweep (v4.1 Phase B). | `PRISM_DISABLE_FRESHNESS_SWEEP=1` (sweep only — core SessionStart logic always runs) |
| SessionEnd[matcher=clear] | `prism-clean-nudge-flag.mjs` (v4.1 Phase A) | Writes flag → next session nudges `/prism-clean` if session ended via `/clear`. | `PRISM_DISABLE_CLEAR_NUDGE=1` |
| SessionEnd (catch-all) | `prism-git-clean-nudge.mjs` (v4.1 Phase A) | Writes flag if git working tree dirty → next session nudges to commit/stash. Skipped in non-git projects. | `PRISM_DISABLE_GIT_CLEAN_NUDGE=1` |
| PreCompact | `prism-precompact-nudge-flag.mjs` (v4.1 Phase A) | Writes flag → next session nudges `/prism-clean`. | `PRISM_DISABLE_PRECOMPACT_NUDGE=1` |
| PreToolUse[Bash] | `prism-prepush-review.mjs` (v4.1 Phase A) | Detects `git push *` and asks for confirmation + nudges `/code-review` + `/security-review`. Bypass via per-branch `review-done` flag-file. | `PRISM_DISABLE_PREPUSH_NUDGE=1` |
| PreToolUse[Bash] | `prism-safety.mjs` | Blocks `rm -rf`, `DROP TABLE`, `git push --force`, etc. Warns on push-to-main. | n/a — safety gate |
| SubagentStop | `prism-phase-1-5-oob.mjs` (v4.4) | When specialist has `requires_phase_1_5: true` in roster, invokes independent reviewer via Anthropic SDK. Async by default; block-mode if `requires_phase_1_5_block: true`. | `PRISM_DISABLE_OOB_REVIEW=1` |

---

## Skills (auto-activated by Claude Code)

PRISM ships several skills that load themselves on triggers — you don't
invoke them with a slash command, you trigger them by intent:

| Skill | Triggers on |
|---|---|
| `master-orchestrator` | Loaded automatically by every `master-<slug>` project agent (Phase E). Carries the multi-step orchestration protocol with adversarial review + Phase 1.5 senior-review evidence rules (Phase J). |
| `prism-chat` | Chat-mode planning + adversarial expert panel; classifies prompts as TRIVIAL/ROUTINE/COMPLEX/NOVEL. |
| `prism-plan` | Multi-step project planning with expert agent teams. Use `/prism-plan` or natural-language intent. |
| `prism-discover`, `prism-clean`, `prism-validate-plugins`, others | Each PRISM slash command has a backing skill that carries the protocol body. |

---

## See also

- `README.md` — top-level PRISM overview
- `docs/prism/MIGRATION.md` — upgrade recipes (v3.x → v4.0 through v4.7 → v5.0)
- `CHANGELOG.md` — release-by-release change history
- `docs/prism/adjudications/D004-v4-product-vision.md` — locked v4.0 design
