# PRISM — cognitive-tier orchestration for agentic coding

PRISM makes an agentic coding session **self-aware about task complexity**. Every prompt is classified and routed to the cheapest model tier that can do the job, simple work is kept off expensive models, high-stakes work is forced through an adversarial expert panel before any code is written, and each project grows a persistent "project-master" that remembers its decisions across sessions.

It is **local-first and dep-free at its core**: deterministic Node hooks + a small set of JSON manifests. No network calls, no API keys, no telemetry leave your machine unless you explicitly opt in.

---

## What it solves

Three recurring pain points in long agentic coding sessions:

1. **Everything runs on the most expensive model.** A one-line lookup and a multi-file refactor cost the same. PRISM scores each prompt (`haiku` / `sonnet` / `opus`) and routes accordingly — typically a large cut in spend with no loss of quality on the work that matters.
2. **High-stakes work gets one-shot answers.** Architecture, migrations, and irreversible decisions deserve more than a single pass. PRISM detects novel-architecture intent and convenes an **adversarial expert panel** (≥2 substantive challenges before synthesis) instead of answering blind.
3. **Context evaporates between sessions.** Decisions, lessons, and project shape are lost on every `/clear`. PRISM keeps a per-project **memory router** and a cross-project **knowledge index** so the next session starts already caught up.

PRISM enforces all of this with **guards** — deterministic hooks that block the wrong-tier or unsafe action *before* it happens, not after.

---

## Quick start — a brand-new project

Once PRISM is installed on your machine (see [Installation](#installation)), onboarding any project takes one command:

```text
cd your-project
# then, in your coding session:
/prism-bootstrap
```

That runs the full 7-phase setup (idempotent — safe to re-run):

| Phase | What it does |
|---|---|
| identity | Audits/creates `CLAUDE.md` operating rules |
| structure | Scaffolds `.claude/` + `docs/prism/` + `tasks/` |
| plugin-validate | Sanity-checks installed plugins |
| discovery | Scans codebase + DB + API into compact reference files |
| roster | Reconciles available specialist agents |
| **project-master** | Creates `master-<slug>` — your project's persistent solution-architect (default-on) |
| health | Verifies wiring; green/yellow/red report |

After bootstrap:

```text
/prism-recall   <question>     # ask anything PRISM has learned about this project
/prism-clean                   # capture durable decisions/lessons before you /clear
/prism-sync                    # refresh the project index after big changes
```

That's the whole daily loop. Everything below is reference.

---

## Installation

**Requirements:** Node.js ≥ 18, `git`, and an agentic coding CLI (the `claude` command) available on your PATH. Optional: `python` ≥ 3.10 and the `notebooklm` / `gh` CLIs for the cross-project knowledge and research tiers.

### 1. Clone

```bash
git clone https://github.com/vosser24/prism_master.git
cd prism_master
```

### 2. Install

**Windows (PowerShell):**
```powershell
pwsh .\install.ps1
```

**macOS / Linux / Git-Bash:**
```bash
bash install.sh
```

The wrappers call `node tools/prism-installer.mjs install` under the hood. The installer is **idempotent** — re-running it upgrades in place: it backs up your settings + roster first, removes old files by pattern, copies the new ones, and merges configuration (preserving your roster agents, policy, and telemetry logs).

### 3. Verify

```bash
node tools/prism-installer.mjs verify
```

Every check should print `PASS`. If any print `FAIL`, re-run the installer.

### Install flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print what would happen; change nothing |
| `--no-backup` | Skip backing up existing settings/roster |
| `--quiet` | Suppress progress output |
| `--home <path>` | Override the install HOME (for testing) |

### Upgrade an existing install

```bash
node tools/prism-installer.mjs update
```

Detects the current install, checks version, backs up, then installs — equal-version runs are a no-op.

### Uninstall

```bash
bash scripts/uninstall.sh            # DRY-RUN preview (default)
bash scripts/uninstall.sh --purge    # actually remove
```
```powershell
.\scripts\uninstall.ps1              # DRY-RUN preview (default)
.\scripts\uninstall.ps1 -Purge       # actually remove
```

To restore a backup taken during install:
```powershell
.\uninstall.ps1 -RestoreBackup "<your .prism-install-backup-… path>"
```

---

## Capabilities

| Capability | What it does |
|---|---|
| **Tier routing** | A keyword-floor classifier scores every prompt and routes it to `haiku` / `sonnet` / `opus`. Trivial lookups stay cheap; genuine engineering gets the model it needs. You can override per-prompt with `!opus-force:`. |
| **Adversarial expert panel** | Novel-architecture / migration / multi-option prompts (or an explicit "summon the panel") convene a panel of specialist agents that challenge each other before a synthesized plan is returned. |
| **Dispatch guard** | Enforces the dispatch pattern — heavy work is farmed out to subagents instead of being run directly in the expensive main loop. |
| **Mutation guard** | Blocks direct file mutation from the main loop on non-trivial turns, steering edits through reviewed subagents. |
| **Safety gate** | Blocks genuinely dangerous shell commands (`rm -rf /`, `curl … \| bash`, `DROP TABLE`, force-push) while allowing routine ones (`rm -rf ./build`). Scans a de-quoted view so a dangerous token merely *mentioned* in data doesn't trip it. |
| **Project-master memory** | Each project gets a `master-<slug>` agent whose `MEMORY.md` router carries forward recent decisions, lessons, and a session log — auto-injected at the start of every subagent so work resumes already informed. |
| **Two-mode session memory** | If the optional `claude-mem` tier is present it owns ambient capture; otherwise PRISM's native nudge + `/prism-clean` fold keeps a durable record. Nothing is lost either way. |
| **Cross-project knowledge index** | An opt-in, offline BM25 + re-rank index over your adjudications / lessons / plans, queryable with `/prism-recall --cross-project`. |
| **Agent factory + roster** | Specialist agents are created on demand, registered in a roster, and reused across sessions; `/prism-roster` and `/prism-retire` manage the talent pool. |

---

## Command reference

Every command, grouped by workflow, with a concrete use case. Run `/prism-help` in-session for the live index.

### Setup

| Command | Use case | Key flags |
|---|---|---|
| `/prism-bootstrap` | Run **once on any new or freshly-cloned project** to fully initialize PRISM through the 7-phase machine. Idempotent. | `--dry-run`, `--interactive`, `--force`, `--skip-discover`, `--no-master`, `--no-telemetry` |
| `/prism-init` | When you only need the `CLAUDE.md` operating-rules template + directory scaffold, without the full 7-phase run. (Subsumed by bootstrap.) | `full` |

### Daily

| Command | Use case | Key flags |
|---|---|---|
| `/prism-sync` | Run weekly or after significant changes to refresh PRISM's discovery references, reconcile the roster, and re-check health. | `--smart-drift` |
| `/prism-clean` | Run **before `/clear` or at session end** — applies a 5-level importance classifier and writes durable adjudications/lessons/smoke docs, folding a one-line summary into the project-master memory. | `--allow-l5-skip` |
| `/prism-recall <query>` | Ask anything PRISM has learned: *"what was the decision on the auth middleware?"*, *"total spend today?"*. Auto-routes between semantic, session-state, and metrics tiers. | `--cross-project`, `--json`, `--verbose`, `--tier 1\|2\|3`, `--no-rerank` |

### Project-master

| Command | Use case | Key flags |
|---|---|---|
| `/prism-deep-dive` | Create or refresh the per-project `master-<slug>` agent (bootstrap creates it by default; run directly to `--refresh` its memory or `--upgrade` its body after big changes). | `--refresh`, `--upgrade <slug>` |

### Agent management

| Command | Use case | Key flags |
|---|---|---|
| `/prism-app-expert <app>` | Before a UI/screenshot/video task or after a big app refactor, create a specialist that knows one application as a power user. | `--update`, `--list` |
| `/prism-roster` | Inspect the available talent pool; use `--reconcile` to register agent files created outside the factory. | `--by-domain`, `--team <id>`, `--reconcile` |
| `/prism-retire @agent` | Cleanly archive a stale or wrong specialist — removes its directory and roster entry atomically. | — |
| `/prism-recommend` | After bootstrap, see which optional external tools actually fit this project's stack (fit-scored). | `--check`, `--re-check <tool>`, `--include-optional` |
| `/prism-uninstall-cleanup` | Run before removing PRISM-as-plugin to clear agents that were factory-created under the plugin. | `--dry-run`, `--mode=remove-all\|keep-all` |

### Validation & health

| Command | Use case | Key flags |
|---|---|---|
| `/prism-doctor` | Use when routing/guards *feel* wrong — symptom-driven diagnostic that proposes exactly one fix per finding and confirms before applying. | — |
| `/prism-health` | Onboarding a new machine or post-upgrade: confirm core install, roster, tools, and dependencies are green. | `--quick`, `--tools`, `--agents`, `--project` |
| `/prism-audit` | Fast pre-commit hygiene/security scan of PRISM's own config surfaces (secrets, YAML integrity, roster, hook syntax). | `--fix`, `--quick`, `--severity high` |
| `/prism-audit-full` | Before tagging a release or after adding a hook — deep end-to-end audit that exercises every hook path and produces a timing/coverage report. | (interactive) |
| `/prism-validate-plugins` | After installing/updating any plugin, catch broken hooks, missing manifests, and skill-name conflicts (report-only). | — |
| `/prism-deps` | On a fresh machine or before media work, find and install optional dependencies (ffmpeg, playwright, `gh`, `jq`, …). | `--check`, `--list` |

### Telemetry (local-only, opt-in)

| Command | Use case | Key flags |
|---|---|---|
| `/prism-telemetry` | Enable local routing/cost telemetry, inspect tier distribution and guard fire-rates, or export an anonymized rollup. **No network.** | `--opt-in`, `--opt-out`, `--status`, `--aggregate`, `--export <path>` |

### Knowledge & maintenance

| Command | Use case | Key flags |
|---|---|---|
| `/prism-index` | After installing a new plugin/MCP, populate the roster's skills/tools blocks so the orchestrator sees real specialists, not generics. | `--enrich`, `--dry-run`, `--skills-only` |
| `/prism-archive @agent` | Periodically consolidate a specialist's accumulated research notes into one RAG-queryable document. | `--list`, `--threshold N`, `--cleanup` |
| `/prism-update` | Keep the model matrix, registries, and agent bodies current on a ~15-day cadence. | — |
| `/prism-help` | Don't know which command to run? The curated, by-workflow index. | — |

---

## Architecture at a glance

- **Hooks** (`~/.claude/hooks/*.mjs`) — deterministic Node scripts wired to session events: a tier router on every prompt, guards on tool calls (dispatch / mutation / safety / parallel / config), and lifecycle capture on session start/stop.
- **Skills** — the orchestration protocol (`master-orchestrator`), planning, recall, discovery, and the project lifecycle commands.
- **Agents** — a reusable roster of specialists plus the per-project `master-<slug>`.
- **Tools** (`tools/*.mjs`) — the deterministic engines behind the commands (bootstrap state machine, installer, knowledge indexer, recall, telemetry aggregation).
- **State** — per-project under `.claude/`, machine-global under `~/.claude/`. JSON manifests, no database.

---

## Layout

```
~/.claude/
  hooks/            # the guards + router + lifecycle hooks
  skills/           # orchestration + command skills
  agents/           # global specialist roster
  tools/            # deterministic command engines
  commands/         # slash-command definitions

<your-project>/
  CLAUDE.md         # operating rules
  .claude/
    agents/         # master-<slug> + MEMORY.md router
    references/     # discovery output (codebase/API map)
  docs/prism/       # adjudications, lessons, plans, smoke docs
  tasks/            # todo + lessons logs
```

---

## Uninstall

See [UNINSTALL.md](UNINSTALL.md) for the tiered procedure (transient-state reset → full uninstall → reinstall) and flag reference.

## Contributing

Issues and PRs welcome at https://github.com/vosser24/prism_master. Before submitting, run the test suite and ensure all assertions pass.

## License

See the repository for license details.
