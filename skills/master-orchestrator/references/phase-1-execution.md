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
    Generate a FRESH id per new plan/topic — never reuse a task-id minted for
    an earlier or declined plan/topic in the same session; reusing silently
    aliases the wrong `~/.claude/.prism-task-<id>/` workspace.
  WAIT for: "go" / "go A" / "adjust" / "explain" / "abort"

## Single Plan (when one approach is clearly best)
Steps, pros, risks, mitigation. Still generate task-id. WAIT for approval.

# PHASE 1: Execution (after approval)

## Step 0 — surface the task list (FIRST action of execution, v5.8)
Before any worker dispatch or mutating action, write the plan to the live task
list: one `TaskCreate` per phase/slice, then `TaskUpdate` each to `in_progress` /
`completed` as you go. Mandatory for any multi-phase or multi-slice plan — it
makes progress visible, lets the user redirect you mid-flight, and is the thing
that stops a plan from being ground out monolithically in your own context with
no checkpoints. (On builds that expose only the legacy `TodoWrite` name, use
that.) Do NOT begin executing a phase whose task you have not created.

**`description` must be self-contained (v6.2.0 — recall hardening).** The task
`description` field is the SOLE record that survives into next session's
recall: if the session ends or `/clear`s before this task completes, a future
`/prism-clean` handoff and the session-start task-recall block can only see
what is written HERE — not this conversation's context, not your reasoning,
not the plan you presented in PHASE 0. Write each `description` as if the next
session has none of the current context, because it won't:
- **Restate the acceptance criteria** — what "done" looks like for this task,
  not just the action.
- **Name the target files** — exact paths the task touches or creates.
- **Carry enough context** that a cold read of the description alone (no
  scrollback) is sufficient to resume or re-delegate the work correctly.

This is a DIFFERENT bar than the terse `[tier] action — done when:` one-liner
style used for the LIVE checklist row shown to the user turn-by-turn (that
style is fine there — the user has the surrounding chat for context). The
`description` field has no such surrounding context once the session clears;
a terse one-liner that reads fine in the moment becomes an undecipherable
fragment on recall. Prefer over-specifying the description to under-specifying
it — the cost of a few extra lines is far cheaper than a next session
re-deriving lost context or silently dropping the task.

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

## Model-A execution: experts plan, the master dispatches (v5.x)

Dispatch is **main-loop-only** (STEP 0 spike): a dispatched expert/specialist has
NO Agent tool and **cannot spawn** workers. So PHASE 1 execution runs as model A:

- The master (session-level chair) assigns each domain workstream to its owning expert.
- The expert returns a **written worker spec** (tasks, acceptance criteria, file
  targets) — it does NOT spawn workers.
- The **master dispatches** the workers on that spec (the sole dispatcher), equipping
  each with the expert's owned skills by injecting the skill file into the worker
  prompt (mid-session skills do not hot-reload).
- The owning expert **reviews** worker output via a master re-dispatch round; the
  master persists the expert's domain learnings back to its `domain_memory_file`
  (master-brokered).

Never assume an expert can fan out its own sub-agents — route every fan-out through
the master. "Experts own planning; the master owns dispatch."

## Execution Patterns

**Diagnosis budget (v5.3.2).** Investigation/diagnostic dispatches are BOUNDED:
cap at ~15–20 tool calls, return PARTIAL findings if the cap is hit, and do NOT
install dependencies, write throwaway scripts, or thrash on environment errors
(note the blocker and return). A "is X done / why isn't Y showing" question is a
quick state check — scope the sub-prompt tightly to the INVESTIGATION ("check
ONLY these 3 things and report exactly what you find — no open-ended forensic
sweep"), don't hand it an open-ended forensic checklist. Bound the scope of what
it inspects, never the length of what it reports back. For purely
read-only checks, prefer running the probe directly (the dispatch guard's
read-only fast path allows non-mutating Bash/PowerShell in the parent) over
spawning a subagent at all.

**Build-slice budget (v5.7.3) — distinct from the diagnosis budget above.** The
diagnosis cap (~15–20 calls) bounds an *investigation* so it returns fast. A
heavy *build* is not globally capped — it is DECOMPOSED (see SKILL.md DISPATCH
CONTRACT step 2): split into 3-5 bounded sequential slices, give each slice its
own build-slice budget (~20 tool calls), and dispatch one at a time, feeding
each slice's summary forward. Never dispatch a monolithic 65-tool-use builder —
that is the stall pattern. A globally-capped builder wrongly throttles
legitimate work; a decomposed builder bounds the blast radius of any one stall.

Standard step (sequential): delegate with full context + "read your references/
and lessons/" → validate result → if good: mark [x] → if bad: log correction
to agent's lessons/improvements.md, re-delegate ONCE → if still bad: escalate.
Pass summaries between steps, not raw output.

**Validate the result before accepting it (v5.7.3).** A subagent reporting a
**near-zero** result — ~0 tokens AND sub-second AND 0 tool-uses (e.g.
`Done (0 tokens · 1s)`) — is a throttled/failed spawn, NOT a completed step:
treat as FAILED → back off + retry (cap ~2), then escalate to the user; do not
mark [x]. On a mid-run cutoff (nonzero tool-uses but 0 tokens) verify partial
state before any re-run (double-apply risk) and re-run only the remainder. Only
the full conjunction signals failure — a small nonzero result is a real step.

**Verify ARTIFACTS, not the usage counter (v5.10.0).** A subagent's usage block
counts only its OWN direct tool calls — so a worker that *delegates* (one nested
`Agent` dispatch) reports `tool_uses=1` even though it created files, edited code,
and ran a suite; the real work lives in the child's separate `agent-<childId>.jsonl`.
The counter therefore UNDER-represents work and must NEVER be a completion signal
(sibling of the `0 tokens` failure case above, and of the phantom-`written` / zombie
relayed-report lessons). After an **output-producing** worker returns, measure
GROUND TRUTH instead of trusting the count or the worker's prose:

```bash
git status --porcelain && git diff --stat   # what actually changed on disk
# then: confirm each claimed path exists, and run the relevant tests for green
test -f <claimed/path> && echo OK || echo MISSING
node <the relevant test(s)>                  # pass-count is the real signal
```

**Exception — `docs/` and `.claude/references/` claims: `git status` is silent
by construction.** Both paths are gitignored (`.gitignore:26` = `/docs/`;
`.gitignore:19` = `.claude/references/`), so a worker claiming it wrote a
lesson, adjudication, or discovery-index file there will show as a clean tree
above — that proves nothing, it's the absence of a signal, indistinguishable
from "landed correctly" / "never written" / "write silently failed". For those
paths, drop the `git status`/`git diff` step and go straight to `test -f
<claimed/path>` (or `ls -la`) PLUS reading the file back to confirm the actual
content is there. See `.claude/rules/capture-conventions.md` ("Verify ground
truth before you capture 'it works'").

Equip the worker to make this cheap: end its prompt with "list every file you
created/edited by absolute path and run the test suite; report the pass count,"
so the master only checks paths-exist + tests-pass. True per-worker tool count, if
ever needed as a diagnostic, is `grep -c '"type":"tool_use"' <transcript>/agent-<id>.jsonl`
— and remember nested-child calls live in a *separate* `agent-<childId>.jsonl`,
which is *why* the rollup reads 1.

**PERFORMANCE CONTRACT (keeps PRISM's no-slowdown rule intact):** this runs ONCE
per dispatch — a rare, already-heavyweight event (seconds-to-minutes) — NOT on the
per-turn / per-tool-call hot path. A sub-second `git status` after a multi-minute
worker is ~0.02% overhead. **Scope it to output-producing dispatches only** — skip
verification after read-only/research workers (nothing to diff). **Do NOT wire it
as an unconditional `SubagentStop` hook** — that would git-diff on *every*
completion (incl. read-only) and tax the dispatches that produced nothing. It is
conditional ORCHESTRATOR DISCIPLINE, not a runtime feature. (Windows/SMB: the
index.lock-orphaning root cause is fixed — read-only `git status` calls on the
hot/background paths now pass `--no-optional-locks`, so this hook's own check
should never take the lock. Routinely deleting `.git/index.lock` is NOT normal
practice; if one recurs here, investigate — a live git process, an unpatched
call site — rather than deleting it.) Pairs with WS-3's wiring guard —
both assert ground truth over green/self-report: *a green component suite does not
prove the component is wired or that it works end-to-end.*

**Equip the worker IN ITS PROMPT — don't expect a subagent to invoke skills.**
A dispatched subagent does NOT hot-reload skills and is scoped to one task, so
the master carries what it needs INTO the dispatch prompt: (a) the relevant
DISCIPLINE inline — e.g. "follow red-green TDD: write the failing test first";
"use systematic debugging: reproduce → isolate → fix → verify" — and (b) for a
vertical procedure, the `SKILL.md` path (or its content) for the worker to
`Read` and follow. Skill-tool invocation inside a worker is neither required nor
reliable (no hot-reload, scoped context); injecting the skill's substance into
the prompt is the supported mechanism. This is the same "Equip (same session)"
rule as the panel experts' authored skills in `phase-0-team-assembly.md`.

**Inject recalled lessons too (v5.7.3).** Alongside the discipline injection,
carry the **recalled lessons** (top 1-3, one-liners, domain/tool-tagged) into
the worker prompt — the worker cannot query the KB itself. Default recall is the
cheap local path (read `MEMORY.md` + grep `tasks/lessons-*.md` by tag); cloud
`/prism-recall --no-rerank` only on NOVEL / high-stakes work. Single source of
truth for the full reuse-first + recall gate: SKILL.md DISPATCH CONTRACT step 1.

**MANDATORY: superpowers discipline-match (v5.5).** `using-superpowers` carries a
`<SUBAGENT-STOP>` that makes dispatched agents SKIP superpowers auto-activation —
so a worker gets ZERO of that discipline unless the master injects it. For EVERY
worker dispatch, classify the worker's task and inject the matching superpowers
discipline into its prompt (inline substance for short procedures; the `SKILL.md`
path for the worker to `Read` when the full procedure is needed). Do NOT instruct
the worker to "invoke the skill" — auto-activation is suppressed and Skill-tool
calls are unreliable in a scoped subagent; inject the substance/path instead.

**These disciplines also bind YOUR OWN work as the master (v5.8).** Workers get
injection because they cannot reliably invoke skills; YOU, the session-level
master, hold the `Skill` tool and MUST use it directly — run
`superpowers:brainstorming` before designing a plan from a blank slate (PHASE 0),
and `superpowers:systematic-debugging` (not ad-hoc poking) when YOU diagnose a
bug. Same match as the table below — applied to the worker via injection, and to
yourself via a real `Skill(...)` call.

  | Worker task type            | Inject superpowers skill                       |
  | --------------------------- | ---------------------------------------------- |
  | implement feature / bugfix  | `superpowers:test-driven-development`          |
  | diagnose bug / test failure | `superpowers:systematic-debugging`             |
  | design / new capability     | `superpowers:brainstorming` (before any code)  |
  | claims "done" / pre-merge   | `superpowers:verification-before-completion`   |
  | multi-step plan execution   | `superpowers:executing-plans`                  |

  Skip injection ONLY when the worker's task is pure read-only scan/extract (no
  code written, nothing to verify). When in doubt, inject — the cost is a few
  lines of prompt; the cost of skipping is undisciplined worker output.

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
