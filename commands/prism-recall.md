---
description: Unified recall across ATLAS knowledge base (semantic), session state, and spend/metrics (analytical). Auto-routes to the right tier.
argument-hint: <query>
allowed-tools: Bash
---

Run `prism-recall.mjs` with the user's query and show the result.

The tool auto-classifies the query into one of three tiers:
- **Tier 1 (semantic):** free-form questions about skills/agents/patterns → local router + NotebookLM cloud search
- **Tier 2 (state):** "current turn", "my session id", "projects visited" → reads state JSONs
- **Tier 3 (analytical):** "total cost today", "tokens this week", "top models" → aggregates JSONL logs

Command:
```bash
node ~/.claude/tools/prism-recall.mjs "$ARGUMENTS"
```

Forward any flags the user passes (`--json`, `--verbose`, `--tier 1|2|3`) to the underlying tool.

After running, paste the output verbatim into the response. If the result is empty or low-quality:
- Suggest `--tier 1|2|3` to force a specific tier
- Warn that Tier-1 queries take 3–10s (cloud round-trip)
