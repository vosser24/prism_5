# PRISM

Framework for optimizing Claude Code. Modular install — clone, let Claude follow `INSTALL.md`, and you're done.

## What you get

- **Hooks** that make Claude Code self-aware: session start/stop, tool-use safety guards, agent model guards, context-tax audits, subagent tracking.
- **Tools** for KB indexing, routing, classification, notebook sync, test harness, monitor, migrations.
- **Agents** — master orchestrator, agent factory, updater.
- **Skills** — `prism-plan`, `prism-discover`, `blueprint-prompt`, `claude-code-expert`, and more.
- **Statusline** — multi-line status bar with model, git, cost, context bar, rate limits, subagent breakdown.
- **Commands** — `/prism-plan`, `/prism-discover`, `/prism-audit`, `/prism-health`, `/prism-roster`, `/prism-update`, `/prism-recommend`, `/prism-retire`, `/prism-app-expert`, `/prism-archive`, `/prism-recall`, `/prism-init`.

## Install (fresh machine)

In Claude Code, open any project and say:

> Clone https://github.com/vosser24/PRISM into a temp folder, read INSTALL.md, and follow it exactly.

Claude will clone the repo, back up your existing `~/.claude/`, copy files per `manifest.json`, merge `settings.fragment.json` into your `settings.json`, build the KB index, and verify. All steps are idempotent — safe to re-run.

## Update an existing install

Same prompt. Claude will `git pull`, re-run the procedure — unchanged files are skipped.

## Manual install

If you'd rather run it yourself:

```bash
git clone https://github.com/vosser24/PRISM.git
cd PRISM
# Read INSTALL.md and follow steps 0-8 manually.
```

## Layout

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

## Uninstall

Claude will restore your most recent `~/.claude/backups/pre-prism-<timestamp>/` on request.

## Requirements

- `node` >= 18
- `python` >= 3.10
- `git`
- Optional: `notebooklm` CLI (for KB cloud search), `gh` CLI
