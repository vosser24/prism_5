---
name: atlas-plan
description: >
  Multi-step project planning and execution with expert agent teams.
  Use ONLY when user explicitly says "plan", "architect", "design system",
  "build [something complex]", "implement [multi-step feature]",
  "migrate", "create a system", or requests work with 3+ clear steps.
  NEVER activate for questions, lookups, single-file fixes, short tasks,
  or conversation. If in doubt, do NOT activate.
---

# ATLAS Plan — Multi-Step Orchestration

When invoked, follow this protocol:

## Step 1: Classify Silently

- LIGHTWEIGHT (1-3 steps, obvious approach, single domain):
  Present inline plan with pros/cons. Wait for approval. Execute.
  
- FULL-ROUTINE (3+ steps BUT known patterns, familiar codebase, no architecture decisions,
  OR an existing agent in the roster already has the expertise needed):
  Spawn @master-orchestrator directly. No blueprint needed.
  
- FULL-NOVEL (3+ steps AND any of: deep expertise Claude doesn't natively have,
  architecture decisions, technology selection, fundamental approach choices,
  NO existing agent in the roster for this depth of expertise):
  Run blueprint-prompt expert panel FIRST → then spawn @master-orchestrator.

### How to distinguish ROUTINE from NOVEL:
The test is EXPERTISE GAP, not topic keyword.

Ask three questions:
1. Does this task need DEEP specialist expertise beyond Claude's general knowledge?
   NO → LIGHTWEIGHT or FULL-ROUTINE (Claude can handle it)
   YES → go to question 2

2. Does an agent with this expertise EXIST in the roster?
   YES → FULL-ROUTINE (hire the agent, orchestrator executes)
   NO → FULL-NOVEL (blueprint debates approach, factory creates agent)

3. Does the task CHANGE the fundamental approach of something we've done before?
   YES → FULL-NOVEL even if agent exists (new architecture = new challenge)
   NO → FULL-ROUTINE

### Examples:

"make this description SEO friendly"
  → LIGHTWEIGHT. Claude knows basic SEO. No deep expertise needed.

"fix the SEO meta tags on 5 pages"
  → LIGHTWEIGHT. Known patterns, simple execution.

"build an AI-powered SEO audit tool that crawls 50K pages"
  → FULL-NOVEL. Deep SEO expertise needed, architecture decisions,
    no @seo-auditor in roster. Blueprint + factory + orchestrator.

AFTER @seo-auditor is created:

"run the SEO audit on the homepage"
  → FULL-ROUTINE. Agent exists, pattern known. Orchestrator only.

"extend the SEO tool to check backlinks"
  → FULL-ROUTINE. Same agent, incremental feature. Orchestrator only.

"redesign the SEO scoring to use ML instead of rules"
  → FULL-NOVEL again. Fundamental approach change. Blueprint + orchestrator.

"add 4 new API endpoints following the existing pattern"
  → FULL-ROUTINE. Pattern known, no deep expertise gap.

"migrate from ASP.NET to Magento"
  → FULL-NOVEL. Fundamental architecture decision, multiple viable approaches.

### FULL-NOVEL flow (blueprint + orchestrator):

1. DOMAIN TRIAGE (NEW in v2.1.23 — do this first):
   Classify the nature of the novel task:
   
   a. WORKFLOW/TOOLING need (e.g. "set up TDD", "automate testing",
      "add visual regression", "generate AI voices", "scrape data")
      → Route to @agent-factory --skill-research FIRST
      → If skill-research finds a viable tool: use it, skip blueprint
      → If nothing viable: continue to step 2 (blueprint)
   
   b. DOMAIN EXPERTISE need (e.g. "migrate ASP.NET to Magento",
      "forecast Greek retail demand", "review a UK employment contract")
      → Proceed directly to blueprint + orchestrator + agent-factory
      → This is what the existing pattern was designed for
   
   c. HYBRID (both) — e.g. "build a viral TikTok promoting my product"
      → Run BOTH: skill-research for production tools,
                  blueprint + factory for strategy expertise
      → Orchestrator composes them

2. Load blueprint-prompt skill
2. Blueprint runs expert panel:
   - 3-5 domain perspectives analyze the task
   - Contrarian challenge: "why might this fail? what are we not seeing?"
   - Technology/approach options with trade-offs
   - Long-term consequences of each approach
   - Produces: recommended approach + alternatives + risks
3. Present blueprint analysis to user (options with pros/cons)
4. WAIT for user to pick an approach
5. Spawn @master-orchestrator with the chosen approach
6. Orchestrator handles team assembly, execution, checkpoints

## Step 2: Present Plan to User
ALWAYS present before executing:
- Options with pros/cons (when alternatives exist)
- Model assignments per step (haiku/sonnet/opus)
- Estimated scope
- If HIGH STAKES: show checkpoint locations

### Task format (required)
Every step in the plan MUST be written as:

```
- [ ] [tier] [pgroup=X] Step — done when: [criterion]
```

Where `[tier]` ∈ `haiku|sonnet|opus` and `[pgroup=X]` is an optional parallel-dispatch group id.

**Tier rules** — use the 5a.1 classifier: score = `h + 3·s + 8·o` (haiku/sonnet/opus signal counts from `classifyTier`). Thresholds default to `0–2 → haiku`, `3–7 → sonnet`, `8+ → opus`. Ties round UP (overpay < retry). Leaving `[tier]` off is a silent bug — Opus cost on Haiku work.

**Parallel dispatch rules** — tasks sharing the same `pgroup` label fire concurrently in a **single assistant message with multiple `Agent()` tool calls**. Different or missing `pgroup` = sequential. A group is parallel-safe only if **no two tasks write the same file** and **no task depends on another's output**. The advisor hook warns if two tasks in the same pgroup reference the same file path.

**Superpowers reconciliation** — when the `subagent-driven-development` skill is active, implementation steps are **always serialized** regardless of `[pgroup]` annotation (superpowers enforces single-implementer + two-stage review to prevent edit conflicts). `[pgroup]` parallelism still applies to research, retrieval, and review steps. Align with `dispatching-parallel-agents` for the runtime pattern.

Tier assignment rule: apply `classifyTier` heuristics — Haiku for bounded extract/dump/list/count, Sonnet for cross-file refactor or test writing from spec, Opus for architecture/trade-off/root-cause decisions.

**Worked example** — Phase 5a of the ATLAS KB plan:

```
- [ ] [haiku] Extract classifyTier + detectCompound to tools/lib/prism-tier-classify.mjs — done when: 118 existing tests still pass
- [ ] [sonnet] Add PostToolUse:TaskCreate advisor hook + DB writer — done when: synthetic payload emits nudge + advice row written
- [ ] [haiku] Update atlas-plan + blueprint-prompt SKILL task format to [tier]-prefixed — done when: both SKILL.md files carry the new template
- [ ] [sonnet] Rollup adherence section — done when: weekly digest shows Plan-Tier Adherence table
- [ ] [sonnet] Add 5 Phase-5a tests — done when: 123/123 assertions pass
- [ ] [opus] Design Phase 5 compound-learning loop schema — done when: lesson extraction shape agreed + pre-answer recall budget decided
```

The first five rows are bounded, schema-defined, single-responsibility work — Haiku or Sonnet. The last row is an architecture decision with trade-offs — Opus. Writing `[opus]` on every row would burn ~15× on the cheap rows; writing `[haiku]` on the design row would underpower it. Annotate with judgment, and the hook + rollup will flag drift.

WAIT for user approval. Never execute without "go", "yes", or "ok".

## Step 3: Execute After Approval
- LIGHTWEIGHT: execute inline, track progress with [x]/[ ]/[~]/[!] markers.
  After completion: update roster.json if any @agents were used
  (increment tasks, add project — same as orchestrator PHASE 2b).
- FULL-ROUTINE: @master-orchestrator handles team assembly, execution, checkpoints,
  and roster updates. No blueprint was involved.
- FULL-NOVEL: @master-orchestrator executes the approach chosen after blueprint
  analysis. Blueprint's risks and contrarian challenges are included in the plan.

## High Stakes Auto-Detection
Mandatory checkpoints when ANY applies:
- Production deployment, infrastructure changes
- Database migrations, schema changes
- Architecture decisions constraining future options
- Financial calculations, pricing, budgets
- Contract/legal/compliance
- Security-sensitive code (auth, payments, encryption, PII)
- External API integrations (irreversible once live)
- Data deletion, destructive operations
- Client/stakeholder-facing deliverables
- Multi-system cross-dependencies

## Checkpoint Placement
Gates at: direction changes, irreversible actions, Opus-routed steps,
cross-system boundaries, agent handoffs with dependencies.

Present: completed work, key output to validate, why this gate,
what comes next, risks. WAIT for continue/redo/adjust/abort.

## Model Routing
Read references/model-matrix.md for full details.
Summary: Haiku explores ($1/MTok). Sonnet builds ($3/MTok). Opus decides ($5/MTok).
Two-pass pattern: Haiku scans cheaply → Sonnet/Opus executes with targeted context.

## Knowledge
- Read .claude/references/ indexes before planning (if they exist)
- Read references/roster.json for available expert agents
- Read CLAUDE.md → Project Identity → Related projects for cross-project decisions
- Write execution plan to tasks/todo.md
- Log lessons: tactical → tasks/lessons-tactical.md, strategic → tasks/lessons-strategic.md
