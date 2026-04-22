---
name: workflow-orchestration
description: >
  Use ONLY when executing a confirmed multi-step plan with 3+ steps that the user
  has approved. NEVER activate for questions, lookups, single-step tasks, or conversation.
  This skill is triggered by the blueprint-prompt when execution is needed, not autonomously.
---

# Workflow Orchestration Skill

This skill defines how to approach complex tasks: methodically, elegantly, and autonomously — without hand-holding the user.

---

## 1. Plan Mode

**Enter plan mode for ANY non-trivial task** (3+ steps or architectural decisions).

### How to plan:
1. Write a plan to `tasks/todo.md` with checkable items (`- [ ] Step`)
2. Show the plan to the user and check in **before** starting implementation
3. Mark items complete as you go: `- [x] Step`
4. Add a **Review** section at the end summarizing what was done

### When things go wrong:
- If something goes sideways, **STOP and re-plan immediately**
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### todo.md structure (ATLAS model-aware):
```markdown
# Task: <name>

## Plan
- [ ] Step 1: <desc> → @agent (model) — done when: <criteria>
- [ ] Step 2: <desc> → @agent (model) — done when: <criteria>
- [~] Step 3: <desc> → INTERRUPTED (inspect before retry)
- [!] Step 4: <desc> → FAILED: <reason>

## References Used
- .claude/references/db-index.md (generated 2026-04-10)

## Review
- What was done
- What was tricky
- Outcome
```

### Step states:
| Marker | Meaning |
|--------|---------|
| `[ ]` | Pending |
| `[~]` | Interrupted — may be partial, inspect before retry |
| `[x]` | Complete and verified |
| `[!]` | Failed — diagnose before retry |

---

## 2. Self-Improvement Loop (ATLAS lesson routing)

After ANY correction, classify and route:

### Agent-specific mistake
→ `~/.claude/agents/{name}/lessons/improvements.md`
→ Update roster.json: increment total_corrections_received
→ If 3+ since last_upgrade: set pending_upgrade: true

### Execution process mistake
→ `tasks/lessons-tactical.md` (Workflow-owned)

### Direction / strategy mistake
→ `tasks/lessons-strategic.md` (Blueprint-owned)

Format:
```markdown
## Lesson: <title>
- **Date**: <today>
- **Mistake**: What went wrong
- **Correction by**: <user or orchestrator>
- **Rule**: How to prevent this next time
```

Never write the same lesson to multiple pools.

---

## 3. Reference File Awareness

Before starting any task, check `.claude/references/` for existing indexes.
If a reference exists for the resource being worked on, use it instead
of re-scanning the live system.

Log in todo.md under "References Used".

---

## 4. Verification Before Done

Never mark a task complete without proving it works:
- Run tests, check logs, demonstrate correctness
- Diff behavior when making changes to existing systems
- Ask: "Would a staff engineer approve this?"
- For code: actually execute it and confirm output

---

## 5. Elegance Check

For non-trivial changes, pause and ask: "Is there a more elegant way?"
- If a fix feels hacky: re-do the elegant solution
- Skip for simple, obvious fixes
- Challenge your own work before presenting it

---

## 6. Autonomous Bug Fixing

Given a bug report: just fix it.
- Point at logs, errors, failing tests → resolve them
- Zero context switching from the user
- Report: what the bug was, root cause, fix, verification

---

## 7. Core Principles

- **Simplicity First**: Minimal impact on surrounding code/content
- **No Laziness**: Find root causes. Senior-level standards.
- **Minimal Impact**: Touch only what's necessary
- **Own Your Work**: Verify what you can verify yourself

---

## When to Create Task Files

Create `tasks/todo.md` and lesson files only when:
- Working on a coding/data project with an active filesystem
- User is in Claude Code, Cowork, or computer-use mode
- Task will span multiple sessions or produce deliverable files

In conversational Claude.ai chat:
- Apply principles behaviorally — same discipline, no files
- Show plan inline as numbered list before starting
- Track corrections within conversation context
