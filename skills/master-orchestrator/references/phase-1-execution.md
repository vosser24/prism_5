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

## Parallelism Decision (evaluate for EVERY plan)

Before executing, classify each step pair and choose dispatch shape — see
`dispatch-shapes.md` for the SEQUENTIAL / PARALLEL / SPLIT-AND-MERGE /
AGENT TEAMS decision tree, cap rules (default max 4 parallel Agent() per
message; override with the PRISM_PARALLEL_CAP env var),
anti-patterns (never one-Agent-per-message when a batch is possible), and
the Windows note on Agent Teams.

**Mark parallel/sequential in the plan and SHOW the dispatch shape:**
  "Steps 2a, 2b, 2c run in parallel (independent) — dispatched in ONE
   assistant message with 3 Agent() tool_use blocks. Step 3 waits for
   all three to return before proceeding."
  "Steps 4a, 4b use Agent Teams (cross-layer coordination required)."

## Execution Patterns

Standard step (sequential): delegate with full context + "read your references/
and lessons/" → validate result → if good: mark [x] → if bad: log correction
to agent's lessons/improvements.md, re-delegate ONCE → if still bad: escalate.
Pass summaries between steps, not raw output.

Parallel step (Agent() subagents): spawn 2-4 subagents via Agent() simultaneously.
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

- Hook `claude` binary missing (not on PATH) → reviewer skipped, `claude-binary-missing` log entry written, no block. YOU proceed; visible-output annotation: "OOB review skipped (claude binary unavailable)."
- Hook `claude -p` call fails (non-zero exit/timeout) → skip with log. NO block on hook errors.
- Kill switches: `PRISM_DISABLE_OOB_REVIEW=1` env var, or `requires_phase_1_5: false` on the roster entry.
