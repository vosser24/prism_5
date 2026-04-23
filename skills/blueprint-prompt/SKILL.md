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

### Phase 2 — Clarification

Ask only for Missing components that are genuinely blocking. Max 3 questions.
State all defaults transparently. Never ask about things that can be reasonably defaulted.

### Phase 3 — Knowledge Assembly

Gather: training knowledge + MCP tool calls (Claude Code) + web search + user context + strategic lessons.
Synthesize before assembling the expert panel.

### Phase 4 — Expert Panel

**Execution-heavy:** Alignment pass only — one primary expert + one risk voice. No extended debate.
Workflow will govern execution autonomously. Do not debate implementation choices it should resolve.

**Advisory / Hybrid:** Full panel. One expert per domain. Each contributes analysis, challenges
assumptions, flags risks, proposes recommendations. Push for genuine tension.

Where an MCP tool covers a domain: substitute tool call for reasoning-only expert.

### Phase 5 — Workshop (Advisory / Hybrid only)

1. Brief — task, success criteria, constraints
2. Round 1: Domain inputs
3. Round 2: Cross-examination — surface conflicts, trade-offs, dependencies
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

**Parallel dispatch (optional):** `[pgroup=X]` labels tasks that can run concurrently. Same group = dispatch in ONE assistant message with multiple `Agent()` tool uses. Missing/different group = sequential. A group is parallel-safe only if no two tasks write the same file AND no task depends on another's output.

Why required: the PostToolUse TaskCreate hook (`~/.claude/hooks/prism-task-tier-advisor.mjs`) classifies each task and the weekly rollup checks whether the execution actually used the advised tier. Annotating upfront prevents silent Opus-tier drift on Haiku subtasks.

ONE PLAN RULE: Blueprint Execution Plan and Workflow todo.md are the same artifact.
Blueprint writes it. Workflow tracks it. Never create two plans.

### Phase 7 — Execution Handoff (Execution-light / Execution-heavy only)

**Chat mode:** Inline checklist is live. Apply Workflow discipline behaviorally.
Track corrections mentally. Deliver Review summary on completion.

**Claude Code mode:** Write Execution Plan directly to tasks/todo.md. Check in before starting.
Verify before marking complete, checkpoint every 5 steps, capture lessons after any correction.

If Advisory: "Blueprint complete. Say activate execution to engage Workflow on next steps."

### Phase 8 — Re-entry Protocol

When execution halts due to direction failure (not execution mistake):
1. Mark current step [~] and stop
2. Identify failure type: wrong context → re-enter Phase 3 | wrong recommendation → Phase 4/5 | wrong constraints → Phase 1
3. Update plan before resuming — do not resume from memory

---

## Workflow Execution Mechanics

### Plan Mode (Chat)
Show plan inline before starting. User can say "stop" to adjust.

### todo.md Structure (Claude Code)
```
# Task: <name>
# Type: <Advisory|Hybrid|Execution-light|Execution-heavy>
# Started: <datetime> / Last checkpoint: <datetime>

## Plan
- [ ] [tier] [pgroup=X] Step — done when: [criterion]   <!-- [tier] ∈ haiku|sonnet|opus; [pgroup=X] optional, same group = parallel-safe; see Execution Plan rules above -->

## Checkpoints
- [state snapshot]

## Review
- What was done / What was tricky / Outcome
- Strategic lessons to escalate: [any]
```

### Step States (Claude Code)
- [ ]  Pending
- [~]  Interrupted — started, may be partial
- [x]  Complete and verified
- [!]  Failed — needs diagnosis before retry

### Context Checkpointing (Claude Code)
Checkpoint every 5 completed steps, before irreversible operations, or at 60%+ context consumption.
Write to tasks/todo.md: steps completed, current step, state summary, next action, open risks.

### Verification Before Done
Never mark [x] without proving it works. Run tests, check logs, diff behavior.
Ask: "Would a staff engineer approve this?"

### Self-Improvement Loop

After any correction, classify the lesson first:

**Tactical** (execution mistake — wrong tool, bad step, environment error):
→ tasks/lessons-tactical.md (Claude Code) or mental note (Chat)
→ Read at session start, before executing anything

**Strategic** (direction mistake — wrong recommendation, bad framing, flawed expert reasoning):
→ tasks/lessons-strategic.md (Claude Code)
→ Blueprint reads at Phase 1 before assembling expert panel

TWO POOLS. NO CROSS-CONTAMINATION.

### Subagent Coordination (Claude Code)
- Orchestrator owns tasks/todo.md — single source of truth
- Each subagent gets scoped file: tasks/subagent-[name].md
- Merge results before marking parent step [x]
- Surface conflicts to user — never silently pick one

### Core Execution Principles
- Simplicity first — minimal impact on surrounding code/content
- No laziness — find root causes, no temporary fixes, senior-level standards
- Own your work — do not ask user to verify things you can verify yourself
- Autonomous bug fixing — given a bug report, just fix it; report back with root cause + verification
- Elegance check — for non-trivial changes ask: "Is there a more elegant way?"

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
