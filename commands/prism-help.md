---
name: prism-help
description: Curated index of PRISM slash commands and skills. Lists active commands by workflow, notes which legacy commands are subsumed by /prism-bootstrap but still callable.
---

# /prism-help — PRISM command index

This is the user-facing index for PRISM as of v4.0. Commands are grouped by
workflow; the most common entry points come first.

Active version: **v4.0** (project-master surface). For migration from v3.x
see [`docs/prism/MIGRATION.md`](../docs/prism/MIGRATION.md).

---

## Daily workflow

| Command | What it does |
|---|---|
| `/prism-bootstrap` | One-command setup. Runs the 7-phase state machine (identity → structure → plugin-validate → discovery → roster → project-master → health). Idempotent. Pass `--with-deep-dive` to opt into the project-master phase. |
| `/prism-sync` | Refresh PRISM's project index — re-runs discovery, roster reconcile, and health checks. Stamps `last_sync_at`. Conservative drift detection (always re-scans). |
| `/prism-clean` | Capture durable session knowledge into `docs/prism/`. Applies a 5-level importance classifier; surfaces candidates as a checklist; writes approved artifacts with locked headers. Use before `/clear` or at session end. |
| `/prism-recall <query>` | Unified recall across PRISM knowledge base (semantic), session state, and spend/metrics (analytical). Auto-routes to the right tier. |

## Project-master (v4.0 surface)

| Command | What it does |
|---|---|
| `/prism-deep-dive` | Generate this project's `master-<slug>` agent. Discovery + ≤5 clarifying questions; writes `<project>/.claude/agents/master-<slug>.md`, seeded `MEMORY.md`, and `settings.json` `agent:` field. Opt-in entry point. |

The `master-orchestrator` skill (Phase E) is loaded automatically by every
`master-<slug>` agent — no slash command needed. Its protocol body lives at
`~/.claude/skills/master-orchestrator/SKILL.md`.

## Agent management

| Command | What it does |
|---|---|
| `/prism-app-expert` | Create or update an app expert agent for a specific application. |
| `/prism-roster` | Display the PRISM agent talent pool (the `--reconcile` mode is now part of `/prism-bootstrap`'s roster phase). |
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
| `/prism-init` | `/prism-bootstrap` (identity phase) | Initial project setup |
| `/prism-discover` | `/prism-bootstrap` (discovery phase) | Codebase + DB + API scan |
| `/prism-roster --reconcile` | `/prism-bootstrap` (roster phase) | Orphan-agent reconciliation. `/prism-roster` itself stays visible for display modes. |
| `/prism-health` | `/prism-bootstrap` (health phase) | Wiring health check |

Per D002, these will be removed in v3.12.0+ after a usage soak.

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
- `docs/prism/MIGRATION.md` — v3.10 → v3.11 → v4.0 migration recipe
- `CHANGELOG.md` — release-by-release change history
- `docs/prism/adjudications/D004-v4-product-vision.md` — locked v4.0 design
