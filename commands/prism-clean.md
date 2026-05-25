---
name: prism-clean
description: Capture durable session knowledge into docs/prism/. Applies a 5-level importance classifier, surfaces candidates as a checklist, and writes approved artifacts with locked headers.
---

# /prism-clean — v3.11.0 session-archival mechanism

Locked design: `docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md` §6
(5-level importance classifier; detection heuristics; bucket layout).
Capture format: `.claude/rules/capture-conventions.md` (written by
`/prism-bootstrap` phase-conventions).

Run this before `/clear` or `/exit` so durable knowledge from the session
survives. The deterministic surface is `tools/prism-clean.mjs`; the
classification + UX is LLM-judged and lives in this slash command body.

---

## Step 0 — git guard

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: STOP. `/prism-clean` requires a bootstrapped project.

## Step 1 — establish the session window

Read `.claude/.prism-state.json`. Pull `last_sync_at` (preferred) or
`last_run` as the "since" baseline. If neither is set (fresh project),
use `initialized_at`.

Run: `node ~/.claude/tools/prism-clean.mjs git-stats --since <baseline>`

The JSON output tells you the rough session size:
- `commits` — how many landed
- `files_changed`, `insertions`, `deletions` — diff against the boundary

**Pre-classification heuristic from D002 §6:**
- If `commits == 0` AND no edits AND the session was conversational only → likely L1 NOISE. Don't surface anything; tell the user "session has no durable artifacts" and exit.
- If `commits == 0` BUT the session produced agent panels, adjudications, or substantial design work → still surface (panel work counts as L5 even without commits).

---

## Step 2 — classify session contents (5 levels)

Review the conversation context (the entire session thread you can see, not
the filesystem) and identify candidate artifacts. Apply the **D002 §6
heuristics in priority order**:

### L5 CRITICAL — auto-archive, no opt-out

Triggers (any one fires L5):
- An agent panel ran (≥2 agents adjudicating a design question with explicit verdict)
- An agent returned a "deviation" report (it flagged "the rule doesn't fit here, here's what I did instead")
- Security finding surfaced (CVE-style; auth/secrets/permission errors found and fixed)

Bucket assignment:
- Panel adjudication → `docs/prism/adjudications/D###-<slug>.md`, Status: `Locked`
- Agent deviation → `docs/prism/deviations/YYYY-MM-DD-<agent-name>-deviation.md`, Status: `Locked`
- Security finding → `docs/prism/adjudications/D###-<slug>.md`, Status: `Locked`

### L4 HIGH — default-selected in checklist

Triggers:
- Explicit architectural decision the user took ("we'll use X because Y")
- Bug root cause + fix that wasn't obvious from the diff alone (the *why* it was broken matters more than the patch)
- New smoke procedure (a runbook the user wants to be able to follow next time)
- User said "lock this in" / "this is good" / "use again" / "remember this" — strong signal to BOOST to L4 from a lower default

Bucket assignment:
- Architecture decision → `adjudications/D###-<slug>.md`, Status: `Proposed` (user can promote to `Locked`)
- Bug root cause → `lessons/YYYY-MM-DD-session.md`, append to today's file
- Smoke procedure → `smoke/smoke-<topic>.md`

### L3 MEDIUM — default-unselected in checklist

Triggers:
- A refactor pattern that was reused 2+ times in the session
- Performance numbers worth remembering (benchmarks, latency budgets confirmed)
- Cross-task gotcha (something that bit you in task A and could bite again in task B)
- Same root cause hit 2+ times → BOOST to L3 from L2 (the recurrence is the signal)

Bucket: `lessons/YYYY-MM-DD-session.md` (tactical lessons).

### L2 LOW — offered but unselected by default

Triggers:
- Per-task tactical lessons (one-off "next time try X")
- Drift findings from `/prism-sync` (orphan agents, schema gaps)
- Tool-usage notes (the right command for a specific scenario)

Bucket: `lessons/YYYY-MM-DD-session.md` (same file as L3, appended).

### L1 NOISE — auto-skipped, never surfaced

Triggers (any one → SKIP):
- Trivial Q&A (single turn, no artifacts changed)
- Read-only exploration (no code/state mutation)
- Routine edits (typo fixes, formatting-only churn)
- Session <10 min wall-clock AND no edits

DO NOT surface L1 items. They go nowhere.

---

## Step 3 — present checklist

Build a single checklist organised by level. Use `AskUserQuestion` if the
checklist is short (≤4 items total) or present as a markdown list and ask
for free-text confirmation if larger.

**Format for each item:**
```
[level] [bucket]/[proposed filename] — <one-line summary>
```

**Defaults:**
- L5 items are pre-checked and labelled `(auto-archive)`. User can rename
  the slug but cannot uncheck without an explicit `--allow-l5-skip` flag.
- L4 items are pre-checked.
- L3 items are unchecked but visible.
- L2 items are unchecked and visible.
- L1 items are NOT shown.

Confirm with the user. Honour any renames or unchecks (within the L5 rule).

---

## Step 4 — write artifacts

For each approved item, write the file with the locked header from
`capture-conventions.md`:

```markdown
# <one-line title>

**Status:** Locked | Proposed | Draft
**Date:** YYYY-MM-DD
**Captured by:** /prism-clean
**Related:** (optional `[[D###]]` pointers)

<body — the LLM-synthesized content of this artifact>
```

**Filename derivation:**
- Adjudications: get next number via `node ~/.claude/tools/prism-clean.mjs next-d-number`. Slug = kebab-cased version of the title (e.g. `auth-middleware-replacement`). Filename: `D###-<slug>.md`.
- Deviations: `YYYY-MM-DD-<agent-name>-deviation.md` (today's date, agent that flagged the deviation).
- Lessons: `YYYY-MM-DD-session.md`. If a file with today's date already exists, APPEND to it under a new `## <session-time>` section instead of clobbering.
- Smoke: `smoke-<topic>.md` (topic = kebab-cased). If the file exists, ask the user whether to append or rename.

**After each D### adjudication file is written**, append a pointer line to the project-master MEMORY.md so the master agent's "Recent decisions" router reflects the new adjudication:

```bash
node tools/prism-clean.mjs append-decision \
  --slug "$(node -e "process.stdout.write(require('fs').existsSync('.claude/.prism-state.json') ? JSON.parse(require('fs').readFileSync('.claude/.prism-state.json','utf8')).project_slug || '' : '')")" \
  --d-number <NNN> \
  --title "<short title verbatim from the D### file heading>"
```

Exit-code handling:
- Exit 6 (`MEMORY.md not found`): the project hasn't been through `/prism-deep-dive` yet — note this in the session summary and skip the pointer step.
- Exit 7 (`anchor not found`): the MEMORY.md exists but lacks a `## Recent decisions` anchor — note this and skip.
- Exit 8 (`>25 KB cap`): suggest `/prism-deep-dive --upgrade <slug>` to re-synthesize the router.
- Exit 5 (`bad args`): the state file is missing or `project_slug` is null — note this and skip.
- Exit 0: success; the master agent will surface the pointer on its next subagent dispatch.

**After each session-lessons entry is appended** to `docs/prism/lessons/YYYY-MM-DD-session.md` (L2–L4 items), mirror the lesson title to the project-master MEMORY.md:

```bash
node tools/prism-clean.mjs append-lesson \
  --slug "$(node -e "process.stdout.write(require('fs').existsSync('.claude/.prism-state.json') ? JSON.parse(require('fs').readFileSync('.claude/.prism-state.json','utf8')).project_slug || '' : '')")" \
  --date "$(node -e "process.stdout.write(new Date().toISOString().slice(0,10))")" \
  --title "<one-line lesson title>"
```

Same exit-code handling as `append-decision` above. Run once per distinct lesson title (not once per file write if multiple lessons land in the same session file).

**Deviation files** (`docs/prism/deviations/`) do not have a MEMORY.md pointer step in v4.0 — D004 §H locked the per-decision + per-session rhythms only. A `append-deviation` subcommand is deferred to a future phase.

**Atomic writes:** use the Write tool for each file. Refuse to overwrite an
existing file unless the user explicitly confirmed a rename.

**Cross-linking:** if the body references prior adjudications (e.g.
`[[D002]]`), include them in the `**Related:**` header line.

---

## Step 5 — summary

Print a final list:

```
✅ Captured X artifacts:
  - L5 adjudication: docs/prism/adjudications/D005-foo.md
  - L4 lesson: docs/prism/lessons/2026-05-25-session.md (appended)
  - L4 smoke: docs/prism/smoke/smoke-postgres-restart.md

⏭ Skipped Y items:
  - L1 noise (Z items)
  - L2 items the user unchecked

Suggested next: `/clear` or `/exit` if your session is wrapping.
```

Do NOT auto-`/clear`. The user owns that decision.

---

## Idempotency

Running `/prism-clean` twice in a row with no new session content between
runs should:
- Detect that previous artifacts are already on disk (filename collision
  check).
- Surface nothing new; report "no additional durable artifacts".
- Be safe to re-run (no destructive side effects).

The lessons-tactical / lessons-strategic files (`tasks/lessons-tactical.md`,
`tasks/lessons-strategic.md`) written by `/prism-bootstrap` phase-structure
are separate — they are sticky append-only logs. `/prism-clean` MAY append
to them if the user explicitly opts a finding in, but the default route for
session lessons is `docs/prism/lessons/YYYY-MM-DD-session.md`.

---

## Failure modes

| Situation | /prism-clean behaviour |
|---|---|
| No `.prism-state.json` | STOP; tell user `/prism-bootstrap` first |
| `git-stats --since <baseline>` returns shape `{commits: 0, files_changed: 0, ...}` AND no panel/deviation in session | Report "no durable artifacts" and exit |
| User unchecks an L5 item without `--allow-l5-skip` | Refuse; explain the auto-archive contract |
| Filename collision | Surface to user; offer rename or append (lessons) |
| Write fails mid-loop | Report which files were written; the slash command does not roll back successful writes |

## Related commands

- `/prism-bootstrap` — initial setup; writes the bucket directories and `capture-conventions.md` rule file.
- `/prism-sync` — refreshes the project index; complements `/prism-clean` (sync = refresh state, clean = capture knowledge).

## Future work (NOT in v3.11.0)

- `/prism-bye` wrapper (= `/prism-clean` + confirm + `/exit`). Deferred — user-driven.
- Auto-fire on `SessionEnd[matcher=clear]` and `PreCompact` — deferred to v4.0 per D004 §6.
- Per-decision and per-session MEMORY.md pointer-append — shipped in v4.0 Phase H (Step 4 above).
