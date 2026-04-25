---
name: prism-roster
description: Display and manage the PRISM agent talent pool
---

Usage:
  /prism-roster                → display mode (default — all agents)
  /prism-roster --team <id>    → display only agents with matching team_id (v3.1+)
  /prism-roster --reconcile    → scan ~/.claude/agents/ and register any orphan agent files in roster.json

## Default mode (no args)

Read `~/.claude/skills/prism-plan/references/roster.json`.

Display table: Agent | Version | Domains | Tasks | Corrections | Status | Last Used | Team

(Team column added v3.1+. Shows `team_id` field if set, blank otherwise.)

## --team `<id>` filter (v3.1+)

When `--team <id>` is passed, filter the display table to ONLY agents whose `team_id` matches `<id>` exactly. Use `--team null` or `--team -` to show only agents with no team (`team_id: null` or absent). The Team column is then implicit and can be omitted from the display.

This is a *visibility* lever, not an *access-control* lever. Any user with read access to roster.json sees every agent regardless of team_id. Tier 3 enterprise installs that need real RBAC must layer their own auth on top — outside PRISM's scope.

If agents have `pending_upgrade: true`, suggest running upgrades.
If agents not used in 180+ days: flag as "Stale — consider /prism-retire".

Show cost summary if available:
"Agent creation costs: Tier 1 (NotebookLM): N agents ($0.00) | Tier 3: N agents (~$X)"

After display, update PRISM line in `~/.claude/CLAUDE.md`:
"{N} agents available. Use @master-orchestrator or /prism-plan for complex tasks."

If `~/.claude/agents/` contains agent files not in `roster.json`, flag them at
the end of the display as **orphans** and suggest `/prism-roster --reconcile`.

---

## Reconcile mode (`--reconcile`)

Purpose: reconcile orphan agent files (files on disk but missing from
`roster.json`). This happens when agents are created outside `agent-factory`
(manual creation, imported from another PRISM install, legacy pre-v2.7
agents, or a mid-creation `agent-factory` crash). Reconcile is **additive
only** — it never modifies or removes existing roster entries.

### PROTOCOL

**Step 1 — Read current roster.**

```
ROSTER_PATH = ~/.claude/skills/prism-plan/references/roster.json
```

If the file doesn't exist, create it with this skeleton and continue:

```json
{
  "schema_version": 2,
  "agents": {}
}
```

**Step 2 — Discover agent files on disk.**

Scan `~/.claude/agents/` for agent definition files. PRISM supports two layouts:

- **Flat**: `~/.claude/agents/<name>.md`
- **Subdir**: `~/.claude/agents/<name>/agent.md` (with optional `references/` alongside)

For each layout, collect the agent name (the file's base name, or the subdir
name — NOT the path).

**Core agents always skipped** — these are PRISM-owned, never user specialists:
- `agent-factory`
- `master-orchestrator`
- `prism-updater`

**Step 3 — Compute orphan set.**

For each discovered agent name, check if `roster.agents[<name>]` exists.
If absent, it's an orphan candidate.

If orphan set is empty: print `"Roster already reconciled — 0 orphan(s) found."` and exit.

**Step 4 — Backup roster before writing.**

Copy `ROSTER_PATH` to `ROSTER_PATH + '.bak'` (overwrite any existing .bak
— single-generation safety net is enough; user's git is the real history).

**Step 5 — For each orphan, read frontmatter and build a roster entry.**

Read the agent file. Parse YAML frontmatter between the first two `---` lines.
Extract (with defaults if missing):

| Field | Source | Default |
|---|---|---|
| `name` | frontmatter `name:` | filename base (orphan name) |
| `description` | frontmatter `description:` | `"(reconciled — no description in frontmatter)"` |
| `model_hint` | frontmatter `model:` (if present, e.g. `opus`/`sonnet`/`haiku`) | `null` |
| `domains_hint` | frontmatter `core_domains:` or `domains:` (if present, as array) | parsed from description as a rough guess, fallback `["uncategorized"]` |

**Creation date fallback chain** (use first that succeeds):
1. `git log --diff-filter=A --follow --format=%aI -- <file>` first line
2. File mtime via `stat` (`ls -la --time-style=full-iso`)
3. Current ISO timestamp (last resort — note this in the action log)

Build the roster entry:

```json
{
  "created": "<creation-date-iso>",
  "last_upgraded": "<creation-date-iso>",
  "version": 1,
  "core_domains": <domains_hint>,
  "tools_known": [],
  "total_tasks_completed": 0,
  "total_corrections_received": 0,
  "corrections_since_last_upgrade": 0,
  "consecutive_successful_sonnet_tasks": 0,
  "default_model": <model_hint>,
  "pending_upgrade": false,
  "status": "available",
  "notebooklm_notebook_id": null,
  "file_path": "~/.claude/agents/<name>.md | ~/.claude/agents/<name>/agent.md",
  "source": "reconcile"
}
```

The `"source": "reconcile"` field distinguishes these from entries created
via `agent-factory` (which writes `"source": "agent-factory"` — any agent
without this field is assumed factory-created for back-compat).

**Step 6 — Write updated roster.json.**

Merge the new entries into `roster.agents` and write the file back. Format
with 2-space indent. **Do not touch any existing entry** — additive only.

**Step 7 — Report to the user.**

Print, in this exact form:

```
Reconciled N agent(s):
  - <name>: domains=<...>, model=<...>, created=<iso>
  - <name>: ...

Roster now has M total agents (N reconciled + <pre-existing>).
Backup: ~/.claude/skills/prism-plan/references/roster.json.bak

Next steps:
  - If any default_model is wrong, edit roster.json directly (adjust `default_model` field).
  - If any core_domains is "uncategorized", add domains to the agent's frontmatter and re-run reconcile.
  - Run /prism-health to confirm roster drift warning is cleared.
```

### Safety rules (do not violate)

1. **Additive only.** Never modify an existing `roster.agents[<name>]` entry.
   If an orphan name collides with an existing entry, skip it and warn.
2. **Always backup first.** Never write to `roster.json` without first
   copying to `.bak`.
3. **Never invent data.** If frontmatter is missing, use the documented
   default — do not guess domains from file content or agent behavior.
4. **Subagent-compatible.** This command can be executed by the parent
   Opus directly (low-stakes metadata operation, no external calls).
5. **Idempotent.** Running `--reconcile` twice with no new orphan files is
   a no-op — step 3 exits early.

### What reconcile does NOT do

- Does not run `agent-factory` research (NotebookLM, web search) — the
  reconciled entries have minimal metadata, good enough for orchestrator
  dispatch and subagent-stop task counting but lacking the rich
  `notebooklm_notebook_id`, `cost_estimate`, and researched domains that
  factory-created agents have.
- Does not deduplicate flat vs. subdir layouts. If the same agent name
  exists in both forms (e.g., a flat `foo.md` and a subdir `foo/agent.md`),
  both are discovered as the same name; the entry gets whichever file_path
  is found first (alphabetical: flat before subdir). This is a known gap
  — resolve manually if it matters.
- Does not upgrade old roster schema versions. If `schema_version` is
  below the current code's expectation, warn and exit; ask user to run
  `/prism-update`.
