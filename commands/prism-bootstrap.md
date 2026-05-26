---
name: prism-bootstrap
description: One-command PRISM bootstrap — drives the 7-phase state machine from "no PRISM" to "fully operational." Idempotent. Replaces /prism-init + /prism-discover + /prism-roster --reconcile + /prism-health.
---

# /prism-bootstrap — v3.11.0 unified bootstrap

Locked design: `docs/prism/adjudications/D001-bootstrap-unification.md`,
`docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md`,
`docs/prism/adjudications/D004-v4-product-vision.md` (Phase B brought the
schema from v1's 5 phases to v2's 7 phases). Schema lives in
`tools/lib/prism-state.mjs`. Phase machine is driven by
`tools/prism-bootstrap.mjs` (deterministic ops) plus the LLM-judged steps
described below.

**Phases (locked schema, ordered):**

| # | Phase            | Kind          | Notes |
|---|------------------|---------------|-------|
| 1 | identity         | LLM-judged    | Audit/create CLAUDE.md |
| 2 | structure        | deterministic | Helper creates dir tree + capture-conventions.md |
| 3 | plugin-validate  | deterministic | v3.11.0 sentinel stub; `/prism-validate-plugins` runs the real validator |
| 4 | discovery        | LLM-judged    | Codebase + DB + API scan |
| 5 | roster           | LLM-judged    | Reconcile orphan agents |
| 6 | project-master   | LLM-judged    | **Opt-in only** (`--with-deep-dive`); generates `master-<slug>` agent via `/prism-deep-dive` |
| 7 | health           | LLM-judged    | Verify wiring; report green/yellow/red |

**Flags:**
- `--dry-run` — print plan, write nothing
- `--interactive` — confirm between phases
- `--force` — re-run all phases even if state shows them complete
- `--skip-discover` — for projects without DB/API surface
- `--with-deep-dive` — opt-in to phase 6 (project-master); default is skipped (D004 §8)

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
  is on disk as `completed_at: now, synthesized: true`. The v2-only phases
  (`plugin-validate`, `project-master`) are never auto-synthesized — they
  have no filesystem signal under v3.8.9 (D004 §4).
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

### Phase 3 — plugin-validate

Goal: surface plugin-installation problems before later phases depend on
them. v3.11.0 ships a **sentinel stub**; the full validator lives in
`/prism-validate-plugins` (D004 Phase C).

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-plugin-validate`

What the stub does today:
- Marks the `plugin-validate` phase complete with `{stub: true, note: ...}`
- Writes a one-line status: *"plugin-validate phase: stub (Phase C wires the real validator)"*
- Lets the 7-phase planner advance past plugin-validate on idempotent reruns

What `/prism-validate-plugins` does when invoked directly:
- Shells out to `claude plugin list --json`
- Reports broken hooks, missing manifests, skill-name conflicts, MCP reachability
- **Report-only** in v3.11.0; `--fix` is deferred to v3.12.0 (D004 risk #5)

If the stub fails (no `phase-plugin-validate` subcommand on this build):
treat as a Phase B install drift — stop and surface the version mismatch
to the user.

Complete with meta: `{"stub": true, "note": "Phase C will populate plugin reachability + version drift checks."}`.

### Phase 4 — discovery

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

### Phase 5 — roster

Goal: reconcile orphan agents (agents installed in `~/.claude/agents/` but
not in this project's `.claude/agents/roster.json`).

Invoke the existing `/prism-roster --reconcile` logic. Surface dual-form
matches (e.g., `app-expert` vs `nexus-expert`) for user choice — D001
phase 6 explicitly gates here: "**confirm before roster.json write**".

If `--interactive`: hold for user confirmation.

Complete with meta: `{"agents_registered": N, "orphans_remaining": N}`.

### Phase 6 — project-master (opt-in via --with-deep-dive)

This phase is **skipped by default** (D004 §8). To run it, the user invoked
`/prism-bootstrap --with-deep-dive` OR runs `/prism-deep-dive` directly.

Two paths:

**Path A — opt-in via bootstrap flag:**

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-project-master --with-deep-dive`

Outcomes:
- Exit 0 with "slug locked" message → phase complete (slug recorded in
  state; the actual agent generation happens when the user runs
  `/prism-deep-dive` to drive the AskUserQuestion turn).
- Exit 0 with "slug needs user prompting" message → tell the user to run
  `/prism-deep-dive` directly. Do NOT try to AskUserQuestion in the bootstrap
  flow — that's the deep-dive slash command's responsibility.
- Exit 6 ("opt-in") → the user passed `--with-deep-dive` but the bootstrap
  helper didn't honor it. Re-check the invocation.

After the helper returns, **invoke /prism-deep-dive yourself** (as the
bootstrap slash command) to complete the agent generation. Do not leave the
user with a half-built master.

**Path B — direct deep-dive (recommended for clarity):**

If the user did NOT pass `--with-deep-dive`, the planner skips this phase
silently. Surface a one-line nudge at the end of bootstrap:

  *"To create your project-master agent, run `/prism-deep-dive`."*

Per D004 §8, this is the opt-in default. Do NOT auto-prompt or auto-run.

### Phase 7 — health

Goal: verify wiring; produce a green/yellow/red report.

Invoke the existing `/prism-health` checks. Report status to the user.

Complete with meta: `{"health_status": "green"|"yellow"|"red", "checks_passed": N, "checks_failed": N}`. (The v2 sentinel `status` is reserved for the orchestrator's phase state.)

---

## Step N — final report

Run: `node ~/.claude/tools/prism-bootstrap.mjs status`

Then summarize for the user:

- ✅ Phases completed this run
- ⚠ Phases skipped (and why — especially project-master if `--with-deep-dive` was not passed)
- ❌ Phases that failed (and where they're recorded)
- Suggested next action: `/prism-sync` for ongoing maintenance,
  or `/prism-clean` before /exit to capture session lessons.

If new files were written: show `git status --short` and ask the user
whether to stage and commit. **Do not auto-commit** (D001 phase 9 gate).

### Step N.1 — statusline offer (opt-in, v4.0)

After the status summary, check whether the PRISM statusline is installed:

```bash
node ~/.claude/tools/prism-bootstrap.mjs detect-statusline
```

The helper prints a JSON report:

```json
{
  "settings_path": "<HOME>/.claude/settings.json",
  "settings_exists": true|false,
  "settings_parse_error": null,
  "installed": true|false,
  "source_script_path": "<HOME>/.claude/statusline-command.sh",
  "source_script_exists": true|false
}
```

Behaviour by branch:

- **`installed: true`** → say nothing. Already wired.
- **`installed: false` AND `source_script_exists: true`** → ask the user via
  `AskUserQuestion`: *"PRISM ships a multi-line statusline (model / git /
  cost / context bar / rate limits). Install it now?"* — options: *Install*
  (recommended) / *Skip for now*.
  - On *Install*: run
    `node ~/.claude/tools/prism-bootstrap.mjs install-statusline`
    and report the patched path. (The helper refuses to overwrite an
    existing `statusLine` value — that's the `exit 11` guard. To overwrite
    deliberately, pass `--force`.)
  - On *Skip*: log "statusline skipped — re-run /prism-bootstrap any time
    to revisit" and continue.
- **`installed: false` AND `source_script_exists: false`** → log the gap
  ("statusline script not on disk; run `scripts/install-statusline-only.sh`
  if you want the standalone install") and do **not** prompt. The
  `install-statusline` helper would exit 12 in this state.
- **`settings_parse_error` non-null** → STOP. Surface the parse error to
  the user; do not attempt the install. They need to fix
  `~/.claude/settings.json` first.

**Never silently write** the statusline. The whole point of folding this
into bootstrap is opt-in convenience; auto-write would be a behavioural
regression vs v3.11.0 and earlier. (D001 phase 9 gate — confirm before
mutating user config.)

If `--dry-run` was passed to `/prism-bootstrap`: skip the prompt; just
print the detect-statusline output and a one-line *"would offer install
if not in dry-run"* note.

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
