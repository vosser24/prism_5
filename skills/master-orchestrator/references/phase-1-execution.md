---
name: phase-1-execution
description: PHASE 1 execution — present options, single plan, parallelism decision tree (sequential/parallel/SAM/teams), execution patterns, dispatch rules, checkpoint placement. NEW v4.4 OOB-execution timing rule (block-mode pause vs async annotate).
---

# Present Options & Single Plan

OUTPUT HEADER (always start with this line):
  "PRISM Plan | Classification: {LIGHTWEIGHT/FULL-ROUTINE/FULL-NOVEL} | Task: {one-line summary}"

IF spawned after blueprint analysis (FULL-NOVEL):
  Blueprint-prompt has already analyzed this task.
  Use blueprint's analysis to inform your options:
  - Each option: approach, steps, agents (new/existing), models, pros, cons
  - MY RECOMMENDATION with rationale based on project context + blueprint analysis
  - Include blueprint's contrarian challenges as risks

IF spawned directly (FULL-ROUTINE):
  You are the strategic thinker for this task.
  
  SCOPE GUARD — CRITICAL FOR FULL-ROUTINE:
  The user asked for ONE specific feature or change. Plan ONLY that feature.
  Do NOT design a whole platform, system, or architecture around it.
  If the feature requires infrastructure that doesn't exist yet:
    - Note the dependency ("This needs X, which doesn't exist yet")
    - Ask: "Should I include X in the plan, or focus only on the feature?"
    - NEVER silently expand scope beyond what was requested.
  Example: "Add keyword density analyzer" → plan the analyzer ONLY.
    NOT: design a complete SEO platform with 10 database tables.
  
  ALWAYS present at least 2 approaches, even if one is clearly better.
  If you genuinely believe only one approach exists, explain WHY alternatives
  were rejected (don't just omit them). Users need to see the decision space.
  - Each option: approach, steps, agents (new/existing), models, pros, cons
  - MY RECOMMENDATION with rationale based on project context

ALWAYS:
  - If HIGH STAKES: show checkpoint locations
  - Generate task-id: date + short-hash (e.g., "20260414-a3f7")
    Use for: workspace dir, model-log, roster task tracking.
  WAIT for: "go" / "go A" / "adjust" / "explain" / "abort"

## Single Plan (when one approach is clearly best)
Steps, pros, risks, mitigation. Still generate task-id. WAIT for approval.

# PHASE 1: Execution (after approval)

## Parallelism Decision (evaluate for EVERY plan — v2.7.1 corrected)

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

**SEQUENTIAL** — Step B needs Step A's output:
  Example: "Design schema" → "Build API from schema" → "Write tests for API"
  Execute one at a time. Pass **summary** between steps (not raw output).

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

  Cap: 4 parallel `Agent()` calls per message. Beyond that, coordination
  cost (merge, contention, context prep) starts to dominate. If you need
  more, stage them as successive parallel batches.

**SPLIT-AND-MERGE** — Same task on different data subsets:
  Always parallel `Agent()` in one message.
  "Index 600 tables" → split by schema group → 3 haiku subagents in one
   message → merge
  "Migrate 50 files" → split by directory → 3 sonnet subagents in one
   message → merge
  Best for discovery, scanning, migration, bulk review.

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

**Mark parallel/sequential in the plan and SHOW the dispatch shape:**
  "Steps 2a, 2b, 2c run in parallel (independent) — dispatched in ONE
   assistant message with 3 Agent() tool_use blocks. Step 3 waits for
   all three to return before proceeding."
  "Steps 4a, 4b use Agent Teams (cross-layer coordination required)."

**ANTI-PATTERN — one Agent() per message when batch is possible:**
  If your plan has 3 independent haiku scans and you emit them as 3
  successive assistant messages, each with 1 `Agent()`, the wall-clock
  is 3× what it should be AND each spawn pays a fresh prompt-cache
  miss. Always batch when you can.

## Execution Patterns

Standard step (sequential): delegate with full context + "read your references/
and lessons/" → validate result → if good: mark [x] → if bad: log correction
to agent's lessons/improvements.md, re-delegate ONCE → if still bad: escalate.
Pass summaries between steps, not raw output.

Parallel step (Task() subagents): spawn 2-4 subagents via Task() simultaneously.
  Each gets: specific scope, output file path, completion criteria.
  Parent waits for all, merges results, validates combined output.
  If one fails: re-delegate that one only, don't restart others.

Parallel step (Agent Teams): create team with 3-5 teammates.
  Each teammate gets: role description, specific scope, access to shared task list.
  If teammate is a rostered agent with notebooklm_notebook_id:
    Include in spawn prompt: "You have a research notebook. For deep domain
    questions, use the Bash tool to run: notebooklm ask '<question>' --notebook <id>
    This is a CLI command, NOT an MCP tool."
  Teammates coordinate directly — share findings, challenge each other.
  Lead (orchestrator) monitors progress, redirects as needed.
  Use Shift+Down to cycle between teammates (in-process mode).
  When complete: lead synthesizes all teammates' output into final deliverable.
  Clean up: dismiss team after task completion.

Split-and-merge step: divide data into roughly equal groups.
  Spawn haiku subagents (cheap) — one per group.
  Each writes partial result to temp file.
  Parent merges, adds cross-group relationships, writes final output.

## Rules for Parallel Execution
- Task() subagents: max 3-4 (diminishing returns beyond that)
- Agent Teams: max 3-5 teammates (coordination overhead scales)
- Each agent/teammate must have CLEAR scope (no overlapping files/data)
- Use worktree isolation for agents that WRITE to the same repo
- Haiku for scanning/reading, Sonnet for implementation, Opus for decisions
- Never parallelize high-stakes steps — those need sequential checkpoints
- Agent Teams cost MORE tokens — only use when coordination value justifies it

## Checkpoint step (high stakes)

Checkpoint step (high stakes): present completed work, key output to validate,
why this gate, what comes next, risks → WAIT for continue/redo/adjust/abort.
Place at: direction changes, irreversible actions, Opus steps, cross-system
boundaries, agent handoffs with dependencies.

## OOB-execution timing rule (v4.4 NEW — closes B5/D2 cross-link)

After every subagent returns, the OOB PHASE 1.5 hook fires automatically (if the subagent is tagged `requires_phase_1_5: true` in roster.json). Two modes determine how YOU proceed:

### Async mode (default — `requires_phase_1_5_block: false`)

- Hook writes a pending-verdict file to `~/.claude/.prism-phase-1-5-pending-<sha>.json` and spawns the SDK reviewer in background.
- YOU may proceed immediately to the next step.
- The verdict surfaces on the NEXT turn via SessionStart pickup as `[Prior turn] reviewer disagreed on N claims: …`.
- ANNOTATE in your visible output: "OOB review pending for @<specialist-name> output; will surface next turn if any UN-CITED/REJECTED."

### Block mode (`requires_phase_1_5_block: true`)

- Hook runs SDK reviewer INLINE (within 60s hook timeout) and returns `decision: "block"` with the verdict embedded in the reason.
- YOU receive the block reason in your context BEFORE the next step.
- PAUSE before the irreversible next step. Surface to user: "Pausing ~15s for OOB review of @<specialist-name> output. Will continue once verdict completes."
- If reviewer returns EVIDENCED on all claims: proceed.
- If reviewer returns UN-CITED or REJECTED: bounce-ONCE per the senior-review protocol.

**Failure modes (both modes):**

- Hook missing API key (`ANTHROPIC_API_KEY` unset) → reviewer skipped, log entry written, no block. YOU proceed; visible-output annotation: "OOB review skipped (no API key)."
- Hook SDK call fails (5xx/timeout) → single retry + 5s backoff, then skip with log. NO block on hook errors.
- Kill switches: `PRISM_DISABLE_OOB_REVIEW=1` env var, or `requires_phase_1_5: false` on the roster entry.
