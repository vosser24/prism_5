# PRISM — Cognitive-tier orchestration for Claude Code

> **30-second pitch**: PRISM makes Claude Code self-aware about task complexity, automatically routing work to the cheapest viable model tier (Haiku/Sonnet/Opus) and enforcing dispatch discipline through 16 hooks. Closes the gap between "Claude Code as smart assistant" and "Claude Code as a cost-disciplined orchestration framework".

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
/plugin marketplace add vosser24/PRISM
/plugin install prism@PRISM
```

Then run `/reload-plugins` to activate. Hooks, skills, commands, and agents are namespaced under the plugin (e.g. `/prism:prism-plan`) and registered automatically — no `settings.fragment.json` merge, no manual file copy. To update later: `/plugin update prism@PRISM`. To remove: `/plugin uninstall prism@PRISM`.

> **Note**: Until PRISM is listed on the official Anthropic marketplace, the `marketplace add` step above pulls the plugin manifest from this repo's `.claude-plugin/plugin.json`. Once accepted into `claude-plugins-official`, the install becomes a single `/plugin install prism@claude-plugins-official`.

### Alternative: clone + install script

```bash
curl -sSL https://raw.githubusercontent.com/vosser24/PRISM/main/scripts/install.sh | bash
```

(Or clone manually — see [Manual install](#manual-install) below.) The clone path remains supported for users who want full control, are developing PRISM itself, or need the post-install scaffolding the plugin install cannot perform (see CHANGELOG v3.5.0 limitations).

## Status — works / half-works / known-gaps (v3.1.0)

| Journey | State | Notes |
|---|---|---|
| Install / upgrade | ✅ Works | Idempotent, backup-first |
| Tier classification | ✅ Works | Keyword-floor regex + conversation-model self-override (v3.2.0) |
| Mutation guard | ✅ Works | Hard-block on parent-context writes |
| Parent-dispatch guard | ✅ Works | Hard-block on novel-tier turns |
| Parallel-dispatch guard (v3.1) | ✅ Works | Closes T10.3 gap |
| Panel-hallucination guard (v3.1) | ✅ Works | Closes DOCTRINE-DRIFT-001 |
| Skill-trigger guard (v3.1) | ✅ Works (advisory) | Closes T13.4 gap |
| Resource-index | ✅ Works | Run `/prism-index` to populate |
| Centrally-managed policy (v3.1) | ✅ Works | `~/.claude/prism-policy.json` |
| Team roster (v3.1) | ✅ Works (file-based) | `--team` filter on /prism-roster |
| Telemetry (v3.1) | ⚠ Local-only | No SaaS yet; export-to-JSON |
| User hook customization preservation | ❌ Not yet | v3.2 target |
| Schema-version reader checks | ❌ Not yet | v3.2 target |
| Tested on macOS native | ❌ Not yet | Linux + Windows tested |

See `tests/v3/plan.md` for the comprehensive 62-test journey grid.

## Architecture at a glance

- 16 hooks in `~/.claude/hooks/`: classifier router, 7 enforcement guards, lifecycle (session-start/end, subagent-stop), 4 advisory hooks
- 8 PRISM-owned skills in `~/.claude/skills/`: prism-plan, blueprint-prompt, workflow-orchestration, prism-discover, prism-chat, claude-code-expert, notebooklm, video-production
- 3 core agents: `@master-orchestrator`, `@agent-factory`, `@prism-updater`
- 13 slash commands: `/prism-plan`, `/prism-index`, `/prism-doctor`, `/prism-roster`, `/prism-update`, `/prism-health`, `/prism-audit`, `/prism-recommend`, `/prism-recall`, `/prism-app-expert`, `/prism-archive`, `/prism-retire`, `/prism-deps`, `/prism-telemetry`
- Single source of truth: `~/.claude/skills/prism-plan/references/roster.json` (4 sibling blocks: agents/skills/tools/mcps + index_meta)

## Documentation

- [INSTALL.md](INSTALL.md) — authoritative install procedure
- [CHANGELOG.md](CHANGELOG.md) — version history
- [tests/v3/plan.md](tests/v3/plan.md) — user-journey test grid
- [tests/v3/run-claude.md](tests/v3/run-claude.md) — manual prompt pack

## What you get

- **Hooks** that make Claude Code self-aware: session start/stop, tool-use safety guards, agent model guards, context-tax audits, subagent tracking.
- **Tools** for KB indexing, routing, classification, notebook sync, test harness, monitor, migrations.
- **Agents** — master orchestrator, agent factory, updater.
- **Skills** — `prism-plan`, `prism-discover`, `blueprint-prompt`, `claude-code-expert`, and more.
- **Statusline** — multi-line status bar with model, git, cost, context bar, rate limits, subagent breakdown.
- **Commands** — `/prism-plan`, `/prism-discover`, `/prism-audit`, `/prism-health`, `/prism-roster`, `/prism-update`, `/prism-recommend`, `/prism-retire`, `/prism-app-expert`, `/prism-archive`, `/prism-recall`, `/prism-init`.

## Manual install

### Install (fresh machine)

In Claude Code, open any project and say:

> Clone https://github.com/vosser24/PRISM into a temp folder, read INSTALL.md, and follow it exactly.

Claude will clone the repo, back up your existing `~/.claude/`, copy files per `manifest.json`, merge `settings.fragment.json` into your `settings.json`, build the KB index, and verify. All steps are idempotent — safe to re-run.

### Update an existing install

Same prompt. Claude will `git pull`, re-run the procedure — unchanged files are skipped.

### Run it yourself

If you'd rather run it yourself:

```bash
git clone https://github.com/vosser24/PRISM.git
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

Issues and PRs welcome at https://github.com/vosser24/PRISM. Before submitting, run `tests/v3/run-static.sh` and ensure all assertions pass (76/76 as of v3.3.0).

## Standalone statusLine (no full PRISM install)

Single-line install on Linux/Mac/Git-Bash:
```bash
curl -fsSL https://raw.githubusercontent.com/vosser24/PRISM/claude/audit-pending-pushes-Rg1p8/scripts/install-statusline-only.sh | bash
```

Single-line install on Windows PowerShell:
```powershell
iwr -UseBasicParsing https://raw.githubusercontent.com/vosser24/PRISM/claude/audit-pending-pushes-Rg1p8/scripts/install-statusline-only.ps1 | iex
```

Requires: node + curl (bash) / Invoke-WebRequest (PS, built-in).

## License

See repository for license details.
