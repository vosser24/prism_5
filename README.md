# PRISM — Cognitive-tier orchestration for Claude Code

> **30-second pitch**: PRISM makes Claude Code self-aware about task complexity, automatically routing work to the cheapest viable model tier (Haiku/Sonnet/Opus) and enforcing dispatch discipline through 17 hooks. Closes the gap between "Claude Code as smart assistant" and "Claude Code as a cost-disciplined orchestration framework".

## What it solves

Three pain points specific to heavy Claude Code users:

1. **Over-spending on simple work.** Opus on a typo fix costs ~30× what Haiku would. PRISM classifies every prompt and routes accordingly.
2. **Sequential dispatch on parallel-safe work.** A 3-task scan that should finish in 30s takes 3 minutes if dispatched serially. PRISM's `[pgroup=N]` annotation is enforced at execution time (v3.1+).
3. **Hallucinated specialists.** When you have `ui-ux-pro-max` installed, the orchestrator should use it — not invent "Rachel the UX designer". PRISM's resource-index makes installed tools authoritative.

## Three concrete use cases

**Cost discipline** — Run `PRISM_MODEL_GUARD=hard` and PRISM denies any opus dispatch lacking explicit `model` declaration. Sonnet/Haiku stay advisory. (v2.9.1+)

**Parallel orchestration** — `/prism-plan` produces tasks tagged `[pgroup=1]`; v3.1's `prism-parallel-guard` blocks sequential dispatch of pgroup-tagged tasks, forcing batched parallel `Agent()` calls.

**Specialist dispatch** — `/prism-index` populates a unified roster of installed agents/skills/tools/MCPs. `blueprint-prompt` queries the index BEFORE assembling a panel, so real specialists replace generic personas.

## Install

PRISM ships as a first-class Claude Code plugin (v3.5.0+). Two install paths — pick one.

### Recommended: plugin install (one-liner inside Claude Code)

```text
/plugin marketplace add vosser24/prism_master
/plugin install prism@PRISM
```

Then run `/reload-plugins` to activate. Hooks, skills, commands, and agents are namespaced under the plugin (e.g. `/prism:prism-plan`) and registered automatically — no `settings.fragment.json` merge, no manual file copy. To update later: `/plugin update prism@PRISM`. To remove: `/plugin uninstall prism@PRISM`.

> **Note**: Until PRISM is listed on the official Anthropic marketplace, the `marketplace add` step above pulls the plugin manifest from this repo's `.claude-plugin/plugin.json`. Once accepted into `claude-plugins-official`, the install becomes a single `/plugin install prism@claude-plugins-official`.

### Alternative: clone + install script

```bash
curl -sSL https://raw.githubusercontent.com/vosser24/prism_master/main/scripts/install.sh | bash
```

(Or clone manually — see [Manual install](#manual-install) below.) The clone path remains supported for users who want full control, are developing PRISM itself, or need the post-install scaffolding the plugin install cannot perform (see CHANGELOG v3.5.0 limitations).

## Status — works / half-works / known-gaps (v4.0.0)

| Journey | State | Notes |
|---|---|---|
| Install / upgrade | ✅ Works | Idempotent, backup-first |
| Tier classification | ✅ Works | Keyword-floor regex + conversation-model self-override |
| Mutation guard | ✅ Works | Hard-block on parent-context writes |
| Parent-dispatch guard | ✅ Works | Hard-block on novel-tier turns |
| Parallel-dispatch guard | ✅ Works | Closes T10.3 gap |
| Panel-hallucination guard | ✅ Works | Closes DOCTRINE-DRIFT-001 |
| Skill-trigger guard | ✅ Works (advisory) | Closes T13.4 gap |
| Resource-index | ✅ Works | Run `/prism-index` to populate |
| Centrally-managed policy | ✅ Works | `~/.claude/prism-policy.json` |
| Team roster | ✅ Works (file-based) | `--team` filter on `/prism-roster` |
| Telemetry | ⚠ Local-only | No SaaS yet; export-to-JSON |
| `/prism-bootstrap` 7-phase state machine (v3.11.0) | ✅ Works | Idempotent; detect-and-adopt back-fills v3.8.9 installs |
| `/prism-sync` conservative drift (v3.11.0) | ✅ Works | Always re-scans; `--smart-drift` stub until v3.12.0 |
| `/prism-clean` 5-level importance classifier (v3.11.0) | ✅ Works | Wired to `append-decision` + `append-lesson` in v4.0 |
| `/prism-validate-plugins` (v3.11.0) | ✅ Works (report-only) | `--fix` deferred to v3.12.0 |
| `/prism-deep-dive` + `master-<slug>` (v4.0) | ✅ Works | Opt-in via `/prism-bootstrap --with-deep-dive` or direct |
| `master-orchestrator` as skill (v4.0) | ✅ Works | Skill body at `~/.claude/skills/master-orchestrator/`; agent file is thin wrapper |
| PHASE 1.5 tightened evidence rules (v4.0) | ✅ Works | EVIDENCED/UN-CITED/REJECTED verdicts + bounce-ONCE + factory-upgrade at ≥3 UN-CITED |
| `SessionEnd[clear]` + `PreCompact` nudge hooks | ⏸ Deferred to v4.1 | Hook API incompatibility (D005); flag-file + SessionStart pattern in v4.1 |
| User hook customization preservation | ❌ Not yet | v4.1+ |
| Tested on macOS native | ❌ Not yet | Linux + Windows tested |

See `tests/v3/plan.md` for the comprehensive user-journey test grid and
`docs/prism/MIGRATION.md` for the v3.x → v4.0 upgrade recipe.

## Architecture at a glance

- 17 hooks in `~/.claude/hooks/`: classifier router, 7 enforcement guards, lifecycle (session-start/end, subagent-stop), 4 advisory hooks, agent-write auto-fire registrar (v3.11.0)
- PRISM-owned skills in `~/.claude/skills/`: `prism-plan`, `blueprint-prompt`, `prism-discover`, `prism-chat`, `prism-clean`, `prism-validate-plugins`, `master-orchestrator` (Phase E migration target — skill body for orchestration protocol)
- Core agents: `@master-orchestrator` (thin wrapper that loads the skill), `@agent-factory`, `@prism-updater`. v4.0 adds per-project `master-<slug>` agents generated by `/prism-deep-dive`.
- 20 slash commands. Entry points by workflow:
  - **Daily:** `/prism-bootstrap`, `/prism-sync`, `/prism-clean`, `/prism-recall`
  - **Project-master (v4.0):** `/prism-deep-dive`
  - **Agent management:** `/prism-app-expert`, `/prism-roster`, `/prism-retire`, `/prism-recommend`
  - **Validation:** `/prism-validate-plugins`, `/prism-audit`, `/prism-audit-full`, `/prism-doctor`, `/prism-deps`
  - **Knowledge:** `/prism-archive`, `/prism-index`, `/prism-telemetry`
  - **Lifecycle:** `/prism-update`, `/prism-help` (curated index)
  - Subsumed by `/prism-bootstrap` (still callable): `/prism-init`, `/prism-discover`, `/prism-roster --reconcile`, `/prism-health`
- Single source of truth: `~/.claude/skills/prism-plan/references/roster.json` (4 sibling blocks: agents/skills/tools/mcps + index_meta)
- Project state: `<project>/.claude/.prism-state.json` (schema v2; 7 phases; sentinels). Migrates transparently from v1.

## Documentation

- [INSTALL.md](INSTALL.md) — authoritative install procedure
- [CHANGELOG.md](CHANGELOG.md) — version history (latest: v4.0.0)
- [docs/prism/MIGRATION.md](docs/prism/MIGRATION.md) — v3.x → v4.0 upgrade recipe with rollback
- `/prism-help` (in Claude Code) — curated v4.0 slash-command index
- [docs/prism/adjudications/](docs/prism/adjudications/) — locked design adjudications (D001–D006)
- [tests/v3/plan.md](tests/v3/plan.md) — user-journey test grid
- [tests/v3/run-claude.md](tests/v3/run-claude.md) — manual prompt pack

## What you get

- **Hooks** that make Claude Code self-aware: session start/stop, tool-use safety guards, agent model guards, context-tax audits, subagent tracking, agent-write auto-registrar (v3.11.0).
- **Tools** for KB indexing, routing, classification, notebook sync, test harness, monitor, migrations, bootstrap state machine, sync, clean, plugin audit, deep-dive scaffolding.
- **Agents** — `@master-orchestrator` (skill-loading thin wrapper), `@agent-factory`, `@prism-updater`, and per-project `master-<slug>` agents (v4.0).
- **Skills** — `prism-plan`, `prism-chat`, `blueprint-prompt`, `prism-discover`, `prism-clean`, `prism-validate-plugins`, `master-orchestrator` (Phase E — multi-step orchestration protocol body), and more.
- **Statusline** — multi-line status bar with model, git, cost, context bar, rate limits, subagent breakdown. Opt-in install via `/prism-bootstrap` (v4.0).
- **Commands** — see `/prism-help` (v4.0) for the curated by-workflow index. Run `/prism-bootstrap` first on any new project; everything else is reachable from there.

## Manual install

### Install (fresh machine)

In Claude Code, open any project and say:

> Clone https://github.com/vosser24/prism_master into a temp folder, read INSTALL.md, and follow it exactly.

Claude will clone the repo, back up your existing `~/.claude/`, copy files per `manifest.json`, merge `settings.fragment.json` into your `settings.json`, build the KB index, and verify. All steps are idempotent — safe to re-run.

### Update an existing install

Same prompt. Claude will `git pull`, re-run the procedure — unchanged files are skipped.

### Run it yourself

If you'd rather run it yourself:

```bash
git clone https://github.com/vosser24/prism_master.git
cd PRISM
# Read INSTALL.md and follow steps 0-8 manually.
```

### Layout

```
PRISM/
├── INSTALL.md                 # procedure Claude follows
├── manifest.json              # file-to-destination mapping
├── settings.fragment.json     # JSON fragment to merge into ~/.claude/settings.json
├── scripts/verify.mjs         # post-install self-test
├── statusline-command.sh      # the Claude Code statusline
├── hooks/                     # SessionStart, PreToolUse, PostToolUse, etc.
├── tools/                     # PRISM KB, routing, monitor, tests, migrations
├── agents/                    # master-orchestrator, agent-factory, prism-updater
├── commands/                  # /prism-* slash commands
├── skills/                    # prism-plan, prism-discover, blueprint-prompt, ...
└── plans/                     # reference planning docs
```

### Uninstall

Claude will restore your most recent `~/.claude/backups/pre-prism-<timestamp>/` on request.

### Requirements

- `node` >= 18
- `python` >= 3.10
- `git`
- Optional: `notebooklm` CLI (for KB cloud search), `gh` CLI

## Uninstall

**bash (Linux / macOS / Git Bash on Windows):**
```bash
bash scripts/uninstall.sh           # DRY-RUN (default — safe preview)
bash scripts/uninstall.sh --purge   # actually remove PRISM
```

**PowerShell-native (Windows, no Git Bash needed) — v3.4+:**
```powershell
.\scripts\uninstall.ps1             # DRY-RUN (default — safe preview)
.\scripts\uninstall.ps1 -Purge      # actually remove PRISM
```

See [UNINSTALL.md](UNINSTALL.md) for the tiered procedure (transient state → full uninstall → reinstall chain), recovery from accidental purge, and flag reference.

## Contributing

Issues and PRs welcome at https://github.com/vosser24/prism_master. Before submitting, run `tests/v3/run-static.sh` and ensure all assertions pass (76/76 as of v3.3.0).

## Standalone statusLine (no full PRISM install)

Single-line install on Linux/Mac/Git-Bash:
```bash
curl -fsSL https://raw.githubusercontent.com/vosser24/prism_master/main/scripts/install-statusline-only.sh | bash
```

Single-line install on Windows PowerShell:
```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/vosser24/prism_master/main/scripts/install-statusline-only.ps1 | iex
```

Requires: node + curl (bash) / Invoke-WebRequest (PS, built-in).

## License

See repository for license details.
