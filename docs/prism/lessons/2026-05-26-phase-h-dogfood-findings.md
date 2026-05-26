---
name: 2026-05-26-phase-h-dogfood-findings
description: Two findings from the Task 7 manual dog-food run for Phase H knowledge-evolution rhythms — one fixed (created-date drift in agent-write --force), one noted (AskUserQuestion fallback in non-CC harnesses).
metadata:
  type: project
---

# 2026-05-26 — Phase H dog-food findings

Task 7 of the Phase H plan (`docs/prism/plans/2026-05-25-phase-h-knowledge-evolution.md:894-957`) was a user-driven manual verification of the three knowledge-evolution rhythms in a real Claude Code session against the `competition_agents/` testbed. Four checks were run; all four passed, but two findings surfaced.

## Finding 1 — `agent-write --force` regenerated `created:` instead of preserving on-disk date (FIXED)

**What happened.** Phase H Check 3 Apply branch rewrote `master-competition-agents.md` and silently bumped `created: 2026-05-25 → 2026-05-26`. Phase H commit `9cb56ed` introduced on-disk created-date preservation, but only in `diffMasterAgent` — the symmetric path in `writeMasterAgent` was missed. Net effect: `agent-diff` showed no calendar drift (good), but `agent-write --force` (called on Apply) bumped the field on every upgrade, breaking the invariant "agent-diff immediately after agent-write --force should be empty."

**Fix.** `tools/prism-deep-dive.mjs:222-238` — when `--force` is overwriting an existing file, read the on-disk `created:` line and pass it to `renderMasterAgent` the same way `diffMasterAgent` does. Regression test added at `tests/v3/state/test-prism-deep-dive.mjs:165-196` (seeds 2020-01-01, asserts preservation after force-overwrite). 148/148 across all 8 Phase H suites.

**Lesson.** When two codepaths share a renderer (here `renderMasterAgent`), any kwarg the renderer accepts must be passed *consistently* from both callers — otherwise the path that omits it silently diverges. Worth a code-review heuristic: grep callers of any new renderer kwarg before declaring a feature done.

## Finding 2 — `AskUserQuestion` not available in the testbed environment (NOTED)

**What happened.** `commands/prism-deep-dive.md` `--upgrade` mode spec calls for an `AskUserQuestion` confirmation gate (Apply / Skip). In the testbed Claude Code session, the LLM-judged surface reported *"AskUserQuestion is not available in this context"* and gracefully degraded to plain-text Q&A (*"please reply with one of the two options below"*).

**Why this is fine for v4.0.** The slash command's prose-level fallback is correct and safe: same two options, same exit-code branching, same diff-then-confirm pattern. No silent writes; user input is still required.

**Why this is worth noting.** The fallback is environment-driven (which tools the harness exposes), not code-driven (the slash command can't know in advance). Future work to consider:
- Make `commands/prism-deep-dive.md` instructions explicitly document the fallback so the LLM-judged surface doesn't need to discover it ad-hoc on every run.
- Phase J (tightened evidence rules) could add a hint to the command body: *"If `AskUserQuestion` is unavailable, present the diff inline and prompt for `apply` / `skip` verbatim."*

**Not a Phase H bug.** Closing without code action; capturing here so Phase J planning has the input.

## Net Phase H status

- Task 1-6: shipped on `claude/prism-v3-phase-1-0eVY1`.
- Task 7: four checks verified (append-decision, append-lesson, --upgrade no-diff/Skip/Apply, 25 KB cap).
- One follow-up fix landed (this commit's helper change + regression test).
- One follow-up noted for Phase J input (AskUserQuestion fallback prose).
- Milestone marker commit (`test(prism): Phase H knowledge evolution verified end-to-end`) follows this lesson doc.
