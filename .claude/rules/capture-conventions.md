# Capture conventions

When the session produces durable knowledge, write it under `docs/prism/`
in the right bucket. PRISM `/prism-clean` and the v3.10.0 archival path
expect this layout.

## Buckets

| Folder | What goes there | Example filename |
|--------|-----------------|------------------|
| `adjudications/` | Locked panel decisions, architecture call-outs | `D003-postgres-vs-sqlite.md` |
| `deviations/` | Agent/sub-agent reports of cases the rule did not fit | `2026-05-06-agent-X-deviation.md` |
| `lessons/` | Cross-task tactical lessons (created by `/prism-clean`) | `2026-05-06-session-lessons.md` |
| `smoke/` | Reusable smoke procedures, runbooks | `smoke-postgres-restart.md` |

## File-naming rules

- Adjudications: `D###-<short-slug>.md`, sequential, never re-used.
- Deviations: `YYYY-MM-DD-<agent-name>-deviation.md`.
- Lessons: `YYYY-MM-DD-session.md` (one per /prism-clean run).
- Smoke: `smoke-<topic>.md`.

## The `**Rule:**` header line

New adjudications and lessons SHOULD include a `**Rule:** <imperative>` line immediately after the required header block. Write one concise, actionable sentence capturing the core decision. This line is extracted by `tools/prism-knowledge-index.mjs` and injected verbatim by `hooks/prism-lesson-match.mjs` when the prompt matches — replacing a file-pointer that would require a follow-up read. **Rule:** lines are auto-collected into the `## Standing rules` block on SessionStart by `tools/lib/memory-heal.mjs` (`regenerateStandingRules`), ordered newest-Locked-first and capped — this is the always-on deterministic recall layer in `.claude/agents/MEMORY.md`, and it is genuinely auto-managed (not a manual step someone has to remember to run). If a `**Rule:**` line is absent, the matcher falls back to the title, which is less actionable, and `regenerateStandingRules` has nothing to collect for that file.

## Anti-brevity rule for task carryover (v6.2.0 — recall hardening)

The `description` field on a `TaskCreate`/`TaskUpdate` call is a durable
artifact, not a chat aside: it is the sole record that survives a `/clear` or
session end and is what a resumed session (or a `/prism-clean` handoff) reads
back. Treat it like a captured lesson, not like a live status line:
- Self-contained: restate the acceptance criteria, the target file(s), and
  enough surrounding context that the description alone (no scrollback) is
  enough to resume the work correctly.
- Do NOT compress it to the terse `[tier] action — done when:` one-liner
  style used for the live checklist row shown turn-by-turn — that style is
  acceptable there because the user still has the surrounding conversation;
  it is not acceptable in a `description` field that must outlive the
  conversation.
- When carrying tasks into a `/prism-clean` handoff (Step 4b), copy the
  description **verbatim** — do not re-summarize or further compress it.

## Required headers

Every captured file starts with:

```markdown
# <one-line title>

**Status:** Locked | Proposed | Draft
**Date:** YYYY-MM-DD
**Captured by:** <session id or "manual">
**Related:** (optional links to other adjudications)
**Rule:** <one-line imperative — what to do or not do>
```

## Locking

A file with `Status: Locked` is referenced in `CLAUDE.md` and may not be
edited in place. Subsequent design changes create a new file referencing
the locked one.

## Verify ground truth before you capture "it works"

Deployed ≠ wired ≠ works. A green component/unit suite does NOT prove the
component is wired into its dispatcher or that the end-to-end path works —
add an integration assertion for each critical path. Before capturing a lesson
or adjudication that claims something "works", confirm ground truth: the files
changed (`git status --porcelain`), the claimed paths exist, and the relevant
tests pass. Never trust a subagent's usage counter as a work/completion signal —
a delegating worker reports `tool_uses=1` while the real work lives in its
child's separate transcript. Measure artifacts, not counters or relayed prose.
