# Uninstalling PRISM

## Plugin install — one-liner (v3.5.0+)

If you installed PRISM via `/plugin install prism@PRISM`, removing it is symmetric:

```text
/plugin uninstall prism@PRISM
```

Claude Code drops the plugin from your enabled list, removes the cache directory under `~/.claude/plugins/cache/`, and unregisters all hooks, skills, commands, and agents PRISM declared in `plugin.json`. Pass `--keep-data` if you want to preserve any state PRISM stored under `${CLAUDE_PLUGIN_DATA}` (e.g., for a fresh reinstall later). After uninstall, run `/reload-plugins` to drop hook registrations from the running session.

> **Note**: PRISM-specific transient state files (`~/.claude/.prism-turn-tier-*.json`, `.prism-routing.jsonl`, etc.) live outside `${CLAUDE_PLUGIN_DATA}` because they predate the plugin packaging. To clean those, run the Tier 1 commands below.

---

## Manual install — automated uninstaller

The sections below cover users who installed PRISM via the legacy clone-and-script path. PRISM ships an automated uninstaller. Three usage levels depending on how deep you want to go.

## Tier 1 — Just clean stale state (fixes 90% of "stale file" issues)

```bash
rm -f ~/.claude/.prism-turn-tier-*.json \
      ~/.claude/.prism-routing.jsonl \
      ~/.claude/.prism-tier-cache.json \
      ~/.claude/.prism-memory-save-counter-*.json \
      ~/.claude/.prism-context-audit.{json,last} \
      ~/.claude/.prism-parallel-trace-*.json \
      ~/.claude/.prism-skill-trigger-*.json \
      ~/.claude/.prism-v2.9.1-migration-shown
```

Restart Claude Code. Reinstallation NOT needed.

## Tier 2 — Full uninstall (preserves Claude Code + your custom agents + global CLAUDE.md)

**bash (Linux / macOS / Git Bash on Windows):**
```bash
cd /path/to/PRISM
bash scripts/uninstall.sh                      # DRY-RUN (default — safe)
bash scripts/uninstall.sh --purge              # actually delete
```

**PowerShell-native (Windows, no Git Bash needed) — v3.4+:**
```powershell
cd C:\path\to\PRISM
.\scripts\uninstall.ps1                        # DRY-RUN (default — safe)
.\scripts\uninstall.ps1 -Purge                 # actually delete
```

The script:
- Removes 16 PRISM-owned hooks + 14 commands + 8 skill directories + 3 core agents (by exact name) + tools + statusline.
- Edits `~/.claude/settings.json` to remove only PRISM hook entries. User/plugin entries, MCP servers, permissions are preserved.
- Backs up the entire `~/.claude/` tree to `~/.claude/backups/pre-uninstall-<ts>/` before any deletion (skip with `--no-backup`).

**Preserved:**
- `~/.claude/agents/<your-specialists>/` — your custom agents
- `~/.claude/CLAUDE.md` — your global instructions
- `~/.claude/skills/<non-PRISM>/` — installed plugin skills
- `~/.claude/.claude.json` `mcpServers` — your MCP config
- `~/.claude/backups/` — safety net intact

## Tier 3 — Reinstall in one command

**bash:**
```bash
bash scripts/uninstall.sh --purge --reinstall /path/to/PRISM
```

**PowerShell:**
```powershell
.\scripts\uninstall.ps1 -Purge -Reinstall C:\path\to\PRISM
```

Does the full uninstall and chains immediately into a fresh install. Useful for upgrading from a corrupted state, or testing that PRISM still installs cleanly on your machine.

## Recover from accidental `--purge`

If you ran `--purge` and want it back:

```bash
LATEST=$(ls -1td ~/.claude/backups/pre-uninstall-* | head -1)
cp -pr "$LATEST"/* ~/.claude/
```

The pre-uninstall backup is created automatically unless `--no-backup` was passed.

## Flag reference

| Flag | Effect |
|---|---|
| (no flag) | **DRY-RUN** — print what would be deleted, mutate nothing. Default for safety. |
| `--purge` | Required to actually delete. Inverted default vs install.sh. |
| `--keep-memory` | Preserve `.prism-sessions/` and `.prism-rollups/` |
| `--no-backup` | Skip pre-uninstall backup (NOT recommended) |
| `--reinstall <path>` | Chain into install.sh from given repo path after uninstall |
| `--help` | Print usage |

## When to use which approach

| Symptom | Approach |
|---|---|
| Stale guard behavior, sentinel issues | Tier 1 (state cleanup commands above) |
| Want to test fresh install end-to-end | `uninstall.sh --purge --reinstall <path>` |
| Removing PRISM permanently | `uninstall.sh --purge` |
| Wipe everything (`~/.claude/`) | Manual `mv ~/.claude ~/.claude.old-$(date +%s)` then reinstall |

**Don't reinstall Claude Code itself** unless you suspect Claude Code's binary or core config is corrupt. PRISM lives in `~/.claude/`, which is independent of Claude Code's binary install location.

## Verifying a clean uninstall

After running `--purge`:

```bash
ls ~/.claude/hooks/prism-*.mjs 2>/dev/null               # expect: empty
ls ~/.claude/commands/prism-*.md 2>/dev/null             # expect: empty
ls ~/.claude/agents/master-orchestrator.md 2>/dev/null   # expect: empty
grep -c prism-exec ~/.claude/settings.json               # expect: 0
```

All four should report no PRISM remnants.
