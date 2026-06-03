# Design — scope-aware agent survival (auto-archive of project-orphaned specialists)

**Status:** Approved (brainstormed 2026-06-03) · **Target:** PRISM v5.2.0 · **Adjudication:** [[D008]]

## Problem

Every talent-pool specialist (`coffee-ledger-expert`, `debt-settlement-algo-expert`, …) is created into the **global** pool (`~/.claude/agents/` + global `roster.json`), even when it only applies to one project. Only the project-**master** (`master-<slug>`) is project-local. Result: project-specific specialists accumulate in the global pool forever, with no lifecycle tying them to the project they were built for.

## Decision (from brainstorming)

Give the agent's **creator** a deliberate scope decision at creation, and make scope drive **retirement lifecycle only** (storage/visibility unchanged — everything stays global):

- `scope: "broad"` — reusable; **protected**, never auto-archived.
- `scope: "project"` — targeted to one app; **auto-archived** (reversibly) once its home project is gone or stale.

User chose **auto-archive immediately** (most aggressive pollution control) over nudge-only. This is the **first mutating action in the freshness sweep** (every other check is nudge-only), so it bends the locked "detect automatically, execute manually" principle — recorded + justified in [[D008]] with the safety rails below.

## Schema (roster.json agent entry)

New fields (added to `_schema_example_agent`):
- `scope`: `"broad" | "project"`. **Absent ⇒ treated as `broad`** (safe default; unknown never auto-archives).
- `home_project`: slug string (for `project` scope; display + audit).
- `home_project_path`: absolute path to the project root (the authority for the staleness/absence probe; recorded at creation so no fragile slug→path registry is needed).
- `archived`, `archived_at`, `archived_reason`: set when auto-archived. Entry is **retained** (never deleted) for restore + audit.

## Creation — the master declares scope (the core ask)

- `agent-factory` records `scope` (+ `home_project`/`home_project_path` for `project`) into the roster entry it already writes. Omitted ⇒ `broad`.
- A rule added to `agents/agent-factory.md` and the master-orchestrator commissioning step: *"Declare `scope: project:<slug>` if the agent only applies to this codebase; `broad` if it's reusable. Project-scoped agents are auto-archived when their project is gone."*

## Survival evaluation (pure, testable) — `tools/lib/prism-agent-scope.mjs`

`projectStatus({homePath, dirExists, parentExists, lastSyncMs, now, staleDays})` →
- no `homePath` ⇒ `unknown`
- dir exists & fresh ⇒ `present`
- dir exists & `last_sync_at` older than `staleDays` ⇒ `stale`
- dir gone, **parent reachable** ⇒ `absent`
- dir gone, **parent/mount gone** ⇒ `unreachable` (SMB guard)

`evaluateSurvival(roster, statusFn)` → `{archive: [{name, reason}]}`. Only `scope:"project"`, non-`archived` agents are eligible; `absent`/`stale` ⇒ archive; `present`/`unreachable`/`unknown`/broad ⇒ keep.

## Execution — in the 24h freshness sweep (`prism-freshness-sweep.mjs`)

New check `checkProjectScopedSurvival(home, now, apply)`:
- Builds a real `statusFn` (FS probes: `existsSync(homePath)`, `existsSync(dirname(homePath))`, read `<homePath>/.claude/.prism-state.json` `last_sync_at`). `staleDays` from `PRISM_AGENT_PROJECT_STALE_DAYS` (default 90).
- `apply:false` (dry-run) ⇒ returns a "would archive" notice, **no mutation** (keeps `freshnessSweepDryRun` read-only).
- `apply:true` (real sweep) ⇒ for each target: **move** `~/.claude/agents/<name>.md` → `~/.claude/agents/retired/<name>.md` (never delete), set `archived:true/at/reason` on the retained roster entry, atomic-write roster. Returns a **notify-after** notice listing what was archived + how to restore.

### Safety rails (the justification for bending the manual-execution rule)
1. **Reversible** — file is *moved* to `retired/`, roster entry *retained*. No deletion, ever.
2. **SMB guard** — `unreachable` (whole share/parent offline) is NOT archived → prevents mass false-archiving when `//grhqecomm/…` is unmounted.
3. **Broad-protected + safe default** — only explicit `scope:"project"` is eligible; unknown/absent scope ⇒ broad ⇒ never touched.
4. **Notify-after** — even though automatic, the sweep surfaces what it archived + the restore path.
5. **Throttled, no hot-path cost** — rides the existing 24h sweep.

## /prism-roster

Display each agent's `scope` (`broad` / `project:<slug>`); list/append archived agents separately. Restore (v1): move `retired/<name>.md` back + clear `archived`; a first-class `--restore` is a follow-up.

## Rollout

- Backfill: existing agents have no `scope` ⇒ default `broad` (no surprise archiving). Re-declaring the coffee specialists as `project` is **manual/opt-in**, not part of v1.
- Tests (TDD): the pure lib (status classification + eval) and the sweep integration (broad-kept, project+absent-archived, project+unreachable-kept[SMB], project+fresh-kept, dry-run-no-mutation, restore round-trip).

## Out of scope (deferred)
- First-class `/prism-roster --restore`.
- Project-local storage for targeted specialists (the "Isolate it" option) — bigger; revisit if lifecycle-only proves insufficient.
