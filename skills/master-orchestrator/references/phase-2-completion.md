---
name: phase-2-completion
description: PHASE 2 completion — report to user, roster update, knowledge persistence, upgrade check. v4.4 NEW verdict-log ratchet trigger (delegates to /prism-clean → prism-roster.mjs --apply-ratchet).
---

# PHASE 2: Completion

After ALL steps complete:

## 2a. Report to User

Summary of what was done, key outputs, any issues encountered.

## 2b. Update Roster (IMPORTANT — no stop hook does this)

Read ~/.claude/skills/prism-plan/references/roster.json
For EACH agent used in this task:
  - Increment `total_tasks_completed`
  - Add/update project entry in `projects_worked[]`
  - If agent received corrections: increment `total_corrections_received`
  - If corrections since last upgrade ≥ 3: set `pending_upgrade: true`, `status: "upgrade_needed"`
  - Update `last_updated` timestamp

Apply the escalation, deescalation, and factory-upgrade reset rules per `model-ratchet.md`.

Write the updated roster.json back.

## 2c. Knowledge Persistence
- Create/update context adapter: agent experience/context-adapters/{project}.md
- Log decisions to experience/decisions.md (include scope: "this project" or "all X projects")
- Flag lessons: tactical → tasks/lessons-tactical.md, strategic → tasks/lessons-strategic.md
- If corrections > 0: log to agent's lessons/improvements.md

## 2d. Upgrade Check
If any agent has pending_upgrade: true, inform user:
"Agent @{name} has {N} corrections since last upgrade. Run /prism-roster to review."

## 2e. Verdict-log ratchet trigger (v4.4 NEW)

After all roster updates above, signal that the verdict-log ratchet should run on the next `/prism-clean` invocation. This is the *evidence-discipline* ratchet — separate from the in-process roster updates above (which track task completion + corrections).

The verdict-log ratchet:
- Reads `~/.claude/.prism-phase-1-5-verdicts.jsonl` (append-only log written by OOB hook).
- For each specialist, computes UN-CITED rate over the last N=10 dispatches.
- If UN-CITED rate ≥ 0.30 → flips `pending_upgrade: true` on the roster entry.
- Atomic write via `node tools/prism-roster.mjs --apply-ratchet`.

You do NOT invoke this directly in PHASE 2 — `/prism-clean` invokes it at end-of-session hygiene. Surface to user only if 2d already flagged a `pending_upgrade: true`.
