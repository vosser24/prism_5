---
name: atlas-retire
description: Archive an unused ATLAS agent
---

Usage: /prism-retire @agent-name

1. Verify agent exists in ~/.claude/agents/{name}/
2. Confirm with user: "This will archive @{name}. It won't be loaded
   or appear in roster. You can restore it later. Proceed?"
3. Move ~/.claude/agents/{name}/ to ~/.claude/agents-archive/{name}/
4. Remove from roster.json
5. Update CLAUDE.md agent count
6. Report: "Archived @{name}. Restore with: mv ~/.claude/agents-archive/{name} ~/.claude/agents/"
