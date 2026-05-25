---
name: prism-deep-dive
description: Generate this project's master-<slug> agent. Discovery + ≤5 clarifying questions + writes <project>/.claude/agents/master-<slug>.md, seeded MEMORY.md, and settings.json agent: field. Opt-in entry point for v4.0 project-master surface.
---

# /prism-deep-dive — v4.0 project-master generator (Phase D)

Locked design: `docs/prism/adjudications/D004-v4-product-vision.md` §1 (slug
derivation), §3 (skill wiring), §5 (MEMORY.md router), §8 (opt-in migration).
The deterministic surface lives in `tools/prism-deep-dive.mjs`; the
LLM-judged synthesis + clarifying-turn UX is in this slash command body.

This command is the entry point for the project-master surface. Run ONCE per
project. To re-run with updated profile, pass `--refresh` (regenerates
MEMORY.md only, preserves the agent file and settings).

---

## Step 0 — guards

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: STOP. Tell the user to `git init` first and re-run.

Read `.claude/.prism-state.json`. If missing: STOP and tell the user to run
`/prism-bootstrap` first — the project-master phase opt-in pattern requires
state to exist (D004 §8).

## Step 1 — derive slug

Run: `node ~/.claude/tools/prism-deep-dive.mjs slug-derive --source auto`

Outcomes:
- **Exit 0** with JSON `{slug, source, reason}` → the slug is locked. Tell
  the user: *"Project slug: `<slug>` (derived from <source>)"*. Skip to Step 2.
- **Exit 6** with JSON `{slug:null, source:"prompt", reason}` → the basename
  is generic (e.g., `app`, `project`, `repo`). Use `AskUserQuestion` to ask:
  *"Pick a project slug (lowercase, hyphens only, ≤30 chars):"* — offer 2-3
  candidates derived from CLAUDE.md keywords, recent commit subjects, or top
  directory names. Honor the user's pick.

Persist the chosen slug: run `node ~/.claude/tools/prism-bootstrap.mjs
start-phase project-master` to mark the phase in-progress, then write
`project_slug` via the state-manipulation flow (see Step 5 — the slug is
recorded as part of the project-master phase completion meta).

## Step 2 — discovery synthesis

Invoke the existing `prism-discover` skill (do NOT re-implement). It indexes
the project under `.claude/references/`:
- `database-index.md` (if a DB connection or MCP exists)
- `codebase-map.md` (if 10+ top-level dirs)
- `api-surface.md` (if route files or OpenAPI spec exist)

If `.claude/references/` already has indexes from a prior `/prism-bootstrap`
or `/prism-sync`: read them rather than re-running discovery. The deep-dive
EXTENDS the existing index, not replaces it.

From the discovery output, extract:
- `stack`: language, frameworks, package manager (one-line summary)
- `datasources`: list of indexed resources (db schemas, API base URLs, etc.)
- `existing_specialists`: any agents already registered in
  `~/.claude/skills/prism-plan/references/roster.json` whose `projects_worked`
  includes a path under this project's root

Hold these in a draft `profile = {stack, datasources, active_workstreams: [],
specialists: existing_specialists}` object for Step 4.

## Step 3 — clarifying questions (AskUserQuestion, ≤5)

Use `AskUserQuestion` with **at most 5** questions. Skip a question if
discovery already gave you a confident answer. Default question battery (cut
where evidence makes it unnecessary):

1. **Primary stack** — confirm the language/framework guess from Step 2.
   *Header: "Stack"*. Options: confirmed candidate (recommended), 2 alternatives.

2. **Primary datasource** — which is the "production" one the project most
   interacts with. *Header: "Primary DB"*. Options: each indexed source +
   "none" + "other (free text)".

3. **Active workstreams** (multiSelect) — what is this project currently
   working on? *Header: "Workstreams"*. Options: derived from `git log --since
   "30 days ago" --pretty=format:%s | head -20` clustered by leading verb
   ("feat:", "fix:", "docs:"). 3-5 options.

4. **Master operating tone** — does this project's master prefer concise or
   verbose explanations? *Header: "Master tone"*. Options: "Terse (default)",
   "Verbose", "Match-the-user".

5. **Auto-hire specialists?** — when a domain-expert task arises, should the
   master auto-call `@agent-factory` or surface the gap and let the user
   trigger it? *Header: "Auto-hire"*. Options: "Surface and ask (recommended)",
   "Auto-hire silently", "Disable factory".

Merge the answers into the `profile` object. Persist tone + auto-hire
preference into a sub-key `profile.preferences = {tone, auto_hire}`.

## Step 4 — write the agent + MEMORY.md + settings.json

For each of these three writes, run the helper subcommand and capture the
output path. Report each one to the user as it lands.

### 4a — write master-<slug>.md

Run: `node ~/.claude/tools/prism-deep-dive.mjs agent-write --slug <slug>`

The helper defaults to `--orchestrator-protocol skill-ref` (Phase E completed).
The generated agent loads its operating protocol from
`~/.claude/skills/master-orchestrator/SKILL.md`. To target environments
without the skill installed, pass `--orchestrator-protocol inline` explicitly
so the helper emits the 5-rule fallback body verbatim.

If the file already exists (exit 7): surface to the user. Ask whether to
overwrite — if yes, re-run with `--force`.

### 4b — write MEMORY.md

Build the profile JSON from Step 2/3 and pass it inline:

```
node ~/.claude/tools/prism-deep-dive.mjs memory-seed --slug <slug> --profile '<json>'
```

If exit 8 (>25 KB): the profile is too large. Trim `active_workstreams` to
top-5 and the `specialists` list to currently-relevant entries, then retry.

### 4c — write settings.json

Run: `node ~/.claude/tools/prism-deep-dive.mjs settings-write --slug <slug>`

If exit 9 (existing settings.json is invalid JSON): STOP. Tell the user the
existing file is broken; they must fix it manually. Do NOT auto-rewrite
broken JSON — that's a different command's responsibility (`/prism-doctor`).

## Step 5 — close the project-master phase

Run: `node ~/.claude/tools/prism-bootstrap.mjs complete-phase project-master
--meta '{"slug": "<slug>", "agent_path": "<path-from-4a>", "memory_path":
"<path-from-4b>", "settings_path": "<path-from-4c>", "source": "<step-1-source>"}'`

This marks the phase complete in `.prism-state.json` with sentinel +
artifact paths. The `slug` field in the meta is captured for future
`slug-derive --source state` runs.

## Step 6 — tell the user what happens next

Print a closing report:

```
✅ Project-master created.

  Agent file:  .claude/agents/master-<slug>.md
  MEMORY.md:   .claude/agents/MEMORY.md  (<bytes>/25600)
  Settings:    .claude/settings.json     (agent: master-<slug>)

Next session in this project, the main thread will load as master-<slug>.
This requires a Claude Code restart (/exit + claude) — /clear is not enough.

To re-run with an updated profile:  /prism-deep-dive --refresh
To upgrade the agent body (diff+confirm):  /prism-deep-dive --upgrade <slug>
To roll back:                       /prism-doctor --rollback project-master
```

---

## --refresh mode

When the slash command is invoked with `--refresh`:
1. Skip Step 1 (slug is locked).
2. Run Step 2 (discovery) + Step 3 (clarifying) as normal.
3. Skip Step 4a (agent file already exists; do not overwrite).
4. Run Step 4b (regenerate MEMORY.md from refreshed profile).
5. Skip Step 4c (settings.json already has `agent:` set).
6. Append a "refreshed" entry to the project-master phase meta but do NOT
   re-call `complete-phase` (the phase stays complete; meta gets a
   `last_refreshed_at` field added by a follow-up `complete-phase --meta
   '{"last_refreshed_at": "<now>"}'`).

> See `--upgrade <slug>` below for the manual re-synth flow that wraps `agent-diff` + `agent-write --force` with a confirmation gate.

## --upgrade <slug> mode

Re-synthesizes an existing project-master agent with a diff preview and
explicit user approval before any write. This is the manual re-synth rhythm
locked in D004 §5 ("per-quarter: manual only in v4.0").

### Workflow

1. **Verify the agent exists.** Read `.claude/agents/master-<slug>.md`. If
   missing, instruct the user: *"No `master-<slug>` agent found. Run
   `/prism-deep-dive` (no --upgrade) to create one first."*

2. **Generate the diff.** Run:

   ```bash
   node tools/prism-deep-dive.mjs agent-diff --slug <slug>
   ```

   Capture stdout (the unified diff) and the exit code.

3. **Branch on exit code:**
   - **Exit 0** (no diff): report *"`master-<slug>` is already up to date — no upgrade needed."* and stop.
   - **Exit 1** (diff present): proceed to step 4.
   - **Exit 5** (bad args — slug missing or invalid protocol value): surface the stderr and stop. This most likely means the slug was not passed or was malformed.
   - **Exit 6** (missing file): same as step 1 — instruct the user to run base `/prism-deep-dive` first.
   - **Exit 9** (git spawn / runtime error): surface the stderr and stop. The most common cause is a missing or corrupt git installation; ask the user to check `git diff` works in the project root.
   - **Any other exit**: surface the stderr and stop.

4. **Present the diff to the user via AskUserQuestion.** Use a single-question form:

   - **Header:** "Master upgrade"
   - **Question:** "Apply this upgrade to `master-<slug>`?"
   - **Options:**
     - *Apply (Recommended)* — "Write the new body to disk via `agent-write --force`."
     - *Skip* — "Discard the proposed changes; leave the existing agent file as-is."

   Include the diff inline in the question prose (use a code fence) so the
   user can read it before deciding.

5. **On Apply:**

   ```bash
   node tools/prism-deep-dive.mjs agent-write --slug <slug> --force
   ```

   Report the path written and remind the user that the upgrade takes effect
   on the next session that opens in this project (the agent is loaded at
   session start — a `/exit` + `claude` restart is required; `/clear` is not
   enough).

6. **On Skip:** acknowledge and stop. Do not write anything.

### When to use

- After a `/prism-deep-dive` helper change (e.g., a new section added to
  `renderMasterAgent`) that the user wants their existing project-masters to
  pick up.
- After manually hand-editing the seeded master and wanting to see what the
  freshly-generated body would look like by comparison. Note: `agent-diff`
  shows what the generator *would* produce, not a diff of the user's edits
  against the original — so "what did I change?" is a separate question.
- Per the v4.1 telemetry roadmap, this command will eventually be
  auto-invoked on a per-quarter schedule. For v4.0 it remains user-initiated
  only.

## Idempotency

Running `/prism-deep-dive` twice in a row on an already-completed project:
- Step 1: returns the locked slug from state (exit 0, source: state).
- Step 4a: exits 7 (file exists). The slash command surfaces and asks.
- The user can either decline (no-op) or accept `--refresh` semantics.

## Failure modes

| Situation | /prism-deep-dive behaviour |
|---|---|
| No `.git/` | STOP, ask user to `git init` |
| No `.prism-state.json` | STOP, ask user to `/prism-bootstrap` first |
| `slug-derive` exit 6 | AskUserQuestion to pick slug from 2-3 candidates |
| `agent-write` exit 7 (collision) | Ask user; only retry with --force after confirmation |
| `memory-seed` exit 8 (>25 KB) | Trim profile, retry; if still over → escalate to user |
| `settings-write` exit 9 (bad JSON) | STOP, tell user to fix manually (offer /prism-doctor) |
| `agent-diff` exit 5 (bad args) | Surface stderr; most likely slug was omitted or malformed |
| `agent-diff` exit 6 (missing file) | Instruct user to run `/prism-deep-dive` (no --upgrade) first |
| `agent-diff` exit 9 (git spawn error) | Surface stderr; ask user to verify `git diff` works locally |

## Related commands

- `/prism-bootstrap --with-deep-dive` — runs `/prism-deep-dive` automatically
  during the project-master phase
- `/prism-deep-dive --upgrade <slug>` — re-synthesize an existing
  project-master with diff preview + explicit approval (D004 §5 manual rhythm)
- `/prism-clean` — appends per-decision pointers into the master's MEMORY.md
  (Phase H, post-this)
- `@agent-factory --master-<slug>` — alternate entry: factory can also
  generate the agent (this slash command is the recommended path)
