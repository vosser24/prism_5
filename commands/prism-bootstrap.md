---
name: prism-bootstrap
description: One-command PRISM bootstrap — drives the 5-phase state machine from "no PRISM" to "fully operational." Idempotent. Replaces /prism-init + /prism-discover + /prism-roster --reconcile + /prism-health.
---

# /prism-bootstrap — v3.10.0 unified bootstrap

Locked design: `docs/prism/adjudications/D001-bootstrap-unification.md`,
`docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md`. Schema lives in
`tools/lib/prism-state.mjs`. Phase machine is driven by
`tools/prism-bootstrap.mjs` (deterministic ops) plus the LLM-judged steps
described below.

**Phases (locked schema, ordered):**

| # | Phase     | Kind         | Notes |
|---|-----------|--------------|-------|
| 1 | identity  | LLM-judged   | Audit/create CLAUDE.md |
| 2 | structure | deterministic | Helper creates dir tree + capture-conventions.md |
| 3 | discovery | LLM-judged   | Codebase + DB + API scan |
| 4 | roster    | LLM-judged   | Reconcile orphan agents |
| 5 | health    | LLM-judged   | Verify wiring; report green/yellow/red |

**Flags:**
- `--dry-run` — print plan, write nothing
- `--interactive` — confirm between phases
- `--force` — re-run all phases even if state shows them complete
- `--skip-discover` — for projects without DB/API surface

---

## Step 0 — git guard

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: prompt the user before proceeding (PRISM agents need a
git repo for worktree isolation). If they confirm: `git init`.

If `--dry-run`: report "would init git" instead of running.

## Step 1 — load or initialize state

Run: `node ~/.claude/tools/prism-bootstrap.mjs init-state-if-missing "<project-name>"`

The helper:
- If `.claude/.prism-state.json` exists and is valid → no-op.
- If `.claude/` is already populated (v3.8.9 install) → synthesizes state
  from the filesystem (`detect-and-adopt`), marking phases whose evidence
  is on disk as `completed_at: now, synthesized: true`.
- Otherwise → writes a fresh initial state.

Then run: `node ~/.claude/tools/prism-bootstrap.mjs plan [--force] [--skip-discover]`

The output JSON has:
- `pending`: phases that still need running, in order
- `completed`: phases already done
- `last_command`: non-null means a previous run crashed mid-phase
- `phase_failures`: recent failures (capped at 10)

If `pending` is empty → report "all phases complete; use /prism-sync for
ongoing maintenance" and exit.

If `last_command` is set → tell the user the previous run did not finish,
and the next phase will pick up where it stopped.

If `--interactive` was passed: confirm the plan with the user before any
phase mutates files.

---

## Phase execution loop

For each phase in `pending`, in order:

1. Mark start: `node ~/.claude/tools/prism-bootstrap.mjs start-phase <name>`
2. Run the phase-specific work (see sections below).
3. On success: `node ~/.claude/tools/prism-bootstrap.mjs complete-phase <name> --meta '<json>'`
4. On failure: `node ~/.claude/tools/prism-bootstrap.mjs fail-phase <name> "<error>"` — then STOP. Do NOT roll back prior phase writes (D001 §Robustness #4: failure isolation).

If `--dry-run`: skip the deterministic helper writes; print what would happen.

---

### Phase 1 — identity

Goal: ensure `CLAUDE.md` exists and is well-formed.

Logic:
- If `CLAUDE.md` is missing → invoke the existing `/prism-init` FAST-mode
  template logic (see `commands/prism-init.md` Step 3). DO NOT re-implement;
  reuse that template verbatim.
- If `CLAUDE.md` exists → read it. Count lines. Verify it has a `## PRISM
  Operating Rules` section. If absent, append the template per `/prism-init`
  Step 2's "append, don't reorder" rule.
- Report line count.
- Soft warning if line count exceeds 200 (D001 phase 7 calls for ≤200; the
  CLAUDE.md update phase 7 is folded into the discovery refinement step).

Complete with meta: `{"claude_md_lines": N, "had_existing": true|false}`.

### Phase 2 — structure

Goal: create the **complete** PRISM project scaffold in one shot. Scope is
locked by `docs/prism/adjudications/D003-bootstrap-scaffold-scope.md` (which
supersedes D001's narrower structure-phase table).

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-structure`
Then:  `node ~/.claude/tools/prism-bootstrap.mjs phase-conventions`

Both are idempotent. The structure helper creates:

```
.claude/references/   .claude/rules/      .claude/agents/
.claude/hooks/        .claude/skills/     .claude/commands/
docs/prism/adjudications/   docs/prism/deviations/
docs/prism/lessons/         docs/prism/smoke/
tasks/

# seed files — written only when absent, never overwritten:
tasks/todo.md   tasks/lessons-tactical.md   tasks/lessons-strategic.md
.mcp.json       CLAUDE.local.md

# .gitignore — created, or PRISM block appended once if it already exists
```

The conventions helper writes `.claude/rules/capture-conventions.md` if
absent (the rule file `/prism-clean` consumers expect to find).

Both `complete-phase structure` calls are folded — the helper handles the
state write itself.

If `--dry-run`: pass `--dry-run` to both helper calls; helper prints
"DRY-RUN: would write state" and skips every disk write.

Note: this phase only *creates* directories. Populating `.claude/agents/`
(roster phase), `.claude/skills/` + `.claude/references/` (discovery phase),
and global-memory pointers in CLAUDE.md (identity phase) happens in those
later phases — see D003 §"Populating skills, agents, and global memory".

### Phase 3 — discovery

Goal: scan codebase + DB + API into `.claude/references/`.

If `--skip-discover`: log "skipped per --skip-discover" and continue.

Otherwise: invoke the existing `/prism-discover` logic (parallelized
codebase scan + schema introspection + API surface). DO NOT re-implement.

Skip-condition: D001 §Phases table says skip if last successful run < 24h
unless `--force`. Implement this by checking `state.phases.discovery.completed_at`:

```js
const last = new Date(state.phases.discovery.completed_at);
const ageMs = Date.now() - last.getTime();
if (ageMs < 24 * 3600_000 && !opts.force) skip;
```

Complete with meta: `{"references_count": N, "tables_indexed": N, "endpoints_indexed": N}`.

### Phase 4 — roster

Goal: reconcile orphan agents (agents installed in `~/.claude/agents/` but
not in this project's `.claude/agents/roster.json`).

Invoke the existing `/prism-roster --reconcile` logic. Surface dual-form
matches (e.g., `app-expert` vs `nexus-expert`) for user choice — D001
phase 6 explicitly gates here: "**confirm before roster.json write**".

If `--interactive`: hold for user confirmation.

Complete with meta: `{"agents_registered": N, "orphans_remaining": N}`.

### Phase 5 — health

Goal: verify wiring; produce a green/yellow/red report.

Invoke the existing `/prism-health` checks. Report status to the user.

Complete with meta: `{"health_status": "green"|"yellow"|"red", "checks_passed": N, "checks_failed": N}`. (The v2 sentinel `status` is reserved for the orchestrator's phase state.)

---

## Step N — final report

Run: `node ~/.claude/tools/prism-bootstrap.mjs status`

Then summarize for the user:

- ✅ Phases completed this run
- ⚠ Phases skipped (and why)
- ❌ Phases that failed (and where they're recorded)
- Suggested next action: `/prism-sync` (when implemented) for maintenance,
  or `/prism-clean` before /exit to capture session lessons.

If new files were written: show `git status --short` and ask the user
whether to stage and commit. **Do not auto-commit** (D001 phase 9 gate).

---

## Crash resume semantics

If invoked when `last_command` is non-null in state:
- The helper's `plan` includes the failed phase as the first pending entry.
- Phase work resumes from there. Earlier completed phases are preserved.
- After the resumed phase succeeds, `last_command` is automatically cleared.

## Idempotency contract

Re-running `/prism-bootstrap` on a project that is already fully bootstrapped
must:
- Produce no destructive changes.
- Produce no duplicate roster entries.
- Leave the state file's `phases[*].completed_at` advanced (timestamps
  refresh) but the schema valid and checksum correct.
- Produce a final report saying "all phases complete; no changes needed."

`--force` is the only way to re-run already-completed phases.

## Subsumed commands (D002 §3)

`/prism-bootstrap` subsumes the workflow of:
- `/prism-init` (now identity phase)
- `/prism-discover` (now discovery phase)
- `/prism-roster --reconcile` (now roster phase)
- `/prism-health` (now health phase)

These commands remain functional but are hidden from `/prism-help` per D002.
Users who explicitly invoke them still get the underlying behaviour.

## Failure modes

| State status | Bootstrap behaviour |
|--------------|---------------------|
| `ok` | Normal phase loop |
| `missing` | `init-state-if-missing` runs first |
| `invalid_json` / `invalid_schema` / `checksum_mismatch` | STOP. Tell the user to back up `.claude/.prism-state.json` and run `/prism-bootstrap --reset-state` (deferred to v3.10.1 if not yet implemented) — for now, manual: delete the file and re-run. |
| `unreadable` | STOP. Permission/IO issue — surface to user. |
