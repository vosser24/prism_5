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
| 6 | project-master   | deterministic (+LLM fallback) | **Default-on** (v5.1); non-interactively creates `master-<slug>` as the session agent. `--no-master` opts out. Falls back to `/prism-deep-dive` only when the slug needs prompting |
| 7 | health           | LLM-judged    | Verify wiring; report green/yellow/red |

**Flags:**
- `--dry-run` — print plan, write nothing
- `--interactive` — confirm between phases
- `--force` — re-run all phases even if state shows them complete
- `--skip-discover` — for projects without DB/API surface
- `--no-master` — opt OUT of phase 6 (project-master). Phase 6 is **default-on** in v5.1 (user decision: all their projects are code; the project-master is the prerequisite for real dispatched panels)
- `--with-deep-dive` — **accepted no-op** (back-compat). project-master is now default-on, so this flag no longer gates phase 6; it is silently ignored

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
- If `CLAUDE.md` is missing → create it from the canonical template below,
  substituting `{name}` / `{domain}` / `{stack}` from the project (read README/
  package.json/etc. to detect them).
- If `CLAUDE.md` exists → read it, count lines, and verify it has a
  `## PRISM Operating Rules` section. If absent, APPEND the template's
  `## PRISM Operating Rules` section at the end (do not reorder existing content).

**Canonical CLAUDE.md template:**

```markdown
# {name}

## Project Identity
- **Domain:** {domain}
- **Stack:** {stack}
- **Related projects:** (list siblings that share infra or conventions, if any)

## PRISM Operating Rules

PRISM is active on this project. These rules govern every prompt.

### 1. Classification — every prompt is tier-routed

The UserPromptSubmit hook classifies each prompt via
`hooks/lib/prism-opus-classifier.mjs` (Opus primary → Sonnet fallback →
24h cache → keyword floor). The classification is written to
`~/.claude/.prism-turn-tier-<session>.json` and drives downstream behaviour.

| Tier | Budget | Who executes | Example |
|---|---|---|---|
| **LIGHTWEIGHT** | ~2k tokens | Parent directly | "What's the flexbox centering syntax?" |
| **ROUTINE** | ~15k tokens | Single subagent (Haiku or Sonnet) | "Review this React component for bugs." |
| **NOVEL** | ~50k+ tokens | Master-orchestrator + expert panel | "Plan a real-time analytics dashboard." |

### 2. Orchestrator pattern — parent plans, subagents execute

The parent conversation (Opus) does: classification, planning, evaluation,
dispatch, synthesis. Subagents do: the actual work (reads, edits, searches,
tests). The mutation-guard (`hooks/prism-mutation-guard.mjs`) and
parent-dispatch-guard (`hooks/prism-parent-dispatch-guard.mjs`) enforce this
boundary for ROUTINE+ tiers:

- Parent calling `Edit`/`Write`/`MultiEdit` directly on ROUTINE/NOVEL tiers
  → blocked with a dispatch-first nudge.
- Subagent calls always pass (detected via `parent_tool_use_id`,
  `CLAUDE_CODE_ENTRYPOINT=subagent`, or `sentinel.dispatched=true`).
- Override for one-shot mutations: prefix prompt with `!opus-force:`.

### 3. Model selection — cheapest viable

Use the cheapest model that clears the quality bar. The
agent-model-guard (`hooks/prism-agent-model-guard.mjs`) nudges you on
every `Agent()` call without an explicit `model` field.

| Work | Model | Cost vs Opus |
|---|---|---|
| Typo fix, rename, docstring, trivial edit | `haiku` | ~1/15 |
| Single-file implementation, standard review | `sonnet` | ~1/5 |
| Cross-cutting architecture, novel domain, adversarial review | `opus` | 1× |

Always pass `model=` explicitly on `Agent()` calls. No default implicit to Opus.

### 4. NOVEL flow — panel of experts + master orchestrator

When the classifier returns `opus` tier OR the prompt contains novel
architectural stakes, the flow is:

1. `@master-orchestrator` is invoked (Opus).
2. It reads `~/.claude/skills/prism-plan/references/model-matrix.md`,
   `roster.json`, `mcp-registry.md`, `tools-registry.md`.
3. It identifies required specialists. For each gap it checks
   `tools-registry.md` FIRST (compose-first — see rule 7).
4. It assembles a panel (3–5 expert subagents, each pick their own stance).
5. It chairs **adversarial review** — every position must survive at least
   two substantive challenges before making the final plan.
6. It presents a phased plan with explicit "Deliberately NOT doing" section
   and waits for user approval.
7. On approval, it dispatches work to subagents in parallel where
   dependencies allow.

### 5. Parallel execution

When you have independent work, send multiple `Agent()` tool uses in a
single message. One turn = N parallel subagents, not N sequential turns.
This is the primary speed lever.

### 6. Memory + context hygiene

The session-start hook runs a daily context tax audit. The
UserPromptSubmit hook counts turns per session and nudges:

- **Turn 15:** `/clear` reminder + `memory-save-nudge` fires (save durable
  lessons to `tasks/lessons-*.md` BEFORE clearing).
- **Turn 20+:** strong `/clear` recommendation — quality degrades in long
  sessions.
- **Every 5 turns after 15:** repeat memory-save nudge.
- **Stop hook:** writes a rich session summary to
  `~/.claude/.prism-sessions/<session_id>.md`.

When you see a memory-save nudge, review the session and write any durable
insights to:
- `tasks/lessons-tactical.md` — code-level patterns, gotchas, fixes
- `tasks/lessons-strategic.md` — architecture decisions, trade-off rationale

### 7. Compose-first (Tier 1 tools)

Before building a new specialist agent, check
`~/.claude/skills/prism-plan/references/tools-registry.md`. If a Tier 1
tool handles the need, invoke it. If not, check Tier 2 and consider
installing via `/prism-recommend`. Only spawn the agent-factory when no
existing tool fits.

### 8. Safety

`hooks/prism-safety.mjs` hard-blocks: `rm -rf`, `DROP TABLE/DATABASE/SCHEMA`,
`TRUNCATE TABLE`, `git push --force`, `mkfs.*`, `dd if=*of=/dev/*`. No
override. Run these manually outside Claude Code if genuinely required.

### 9. Persistence + evolution

- `~/.claude/.prism-routing.jsonl` — every hook decision appended here. Use
  `tools/prism-monitor` to tail it.
- `skills/prism-plan/references/roster.json` — agent usage counts,
  effectiveness, last-used dates. Updated by `hooks/prism-subagent-stop.mjs`.
- `/prism-roster` — inspect the roster.
- `/prism-health` — overall PRISM state.
- `/prism-retire @name` — archive unused specialists.
- `/prism-update` — self-update (model-matrix, registries) every ~15 days.

### 10. CLAUDE.md sizing discipline

This file is a **routing table, not a knowledge base**. Claude Code loads
every CLAUDE.md along the path from cwd up on every turn, so growth here
is paid on every prompt forever. Detail lives elsewhere.

- **Target: ≤200 lines for this root CLAUDE.md.** Over that, move
  detail OUT to one of the destinations below.
- **What stays here:** project identity, stack summary, operating
  rules, build/test/lint commands, 1–2 line routing pointers like
  *"for DB schema, read `.claude/references/db-index.md`"*.
- **What moves OUT:**
  - Indexed scans (DB schema, codebase map, API specs) →
    `.claude/references/<domain>-{index,full}.md` via `/prism-discover`.
  - Subdomain-specific conventions (backend vs frontend stack rules) →
    nested `CLAUDE.md` in that subdir (auto-loaded only when working
    there — not always-on). `/prism-discover` detects candidates.
  - Accumulated code-level lessons → `tasks/lessons-tactical.md`
    (append-only).
  - Architecture decisions + trade-off rationale → `tasks/lessons-strategic.md`.
  - Per-session recap → written by the Stop hook to
    `~/.claude/.prism-sessions/<session_id>.md`.
  - Personal overrides that must not be committed → `CLAUDE.local.md`
    (gitignored).
- **Nested CLAUDE.md files** (only when subdomains diverge):
  - Each stays ≤100 lines.
  - Covers ONLY what differs from root — never repeats project-wide
    rules (those cascade from root automatically).
  - `/prism-discover` proposes nested files when it detects distinct
    tech-stack subdomains; user approves per-subdomain.
  - Scaffolded subdomain map lives at `.claude/references/subdomain-map.md`.
- **Health check:** `/prism-discover --check-claude-chain` walks the
  repo and warns on size or duplication violations.

## Build / Test / Lint

(fill in per stack — `npm run dev`, `pytest`, `ruff`, etc. Keep to the
exact shell commands PRISM subagents should run — nothing else.)

## Conventions

(Project-wide conventions that apply everywhere. Subdomain-specific
ones go in nested `CLAUDE.md` files if needed.)
```
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

### Phase 6 — project-master (default-on; `--no-master` opts out)

This phase **runs by default** (v5.1). The project-master (`master-<slug>`) is
wired as the session agent — the prerequisite for real dispatched panels
(STEP 0 spike: dispatch is main-loop-only, so the chair must be the
session-level agent). The user opts out with `--no-master`.

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-project-master`

The helper does the whole thing **non-interactively**: slug-derive →
agent-write → memory-seed (fresh only, never clobbers a learned MEMORY.md) →
settings-write. It is idempotent (re-running skips an existing agent and
preserves its learned router).

Outcomes:
- **Exit 0, "master-`<slug>` wired as session agent"** → phase complete. The
  agent file, seeded MEMORY.md, and `settings.json` `agent:` field are all in
  place. Nothing more to do.
- **Exit 0, "slug needs user prompting"** → the project basename is generic
  and there's no CLAUDE.md identity to derive a slug from, so the helper did
  NOT mark the phase complete. Invoke `/prism-deep-dive` yourself (as the
  bootstrap slash command) to drive the AskUserQuestion slug turn and finish
  the agent generation. Do not leave the user with a half-built master.
- **"skipped via --no-master"** → the user opted out. Surface a one-line nudge
  at the end of bootstrap: *"project-master skipped (--no-master). Run
  `/prism-deep-dive` any time to create it."*

### Phase 7 — health

Goal: verify wiring; produce a green/yellow/red report; offer the v4.1 telemetry opt-in if not yet set.

#### Step 7a — wiring checks

Invoke the existing `/prism-health` checks. Report status to the user.

#### Step 7b — telemetry consent prompt (v4.1 Phase C / Q10)

If the bootstrap was invoked with `--no-telemetry`, run the durable opt-out FIRST and then skip the prompt:

```bash
node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent off
```

This writes `opt_in: false` + `asked_at: <ISO>` to `~/.claude/prism-policy.json` so subsequent bootstraps see the value as set and don't re-prompt. Proceed to Step 7c without prompting; the meta `telemetry_opt_in` value will be `false`.

Otherwise (no `--no-telemetry` flag):

```bash
node ~/.claude/tools/prism-bootstrap.mjs detect-telemetry-consent
```

Branch on the returned JSON:

- `forced_off_by_env: <VAR>` → the environment has `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` set; effective `opt_in` is locked to `false`. Persist as durable opt-out (also writes `prism-policy.json` with `opt_in:false`) and skip the prompt. Tell the user briefly that the env var has been honored.
- `opt_in: true | false`  → already configured; skip the prompt (re-asking is annoying).
- `parse_error: <message>` → tell the user `~/.claude/prism-policy.json` is malformed and skip the prompt. Suggest fix-and-rerun.
- `opt_in: null` (and no `parse_error`) → prompt:

  > **Enable PRISM telemetry?** PRISM writes a local routing log at `~/.claude/.prism-routing.jsonl` (**no network, ever**). Optional: aggregate it into `~/.claude/.prism-telemetry-rollup.json` so the `prism-updater` agent can surface guard-tuning candidates during `/prism-update` runs. **Default: off** — telemetry is opt-in. Honors `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1`. The rollup is plain JSON inspectable with `jq`; you can flip this any time via `/prism-telemetry --opt-in` or `--opt-out`.

  Use AskUserQuestion with two options (default-off is the first / recommended position):

  - **Keep telemetry off (default)** → `node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent off`
  - **Enable local-only telemetry** → `node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent on`

  Both branches write to `~/.claude/prism-policy.json` under `telemetry.opt_in`. Either way the bootstrap proceeds — the choice is durable; you ask once per machine, never again.

#### Step 7c — complete

Complete with meta: `{"health_status": "green"|"yellow"|"red", "checks_passed": N, "checks_failed": N, "telemetry_opt_in": true|false}`. (The v2 sentinel `status` is reserved for the orchestrator's phase state.)

---

## Step N — final report

Run: `node ~/.claude/tools/prism-bootstrap.mjs status`

Then summarize for the user:

- ✅ Phases completed this run
- ⚠ Phases skipped (and why — especially project-master if `--no-master` was passed)
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

### Step N.2 — claude-mem memory-tier offer (opt-in, v5.1)

`claude-mem` (`thedotmack/claude-mem`) is an **optional ambient-memory tier**:
it captures every session continuously and re-injects context at SessionStart.
PRISM treats it like the NotebookLM free-research tier — **offered, never
required**. Its presence selects PRISM's memory mode (see *Memory modes* below).

After the statusline step, detect it:

```bash
node ~/.claude/tools/prism-bootstrap.mjs detect-claude-mem
```

The helper prints `{"installed": true|false}` (signal = the `~/.claude-mem/`
data dir, with a settings.json reference as a corroborating fallback).

Behaviour by branch:

- **`installed: true`** → **Mode A** is active. Say one line: *"claude-mem
  detected — it owns ambient session memory; PRISM's save-nudge stands down
  and `/prism-clean` stays manual."* Do not offer anything.
- **`installed: false`** → **Mode B** is the default. Offer the install via
  `AskUserQuestion`: *"PRISM can run with `claude-mem` for continuous ambient
  memory (auto-capture + auto-reload across sessions). Install it now?"* —
  options (default-first):
  - **Keep PRISM-native memory (default)** → log: *"staying on Mode B —
    PRISM's save-nudge stays active and `/prism-clean` folds session
    summaries into your project-master MEMORY.md. Nothing is lost."*
  - **Install claude-mem** → run `npx claude-mem install` (Node ≥20 + Bun are
    auto-handled by its installer). On success, note that PRISM has switched to
    Mode A for subsequent sessions; on failure, surface the error and remain on
    Mode B.

**Never auto-install.** Like the statusline, this is opt-in convenience.

If `--dry-run` was passed: print the detect-claude-mem output and a one-line
*"would offer install if not in dry-run"* note; prompt nothing.

---

## Memory modes (Mode A / Mode B)

PRISM's session-memory behaviour is **two-mode**, selected at runtime by
whether `claude-mem` is installed (`~/.claude-mem/`). Nothing is lost either
way — the modes are mutually exclusive fallbacks, not a feature gate.

| | **Mode A — claude-mem present** | **Mode B — claude-mem absent (default)** |
|---|---|---|
| Ambient capture | claude-mem captures continuously + reloads at SessionStart | PRISM's `memory-save-nudge` reminds you to capture before `/clear` |
| Save nudge | **Stands down** (claude-mem already injects + reminds) | **Active** |
| `/prism-clean` | Manual; the MEMORY.md session-summary fold is redundant (skip it) | Manual; folds a one-line session summary into `master-<slug>` MEMORY.md `## Session log` via `append-summary` |
| Durable router | claude-mem store + project-master MEMORY.md | project-master MEMORY.md (decisions / lessons / session log) |

Switching is automatic: install claude-mem → next session runs Mode A; remove
it → back to Mode B. `/clear` fires `SessionEnd`+`SessionStart` (not
`PreCompact`), so capture always happens *during* the session (nudge +
`/prism-clean`), and reload is automatic (subagent MEMORY.md auto-injects).

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
