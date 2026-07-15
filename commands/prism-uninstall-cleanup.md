---
name: prism-uninstall-cleanup
description: Remove agents that were created while PRISM was installed as a plugin (entries tagged `installed_via: "plugin"` in roster.json). Safe pre-`/plugin remove` hygiene — never touches manually-created agents.
---

# /prism-uninstall-cleanup

Pre-uninstall hygiene for PRISM-as-plugin users.

When the agent-factory creates an agent while PRISM is installed via `/plugin install`, it tags the roster entry `installed_via: "plugin"`. This command finds those entries and offers to remove them — the agent directory, its flat `.md` file, and the roster entry — in one shot.

**Manually-created agents (`installed_via: "manual"`) and legacy entries (field missing) are NEVER touched.**

## When to run

Before `/plugin remove prism` (or before deleting `~/.claude/plugins/cache/.../prism/`). Running it after the plugin is removed will still work IF the user manually installed PRISM as well — but in a pure plugin-only setup, the slash command itself is gone after removal.

## What it does

1. Reads `~/.claude/skills/prism-plan/references/roster.json`.
2. Filters `roster.agents` to entries where `installed_via === "plugin"`.
3. If zero matches: prints `Nothing to clean up — no plugin-created agents found.` and exits.
4. Otherwise, presents the list with creation dates and prompts:

   ```
   PRISM-tagged agents detected (3 created while installed as plugin):
     • @nuclear-physicist (created 2026-04-12)
     • @db-migrator       (created 2026-05-01)
     • @react-expert      (created 2026-05-20)

   How would you like to clean these up?
     [a] Remove all
     [k] Keep all (cancel)
   >
   ```

5. On `[a]`: for each agent — `rm -rf ~/.claude/agents/<name>/`, delete `~/.claude/agents/<name>.md`, remove the roster entry. Roster write is atomic (tmp + rename).
6. Reports the count removed and reminds: `Run /plugin remove prism to finish uninstall.`

## Flags (for non-interactive use)

| Flag | Behavior |
|---|---|
| (none) | Lists plugin-tagged agents. Default safe behavior is list-only (never destructive). |
| `--dry-run` | Lists and exits 0. No writes. |
| `--mode=remove-all` | Non-interactive removal of every plugin-tagged agent. |
| `--mode=keep-all` | Non-interactive no-op. Exits 0. |

## Implementation

This command delegates to `node ~/.claude/tools/prism-uninstall-cleanup.mjs` (or `${CLAUDE_PLUGIN_ROOT}/tools/prism-uninstall-cleanup.mjs` under plugin install). For the interactive UX, the assistant reads the tool's `--dry-run` output, presents the list to the user, takes their choice, and runs the corresponding `--mode=...` invocation.

Exit codes: see the tool's header comment (`tools/prism-uninstall-cleanup.mjs`).
