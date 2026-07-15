---
name: blueprint-prompt
description: >
  Use ONLY when user explicitly says "plan", "analyze", "strategy", "build",
  "create system", "implement", or requests multi-step work with 3+ steps.
  NEVER activate for simple questions, lookups, one-line tasks, or conversation.
  If in doubt, do NOT activate — just answer directly.
---

# Blueprint + Workflow Skill

## Purpose

One skill, two modes. Blueprint owns *what to do and why*. Workflow owns *how to do it reliably*.
They are not separate concerns — direction without execution discipline is incomplete, and
execution without structured thinking produces the wrong thing efficiently.

---

## Step 1 — Runtime Environment Detection

**Detect once at session start. All behavior forks from this.**

```
[Claude Code mode] — filesystem accessible AND CLAUDE.md present
  → tasks/todo.md and lessons files are real persistent files
  → Session resumption protocol activates
  → Context checkpointing activates
  → Subagent coordination activates
  → Interruption states [~] and [!] available
  → Read tasks/lessons-tactical.md and tasks/lessons-strategic.md before starting

[Chat mode] — no filesystem (claude.ai)
  → Plans shown inline as numbered checklists
  → Lessons tracked mentally within session
  → All principles applied behaviorally — same discipline, no files
```

---

## Step 2 — Task Classification

**Classify before anything else. Announce it. User can override.**

| Type | Definition | Blueprint mode | Workflow activation |
|------|-----------|----------------|---------------------|
| **Advisory** | Analysis, review, research — no action steps | Full workshop | None |
| **Hybrid** | Analysis + recommendations to act on later | Full workshop | Passive — on request |
| **Execution-light** | 1–2 steps, single session | Alignment pass | Lightweight checklist |
| **Execution-heavy** | Multi-step, multi-session, technical build | Alignment pass | Full activation |

```
Task type: [type]
Workflow: [status]
(Say "change to [type]" to override.)
```

---

## Step 3 — The 8-Component Blueprint Framework

| # | Component | Template | Default if missing |
|---|-----------|----------|--------------------|
| 1 | **Role** | `You are a [ROLE] with expertise in [DOMAIN]. Tone: [TONE]. Audience: [AUDIENCE].` | Infer from domain |
| 2 | **Task** | `I need you to [TASK] so that [SUCCESS CRITERIA]. No preamble.` | Must resolve — always ask |
| 3 | **Context** | `<context>[background, data, domain specifics]</context>` | Ask if data-dependent |
| 4 | **Example** | `<examples>[input/output pairs]</examples> Match format exactly.` | Skip unless format ambiguous |
| 5 | **Thinking** | `Think step by step. Use <thinking> tags. Final answer in <answer> tags.` | ON for advisory, OFF for execution-heavy |
| 6 | **Constraints** | `Never [avoid]. Always [ensure]. If about to break a rule, stop and say so.` | Apply domain norms |
| 7 | **Output Format** | `Return as [format]. Use this structure: [template]. Wrap in <r> tags.` | Infer from task type |
| 8 | **Prefill** | `Start your response exactly like this: [opening token]` | Only for structured data output |

---

## Execution Protocol

### Phase 1 — Gap Analysis + Session State

**Claude Code mode — run in this order:**
1. Check tasks/todo.md for [ ] / [~] / [!] items → if found, declare resumption state before proceeding
2. Read tasks/lessons-tactical.md — apply before executing anything
3. Read tasks/lessons-strategic.md — feed into expert panel assembly
4. Check available MCP tools — map to expert roles

**All modes:**
- Silently map prompt to all 8 components: Resolved / Partial / Missing
- Classify task type and announce it

**COMPOSE-FIRST GATE (do this BEFORE synthesizing any direction — runs ahead of Phase 3):**

The existing-resource check runs HERE, before you form a build direction — not
after. Direction formed before checking coverage is the "skip the check, jump to
building" failure.

- Query the unified resource-index / `roster.json` (its four blocks — agents,
  skills, tools, mcps) AND `tools-registry.md` for tools/agents/skills that
  already satisfy the need.
- Run the **Mandatory query protocol** from Phase 4 NOW (extract domain
  keywords, score every entry across all four blocks) — do not defer it until
  after a direction is picked.
- Only synthesize a NEW direction for genuine gaps that nothing existing covers.
  If an existing resource covers the need, COMPOSE with it instead of inventing.

This is a hard ordering rule: the existence check precedes direction-forming.
Rationale — PRISM compose-first (rule 7): real resources over invented voices.

### Phase 2 — Clarification

Ask only for Missing components that are genuinely blocking. Max 3 questions.
State all defaults transparently. Never ask about things that can be reasonably defaulted.

### Phase 3 — Knowledge Assembly

Gather: training knowledge + MCP tool calls (Claude Code) + web search + user context + strategic lessons.
Synthesize before assembling the expert panel.

### Phase 4 — Expert Panel

**Resource-index-first assembly (v2.9.0)**: Before assembling any panel, query the unified resource-index at `~/.claude/skills/prism-plan/references/roster.json`. This file has four sibling blocks — all four are authoritative:

- `agents` — rostered specialists with task-tracking history (agent-factory + reconcile)
- `skills` — user-installed + plugin-provided + PRISM-owned skills (populated by `/prism-index`)
- `tools` — Tier 1/2 tools with install status (superpowers, uipro-cli, etc.)
- `mcps` — configured MCP servers

**Mandatory query protocol** — do this BEFORE writing a single persona name:

1. Extract domain keywords from the user prompt (nouns, verbs, tool names)
2. For each domain the panel needs, score every entry across all four blocks:
   - +3 if keyword matches an entry's `domains` array
   - +2 if keyword matches an entry's `keywords` array
   - +1 if a trigger_phrase substring appears in the prompt
3. For each domain, pick the top-scoring indexed resource if score ≥ 3
4. Each picked skill/tool/MCP REPLACES what would otherwise be a hardcoded persona
5. `notebooklm list` — surface any per-agent research archives for picked agents

**Fallback rule**: hardcoded personas ("Architect", "Security engineer", etc.) are used ONLY when no indexed resource scores ≥ 3 for a given domain — AND only for **generic cross-cutting seats** (Architect, Security, Performance, Cost, Skeptic, …). For a **VERTICAL/domain-expertise seat** (SEO, Greek e-commerce, clinical, conversion/microcopy, …) a generic persona is NOT an acceptable fill: **adjacency is not fitness**. When no indexed specialist scores ≥ 3 for a vertical domain, the correct move is **factory-first** — recommend/route `agent-factory` to create the durable specialist (in a project/orchestrator session that can dispatch). State it explicitly:

> *"No indexed specialist for <vertical domain>. A generic persona is not an acceptable stand-in for vertical expertise — create one with `agent-factory` (or run `/prism-index` if you expected an existing specialist). Proceeding with a clearly-labelled generic persona ONLY as a stopgap for this advisory pass."*

For a generic cross-cutting seat, the lighter notice still applies:

> *"No indexed specialist for <domain>; using generic <Architect> persona as fallback. Consider `/prism-index`, or `agent-factory` to create one."*

**If the index is empty or missing** (`roster.skills`, `roster.tools`, `roster.mcps` all `{}`), emit a loud notice at the top of the panel output: *"Resource-index not populated — hallucination risk HIGH. Run /prism-index and re-run this panel."* Then proceed with hardcoded personas, clearly labeled as such.

**Hardcoded personas are the LAST resort**, not the default. This aligns with PRISM's compose-first stance: don't invent generic voices when a researched specialist or installed tool already covers the need. Real resources over hallucinated voices — always.

**Execution-heavy:** Alignment pass only — one primary expert + one risk voice. No extended debate.
Execution-heavy tasks are handed off to @master-orchestrator (see Phase 7) —
the orchestrator owns panel assembly, adversarial review, and parallel
dispatch. Do NOT duplicate its work here.

**Advisory / Hybrid:** Full panel, with resource-index-first assembly. One expert
per domain. Each contributes analysis, challenges assumptions, flags
risks, proposes recommendations. Push for genuine tension.

Where an MCP tool or installed skill covers a domain: substitute tool/skill invocation for reasoning-only expert.

### Phase 5 — Workshop (Advisory / Hybrid only)

1. Brief — task, success criteria, constraints
2. Round 1: Domain inputs
3. Round 2: **Adversarial review** — apply the formal protocol from
   `~/.claude/skills/prism-plan/references/adversarial-review.md`:
   - Each expert position gets ≥2 substantive challenges
   - Challenges MUST include: specific flaw, condition under which it
     bites, concrete consequence
   - Disqualified as theater: generic objections, semantic nitpicks,
     restating another expert's position
   - Each expert responds with exactly one of: ACCEPT (revise position),
     REJECT (give counter-reason), CONDITIONAL (state mitigation)
   - Anti-theater rule: if you cannot generate 2 substantive challenges
     against an expert, that expert doesn't belong on the panel. DROP
     them rather than inventing weak challenges
   - Verdict per expert: SURVIVES / SURVIVES (revised) / DROPPED
   - Visible to user in the output — do NOT summarize the review away
4. Round 3: Synthesis — resolve conflicts, identify consensus and open questions
5. Decision — final integrated recommendation with rationale

### Phase 6 — Output Delivery

**Advisory / Hybrid:**
```
## Executive Summary
## Expert Panel Findings
## Key Tensions & How They Were Resolved
## Recommendation
## Next Steps [Hybrid: note "say activate execution to engage Workflow"]
```

**Execution-light / Execution-heavy:**
```
## Direction [3-5 sentences]
## Execution Plan  <- THIS IS the Workflow todo.md. One plan, one owner.
- [ ] [tier] [pgroup=X] Step 1 — done when: [criterion]
- [ ] [tier] [pgroup=X] Step 2 — done when: [criterion]
## Risks & Blockers
```

**Tier annotation (required):** `[tier]` ∈ `haiku|sonnet|opus`.
- `haiku` — bounded extract/dump/list/count, schema-defined output, "under N words/lines"
- `sonnet` — cross-file refactor, test writing from spec, doc lookup + reformulation, bug reproduction
- `opus` — architecture decisions, trade-off synthesis, root-cause diagnosis, security review

**Parallel dispatch (v2.7.1 — EXECUTION CONTRACT, not a hint):** `[pgroup=N]`
labels tasks that can run concurrently. **Same `pgroup=N` on two or more
steps is a BINDING contract at execution time** — those steps MUST be
dispatched in ONE assistant message with N `Agent()` tool_use blocks,
run concurrently. Dispatching them sequentially violates the plan.

Wall-clock savings: N parallel subagents finish in `max(each)`, not
`sum(each)`. Plus each sequential `Agent()` pays a fresh prompt-cache
prime (~2–4 s on Opus). Batching a 3-way parallel group cuts ~70% of
wall-clock on a typical scan/implement/review fan-out.

Rules for `pgroup` safety:
  - No two tasks in the same group write the same file.
  - No task in a group depends on another group member's output.
  - If either rule breaks, the tasks belong in different groups
    (sequential dependency) or must be merged into one task.
  - Missing `pgroup` OR different `pgroup` values = sequential.

Example — plan writes:

```
- [ ] [haiku] [pgroup=1] Scan src/auth/ for deprecated APIs
- [ ] [haiku] [pgroup=1] Scan src/payments/ for deprecated APIs
- [ ] [haiku] [pgroup=1] Scan src/notifications/ for deprecated APIs
- [ ] [sonnet] Merge scan results and produce migration plan
```

Execution MUST emit ONE assistant message with three `Agent()` tool uses
(all of pgroup=1, one per scan), then the merge step sequentially.
NOT three separate messages with one `Agent()` each.

Why enforced: the PreToolUse TaskCreate hook
(`~/.claude/hooks/prism-task-tier-advisor.mjs`, v2.7.0+) reads the
`[tier]` annotation as authoritative, and the weekly rollup's Classifier
Calibration section (v2.7.0+) flags sequential-dispatch of same-pgroup
tasks as `{event:'pgroup_violation'}`. Annotating upfront prevents silent
Opus-tier drift on Haiku subtasks AND silent sequential-dispatch of
parallel-safe groups.

ONE PLAN RULE: Blueprint Execution Plan and Workflow todo.md are the same artifact.
Blueprint writes it. Workflow tracks it. Never create two plans.

### Phase 7 — Execution Handoff (Execution-light / Execution-heavy only)

**Chat mode:** Inline checklist is live. Apply Workflow discipline behaviorally.
Track corrections mentally. Deliver Review summary on completion.

**Claude Code mode, Execution-light:** Write Execution Plan directly to
`tasks/todo.md`. Check in before starting. Parent executes directly with
workflow-orchestration discipline (verify before done, checkpoint every
5 steps, capture lessons after corrections).

**Claude Code mode, Execution-heavy (v2.7.0 — explicit handoff)**: After
writing Phase 6 Direction + initial `tasks/todo.md`, state:

> "This is Execution-heavy. Spawning `@master-orchestrator` for full
>  panel assembly, adversarial review, and parallel dispatch. Blueprint
>  direction and initial plan are in `tasks/todo.md`; orchestrator will
>  expand from there."

Then call:

```
Agent({
  subagent_type: 'master-orchestrator',
  model: 'opus',
  prompt: '<original user request, verbatim> — blueprint analysis in tasks/todo.md'
})
```

The orchestrator reads blueprint's output, expands the panel using PHASE 0a
inventory (skills + notebooks + roster + tools-registry), runs formal
adversarial review (PHASE 0d), dispatches specialists in parallel, and
owns PHASE 1.5 senior review before returning the synthesized plan.

**Never execute an Execution-heavy plan in parent context without the
orchestrator handoff** — that was the v2.5.0 bug this rule closes.

If Advisory: "Blueprint complete. Say activate execution to engage Workflow on next steps."

### Phase 8 — Re-entry Protocol

When execution halts due to direction failure (not execution mistake):
1. Mark current step [~] and stop
2. Identify failure type: wrong context → re-enter Phase 3 | wrong recommendation → Phase 4/5 | wrong constraints → Phase 1
3. Update plan before resuming — do not resume from memory

---

## Workflow Execution Mechanics

Execution mechanics (todo.md structure, step states, verification-before-done,
lesson-routing loop, context checkpointing, subagent coordination, elegance
check, autonomous bug fixing, core principles) are owned by the
`workflow-orchestration` skill. Blueprint's Execution Plan (Phase 6) is
consumed by workflow-orchestration without re-stating its mechanics here.

See: `~/.claude/skills/workflow-orchestration/SKILL.md`.

---

## MCP Substitution (Claude Code)

Before assembling the expert panel, map available MCP servers to expert roles:
- Web researcher → web_search
- Calendar / scheduling → Google Calendar MCP
- Email / communication → Gmail MCP
- Knowledge base → Notion MCP
- Design / visual → Canva MCP

Use tool calls instead of reasoning-only experts for substituted roles.

---

## Dev Team Protocol

When execution requires a technical build, these specialists contribute during the Alignment Pass:
Full-Stack Architect, Python Master, PostgreSQL Master, Frontend/React Master,
Django Master, UI/UX Designer, API Architect, Security Engineer.

Each reviews the execution plan, flags technical risks, and contributes to a consolidated
technical spec before any code is written.

---

## When NOT to Run the Full Protocol

For simple factual questions or single-step requests — answer directly.
Rule of thumb: if the task would benefit from a team of humans working on it, run the full protocol.
