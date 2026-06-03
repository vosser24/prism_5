---
name: prism-recall
description: Unified recall across PRISM knowledge base (semantic), session state, and spend/metrics (analytical). Auto-routes to the right tier.
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

## Cross-project knowledge (v5.0 F4 — opt-in)

Tier 1 can also search the **cross-project knowledge index** (shared adjudications / lessons / plans / panel-rationales + always-on verdict logs) when the user explicitly asks. The default 3-tier recall is unchanged and never reaches across projects.

- `--cross-project "<query>"` — augments Tier 1 with BM25 retrieval over the global index + a default-on `claude -p` re-rank. Results are labeled `(LLM re-ranked)` or `(lexical only — …)`.
  - `--no-rerank` (or env `PRISM_RECALL_RERANK=off`) — skip the re-rank, BM25 only.
  - env `PRISM_RECALL_RERANK_TIMEOUT_MS` (default 8000) — raise this on slow-CLI platforms (e.g. Windows, where `claude -p` cold-start ~20s otherwise times out → silent BM25 fallback). For interactive Windows use prefer `--no-rerank` over a long timeout (you'd otherwise block ~20s every cold call); the re-rank pays off in warm/scheduled runs.
- `--share-project [types…]` — opt THIS project into sharing the listed corpus types (`adjudication lesson plan panel-rationale`); no args = share all four. Writes `.prism-kb-share.json` (default-deny: nothing is shared until run).
- `--unshare-project` — stop sharing this project.

After running, paste the output verbatim into the response. If the result is empty or low-quality:
- Suggest `--tier 1|2|3` to force a specific tier
- Warn that Tier-1 queries take 3–10s (cloud round-trip)
- For `--cross-project`, note "no cross-project knowledge yet" means no project has run `--share-project` (and no verdicts have accrued)
