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

## Quick start

**Most of PRISM is automatic.** Once installed, tier routing, the expert panel, the guards, and project-master memory all fire on their own — you don't run a command for them. There are only **three things you actively do:** onboard a project once, then a tiny daily loop.

```text
cd your-project
/prism-bootstrap                 # ONCE per project — full setup (idempotent)

# …then, day to day:
/prism-recall  <question>        # ask anything PRISM has learned about this project
/prism-clean                     # capture decisions/lessons BEFORE you /clear
```

`/prism-bootstrap` runs the full 7-phase setup (safe to re-run):

| Phase | What it does |
|---|---|
| identity | Audits/creates `CLAUDE.md` operating rules |
| structure | Scaffolds `.claude/` + `docs/prism/` + `tasks/`; for **Python projects**, creates a project-root `.venv` and adds a rule to run Python under it |
| plugin-validate | Sanity-checks installed plugins |
| discovery | Scans codebase + DB + API into compact reference files |
| roster | Reconciles available specialist agents |
| **project-master** | Creates `master-<slug>` — your project's persistent solution-architect (default-on) |
| health | Verifies wiring; green/yellow/red report |

> **Python projects:** if the folder is empty/greenfield, bootstrap asks *"Will this be a Python project?"* and remembers your answer — so a still-empty folder you've declared Python stays governed by its `.venv`.

---

## Installation

**Requirements:** Node.js ≥ 18, `git`, and an agentic coding CLI (the `claude` command) on your PATH. Optional: `python` ≥ 3.10 (and 3.12 for the bundled `pwagent` tool), plus the `notebooklm` / `gh` CLIs for the cross-project knowledge and research tiers.

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
| `--with-pwagent` | During install/update, also wire the bundled `pwagent` Playwright tool (PATH + first-run provisioning) without prompting |
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

See [UNINSTALL.md](UNINSTALL.md) for the tiered procedure (transient-state reset → full uninstall → reinstall) and the backup-restore flag.

---

## Capabilities

| Capability | What it does |
|---|---|
| **Tier routing** | A keyword-floor classifier scores every prompt and routes it to `haiku` / `sonnet` / `opus`. Trivial lookups stay cheap; genuine engineering gets the model it needs. Override per-prompt with `!opus-force:`. |
| **Adversarial expert panel** | Novel-architecture / migration / multi-option prompts (or an explicit "summon the panel") convene a panel of specialist agents that challenge each other before a synthesized plan is returned. |
| **Dispatch guard** | Enforces the dispatch pattern — heavy work is farmed out to subagents instead of being run directly in the expensive main loop. (Read-only inspection passes through; only mutations are gated.) |
| **Mutation guard** | Blocks direct file mutation from the main loop on non-trivial turns, steering edits through reviewed subagents. |
| **Safety gate** | Blocks genuinely dangerous shell commands (`rm -rf /`, `curl … \| bash`, `DROP TABLE`, force-push) while allowing routine ones (`rm -rf ./build`). Scans a de-quoted view so a dangerous token merely *mentioned* in a commit message or data doesn't trip it. |
| **Project-master memory** | Each project gets a `master-<slug>` agent whose `MEMORY.md` router carries forward recent decisions, lessons, and a session log — auto-injected at the start of every subagent so work resumes already informed. |
| **Two-mode session memory** | If the optional `claude-mem` tier is present it owns ambient capture; otherwise PRISM's native nudge + `/prism-clean` fold keeps a durable record. Nothing is lost either way. |
| **Cross-project knowledge index** | An opt-in, offline BM25 + re-rank index over your adjudications / lessons / plans, queryable with `/prism-recall --cross-project`. |
| **Python venv discipline** | For Python projects, bootstrap provisions a project-root `.venv` and records a rule to run Python under it (no system Python). |
| **pwagent (optional)** | A bundled Playwright CLI that keeps a Chromium alive across calls for on-demand DOM / text / a11y-snapshot / screenshot / network dumps. Self-provisions its own isolated venv on first run. See the FAQ. |
| **Research-backed agent factory** | When a real domain specialist is needed, the factory **researches** it (free, via NotebookLM) into a grounded expert — not a generic persona — then registers it in the roster and reuses it across sessions. `/prism-roster` and `/prism-retire` manage the talent pool. |
| **Expert skill toolkit** | Each expert can distil its method into reusable, versioned **skills** (`SKILL.md`) that the master equips to cheaper workers. The toolkit compounds across sessions; if a needed skill is missing, the factory's `--skill-research` finds the best existing one before authoring custom. |
| **Knowledge-growth loop** | The master **recalls** what the project already knows before designing, and **archives** decisions/lessons after — so each session starts smarter than the last, not from zero. |

---

## How PRISM orchestrates complex work

PRISM treats your session like a small, disciplined engineering org with one lead and a bench of specialists. When a task is more than a quick edit, this is what happens under the hood:

1. **One dispatcher.** Only the session lead (the project-master / main loop) can spawn work — dispatched subagents **cannot** spawn their own (the capability is stripped at runtime, and enforced). This keeps the expensive top-level context lean and makes the flow predictable: experts advise, the lead delegates.
2. **Reuse before build.** Before creating anything, the lead checks a **tools-registry**: if an existing tool, skill, or rostered agent already fits the step, it's used directly — no agent is spawned for work a script or an existing specialist can do.
3. **Hire a researched expert when needed.** If genuine domain expertise is missing, the **agent-factory researches** a specialist (free, via NotebookLM) and registers it. The expert is grounded in real sources, not vibes, and persists in the roster for next time.
4. **Experts contribute method + judgment, not hands.** A specialist returns a **rubric / worker-spec / skill** (and, if needed, authors a reusable `SKILL.md`). The lead then **equips cheaper workers** (haiku/sonnet) with that skill and **fans them out** — one per page / file / data-slice — in parallel.
5. **Fan-out → consolidate → adjudicate.** Workers run concurrently, each writing a scoped report; the lead **merges** them; the expert **adjudicates** the consolidated result and handles the edge cases. The opus-grade brain spends its tokens on *judgment*, not mechanical fetching or repetitive scoring.
6. **High-stakes work gets challenged first.** Novel-architecture / migration / multi-option decisions convene an **adversarial panel** (≥2 substantive challenges) before any plan is synthesized.
7. **The project gets smarter.** Decisions, lessons, and the catch-up router are **recalled before** design and **archived after** — knowledge compounds across sessions instead of evaporating on `/clear`.

The net effect: the right model on every step, expertise that's researched once and reused, and parallelism where it pays — with the expensive lead reserved for the decisions only it should make.

---

## Command reference

Run `/prism-help` in-session for the live index. Commands are grouped by **when you reach for them**.

### 🚀 Onboarding — run when setting PRISM up on a project (or a new machine)

| Command | What it does | Key flags |
|---|---|---|
| `/prism-bootstrap` | **The one command to start.** Runs the full 7-phase init on a new or freshly-cloned project — identity, scaffold (+ `.venv` for Python), discovery, roster, project-master, health. Idempotent; safe to re-run. (For Python projects it asks once whether to create a `.venv`.) | `--dry-run`, `--force`, `--skip-discover`, `--no-master`, `--no-telemetry` |
| `/prism-deep-dive` | Create or refresh the per-project `master-<slug>` agent. Bootstrap creates it by default; run directly to `--refresh` its memory or `--upgrade` its body after big changes. | `--refresh`, `--upgrade <slug>` |
| `/prism-recommend` | After bootstrap, see which optional external tools actually fit this project's stack (fit-scored). | `--check`, `--re-check <tool>`, `--include-optional` |
| `/prism-deps` | On a fresh machine, find and install optional dependencies (ffmpeg, playwright, `gh`, `jq`, …). | `--check`, `--list` |
| `/prism-help` | Don't know which command to run? The curated, by-workflow index. | — |

### 🔁 Daily — your everyday loop

> Tier routing, the panel, the guards, and memory injection are **automatic** — no command needed. These are the few you actively run.

| Command | What it does | Key flags |
|---|---|---|
| `/prism-recall <query>` | Ask anything PRISM has learned: *"what was the decision on the auth middleware?"*, *"total spend today?"*. Auto-routes between semantic, session-state, and metrics tiers. | `--cross-project`, `--json`, `--verbose`, `--tier 1\|2\|3`, `--no-rerank` |
| `/prism-clean` | **Run before `/clear` or at session end.** Applies a 5-level importance classifier and writes durable adjudications/lessons/smoke docs, folding a one-line summary into the project-master memory. | `--allow-l5-skip` |
| `/prism-sync` | After significant changes (or weekly): refresh discovery references, reconcile the roster, and re-check health. | `--smart-drift` |
| `!opus-force:` *(prefix, not a command)* | Prepend to any prompt to force the `opus` tier for that one turn (e.g. `!opus-force: just give me a one-liner`). | — |

### 🛠 Maintenance — periodic upkeep & when something feels off

| Command | What it does | Key flags |
|---|---|---|
| `/prism-health` | First stop when onboarding a new machine or post-upgrade: confirm core install, roster, tools, and dependencies are green. | `--quick`, `--tools`, `--agents`, `--project` |
| `/prism-doctor` | When routing/guards *feel* wrong — symptom-driven diagnostic that proposes exactly one fix per finding and confirms before applying. | — |
| `/prism-audit` | Fast pre-commit hygiene/security scan of PRISM's own config surfaces (secrets, YAML integrity, roster, hook syntax). | `--fix`, `--quick`, `--severity high` |
| `/prism-audit-full` | Before tagging a release or after adding a hook — deep end-to-end audit that exercises every hook path and produces a timing/coverage report. | (interactive) |
| `/prism-validate-plugins` | After installing/updating any plugin, catch broken hooks, missing manifests, and skill-name conflicts (report-only). | — |
| `/prism-update` | Keep the model matrix, registries, and agent bodies current on a ~15-day cadence. | — |
| `/prism-index` | After installing a new plugin/MCP, populate the roster's skills/tools blocks so the orchestrator sees real specialists. | `--enrich`, `--dry-run`, `--skills-only` |
| `/prism-roster` | Inspect the talent pool; `--reconcile` registers agent files created outside the factory. | `--by-domain`, `--team <id>`, `--reconcile` |
| `/prism-retire @agent` | Cleanly archive a stale or wrong specialist — removes its directory and roster entry atomically. | — |
| `/prism-archive @agent` | Consolidate a specialist's accumulated research notes into one RAG-queryable document. | `--list`, `--threshold N`, `--cleanup` |
| `/prism-app-expert <app>` | Before a UI/screenshot/video task, create a Playwright-driven specialist that knows one running app as a power user. *(For a code/domain expert, ask the project-master to spin up `@agent-factory` instead.)* | `--update`, `--list` |
| `/prism-telemetry` | Enable local routing/cost telemetry, inspect tier distribution and guard fire-rates, or export an anonymized rollup. **No network.** | `--opt-in`, `--opt-out`, `--status`, `--aggregate`, `--export <path>` |
| `/prism-uninstall-cleanup` | Before removing PRISM-as-plugin, clear agents that were factory-created under the plugin. | `--dry-run`, `--mode=remove-all\|keep-all` |

---

## FAQ

**Does PRISM cost money, call home, or send my code anywhere?**
No. The core is deterministic Node hooks + JSON manifests that run locally — no network calls, no API keys, no accounts. Telemetry is **opt-in and local-only** (`/prism-telemetry`); nothing is transmitted. PRISM influences *which model tier* your existing coding CLI uses; it doesn't make model calls itself.

**Do I need any API keys?**
No. PRISM rides on top of whatever agentic CLI you already use (`claude`). The optional cross-project research tier can use `notebooklm`/`gh` if present, but the core needs neither.

**It routed my prompt to the wrong tier / I want a fuller answer.**
Prefix the prompt with `!opus-force:` to force the top tier for that one turn. The classifier also self-corrects on genuinely complex work; the prefix is the manual override.

**A guard is blocking something I want to do.**
Guards *steer*, they don't trap. The usual fix is to do what the guard suggests — dispatch the work to a subagent (that's the intended, cheaper pattern). Read-only inspection (Read/Grep/Glob) is never blocked. If you need to bypass one deliberately, each has an env off-switch, e.g. `PRISM_DISPATCH_GUARD=off`, `PRISM_MUTATION_GUARD=off`, `PRISM_DISABLE_PREPUSH_NUDGE=1` — set it and restart the session.

**Does it work on Windows?**
Yes — PRISM is **Windows-first** (PowerShell + Git Bash both supported) and also runs on macOS/Linux. File writes go through clean UTF-8 (no BOM); the safety gate is target-aware for Windows paths.

**My project suddenly has a `.venv` — what is that?**
For Python projects, `/prism-bootstrap` creates a project-root `.venv` and adds an operating rule to run Python under it (never system Python). On an empty folder it asks first; answer `--no-python` (or decline) for non-Python projects and it won't create one.

**What is `pwagent`?**
An optional Playwright CLI bundled with PRISM. It keeps a headed/headless Chromium alive across CLI calls so you can dump a page's DOM, visible text, accessibility tree, network, or a screenshot on demand (`pwagent open <url>`, `pwagent dom`, `pwagent screenshot`, …). It ships as source and **self-provisions its own isolated venv + Chromium on first run**. Enable it with:
```bash
node tools/prism-installer.mjs setup-pwagent --with-pwagent
```
(That adds it to your PATH and warms it. Requires Python 3.12.) It is independent of your project's `.venv`.

**How do I update PRISM itself?**
`node tools/prism-installer.mjs update` upgrades the install in place (idempotent; backs up first). Separately, `/prism-update` refreshes the model matrix, registries, and agent bodies on a ~15-day cadence.

**Something feels broken / off.**
Run `/prism-health` for a wiring report, then `/prism-doctor` for a symptom-driven diagnostic that proposes one fix per finding (and confirms before applying anything).

**Does PRISM overwrite my `CLAUDE.md` / settings / agents?**
No. The installer backs up and *merges* — it preserves your roster agents, policy, and telemetry logs. `/prism-bootstrap` appends its operating-rules section if absent and never reorders your existing content.

**How do I remove it?**
See [UNINSTALL.md](UNINSTALL.md). Quick path: `bash scripts/uninstall.sh --purge` (or `.\scripts\uninstall.ps1 -Purge`). If you ran PRISM as a plugin, run `/prism-uninstall-cleanup` first.

---

## Architecture at a glance

- **Hooks** (`~/.claude/hooks/*.mjs`) — deterministic Node scripts wired to session events: a tier router on every prompt, guards on tool calls (dispatch / mutation / safety / parallel / config), and lifecycle capture on session start/stop.
- **Skills** — the orchestration protocol (`master-orchestrator`), planning, recall, discovery, and the project lifecycle commands.
- **Agents** — a reusable roster of specialists plus the per-project `master-<slug>`.
- **Tools** (`tools/*.mjs`) — the deterministic engines behind the commands (bootstrap state machine, installer, knowledge indexer, recall, telemetry aggregation), plus the bundled `pwagent` Playwright CLI.
- **State** — per-project under `.claude/`, machine-global under `~/.claude/`. JSON manifests, no database.

---

## Layout

```
~/.claude/
  hooks/            # the guards + router + lifecycle hooks
  skills/           # orchestration + command skills
  agents/           # global specialist roster
  tools/            # deterministic command engines (+ tools/pwagent/)
  commands/         # slash-command definitions

<your-project>/
  CLAUDE.md         # operating rules
  .venv/            # Python projects: project-root virtualenv
  .claude/
    agents/         # master-<slug> + MEMORY.md router
    references/     # discovery output (codebase/API map)
  docs/prism/       # adjudications, lessons, plans, smoke docs
  tasks/            # todo + lessons logs
```

---

## Contributing

Issues and PRs welcome at https://github.com/vosser24/prism_master. Before submitting, run the test suite (`tests/v3/state/*.mjs` + `node tools/prism-audit-runner.mjs`) and ensure all assertions pass.

## License

See the repository for license details.
