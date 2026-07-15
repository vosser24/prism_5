---
name: dispatch-shapes
description: Dispatch shapes for PHASE 1 — SEQUENTIAL / PARALLEL / SPLIT-AND-MERGE / AGENT TEAMS. Cap rules, anti-patterns, Windows note. Companion to phase-1-execution.md.
---

# Dispatch Shapes (PHASE 1)

## Runtime context (v2.7.1 corrected)

**Current Claude Code runtime (2.7.1):** there is ONE spawn tool, `Agent()`.
Parallelism comes from dispatching **multiple `Agent()` tool_use blocks in
a SINGLE assistant message** — Claude Code fans them out concurrently. The
wall-clock cost is `max(each subagent)`, NOT `sum(each)`. Sequential
`Agent()` calls (one per assistant message) are strictly slower.

This supersedes earlier PRISM docs that referenced a separate `Task()`
tool — no such tool exists in current Claude Code. `TaskCreate` /
`TaskUpdate` are *plan-tracking* tools (write to `tasks/todo.md`), not
spawn tools.

Before executing, classify each step pair AND choose dispatch shape:

## Who dispatches (v5.x — dispatch is main-loop-only)

Only the MAIN LOOP (the session-level master) can call `Agent()`. A dispatched
subagent — expert, specialist, or team member — has **NO Agent tool** (STEP 0
spike: even an agent that declares it in frontmatter has it stripped). So:

- An expert returns a written worker **spec**; the master dispatches the workers on
  it. There is no expert-fans-out-its-own-workers shape — it is not buildable.
- In Agent Teams, "teammates coordinate directly" means peer **messaging**, NOT
  further spawning — a teammate still **cannot** issue its own `Agent()` call.
- Any design where a dispatched agent fans out sub-workers must route that fan-out
  back through the master (main loop).

## SEQUENTIAL

**SEQUENTIAL** — Step B needs Step A's output:
  Example: "Design schema" → "Build API from schema" → "Write tests for API"
  Execute one at a time. Pass **summary** between steps (not raw output).

## PARALLEL

**PARALLEL** — Steps are independent (no shared inputs/outputs):
  Emit ALL parallel steps as `Agent()` tool_use blocks in ONE assistant
  message. Each gets: specific scope, output file path, completion
  criteria, explicit `model:` (haiku for scan/extract, sonnet for
  implement/review, opus only for architecture).

  Examples:
    "Scan 3 schema groups" → 3 `Agent(model:'haiku')` in one message → merge
    "Build frontend" + "Build backend" + "Write tests" when specs are
     clear → 3 `Agent(model:'sonnet')` in one message
    "Research Redis vs Memcached vs Dragonfly" → 3 `Agent(model:'sonnet')`
     in one message, each with one technology → synthesis afterward

  Cap: 4 parallel `Agent()` calls per message (the default). Beyond that,
  coordination cost (merge, contention, context prep) starts to dominate. If
  you need more, stage them as successive parallel batches.
  The cap is a knob: set `PRISM_PARALLEL_CAP` to override it. When it is
  overridden, SessionStart announces the active cap in context — honor THAT
  value, not this default-4 prose.

  **BUDGET-AWARE DISPATCH (graceful-degradation mitigation, D025):** Before any
  parallel fan-out of 3+ subagents, emit a one-sentence partial synthesis in
  your visible output stating what you are about to do and the expected outcome
  — this text reaches the stream and survives a mid-dispatch budget kill. Then
  dispatch. On a constrained run (headless AND max-turns small), substitute a
  single worker for any planned fan-out of N>2.

## SPLIT-AND-MERGE

**SPLIT-AND-MERGE** — Same task on different data subsets:
  Always parallel `Agent()` in one message.
  "Index 600 tables" → split by schema group → 3 haiku subagents in one
   message → merge
  "Migrate 50 files" → split by directory → 3 sonnet subagents in one
   message → merge
  Best for discovery, scanning, migration, bulk review.

## AGENT TEAMS (experimental)

**AGENT TEAMS** (experimental — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
  Specialized form for when teammates need to MESSAGE EACH OTHER during
  execution, not just report back. Higher coordination overhead; use ONLY
  when direct teammate-to-teammate messaging is required.

  Use Agent Teams when:
  - 3+ agents need to challenge each other's work mid-execution
  - Cross-layer coordination (frontend + backend + tests simultaneously,
    with shared task list)
  - Research where multiple perspectives need to converge through debate
  - Debugging with competing hypotheses (teammates test different theories,
    compare notes)

  DON'T use Agent Teams when:
  - Steps are truly independent (parallel `Agent()` is cheaper)
  - Sequential dependencies (Teams add overhead for no benefit)
  - Simple split-and-merge operations (parallel `Agent()` is faster)
  - Budget is constrained (each teammate = separate Claude instance with
    its own prompt-cache prime)

  **WINDOWS NOTE:** Split panes (tmux) NOT supported on Windows Terminal.
  In-process mode works (Shift+Down to cycle between teammates); you just
  can't see all teammates simultaneously.

## Mark + show shape in the plan

**Mark parallel/sequential in the plan and SHOW the dispatch shape:**
  "Steps 2a, 2b, 2c run in parallel (independent) — dispatched in ONE
   assistant message with 3 Agent() tool_use blocks. Step 3 waits for
   all three to return before proceeding."
  "Steps 4a, 4b use Agent Teams (cross-layer coordination required)."

## ANTI-PATTERN — one Agent() per message

**ANTI-PATTERN — one Agent() per message when batch is possible:**
  If your plan has 3 independent haiku scans and you emit them as 3
  successive assistant messages, each with 1 `Agent()`, the wall-clock
  is 3× what it should be AND each spawn pays a fresh prompt-cache
  miss. Always batch when you can.

## Rules for Parallel Execution

- Parallel Agent() dispatches: default max 4 (override with `PRISM_PARALLEL_CAP`; honor the SessionStart-announced cap when set). Diminishing returns beyond that.
- Agent Teams: max 3-5 teammates (coordination overhead scales)
- Each agent/teammate must have CLEAR scope (no overlapping files/data)
- Use worktree isolation for agents that WRITE to the same repo
- Haiku for scanning/reading, Sonnet for implementation, Opus for decisions
- Never parallelize high-stakes steps — those need sequential checkpoints
- Agent Teams cost MORE tokens — only use when coordination value justifies it
