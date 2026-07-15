---
name: phase-0a-inventory
description: PHASE 0a resource-inventory protocol — read unified roster.json (agents+skills+tools+mcps), emit ≤30-line summary, handle orphan notebooks. Loaded from master-orchestrator SKILL.md nav index.
---

# PHASE 0a: Resource Inventory (v2.9.0 — do this FIRST, single source)

Before assessing stakes or assembling a team, read the unified resource-index at `~/.claude/skills/prism-plan/references/roster.json`. It has four authoritative sibling blocks:

- `agents` — rostered specialists
- `skills` — user + plugin + PRISM-owned skills (populated by `/prism-index`)
- `tools` — Tier 1/2 tools with install status
- `mcps` — configured MCP servers

**If `skills`, `tools`, or `mcps` is `{}` (empty) or `index_meta.last_indexed` is null:** emit a loud warning and prompt the user to run `/prism-index`. Without an index, hallucination risk is high and Phase 0a becomes a guess. Continue ONLY after the user either runs the index or explicitly confirms they want to proceed blind.

**If index is present:** match the user's request against all four blocks using keyword overlap (see blueprint-prompt Phase 4 for the scoring rubric) and enumerate which resources cover which domains for this request.

Emit a compact summary (≤ 30 lines) before anything else:

```
PHASE 0a — Inventory

Skills (installed & loadable):
  [from Claude Code's session-start skill index]
  - claude-code-expert, prism-plan, prism-discover, blueprint-prompt,
    workflow-orchestration, notebooklm, video-production, <plugin skills>…

External tools (Tier 1 + installed Tier 2):
  [from ~/.claude/skills/prism-plan/references/tools-registry.md
   cross-referenced with /plugin list + uipro --version + uv pip list]
  ✓ superpowers             (TDD, debug, review, worktrees)
  ✓ ui-ux-pro-max           (design systems, 161 industry rules)
  ✗ ECC                     Tier 2, not installed
  ✗ browser-use             Tier 2, not installed

Rostered specialists (fresh < 90 days):
  [from ~/.claude/skills/prism-plan/references/roster.json — filter by
   last_upgraded and flag staleness]
  ✓ @greek-ecommerce-seo-specialist  (last_upgraded: 12d ago)
  ⚠ @demand-forecasting-specialist   (last_upgraded: 142d ago — 90-180 band)
  …

NotebookLM notebooks (per-agent research archives):
  [Bash: notebooklm list 2>/dev/null | head -20
   then cross-reference with roster.json agents that have notebooklm_notebook_id]
  ✓ greek-ecommerce-seo      (45 sources, last note: 8d ago)
  ✓ demand-forecasting       (23 sources, last note: 60d ago)
  …

Orphan NotebookLM notebooks (NEW in v3.7.0 — exist in cloud but no agent linked):
  [Bash: compute set difference: `notebooklm list` IDs MINUS the
   `notebooklm_notebook_id` values from roster.agents. Filter out IDs in
   ~/.claude/.prism-orphan-notebook-skiplist.json (added via /prism-roster --reconcile-cloud [I]gnore)]
  ⚠ <notebook-name>          (<N> sources, last source <date>)
    → Wire via: `@agent-factory --from-notebook <id>`
    → Or skip via: `/prism-roster --reconcile-cloud` and choose [I]gnore
  ⚠ <notebook-name>          (<N> sources, last source <date>)
  ...
  (None — all cloud notebooks linked or skiplisted)  ← if zero orphans

MCP servers (connected):
  [from settings.json mcpServers + runtime detection]
  ✓ postgres, github, context7
  ✗ playwright, supabase, stripe

Gap hypothesis for THIS request:
  <1-2 sentences: which inventory lines cover the request, which don't,
   and what's the smallest creation path for any gap>
```

If the request needs a domain that has an orphan notebook:
  Suggest to user: "Found orphan notebook '<name>' that may match this domain.
                     Wire it as agent before proceeding? [Y/n]"
  If [Y]: dispatch `@agent-factory --from-notebook <id>` BEFORE assembling the panel.
  If [n]: continue with current inventory; note the missed opportunity in the
          panel composition's 'Resource gaps' notes.

## Staleness preview (v4.7 G1 — before you commit to a plan)

The daily SessionStart freshness sweep is throttled (once/24h), so on a long
session its signals may be hours stale by the time you assemble a plan. Before
emitting a plan/proposal for **stale-prone work** (anything that depends on the
roster, the tools-registry, the KB index, or the installed PRISM version —
e.g. "which specialist handles X", "what tools do we have", migrations that
reference indexed knowledge), run the on-demand preview:

```
node ~/.claude/hooks/lib/prism-freshness-sweep.mjs --preview
```

It prints the CURRENT staleness signals (plugin drift, stale agents, KB-index
lag, registry-vs-index drift, version lag) without disturbing the 24h throttle.
If it surfaces signals that bear on the request, resolve or call them out in the
plan's "Resource gaps" notes BEFORE finalizing — don't plan on top of a stale
index.

Now proceed to stakes + team assembly with this inventory as ground truth.
