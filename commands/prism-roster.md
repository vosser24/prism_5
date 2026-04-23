---
name: prism-roster
description: Display and manage the PRISM agent talent pool
---

Read ~/.claude/skills/prism-plan/references/roster.json

Display table: Agent | Version | Domains | Tasks | Corrections | Status | Last Used

If agents have pending_upgrade: true, suggest running upgrades.
If agents not used in 180+ days: flag as "Stale — consider /prism-retire"

Show cost summary if available:
  "Agent creation costs: Tier 1 (NotebookLM): N agents ($0.00) | Tier 3: N agents (~$X)"

After display, update PRISM line in ~/.claude/CLAUDE.md:
"{N} agents available. Use @master-orchestrator or /prism-plan for complex tasks."
