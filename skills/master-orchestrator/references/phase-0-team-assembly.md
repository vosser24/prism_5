---
name: phase-0-team-assembly
description: Stakes auto-detection + team assembly + registry consultation + agent hiring flow + staleness checkpoints + quick-refresh protocol + MCP hints + v4.4 workshop tagging (requires_phase_1_5 lookup).
---

# PHASE 0: Stakes + Team Assembly

## Auto-detect Stakes
HIGH STAKES (mandatory checkpoints): production, database migration, schema,
architecture, financial/pricing, contract/legal, security, external APIs,
data deletion, client-facing, multi-system, new agent creation.
STANDARD: internal tooling, docs, tests, scaffolding, exploratory.
User overrides: "checkpoint this" → high | "run free" → standard

## Team Assembly
For each step: identify domain → search PHASE 0a inventory → assess fitness

**Registry consultation (NEW in v2.1.23 — do this FIRST):**

Before evaluating whether to hire an agent, check the tools-registry:

Read ~/.claude/skills/prism-plan/references/tools-registry.md

For the current step's domain, check:
1. Tier 1 tool (auto-installed by /prism-init) handles this?
   → Route step to that tool directly. No agent needed.
   → Example: "write tests with TDD" → use superpowers
   → Example: "design landing page" → use ui-ux-pro-max

2. Tier 2 tool handles this but isn't installed?
   → Examples: "review Python code" → ECC @python-reviewer (if installed)
               "automate a browser flow" → browser-use (if installed)
   → If the user has the tool installed: route step there.
   → If not: present "Install {tool} for this step?" via /prism-recommend.
   → If decline: fall through to agent hiring flow with a cheap subagent
     (Sonnet with explicit review criteria — don't default to Opus).

3. Domain-expertise need (not workflow/tooling)?
   → Agent hiring flow is correct. Proceed with existing logic.

4. Workflow/tooling need NOT in registry?
   → Spawn @agent-factory --skill-research to find external tool
   → Only create custom agent if research yields no viable option

This prevents creating agents for capabilities better external tools provide
(compose-only stance: never replicate what external tools do well).

**Free-research pre-check (v5.x) — before ANY @agent-factory dispatch that CREATES a new agent:**
agent-factory's $0 research engine is NotebookLM; without it the factory silently
falls back to Opus (~$1-3/agent). Because the factory runs as a subagent (which
cannot prompt the human), this offer MUST happen here in the parent turn:
- Run `command -v notebooklm`.
- If ABSENT → use `AskUserQuestion`: "NotebookLM (free, $0 agent research) is not
  installed. Install it now for $0 research (`pip install notebooklm-py[browser]`
  + `notebooklm login`, or run `/prism-deps`), or proceed with Opus (~$1-3)?"
  On accept: install (reuse `/prism-deps`'s protocol), confirm `notebooklm list`,
  then dispatch the factory. On decline: dispatch anyway (Tier 3, user-informed).
- If PRESENT → proceed directly.
(Skip this pre-check for `--from-notebook` wiring, which already implies NotebookLM.)

**Agent hiring flow:**
- Agent missing → spawn @agent-factory for creation, wait, hire.
  Once @agent-factory is invoked, the factory's own "Decision tree:
  agent-creation vs skill-research" (see `agents/agent-factory.md`,
  end of the `--skill-research` section) picks the mode:
  `--from-notebook <id>` if an orphan notebook exists for the domain,
  `--skill-research` if the need is workflow/tooling, standard create
  flow if the need is domain expertise. (D007 locks this two-layer
  split as the v4.1 architecture — see
  `docs/prism/adjudications/D007-agent-creator-vs-factory.md`.)
- Agent exists → CHECK STALENESS before hiring:

  Read agent's roster entry: last_upgraded or created date.
  Calculate days_since_update.

  If days_since_update < 90:
    → DIRECT HIRE. Knowledge is fresh enough.

  If days_since_update 90-180:
    → HIRE but FLAG: "Agent @{name} was last updated {N} days ago.
      Proceeding with current knowledge. If results seem outdated,
      say 'upgrade @{name}' and I'll refresh their expertise."

  If days_since_update > 180:
    → STALENESS CHECKPOINT. Present to user before hiring:
      "Agent @{name}'s knowledge is {N} months old. The {domain}
       domain may have evolved significantly. Options:
       A. Use as-is (risk: outdated methods/tools)
       B. Quick refresh — factory researches 'what changed in {domain}
          since {last_date}', APPENDS new findings (fast, keeps history)
       C. Full rebuild — factory researches from scratch (thorough, expensive)
       Recommend B for most domains. Recommend C if you suspect fundamental
       changes (new regulations, paradigm shifts, major tool replacements)."

  If agent exists + domain gaps (needed for THIS task but not in agent's domains):
    → spawn @agent-factory for targeted upgrade, wait, hire

**Quick refresh protocol (Option B):**
  Factory receives: agent name + "what changed since {date}" scope
  Factory uses three-tier research focused ONLY on updates
  Factory APPENDS findings to agent's references/ (never overwrites)
  Agent carries forward all prior knowledge + new updates
  Cost: ~$0.05 (NotebookLM) or ~$0.30 (Opus)

When delegating to agents, include MCP hints:
  "MCP tools available: postgresql (query, get_schema). Use these
   instead of writing bash scripts for database access."
This makes agents faster — direct MCP access vs writing and running scripts.

## Workshop tagging (v4.4 NEW)

When you hire an agent (after staleness check passes), check the agent's roster entry for these v4.4 fields:

- `requires_phase_1_5: true` — this agent's output is gated by the OOB PHASE 1.5 reviewer. Hook fires automatically at SubagentStop; no master action needed at hire time.
- `requires_phase_1_5_block: true` — synchronous block-mode. Master MUST pause after this subagent returns until verdict completes. Surface "Pausing ~15s for OOB review" to the user before the irreversible next step. Default: false (async).

If both fields are absent or false: agent runs without OOB review (legacy behavior, no change).

When tagging a NEW agent during agent-factory creation, default to `requires_phase_1_5: false`. Promote to `true` only when:
- the agent makes load-bearing technical claims (e.g., code-reviewer, security-architect, performance-specialist), OR
- the agent's output drives an irreversible downstream action (e.g., schema-migrator), OR
- past corrections suggest evidence-discipline issues.

Block-mode (`requires_phase_1_5_block: true`) is reserved for the irreversible-next-step case only — it adds ~15s latency per dispatch.
