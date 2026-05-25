---
name: 2026-05-25-dev-install-inventory
description: Files copied from prism_3 dev branch (claude/prism-v3-phase-1-0eVY1) to ~/.claude/ for Phase D Task 11 smoke + Phase E migration. Use for cleanup or re-sync.
metadata:
  type: project
---

# 2026-05-25 — Dev install inventory (Phase D smoke bridge + Phase E migration)

**Reason:** Branch `claude/prism-v3-phase-1-0eVY1` is local-only and the standard `scripts/install.ps1` clones from git origin. To run `/prism-bootstrap --with-deep-dive` from inside the `competition_agents/` testbed (Phase D Task 11) and to make Phase E's master-orchestrator skill loadable user-wide, we hand-copied the relevant dev-branch files to `~/.claude/`.

## Files copied (source → destination)

| Source (prism_3) | Destination (~/.claude/) | Added in |
|---|---|---|
| `tools/*.mjs` (21 files) | `tools/` | Phase D |
| `tools/lib/prism-state.mjs` + `tools/lib/prism-tier-classify.mjs` | `tools/lib/` | Phase D |
| `commands/prism-*.md` (20 files) | `commands/` | Phase D |
| `skills/prism-discover/` (full dir) | `skills/prism-discover/` | Phase D |
| `skills/prism-chat/` (full dir) | `skills/prism-chat/` | Phase D |
| `skills/prism-plan/` (full dir) | `skills/prism-plan/` | Phase D |
| `skills/blueprint-prompt/` (full dir) | `skills/blueprint-prompt/` | Phase D |
| `agents/agent-factory.md` | `agents/agent-factory.md` | Phase D |
| `skills/master-orchestrator/SKILL.md` | `skills/master-orchestrator/SKILL.md` | **Phase E** |
| `agents/master-orchestrator.md` (thin wrapper rewrite) | `agents/master-orchestrator.md` (overwrites prior) | **Phase E** |
| `tools/prism-deep-dive.mjs` (default flip + prose alignment) | `tools/prism-deep-dive.mjs` (overwrites prior) | **Phase E re-sync** |
| `commands/prism-deep-dive.md` (instruction update for new default) | `commands/prism-deep-dive.md` (overwrites prior) | **Phase E re-sync** |
| `tools/prism-clean.mjs` + `tools/prism-deep-dive.mjs` + `commands/prism-clean.md` + `commands/prism-deep-dive.md` (Phase H append-decision / append-lesson / agent-diff / --upgrade) | (already covered by bulk rows above; re-sync required) | **Phase H** |

## Cleanup commands (run AFTER smoke is captured + before re-installing from main)

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\tools
Remove-Item -Force $env:USERPROFILE\.claude\commands\prism-*.md
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\skills\prism-discover, $env:USERPROFILE\.claude\skills\prism-chat, $env:USERPROFILE\.claude\skills\prism-plan, $env:USERPROFILE\.claude\skills\blueprint-prompt, $env:USERPROFILE\.claude\skills\master-orchestrator
Remove-Item -Force $env:USERPROFILE\.claude\agents\agent-factory.md, $env:USERPROFILE\.claude\agents\master-orchestrator.md
```

**Note:** Removing `~/.claude/agents/master-orchestrator.md` only undoes the Phase E thin-wrapper version. If a properly-shipped master-orchestrator agent existed at user-level before any of this work, you'd need to restore it from `~/.claude/backups/` (the installer creates timestamped backups at install time).

## Alternative: re-sync from working tree

If iterating on Phase D / Phase E and you want the user-level copy to reflect the working tree, re-run the same `cp` block. Idempotent.

## When to fully uninstall vs re-install from main

- **After Phase D ships and lands on main:** `bash scripts/install.sh` or `.\scripts\install.ps1` deploys a proper versioned install. Run cleanup above first to avoid stale files from the dev branch lingering.
- **Pre-shipping (current state):** leave installed; useful for any further smoke or dog-food sessions.
