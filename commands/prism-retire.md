---
name: prism-retire
description: Archive an unused PRISM agent
---

Usage: /prism-retire @agent-name

The dangerous part — archiving the agent dir AND removing its roster.json entry —
is done by the executable `tools/prism-retire.mjs`, NOT by hand-editing roster.json.
The tool guards against path traversal in the name, parses the roster BEFORE
touching any file (so a corrupt roster can't leave a half-archived agent), and
writes the roster under `withRosterLock` with an atomic tmp+rename. Do NOT edit
roster.json directly.

If @{name} is a PROJECT-scoped agent (lives under this project's
`.claude/agents/<name>.md` with its own `.claude/agents/roster.json`, rather
than the global `~/.claude/agents/`), pass `--project` on both the preview and
the real mutation below — there is no auto-guessing between scopes, so this
must be decided explicitly before running the command.

1. Preview (safe, read-only): run
   `node ~/.claude/tools/prism-retire.mjs @{name} --dry-run [--project]`
   and show the user what would be archived.
2. Confirm with user: "This will archive @{name}. It won't be loaded or appear
   in the roster. You can restore it later. Proceed?"
3. On confirmation, run the real mutation:
   `node ~/.claude/tools/prism-retire.mjs @{name} [--project]`
   (exit 0 = done; 3 = agent not found — if the miss message says it was found
   in the PROJECT roster instead, re-run with `--project`; 13 = roster
   missing/corrupt; 2 = bad name.)
   Relay the tool's "Archived @{name}. Restore with: …" output verbatim.
4. Update the CLAUDE.md agent count to reflect one fewer agent.
