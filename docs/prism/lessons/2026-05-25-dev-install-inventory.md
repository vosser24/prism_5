---
name: 2026-05-25-dev-install-inventory
description: Files copied from prism_3 dev branch (claude/prism-v3-phase-1-0eVY1) to ~/.claude/ for Phase D Task 11 smoke. Use for cleanup or re-sync.
metadata:
  type: project
---

# 2026-05-25 — Dev install inventory (Phase D Task 11 smoke bridge)

**Reason:** Branch `claude/prism-v3-phase-1-0eVY1` is local-only and the standard `scripts/install.ps1` clones from git origin. To run `/prism-bootstrap --with-deep-dive` from inside the `competition_agents/` testbed, we hand-copied the relevant dev-branch files to `~/.claude/`.

## Files copied (source → destination)

| Source (prism_3) | Destination (~/.claude/) |
|---|---|
| `tools/*.mjs` (21 files) | `tools/` |
| `tools/lib/prism-state.mjs` + `tools/lib/prism-tier-classify.mjs` | `tools/lib/` |
| `commands/prism-*.md` (20 files) | `commands/` |
| `skills/prism-discover/` (full dir) | `skills/prism-discover/` |
| `skills/prism-chat/` (full dir) | `skills/prism-chat/` |
| `skills/prism-plan/` (full dir) | `skills/prism-plan/` |
| `skills/blueprint-prompt/` (full dir) | `skills/blueprint-prompt/` |
| `agents/agent-factory.md` | `agents/agent-factory.md` |

## Cleanup commands (run AFTER smoke is captured + before re-installing from main)

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\tools
Remove-Item -Force $env:USERPROFILE\.claude\commands\prism-*.md
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\skills\prism-discover, $env:USERPROFILE\.claude\skills\prism-chat, $env:USERPROFILE\.claude\skills\prism-plan, $env:USERPROFILE\.claude\skills\blueprint-prompt
Remove-Item -Force $env:USERPROFILE\.claude\agents\agent-factory.md
```

## Alternative: re-sync from working tree

If iterating on Phase D / Phase E and you want the user-level copy to reflect the working tree, re-run the same `cp` block. Idempotent.

## When to fully uninstall vs re-install from main

- **After Phase D ships and lands on main:** `bash scripts/install.sh` or `.\scripts\install.ps1` deploys a proper versioned install. Run cleanup above first to avoid stale files from the dev branch lingering.
- **Pre-shipping (current state):** leave installed; useful for any further smoke or dog-food sessions.
