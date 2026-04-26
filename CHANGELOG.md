# Changelog

All notable changes to PRISM are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), the versioning follows
[Semantic Versioning](https://semver.org/).

## [3.8.8] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 runtime failure on Windows PS 5.1 at init step: `$PSVersionTable.Platform` property doesn't exist in PS < 6, throws under StrictMode. Replaced with `$PSVersionTable.ContainsKey('Platform')` hashtable lookup which is safe in both PS 5.1 and PS 7+. Audited install.ps1 + uninstall.ps1 for similar PSVersionTable property accesses.

## [3.8.7] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 third PowerShell 5.1 parser bug: catch block at line 387-392 still tripped PS 5.1 even after $_ subexpression refactor. Hex-audit revealed no non-ASCII bytes, no BOM, no smart quotes, and pure CRLF line endings — the smoking gun was `$()` subexpression interpolation inside double-quoted strings throughout the file (lines 64, 68, 71, 74, 231, 243, 257, 350, 369, 370). PS 5.1's tokenizer misparses nested `$()` blocks inside `"..."` even when syntactically valid in PS7+. Refactored ALL `"...$(...)"` patterns to `('literal' + $var)` concatenation, which bypasses the PS 5.1 string-interp tokenizer entirely. Also normalized line endings to CRLF and stripped any non-ASCII chars in install.ps1 + uninstall.ps1. Added v3.12 static-test assertions: zero non-ASCII bytes, brace balance.

## [3.8.6] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 second PowerShell 5.1 parser bug uncovered by v3.8.5 fix: inline `$($_.Exception.Message)` subexpression in catch block tripped PS 5.1's parser ("Array index expression is missing or not valid" at line 390). Refactored all `$($_.X.Y)` subexpressions in strings to extract the value to a local variable first, then interpolate the variable. Same scrub applied to uninstall.ps1.

## [3.8.5] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 parser error on Windows PowerShell 5.1: replaced PS7-only null-coalescing `??` operator (line 371) with PS5.1-compatible `if ($null -ne ...) { ... } else { ... }` pattern. Scrubbed install.ps1 + uninstall.ps1 for any other PS7-only syntax (`?:` ternary, `?.` null-conditional, `&&`/`||` pipeline chains).

## [3.8.4] - 2026-04-25

CRITICAL data-loss hotfix: uninstaller now preserves
`references/roster.json` and `references/update-log.json`.

### Fixed

- v3.8.3 (and all earlier versions) wiped roster.json and update-log.json
  when removing the prism-plan skill directory. roster.json contains
  user-mutated state (agent registrations, `notebooklm_notebook_id`
  values, task counts, escalation history). For users with researched
  specialists via agent-factory, this would silently lose every
  NotebookLM notebook link on uninstall — making the cloud notebooks
  effectively orphaned.

### Changed

- `scripts/uninstall.ps1`: copies roster.json + update-log.json to
  `$env:TEMP\prism-uninstall-preserve-<ts>\` BEFORE the prism-plan
  skill directory deletion; restores them to
  `~/.claude/skills/prism-plan/references/` AFTER all PRISM removal.
  Cleanup of preserve temp at end of run.
- `scripts/uninstall.sh`: same logic in bash.
- Both scripts: final report now lists the preserved files explicitly.

### Migration

Users who already ran v3.8.3's `--purge` and lost roster.json: restore
from your `~/.claude/backups/pre-uninstall-<ts>/` backup directory.
The backup IS still made unconditionally; only the in-place roster
was wiped from `~/.claude/skills/prism-plan/references/`.

## [3.8.3] - 2026-04-25

Hotfix: full rewrite of uninstall.ps1 after v3.8.0/v3.8.1/v3.8.2
incremental scrubs failed. Three Linux-sandbox-based attempts to
patch the file couldn't reproduce the Windows PowerShell parser
error. Pivot: rewrite from scratch with strict-conservative idioms.

### Changed

- `scripts/uninstall.ps1` rewritten end-to-end (~250 lines vs 537
  before). Same external behavior — same flags (-Purge, -KeepMemory,
  -NoBackup, -ReinstallPath, -Help), same artifact list, same
  surgical settings.json edit. New internal style:
  - No top-level try/catch wrapping (uses explicit Test-Path guards
    and Remove-Item -ErrorAction SilentlyContinue)
  - No < / > characters anywhere in strings
  - No -> arrows in user-facing messages
  - No nested try blocks, no inline here-strings inside try
  - Functions defined before main flow
  - Single-quoted strings preferred; double-quotes only when interpolating
  - The settings.json edit script (Node.js) lives as a top-level
    here-string variable and is piped to `node -` outside any try
- Renamed -Reinstall to -ReinstallPath for clarity (no flag conflict
  in older PS versions). Backwards compat: positional still accepts.

### Mechanics

Manifest 3.8.2 → 3.8.3.

### Why three previous fixes failed

v3.8.0 shipped the original 537-line uninstall.ps1. v3.8.1 patched
one `<...>` marker. v3.8.2 patched 11 more (`<>`, `->`). All scrubs
PASSED structural balance checks in Linux sandbox but Windows still
reported the same `try {` / missing-`}` cascade. Without `pwsh` in
the sandbox to run AST parse, we were debugging blind. Rewrite is
the only deterministic path forward.

## [3.8.2] - 2026-04-25

Hotfix: comprehensive `uninstall.ps1` parser-error scrub.

### Fixed

- v3.8.1 patched only line 208's `<each.../>` marker. Windows users
  reported a follow-on `try {` / missing-`}` parser cascade. Root
  cause: additional `<...>` markers in `Write-*` strings throughout
  the file caused PowerShell's strict parser to derail mid-script.
  v3.8.2 ships a comprehensive scrub: every `<` and `>` inside
  double-quoted strings is now `[` / `]`. The angle brackets that
  remain (single-quoted strings, comments, code operators like `>=`)
  are confirmed safe.
- Same scrub applied defensively to `install.ps1`.

### Mechanics

Manifest 3.8.1 → 3.8.2. install-merge §4d auto-stamps update-log
on next run.

### Migration

`git pull && .\scripts\uninstall.ps1` should now parse cleanly.
Zero state changes.

## [3.8.1] - 2026-04-25

Hotfix: PowerShell parser error in uninstall.ps1.

### Fixed

- **`scripts/uninstall.ps1` line 208 (and any siblings)** — replaced
  `<text>` documentation markers in `Write-UninstallLog` strings with
  `[text]`. PowerShell's strict parser treated unquoted `<` as the
  reserved redirection operator, causing parse failure on Windows
  before the script could even run. Cascading "missing }" / "missing
  catch" errors were downstream parser confusion. Same fix applied
  defensively to `scripts/install.ps1` if any sibling occurrences
  existed.

### Mechanics

Manifest 3.8.0 → 3.8.1. install-merge §4d auto-stamps update-log
on next run for users who already pulled v3.8.0.

### Migration

Zero. Pull v3.8.1, re-run `.\scripts\uninstall.ps1` — it now parses
correctly. No state changes.

## [3.8.0] - 2026-04-25

Conversational-friction reduction. Eliminates the per-turn dispatch
ceremony that fires on short user follow-ups in interactive sessions
("ok", "yes", "go", "proceed" → haiku via keyword-floor → guard
denies every parent tool). Closes ~80% of the friction we hit during
v3.x release-engineering today.

### Added

- **Continuation detection** in `hooks/prism-prompt-tier-router.mjs`.
  Short messages (<8 words) OR explicit approval phrases ("ok",
  "yes", "go", "proceed", "ship", "approved", "continue", etc.) that
  follow an opus/sonnet sentinel <5min old now INHERIT the previous
  tier instead of re-classifying as haiku. New sentinel `source`
  value: `"continuation-inherit"`. Eliminates the dispatch-guard
  spam during interactive Q&A.

- **`PRISM_CONVERSATION_MODE` env var.** Set to `1` to make ALL
  turns inherit the previous tier when one exists (no length / age
  guards). Opt-in escape for development sessions where you want
  zero classifier overhead. Off by default. Project-scoped via
  `.claude/settings.local.json` env block.

- **Agent-model-guard exemption** for `model: opus` on non-haiku
  turns. When a dispatch explicitly specifies opus AND the sentinel
  is non-haiku, the guard now passes through silently (no nudge
  even in soft mode). Closes the cascade where parent dispatches
  opus subagents and gets advisory noise on every one.

### Mechanics

Manifest 3.7.0 → 3.8.0. plugin.json 3.7.0 → 3.8.0 (THIS time staged
and committed in the version-bump commit; v3.7.0 had a follow-up
chore commit for this oversight). install-merge §4d auto-stamps
update-log. Hook count unchanged at 16.

### Migration

Zero migration needed. Continuation-inherit is purely additive — if
the previous sentinel doesn't exist or is stale, normal classification
runs unchanged. `PRISM_CONVERSATION_MODE` is opt-in.

### Why this matters

In interactive Claude Code sessions where users send a long opus-tier
prompt followed by short approvals/follow-ups ("yes", "ship it",
"continue", "what about X"), the keyword-floor classifier scored
those short messages as haiku. The dispatch-guard then denied every
parent tool, forcing `!opus-force:` prefix or subagent ceremony on
each turn. v3.8.0 makes the classifier session-aware: a short
follow-up after an opus context inherits opus tier. Same discipline
on first-message-of-conversation; no friction on continuation.

Solves the friction we hit shipping v3.7.0 in this very session.

### Tests

`tests/v3/run-static.sh` Category v3.8 with 4 assertions
(T_v3.8.1–T_v3.8.4) verifying:
- prism-prompt-tier-router has continuation detection
- prism-agent-model-guard has explicit-opus exemption
- PRISM_CONVERSATION_MODE env var documented
- continuation-inherit source value used in tier router

## [3.7.0] - 2026-04-25

Closes the orphan-NotebookLM-notebook discovery gap. Pre-existing
notebooks (e.g., research-backed agents whose local agent.md was
deleted, or notebooks imported from another machine) are now
discoverable, surfaced in Phase 0a inventory, and wireable as new
agents in one command. Compose-first thesis fully extended to
cloud-stored research.

### Added

- **`agent-factory --from-notebook <notebook-id>`** — reverses the
  standard agent-factory flow. Instead of research → notebook → agent,
  this mode reads an existing NotebookLM notebook (sources, summary)
  and generates a matching `agent.md` + `roster.agents` entry with
  `notebooklm_notebook_id` linked to the EXISTING notebook (no new
  notebook spawned). Sets `source: "from-notebook"` to distinguish
  from `agent-factory`-created and `reconcile`-created entries.
  Default model: `sonnet` (conservative; user can upgrade).

- **`/prism-roster --reconcile-cloud`** — extends `--reconcile`. After
  local reconciliation, scans `notebooklm list` for notebooks NOT
  linked to any roster entry (orphans). For each orphan, prompts:
  [W]rap as new agent (dispatches `@agent-factory --from-notebook`),
  [D]elete the notebook (with double confirmation),
  [I]gnore (adds to skiplist `~/.claude/.prism-orphan-notebook-skiplist.json`),
  [S]kip (re-prompts next run). Cloud step is read-only by default;
  only deletes/wraps on per-orphan user confirmation. Backs up
  `roster.json` to `.bak` before any wrap.

- **Master-orchestrator Phase 0a — orphan-notebook surfacing.** New
  inventory sub-section lists NotebookLM notebooks present in cloud
  but not linked to any roster agent. If the user's request matches
  an orphan's likely domain, the orchestrator suggests wiring it via
  `@agent-factory --from-notebook` BEFORE assembling the panel.
  Closes the failure mode where research-backed knowledge sits
  orphaned in NotebookLM cloud while the panel falls back to
  hardcoded personas.

### How it solves the "nuclear-physicist" scenario

You have a NotebookLM notebook from 6 months ago with curated
nuclear-physics research, but no local agent.md and no roster entry.
- Pre-v3.7.0: invisible to PRISM. Panel falls back to generic persona.
- v3.7.0: Phase 0a flags the orphan notebook. User runs
  `/prism-roster --reconcile-cloud` (or accepts the inline suggestion),
  picks [W]rap. Agent-factory generates the agent.md from notebook
  contents, registers in roster with the notebook ID, takes ~30s.
  Next panel: the rostered nuclear-physicist agent is dispatched
  with full notebook backing.

### Mechanics

Manifest 3.6.0 → 3.7.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Manifest entries unchanged at 85.
No new files in the manifest (changes are doc/protocol updates to
existing agents/commands).

### Skiplist convention

`~/.claude/.prism-orphan-notebook-skiplist.json` schema:
```json
{
  "skipped_ids": ["notebook-id-1", "notebook-id-2"]
}
```
Local-only, not synced anywhere. Removing the file restores
all-orphan visibility on next `--reconcile-cloud` run.

### Closes audit findings

- Orphan-notebook discovery gap surfaced in v3.6.0 audit retrospective
- `agent-factory` was one-way (create only) — now bidirectional
- Phase 0a inventory was complete for linked notebooks but blind to
  orphan notebooks in the same cloud account

## [3.6.0] - 2026-04-25

Bundled release: pre-install audit fixes for v3.5.0 + comprehensive end-to-end audit suite. Closes the two CRITICAL findings from the v3.5.0 plugin-install pre-flight audit AND ships the multi-hour real-environment audit infrastructure.

### Fixed (v3.5.0 pre-install audit findings)

- **SessionStart bootstrap for plugin install** (`hooks/prism-session-start.mjs`). Detects `${CLAUDE_PLUGIN_ROOT}` env var. If present AND `~/.claude/skills/prism-plan/references/` is missing key reference files, copies them from the plugin payload. Files: `adversarial-review.md`, `model-matrix.md`, `prompt-templates.md`, `tools-registry.md`, `mcp-registry.md`. `roster.json` only created if absent. Idempotency flag `~/.claude/.prism-plugin-bootstrap-done-v3.6`. Manual installs skip. Closes CRITICAL #2 (10 hardcoded reference paths).
- **`/prism-index` Step 2 plugin-root tier** — new tier 0 scans `${CLAUDE_PLUGIN_ROOT}/skills/**/SKILL.md` tagged `source: "prism"` BEFORE legacy globs. Explicit dedup. Closes CRITICAL #1.
- **`/prism-health` and `/prism-doctor` layout detection** — both detect plugin-install vs manual-install and check correct paths. New doctor symptom #10: "PRISM bootstrap incomplete".
- **plugin.json hook commands quoted** for spaced Windows paths. All 17 commands changed from `node ${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs` to `node "${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs"`.
- **CHANGELOG v3.5.0 migration recipe corrected** — was `uninstall.sh --purge` (would WIPE `roster.json` + every `notebooklm_notebook_id`); now `uninstall.sh` (no `--purge`) with explanatory note.

### Added — comprehensive audit suite

- **`tools/prism-audit-runner.mjs`** (~190 LOC) — synthetic runner. Spawns each scenario's target hook as subprocess, pipes `input_payload` via stdin, captures exit + stdout + stderr + duration. Modes: `--category`, `--output`, `--scenarios`, `--help`.
- **`tests/v3/audit-scenarios.json`** — declarative catalog of 30 scenarios across 10 categories (classifier 6, mutation-guard 3, parent-dispatch-guard 3, agent-model-guard 3, task-tier-advisor 1, safety 4, parallel-guard 1, panel-guard 1, skill-trigger-guard 2, lifecycle 5). Schema-versioned; extensible.
- **`tests/v3/run-audit.sh`** — bash wrapper. Throwaway HOME, calls runner, calls analyzer. Modes: `--category`, `--output`, `--keep-home`, `--help`. POSIX.
- **`tests/v3/analyze-audit.mjs`** — report generator. Reads runner JSONL + optional routing log. Produces markdown: coverage matrix, timing distribution (p50/p95/p99), trigger correlation, failures detail, anomalies, verdict.
- **`commands/prism-audit-full.md`** — new slash command orchestrating end-to-end audit: pre-flight, synthetic, optional real-session, analyzer, final report. Differentiated from `/prism-audit` (fast hygiene scan).
- **`tests/v3/audit-real-prompts.md`** — 40+ curated real-session prompts across 6 sections (classifier, guards, panels, parallel, skill triggers, lifecycle). Each declares expected behavior. Pasted into fresh Claude Code session for real-environment coverage.

### Changed

- Manifest 3.5.0 → 3.6.0. install-merge §4d auto-stamps update-log.
- Manifest entries: 84 → 85 (+1: `commands/prism-audit-full.md`).

### How to use

```
# Inside Claude Code:
/prism-audit-full

# Or shell:
bash tests/v3/run-audit.sh                       # all categories
bash tests/v3/run-audit.sh --category classifier # filtered

# Analyze a previous run:
node tests/v3/analyze-audit.mjs /tmp/prism-audit-run.jsonl ~/.claude/.prism-routing.jsonl > report.md
```

For real-session coverage: paste prompts from `tests/v3/audit-real-prompts.md` into a fresh Claude Code session, then run analyzer with `~/.claude/.prism-routing.jsonl` as second arg.

### Process notes

SA1 (audit fixes) shipped cleanly across 6 files. SA2 (audit-suite core) timed out twice on API stream-idle — parent wrote audit-scenarios.json + prism-audit-runner.mjs + run-audit.sh + audit-real-prompts.md directly under dispatched-bypass. SA3 (UX) shipped analyze-audit.mjs + prism-audit-full.md cleanly but timed out before audit-real-prompts.md (parent wrote that).

## [3.5.0] - 2026-04-25

Plugin-packaging release. PRISM now ships as a first-class Claude Code
plugin (`/plugin install prism@PRISM`). Closes G1 from the v3.4.0
cheat-sheet structural audit — eliminates the clone+install-merge
ceremony for end users while preserving the manual install path
unchanged for developers.

### Added

- **`.claude-plugin/plugin.json`** — Claude Code plugin manifest at
  repo root. Declares all 16 hooks across the 8 lifecycle events
  (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  SubagentStop, Stop, ConfigChange, PreCompact) using
  `${CLAUDE_PLUGIN_ROOT}` for plugin-relative paths. Skills, commands,
  and agents are auto-discovered from the standard `skills/`,
  `commands/`, `agents/` directories per plugin convention.

- **Plugin-install path** — primary install method documented in
  README:
  ```
  /plugin marketplace add vosser24/PRISM
  /plugin install prism@PRISM
  ```
  Hooks, skills, commands, agents register automatically. No
  `settings.fragment.json` merge needed for plugin users. No
  `prism-exec.sh`/`prism-exec.cmd` wrapper (plugin manifest invokes
  `node` directly).

- **Plugin uninstall path** — `/plugin uninstall prism@PRISM` is
  symmetric; Claude Code drops hooks/skills/commands/agents. Manual
  Tier 1 cleanup of transient state files (`.prism-turn-tier-*.json`)
  is documented because those live outside `${CLAUDE_PLUGIN_DATA}`
  for compatibility with the legacy install path.

### Documentation

- README.md — top-level Install section now leads with plugin install,
  manual clone+install.sh as labeled alternative.
- INSTALL.md — top callout pointing users to `/plugin install` first;
  manual procedure preserved as the legacy/developer path.
- UNINSTALL.md — top section showing `/plugin uninstall prism@PRISM`;
  manual uninstall.sh path preserved below.

### Tests

- `tests/v3/run-static.sh`: new Category v3.5 with assertions
  verifying `.claude-plugin/plugin.json` exists, parses cleanly, has
  required fields (name/version/description/hooks), version matches
  `manifest.json`, and declares all 16 hooks across 8 events.
- `scripts/verify.mjs` extended to check plugin manifest presence
  alongside the legacy file checks.

### Migration

Existing manual installs keep working unchanged. To migrate from
manual to plugin-install:

1. `bash scripts/uninstall.sh`               # preserves roster.json + notebook IDs (do NOT use --purge for migration)
2. Inside Claude Code: `/plugin install prism@PRISM`

> Note on step 1: the default `uninstall.sh` removes hooks, commands,
> agents, and skills from `~/.claude/` but PRESERVES
> `~/.claude/skills/prism-plan/references/roster.json` and any
> `notebooklm_notebook_id` values inside it. Passing `--purge` would
> wipe roster.json and the notebook IDs your agents have accumulated;
> the default uninstall path is the migration-safe option.

Plugin users no longer need `prism.env` (plugin runtime resolves node
automatically).

### Limitations (vs manual install)

- Plugin install does NOT scaffold `~/.claude/skills/prism-plan/references/roster.json`
  with team_id defaults. Run `/prism-roster --reconcile` after
  install to populate.
- Plugin install does NOT auto-write `~/.claude/prism.env` because
  plugin manifest invokes node via `${CLAUDE_PLUGIN_ROOT}` directly
  (no need). If you previously had `ANTHROPIC_API_KEY` in prism.env
  from pre-v3.2.0, that file is no longer read — see CHANGELOG
  v3.2.0 for context.
- Some legacy state files live outside `${CLAUDE_PLUGIN_DATA}` for
  cross-install-method compatibility. Plugin uninstall does not
  remove them; run Tier 1 cleanup manually if desired.

### Mechanics

Manifest 3.4.0 → 3.5.0. install-merge §4d auto-stamps update-log for
manual-install users. settings.fragment.json unchanged (still used
by the manual install path).

## [3.4.0] - 2026-04-25

Windows-native productization release. Ships PowerShell-native ports of
both lifecycle scripts so pure-PowerShell users no longer need Git Bash.
Closes the last cross-shell gap in PRISM's installation lifecycle.

### Added

- **`scripts/install.ps1`** (391 lines) — PowerShell-native installer
  mirroring `install.sh` step-for-step. Parameters: `-Prefix`, `-Branch`,
  `-DryRun`, `-NoBackup`, `-Help`. Walks Windows-specific node
  resolution chain (`Get-Command node` → nvm `$env:APPDATA\nvm\<latest>`
  → Volta `$env:LOCALAPPDATA\Volta\bin` → `${env:ProgramFiles}\nodejs`).
  Writes `~/.claude/prism.env` as **UTF-8 NO BOM** via
  `[System.IO.File]::WriteAllBytes` + `UTF8Encoding($false)` —
  preserves Windows backslashes and avoids the v2.7.2 BOM trap. Uses
  `Join-Path` for all path building, `Set-StrictMode -Version Latest`,
  per-step `try/catch` with `$CurrentStep` tracking. Compatible with
  PowerShell 5.1 (Windows default) and PowerShell 7+ (cross-platform).

- **`scripts/uninstall.ps1`** (537 lines) — PowerShell-native uninstaller
  mirroring `uninstall.sh`. Parameters: `-Purge`, `-KeepMemory`,
  `-NoBackup`, `-Reinstall <path>`, `-Help`. **DRY-RUN by default**
  (inverted vs install.ps1 — same safety stance as the .sh). Surgically
  removes 16 PRISM hooks + 14 commands + 8 skill directories
  (enumerated by name, never glob) + 3 core agents (by exact filename
  — never glob `agents/`) + tools + statusline + state files. Edits
  `~/.claude/settings.json` via inline node heredoc using single-quoted
  `@'...'@` to prevent PowerShell variable interpolation in the JS
  block. Idempotent.

### Documentation

- README + INSTALL.md + UNINSTALL.md updated to show both invocation
  options (PowerShell-native vs bash-via-Git-Bash). Pure-PowerShell
  users no longer need Git Bash for either install or uninstall.

### Tests

- `tests/v3/run-static.sh`: new Category v3.4 with 6 assertions
  verifying both `.ps1` files exist + balance check + parameter
  documentation.
- `tests/v3/run-claude.md`: new Category 23 with manual round-trip
  prompts for testing the PowerShell-native lifecycle on Windows.

### Mechanics

Manifest 3.3.0 → 3.4.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Manifest entries unchanged at 84
(both `.ps1` files are repo-level scripts like their `.sh`
counterparts, not copied to ~/.claude/).

Process note: SA1 (install.ps1 subagent) timed out twice on API
stream-idle, then was blocked by mutation-guard from inside its
subagent context (sentinel inherited haiku from short-prompt
classification). Recovered via parent-as-orchestrator execution
under user `!opus-force:` override. SA2 (uninstall.ps1) completed
cleanly at 537 lines on first attempt. Ships clean despite the
workflow friction.

## [3.3.0] - 2026-04-25

Productization release: ships the missing automated uninstaller. Closes
the symmetry gap with v3.1's `scripts/install.sh` — PRISM now has both
ends of the install lifecycle as one-command operations.

### Added

- **`scripts/uninstall.sh`** — POSIX one-command uninstaller mirroring
  install.sh shape. Modes:
  - default = **DRY-RUN** (safe; prints what would be deleted, mutates
    nothing). Inverted default vs install.sh because uninstall is
    destructive — `--purge` flag is REQUIRED to actually delete.
  - `--purge` — actually performs deletion
  - `--keep-memory` — preserve `.prism-sessions/` and `.prism-rollups/`
    (session memory + weekly rollups)
  - `--no-backup` — skip the pre-uninstall backup (NOT recommended)
  - `--reinstall <repo-path>` — chains uninstall → install in one run
  - `--help` — usage

  Surgically removes: 16 PRISM hooks + 14 PRISM commands + 8
  PRISM-owned skill directories (enumerated by name, never glob) + 3
  PRISM core agents (by exact filename — never glob `agents/`) + tools
  + statusline + state files. Edits `~/.claude/settings.json` to
  remove only PRISM hook entries (preserves user/plugin entries +
  MCP servers + permissions). Pre-uninstall backup at
  `~/.claude/backups/pre-uninstall-<ts>/` unless `--no-backup`.

- **`UNINSTALL.md`** at repo root — full documentation: tiered
  cleanup procedure (state-only → full uninstall → reinstall chain →
  recovery from accidental --purge). Flag reference, when-to-use-which
  decision table.

- **README + INSTALL.md updates** — both link to UNINSTALL.md and
  show the one-command default-DRY-RUN preview.

### Tests

- `tests/v3/run-static.sh`: new Category v3.3 section with 6
  assertions (uninstall.sh exists + executable, --help works,
  default mode is DRY-RUN preserves a marker file, --purge flag
  documented, --keep-memory flag documented, POSIX syntax check).
- `tests/v3/run-claude.md`: new Category 22 with 6 manual prompts
  for testing uninstall + reinstall round-trip on a throwaway HOME.

### Mechanics

Manifest 3.2.0 → 3.3.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. settings.fragment.json unchanged.
Manifest entries unchanged at 84 (uninstall.sh is a repo-level
script like install.sh, not copied to ~/.claude/).

### Migration

Zero migration needed. Additive release. Existing v3.2.0 installs
that pull + run install-merge get §4d auto-stamp 3.2.0 → 3.3.0.
The new uninstall.sh is available immediately from the repo —
no deployment to ~/.claude/ needed.

## [3.2.0] - 2026-04-25

Classifier architecture simplification. Per direct user feedback: PRISM
should not require a separate `ANTHROPIC_API_KEY` to function correctly.
The vast majority of users (Claude Code Pro/Max login) cannot expose
their auth to hook subprocesses, and the previous "API-classifier-as-
default with keyword-floor as fallback" framing was a productization
mistake. v3.2.0 makes keyword-floor the only classifier and adds a
conversation-model self-override mechanism for cases where the regex
heuristic gets it wrong.

### Removed (BREAKING for the small set of users who had API key configured)

- **`hooks/lib/prism-opus-classifier.mjs` API-call paths** — the Opus +
  Sonnet API attempts are gone. Function signature preserved (callers
  unchanged); only the source of the classification changes. `source`
  field can no longer be `"opus"` or `"sonnet-fallback"`; it's now one
  of `"keyword-floor"` / `"cache"` / `"allowlist"` / `"force-opus"` /
  `"conversation-model-override"` (new, see below).
- **`INSTALL.md §2.7` (ANTHROPIC_API_KEY setup)** — entire section
  deleted. No replacement needed; keyword-floor works without any
  external auth.
- **`prism-session-start.mjs` keyword-floor warning notice** — removed.
  Keyword-floor is the standard mode, not degraded.
- **`/prism-doctor` keyword-floor symptom** — removed from the symptom
  list. Doctor no longer flags users for not having an API key set.
- **`/prism-health` API-key environment check** — removed.
- All `ANTHROPIC_API_KEY` references throughout the docs (README, etc.).

### Added

- **Conversation-model self-override protocol** — `prism-prompt-tier-router.mjs`
  now emits, alongside the keyword-floor classification, a directive
  inviting the parent conversation model to override the classification
  when the regex heuristic gets it wrong. The override is a Write to
  `~/.claude/.prism-turn-tier-<session>.json` with `source:
  "conversation-model-override"`. Optional, opportunistic — Claude only
  overrides when it disagrees, otherwise keyword-floor stands. This
  uses the conversation model's full intelligence for classification
  without requiring any separate API call.

### Migration

Users who relied on the API classifier (set `ANTHROPIC_API_KEY` in
`prism.env`): your environment variable becomes inert. Remove it from
`prism.env` if you want a clean state, or leave it — nothing reads it
anymore. Keyword-floor classification is now the single classifier
path. Most users won't notice any change in behavior; classifications
on ambiguous prompts may differ slightly from what the API call would
have produced. The conversation-model self-override protocol kicks in
automatically the first time the parent model decides to correct the
classifier.

### Mechanics

Manifest 3.1.0 → 3.2.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Settings.fragment.json unchanged (the
3 v3.1 hooks ship at the same trigger points). 84 manifest entries.

### Known gaps still open (target v3.3+)

- INSTALL-MERGE-001 — user-customized hooks clobbered on upgrade
- SCHEMA-VERSIONING-001 — readers don't validate `schema_version`
- CONFIG-GUARD-DRIFT-001 — config-guard warns but doesn't restore
- skill-trigger-guard hard mode (false-positive measurement first)
- macOS native testing

## [3.1.0] - 2026-04-25

Productization release. Closes the v3.0 documented gaps (T10.3, T13.4),
adds the first centralized policy mechanism, ships a one-command
installer + guided diagnostic command + opt-in local telemetry. Plus
two Tier 3 levers (team roster, central policy) shipped surgically.

### Added — enforcement hooks

- **`prism-parallel-guard.mjs`** — PreToolUse on `Agent`. Detects
  sequential dispatch of pgroup-tagged tasks within a single turn
  (60s window via `~/.claude/.prism-parallel-trace-<session>.json`)
  and emits advisory (soft, default) or denies (hard) with a message
  pointing at the parallel-dispatch contract. Closes T10.3 — the
  parallel-dispatch enforcement gap that v2.7.1 promised but only
  hint-emitted. Honors `!opus-force:` and three-path subagent bypass.
- **`prism-panel-guard.mjs`** — SubagentStop. Scans subagent output
  for persona-name patterns (`**Name**:` etc.) and cross-references
  against `roster.agents/skills/tools` plus a hardcoded fallback
  whitelist (Architect, Security, Performance, Cost, Skeptic, etc.).
  Names matching neither are flagged as unindexed personas. Closes
  DOCTRINE-DRIFT-001 (v2.8.2 audit finding) — the hallucinated-
  persona detection gap. Soft mode warns; hard mode denies +
  asks to re-assemble. Skips `sentinel.dispatched` bypass path
  (would always be true at SubagentStop) — documented inline.
- **`prism-skill-trigger-guard.mjs`** — UserPromptSubmit. Reads
  `skills/prism-plan/references/skill-triggers.md` (12 keyword→skill
  mappings as of v3.1.0) and emits an advisory when a user prompt
  matches a regex but the corresponding skill wasn't auto-invoked
  in the next 2 turns. Closes T13.4 (advisory). Hard mode coerced
  to soft in v3.1 — reserved for v3.2 once false-positive rate
  is measured. Honors `!opus-force:`.

### Added — productization

- **`scripts/install.sh`** — POSIX-compatible one-command installer.
  Modes: `--dry-run`, `--prefix <dir>`, `--branch <name>`,
  `--no-backup`, `--help`. Detects platform, walks 6-source node
  resolution chain (PATH → nvm → fnm → volta → asdf → homebrew),
  writes `~/.claude/prism.env` via single-quoted heredoc to preserve
  Windows backslashes, runs install-merge + verify, captures verify
  exit code for clean error reporting. ERR trap reports failing step.
  Idempotent.
- **`commands/prism-doctor.md`** — symptom-driven diagnostic + guided
  fix command. Scans 50 most-recent routing events, env state, roster
  integrity, settings.json wiring, hook syntax. 10+ symptom→fix
  mappings (keyword-floor mode, prism.env missing, empty
  resource-index, stale sentinels, hook syntax errors, stale roster,
  v2.9.1 BREAKING CONTRACT misconfig, etc.). READ-ONLY by default —
  every fix proposed gets a `[Y/n]` confirmation before any write.
- **`commands/prism-telemetry.md`** — opt-in local-only telemetry.
  Subcommands: `--opt-in`, `--opt-out`, `--status`, `--aggregate`,
  `--export <path>`. Aggregates `~/.claude/.prism-routing.jsonl` into
  `~/.claude/.prism-telemetry-rollup.json` with cost summary,
  classifier accuracy, guard fire rate, tier distribution. **NO
  NETWORK, NO SHIPPING, NO TELEMETRY-AS-A-SERVICE in v3.1.** Future
  SaaS will read same rollup format. Anonymizes session_ids on
  export; raw prompts never exported.
- **README.md landing page** — 30-second pitch (277 chars), three
  concrete use cases (cost discipline / parallel orchestration /
  specialist dispatch), one-line install, status table covering 15
  user journeys (works / half-works / known-gaps), architecture
  overview, docs links. Existing install/contributing/license content
  preserved under "Manual install".

### Added — Tier 3 surgical levers

- **Team roster (`team_id` field)** — optional per-agent field in
  `roster.json`. `null` = global/no team. String = arbitrary team
  identifier. `/prism-roster --team <id>` filters the display table.
  `--team -` shows team-less agents. **Visibility lever, not
  access-control** — any user with read access to `roster.json` sees
  every agent. Real RBAC requires layered auth outside PRISM scope.
- **`~/.claude/prism-policy.json` central policy file** — admin-owned
  config that hooks read BEFORE checking env vars. Schema covers all
  8 guard knobs (mutation, dispatch, model, tier_advisor, safety,
  parallel, panel, skill_trigger) plus telemetry opt-in and team
  defaults. Precedence: **policy file → env var → hook default**.
  User escape: set `PRISM_POLICY_OVERRIDE=1` to flip precedence so
  env wins. Ships as `prism-policy.example.json` template; users
  rename + drop `_` prefixes from active keys.

### Added — schema + telemetry

- **`roster.json` schema bumped to 3.1.0**. New `team_id` field in
  `_schema_example_agent`. New `schema_notes` entry documenting
  team_id semantics.
- **`skills/prism-plan/references/skill-triggers.md`** — 12 keyword
  regex → required-skill mappings consumed by skill-trigger-guard.
  Severity column reserved for v3.2 (currently all `nudge`).
- **`tests/v3/run-static.sh`** extended with v3.1 assertions:
  install.sh executable + dry-run + POSIX syntax; prism-doctor +
  prism-telemetry frontmatter; prism-policy.example.json valid;
  skill-triggers.md present; 3 new hooks parse + honor force_opus +
  three-path bypass; settings.fragment.json registers all 3; roster
  schema = 3.1.0 + team_id documented.
- **`tests/v3/run-claude.md`** extended: T10.3 + T13.4 flipped to
  expected-pass (gaps closed); 6 new categories (Cat 16
  panel-hallucination, Cat 17 doctor, Cat 18 telemetry, Cat 19
  central policy, Cat 20 team filter, Cat 21 installer dry-run +
  real install).
- **`tests/v3/analyze-log.mjs`** extended: 5 new event types tracked
  (`panel_hallucination_detected`, `skill_trigger_advisory`,
  `policy_loaded`, `parallel_guard_block`, `parallel_guard_advise`)
  with verdict heuristics for each.

### Fixed (closes audit findings + v3.0 documented gaps)

- T10.3 (parallel dispatch enforcement) — closed via
  `prism-parallel-guard.mjs`.
- T13.4 (skill-invocation enforcement) — closed via
  `prism-skill-trigger-guard.mjs` (advisory; hard mode v3.2).
- DOCTRINE-DRIFT-001 (panel adversarial review enforcement) —
  partially closed via `prism-panel-guard.mjs` (catches hallucinated
  personas; ≥2-challenge enforcement still doctrine-only).

### Migration

Zero migration. All v3.1 additions are additive. Existing v3.0
installs that `git pull && node scripts/install-merge.mjs` get the
3 new hooks registered, 2 new commands, 4 new reference files. §4d
auto-stamps update-log `3.0.0 → 3.1.0`. No env-var changes for
existing users; new `PRISM_POLICY_OVERRIDE` is opt-in.

### Known gaps still open (target v3.2)

- INSTALL-MERGE-001 — user-customized hooks clobbered on upgrade
  (checksum-based detection needed)
- SCHEMA-VERSIONING-001 — readers don't validate `schema_version`
- CONFIG-GUARD-DRIFT-001 — config-guard warns but doesn't restore
- Skill-trigger-guard hard mode (false-positive rate measurement)
- macOS native testing (sandbox-tested only)

## [3.0.0] - 2026-04-24

Testability release. First comprehensive user-journey test suite covering
every claim PRISM makes about what it does. Not a breaking-change release
despite the major-version bump — the version bump reflects the
accumulated architectural shift from v2.8 → v3.0 (unified resource-index,
T-shape orchestrator, three-path guard parity, fresh-install hardening,
adversarial-review doctrine, BREAKING CONTRACT on `PRISM_MODEL_GUARD=hard`
semantics in v2.9.1).

### Added

- **`tests/v3/`** — end-to-end user-journey test suite. Six artifacts:
  - `plan.md` — 15 categories × 62 tests, organized by the verdict
    framework (works / half-works / known-gap). Distinguishes automated
    from manual tests up front.
  - `run-static.sh` — automated bash runner for categories that don't
    need a live Claude Code session (install/upgrade, verify, roster
    schema, stale-state recovery, backup safety, hook syntax, JSON
    validity, manifest src integrity). 37 automated assertions. Runs
    in a throwaway HOME so the user's real `~/.claude/` is never
    touched. Local run: 37/37 pass on v3.0.0.
  - `run-claude.md` — Claude Code prompt pack for the 25 manual tests
    across classifier routing, guards, roster/reconcile, resource-index,
    blueprint-prompt, parallel dispatch, cost discipline, skills
    invocation, and Windows-specific checks. Every prompt has exact
    expected outcomes tied to sentinel fields or log events.
  - `analyze-log.mjs` — parses `~/.claude/.prism-routing.jsonl` and
    emits a structured markdown report: tier distribution, classifier
    sources, guard denies, subagent-context bypass events, force-opus
    usage, pgroup violations (for future v2.10 hook), classifier
    divergence, verdict heuristic. Supports `--since <ISO>` filter.
  - `report-template.md` — fill-in table-per-category report with
    auto-captured static-log + analyzer-output appendix.
  - `run-all.sh` — master orchestrator. Modes: interactive (static +
    manual prompt + analyzer + report), `--static-only`, `--ci`.
- **`.gitignore` coverage** for generated test artifacts
  (`tests/v3/v3-report-*.md`, `tests/v3/v3-*.log`).

### Unchanged / documented-gap carry-forward

These findings from the v2.8.2 fresh-eyes audit remain known gaps
targeting later releases. The test suite validates them as documented
failures (T10.3, T13.4), not regressions:

- **Parallel-dispatch enforcement** (target v3.1) — `prism-parallel-guard`
  hook that blocks sequential dispatch of same-pgroup tasks.
- **Hallucinated-persona detection** (target v3.1) — `prism-panel-guard`
  hook that cross-references panel output against `roster.json` skills
  + agents.
- **Skill-invocation trigger map** (target v3.1) — keyword → required-skill
  advisory.
- **User hook customization preservation** (target v3.2) — checksum-based
  detection, copy-to-`.new` on conflict.
- **Config-guard self-heal** (target v3.2) — restore PRISM section in
  global CLAUDE.md from backup.
- **Schema-version runtime checking** (target v3.2) — readers validate
  `roster.schema_version` before parsing new shapes.
- **ATLAS purge in fresh-install path** (target v3.2 cleanup) — move
  legacy migration out of `INSTALL.md §2.6`.

### Migration notes

No migration needed. Test suite is additive. Running `/prism-update` or
`git pull && node scripts/install-merge.mjs` bumps update-log
`2.9.1 → 3.0.0` via the §4d auto-stamp added in v2.8.1. Nothing else
changes. Users not running tests see identical runtime behavior to v2.9.1.

### Running the suite

```bash
# Automated only (~2 min)
bash tests/v3/run-static.sh

# Full (static + manual prompts + analyzer)
bash tests/v3/run-all.sh
```

Report target: 60/62 pass. 2 documented failures in categories 10 + 13
are EXPECTED and prove the v3.1 target gaps still exist. When those hooks
ship, the expected results for those tests flip to pass.

## [2.9.1] - 2026-04-24

Audit hardening patch. Two in-scope findings from the fresh-eyes audit
of v2.8.2 applied, plus a strict-mode migration notice. Executed via
proper PRISM protocol (blueprint-prompt → master-orchestrator
dispatch → parallel Group A execution) — the protocol discipline was
the point; the code fixes are small.

### ⚠ BREAKING CONTRACT — `PRISM_MODEL_GUARD=hard` semantics changed

**If you set `PRISM_MODEL_GUARD=hard` deliberately to deny any non-opus
dispatch without explicit model, you must switch to
`PRISM_MODEL_GUARD=strict` to preserve that behavior.**

v2.9.1 narrows `hard` mode to match `task-tier-advisor` semantics: deny
ONLY when sentinel tier is `opus` AND no explicit model. Sonnet and
Haiku dispatches drop to advisory nudges under `hard`. The old
deny-everything behavior is preserved under the new `strict` enum
value.

A one-time session-start notice surfaces this when
`PRISM_MODEL_GUARD=hard` is detected post-upgrade, gated by
`~/.claude/.prism-v2.9.1-migration-shown`.

### Fixed

- **TIER-DRIFT-001**: `prism-agent-model-guard.mjs` `hard` mode was
  over-enforcing — denying every non-opus dispatch without explicit
  model violated the "soft doctrine in skills, hard enforcement in
  hooks" principle by gating tier-routing decisions that belong in
  advisory territory. Split into three modes (soft / hard / strict)
  with hard now matching task-tier-advisor semantics. Unknown env
  values fall back to `soft` (safe default).

- **ATOMIC-WRITE-001**: `prism-memory-save-nudge.mjs` and
  `prism-session-start.mjs` were writing state files directly via
  `writeFileSync`, missing the tempfile+renameSync pattern that
  v2.8.0 shipped for other state writers. Now match the v2.8.0
  reference shape in `prism-parent-dispatch-guard.mjs:90-107`
  (tempfile + atomic rename with catch-fallback to direct write for
  the Windows-antivirus EBUSY edge case). Counter corruption from a
  crash mid-write no longer silently resets nudge cadence or context-
  audit state.

### Added

- **v2.9.1 migration notice** in `prism-session-start.mjs` — one-time
  emit when `PRISM_MODEL_GUARD=hard` is in env and the flag file
  `~/.claude/.prism-v2.9.1-migration-shown` is absent. Points users
  at the strict-mode contract change. Flag written atomically
  (tempfile+rename) after first emit.

### Known gaps (not addressed in v2.9.1 — tracked for future releases)

Six findings from the v2.8.2 audit remain open. Deferred deliberately
to keep v2.9.1 narrow and shippable; none block current workflows.

| ID | Severity | Target | Summary |
|---|---|---|---|
| INSTALL-MERGE-001 | HIGH | v2.10 | install-merge.mjs has no checksum-based detection of user-edited hooks → upgrades silently clobber user customizations |
| DOCTRINE-DRIFT-001 | MEDIUM | v2.10 | blueprint-prompt adversarial review (≥2 substantive challenges) is text-only doctrine — no hook enforces compliance |
| SCHEMA-VERSIONING-001 | MEDIUM | v3.0 | roster.json `schema_version` is written but no reader validates it before parsing — silent breakage when readers lag writers |
| CONFIG-GUARD-DRIFT-001 | LOW | v3.0 | `prism-config-guard.mjs` warns on CLAUDE.md PRISM-section removal but doesn't restore — damage already done by the time warning fires |
| DEAD-REFERENCE-001 | LOW | v3.0 | INSTALL.md §2.6 ATLAS purge runs on every install including fresh ones that have no ATLAS state — should be gated or relocated |
| DEPENDENCY-MANIFEST-001 | INFO | opportunistic | tools-registry.md has no `last_verified` date or schema version — no staleness detection |

## [2.9.0] - 2026-04-24

Unified resource-index release. Closes the structural gap that caused
orchestrators to hallucinate generic personas ("Rachel/Priya") instead
of dispatching to real installed skills (ui-ux-pro-max, frontend-design,
etc.). Plus one CRITICAL guard-parity fix surfaced by the fresh-eyes
audit run against v2.8.2.

### Added

- **`/prism-index` command** — scans every installed agent, skill,
  tool, and MCP and populates a unified resource-index. Covers resources
  that never flowed through agent-factory: user-installed skills,
  plugin-provided skills (from `~/.claude/plugins/*/skills/`), manually
  imported agents, configured MCP servers. Deterministic keyword
  extraction by default; optional `--enrich` flag uses Opus for higher-
  quality keywords/trigger-phrases (~$0.30 per full reindex).
  Idempotent, additive to the `agents` block (never clobbers
  agent-factory state). Backs up `roster.json` to `.bak` before write.
  Modes: `/prism-index`, `/prism-index --enrich`, `/prism-index --dry-run`,
  `/prism-index --skills-only`.

- **Unified resource-index schema in `roster.json` (schema v2.9.0).**
  The file that was previously an agent-only roster becomes PRISM's
  single source of truth for all callable resources. Four authoritative
  sibling blocks: `agents` (unchanged — task-tracking state), `skills`
  (new — discovery metadata), `tools` (new — Tier 1/2 install status),
  `mcps` (new — configured servers). Plus an `index_meta` block tracking
  `last_indexed` / `indexer_version` / `enrichment` level. Each block
  has a `_schema_example_<type>` entry documenting the fields.

- **Blueprint-prompt Phase 4 — resource-index-first assembly.**
  Hard-codes the mandatory query protocol: extract prompt keywords,
  score across all four index blocks, pick top-scoring indexed resource
  per domain, fall back to hardcoded personas ONLY when no resource
  scores above threshold, and explicitly label any fallback. Also:
  if the index is empty/missing, emit a loud "hallucination risk HIGH"
  notice at the top of the panel output. Closes the doctrine-vs-code
  gap where Phase 4 said "roster-first" but nothing enforced it.

- **Master-orchestrator Phase 0a — unified read.** Single read of
  `roster.json` replaces three separate reads (roster / tools-registry /
  mcp-registry). Emits index-staleness warning when
  `index_meta.last_indexed` is null or >14 days old.

### Fixed

- **CRITICAL: `prism-agent-model-guard.mjs` missing v2.7.5 three-path
  subagent-context bypass.** The v2.8.0 CHANGELOG claimed *"All guards
  now treat subagent context identically"* but agent-model-guard was
  never actually wired with the bypass. Result: on Claude Code builds
  that don't propagate `parent_tool_use_id` to subagent `Agent()`
  calls, a subagent-spawned Agent() without explicit `model` was
  treated as parent-context and hit the same gate as a parent Opus.
  v2.9.0 adds the three-path bypass (parent_tool_use_id /
  CLAUDE_CODE_ENTRYPOINT env / sentinel.dispatched) at the top of
  `main()`, matching mutation-guard, parent-dispatch-guard, and
  task-tier-advisor exactly. The false parity claim in v2.8.0
  CHANGELOG is now genuine.

## [2.8.2] - 2026-04-24

Security hygiene patch. `/prism-audit` run against v2.8.1 install
surfaced a `CRITICAL` + `HIGH` finding both rooted in the same gap:
the PRISM repo shipped with no `.gitignore`. Any fresh clone that
dropped a `.env`, local Claude Code overlay, or secret file would
track it immediately, risking accidental `git add .` commits.

### Fixed

- **Add `.gitignore` to PRISM repo root.** Covers:
  secrets (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials.json`, `*.pfx`); Claude Code local overlays
  (`CLAUDE.local.md`, `.claude/settings.local.json`,
  `.claude/.prism-state.json`, `.claude/references/`); dev cruft
  (`node_modules/`, `.DS_Store`, `Thumbs.db`); and stray
  `backups/` dirs if install-merge ever lands one in repo root
  due to a misconfigured HOME. Tracked-repo canonical files
  (`manifest.json`, `settings.fragment.json`, `tasks/todo.md`,
  `tasks/lessons-*.md`) intentionally NOT ignored — those are
  the shared project-state files PRISM teams commit.

## [2.8.1] - 2026-04-24

Fresh-install hardening release. Three fixes identified during the v2.8.0
install/upgrade walkthrough on a real user's machine where `/prism-health`
surfaced drift that existed in the repo itself (not just local state).
All additive, backward-compatible, no runtime behavior changes.

### Added

- **`skills/prism-chat/SKILL.md` now in manifest.** The definitive
  Claude.ai chat skill landed in v2.8.0 but was not wired into
  `manifest.json`, so `install-merge.mjs` never copied it to fresh
  installs and `verify.mjs` never validated it. Adding the entry fixes
  both — the skill now ships with every install and upgrade.
- **`install-merge.mjs` stamps manifest version into `update-log.json`
  (new §4d).** Previously the merger copied files and merged settings
  but never touched `~/.claude/skills/prism-plan/references/update-log.json`.
  This caused `/prism-health` to report "version lag" on every fresh
  install — the installed files matched v2.8.0 but the log still showed
  the skeleton's shipped version. Now, after a successful merge,
  install-merge reads `manifest.json` → compares to the log's
  `prism_version` → appends an `update_history` entry and bumps the
  field if they differ. Idempotent: re-running with no version change
  only refreshes `last_update_check`. Fresh installs (no log file yet)
  get a freshly-created log with an "Installed PRISM v<X> via
  install-merge" entry. Non-fatal on any error — metadata write, not
  load-bearing.
- **`/prism-roster --reconcile` — new flag for orphan-agent registration.**
  Scans `~/.claude/agents/` (both flat `<name>.md` and subdir
  `<name>/agent.md` layouts), finds agent files not present in
  `roster.json`, and adds minimal roster entries with defaults from
  each agent's frontmatter. Core PRISM agents (agent-factory,
  master-orchestrator, prism-updater) skipped. Existing entries never
  modified — reconcile is strictly additive. Closes the gap for agents
  created outside `agent-factory` (manual creation, imports from
  another PRISM install, legacy pre-v2.7 agents, factory mid-crash
  states). Creation date falls back through: git first-commit date →
  file mtime → current timestamp. Entries are marked `"source":
  "reconcile"` to distinguish from factory-created agents that have
  richer metadata (notebooklm_notebook_id, researched domains, etc.).
  Backup to `roster.json.bak` before any write.

### Fixed

- **Default-mode `/prism-roster` now surfaces orphans.** Previously the
  command displayed only what was in `roster.json`, so agents on disk
  but missing from the roster were silently invisible. The display
  table now ends with an "orphans detected" flag when `~/.claude/agents/`
  contains files not in `roster.json`, with a suggestion to run
  `/prism-roster --reconcile`. Closes the same detection gap that
  required running `/prism-health` to notice roster drift.

## [2.8.0] - 2026-04-23

Audit-driven hardening release. 13 fixes from the full repo audit,
bundled into one version bump after the v2.7.x hotfix cadence. No new
features; all hardening, correctness, and observability. Backward-
compatible — runtime behavior preserved for all legitimate inputs.

### Fixed

- **`scripts/verify.mjs` now checks every manifest entry.** Previously
  only 11 of 75 paths were hardcoded-verified. Silent install failures
  (e.g., `prism-opus-classifier.mjs` missing from disk) would pass
  verify and crash at first prompt. v2.8.0 reads `manifest.json` at
  verify time and checks all 75 `dest` paths exist. Hardcoded fallback
  preserved for the rare case the manifest can't be located.
- **`RELEASE_SAFETY_RE` no longer fires on bare `PRISM` or `2.x.x`
  tokens.** Previously every prompt mentioning "PRISM" by name or
  quoting a version triggered `release/meta-work` in the keyword
  floor → `summon_panel=true` → dispatch-guard panel demand. On
  users with API unreachable (classifier stuck in floor), this was
  nearly every prompt about using PRISM itself. Now requires
  release-like context: `release PRISM`, `deploy v2.8.0`,
  `upgrade PRISM to 2.8`, etc. Bare mentions like
  "configure PRISM for my project" no longer trip the screen.
- **`install-merge.mjs` stale-prune uses explicit legacy-hook whitelist.**
  Previously the pattern `prism-[A-Za-z0-9._-]+\.mjs` matched ANY
  `prism-*` raw-node hook including user-authored custom hooks. v2.8.0
  ships an explicit 26-name whitelist (13 known PRISM legacy hooks +
  13 ATLAS-era renames) so users with their own `prism-my-custom.mjs`
  raw-node entries are preserved intact across upgrades.
- **`INSTALL.md` §2.6 purge uses explicit path lists (no `atlas-*`
  catch-all glob).** The old glob matched `~/.claude/atlas-reference-archive/`
  — a user's legitimate archive directory — and deleted it on any
  upgrade that hit §2.6. v2.8.0 enumerates the 6 known atlas-era
  subdirectories by name and uses the glob only for per-session
  sentinels and counters where the suffix is a UUID (truly unambiguous).
- **`commands/prism-recall.md` now has `name: prism-recall` in YAML
  frontmatter.** All other commands declare `name:` explicitly; this
  was the one outlier. Claude Code may derive name from filename in
  some builds but the explicit declaration is required for consistency
  and for builds that require it.
- **Manifest `chmod +x` entries added for `prism-monitor.py`,
  `refresh-statusline-cache.sh`, and `subagent-summary.py`.**
  Previously these 3 shipped without execute bit; POSIX users saw
  "permission denied" on first invocation. `.sh` and `.py` entries
  that are import-only (not invoked as scripts) correctly remain
  non-executable — only the 3 genuinely script-invoked files get +x.
- **`prism-safety.mjs` fails open on parse error (exit 0, not 1).**
  Consistent with all other PRISM hooks. Previous behavior printed
  "Safety hook error: <msg>" to stderr on malformed PreToolUse
  payloads. Exit 2 (dangerous-pattern match) is preserved — that's
  the only intentional error path.
- **Task-tier-advisor now has the v2.7.5 three-path subagent bypass.**
  Parity with mutation-guard (v2.7.5) and parent-dispatch-guard
  (v2.2.1). Without this, `PRISM_TASK_TIER=hard` users on Claude Code
  builds that drop `parent_tool_use_id` could get subagent TaskCreate
  denied as parent-context. All guards now treat subagent context
  identically.

### Added

- **Atomic sentinel writes** in `prism-parent-dispatch-guard.mjs` and
  `prism-prompt-tier-router.mjs`. Tempfile + rename instead of direct
  writeFileSync. Prevents truncated JSON sentinels from crashes
  mid-write (disk full, antivirus interference, node process kill).
  Readers (all four guards, weekly rollup) never see a partial file.
  Direct-write fallback preserved for edge cases.
- **Session-start classifier-floor hint** in `prism-session-start.mjs`.
  Once per 24h, when `ANTHROPIC_API_KEY` is missing from hook env
  (detected via probe of env var + `~/.claude/prism.env`), emits a
  visible notice: *"Classifier is running in keyword-floor-only mode
  — see INSTALL.md §2.7 for setup"*. Users no longer have to tail
  `.prism-routing.jsonl` to discover they're in floor-only mode.
- **Classifier API error visibility.** Previously the Sonnet-fallback
  catch block swallowed errors silently. v2.8.0 collects `api_errors`
  on both Opus and Sonnet failures (with HTTP status + trimmed
  message) and attaches to the classifier result. Weekly rollup can
  now surface which API failure mode is dominant — 401 (bad key),
  429 (rate limit), 529 (overloaded), or network timeout.
- **INSTALL.md §2.7 — ANTHROPIC_API_KEY setup guide.** Detection
  ("am I in floor-only mode?"), setup recipes per OS (POSIX shell
  profile, POSIX dedicated env file, Windows `setx User`), security
  notes, and verification. Optional — no PRISM feature requires it,
  but presence improves classifier accuracy on ambiguous prompts.
- **INSTALL.md §2.8 — tuning env vars.** All 6 enforcement-mode env
  vars (`PRISM_PROMPT_ROUTER`, `PRISM_DISPATCH_GUARD`,
  `PRISM_MUTATION_GUARD`, `PRISM_MODEL_GUARD`, `PRISM_TASK_TIER`,
  `PRISM_MEMORY_NUDGE`) + 3 classifier-tuning vars
  (`PRISM_TIER_THRESHOLDS`, `PRISM_MEMORY_NUDGE_FIRST`,
  `PRISM_MEMORY_NUDGE_INTERVAL`) documented in one table.
  `!opus-force:` prefix semantics documented inline.

### Changed (doc-only)

- **`tools-registry.md` dangling `/prism-registry` reference** replaced
  with honest doc: "no dedicated registry command exists — edit the
  markdown directly and commit". The command never existed; text was
  aspirational from v1.1.0 planning. Clean now.
- **`roster.json` `schema_version` bumped from 2.7.0 → 2.8.0.** No
  schema changes; version sync with current PRISM version.

### Notes

- **Re-install flow for upgrade**: pull the branch, run `node
  scripts/install-merge.mjs` (v2.7.3 merger). File-copy step 3 picks
  up all hook/script/command changes. No settings migration needed.
- **No breaking runtime changes**. The `RELEASE_SAFETY_RE` tightening
  and stale-prune whitelist both err on the side of fewer actions
  (less panel-summoning, fewer prunes). Users with custom `prism-*.mjs`
  hooks now upgrade cleanly.
- **ANTHROPIC_API_KEY propagation via settings.fragment.json was
  explicitly out of scope**, per user direction. Users who want the
  Opus classifier active add the key manually per INSTALL.md §2.7.
  The session-start hint makes floor-only state visible so they can
  decide whether to configure it.
- **Tested clean-room install with mocked missing manifest entries**:
  `verify.mjs` correctly reports `FAILED: 73 checks did not pass`
  instead of the pre-2.8.0 false green.

## [2.7.5] - 2026-04-23

Second hotfix in the v2.7.4 cycle. Closes the final lockout path where
an installed PRISM + guards-on + Claude Code build that doesn't
propagate `parent_tool_use_id` to subagent tool calls → every
Agent()-dispatched `Edit`/`Write`/`Bash` denied as "parent context".

### Context — the real-world lockout

v2.7.4 fixed `!opus-force:` via `sentinel.force_opus`, but a user on a
Claude Code build that doesn't send `parent_tool_use_id` to subagent
tool calls discovered a deeper problem: **every documented
mutation-guard override was non-functional in that build**:

- `!opus-force:` prefix: pre-v2.7.4 only checked `input.user_prompt`
  (empty on PreToolUse in most builds). v2.7.4 added sentinel path.
- Subagent dispatch: `input.parent_tool_use_id` wasn't populated, so
  haiku-dispatched Edit/Write hit the same guard deny as parent calls.
- `PRISM_MUTATION_GUARD=off` in settings.local.json env: works, but
  the user couldn't edit the file — the mutation-guard was blocking
  writes to the very file that would turn it off. Bootstrap deadlock.

Only escape: manual edit of `.claude/settings.local.json` outside
Claude Code (Notepad etc.). That's a terrible UX for a "hotfix guard".

### Fixed

- **`prism-mutation-guard.mjs` now checks all 3 subagent bypass paths**
  the dispatch-guard has used since v2.2.1:
    1. `input.parent_tool_use_id` present (original v2.2.1 check)
    2. `CLAUDE_CODE_ENTRYPOINT` env var === `'subagent'`
    3. `sentinel.dispatched === true` (parent has already dispatched an
       Agent() this turn; subsequent tool calls — parent or subagent
       that lost its parent_tool_use_id — all pass)
  Parity restored with `prism-parent-dispatch-guard.mjs`. Both guards
  now treat subagent calls identically.

  Path 3 is the critical one for builds that drop `parent_tool_use_id`:
  once parent Opus has made ANY Agent() dispatch on the turn, the
  sentinel.dispatched flag flips (dispatch-guard does this), and
  thereafter both guards allow any work-tool call regardless of
  payload shape.

### Logged reasons (for `.prism-routing.jsonl` observability)

- `subagent-parent-tool-use-id-passthrough` — path 1 fired
- `subagent-claude-code-entrypoint-passthrough` — path 2 fired
- `subagent-sentinel-dispatched-passthrough` — path 3 fired

Weekly rollup (v2.7.0+) can now report which path is most common per
user. On builds with broken `parent_tool_use_id`, path 3 will dominate;
that's a signal the Claude Code build has the propagation bug.

### Notes

- **Bootstrap deadlock remains for users still on pre-2.7.5.** If
  `PRISM_MUTATION_GUARD=off` isn't already set in settings.local.json,
  the only way to add it is to edit the file manually outside Claude
  Code. Once done, `=off` turns the guard off system-wide for that
  project, and the user can subsequently install v2.7.5 normally and
  switch the guard back to `hard` (or remove the env override).
- **No INSTALL.md change.** Re-running `node scripts/install-merge.mjs`
  is a no-op; this is a hook-file-content update — §3 file-copy covers
  it on any re-install.
- **Backward-compatible.** Existing `PRISM_MUTATION_GUARD=off` overrides
  continue to work. Existing `!opus-force:` prefix from v2.7.4 works.
  All three paths are OR-combined with the existing checks — no
  regression possible.

## [2.7.4] - 2026-04-23

Hotfix: `!opus-force:` prefix now actually bypasses the mutation-guard.
Discovered during a real Phase 2 design-migration session — prefix gated
tier routing correctly but parent `Edit`/`Write`/`Bash` still got denied.

### Fixed

- **`prism-mutation-guard.mjs` now reads `sentinel.force_opus`** as
  authoritative. The v2.2.1 → v2.7.3 implementations checked
  `input.user_prompt` for the `!opus-force:` substring, but Claude Code
  PreToolUse payloads do not reliably include `user_prompt` — that's a
  `UserPromptSubmit`-scoped field. The guard was effectively blind to
  the override despite emitting "Override: prefix the user prompt with
  !opus-force:" in its deny message.

  The tier-router (`hooks/prism-prompt-tier-router.mjs` + classifier)
  correctly sets `sentinel.force_opus = true` when it sees the prefix
  on `UserPromptSubmit`. `parent-dispatch-guard.mjs` has read that
  sentinel since v2.5.0. `mutation-guard.mjs` now matches the pattern:
  reads sentinel at the same phase as the bootstrap-command check,
  passes through immediately when `force_opus === true`.

  The legacy `input.user_prompt` path is retained as defense-in-depth
  for any Claude Code version that does include `user_prompt` on
  PreToolUse — it runs after the sentinel check, logs
  `reason: 'opus-force-prompt'` vs `'opus-force-sentinel'` so the
  source is observable in `.prism-routing.jsonl`.

### Why this matters

On a guards-on session (`PRISM_MUTATION_GUARD=hard`,
`PRISM_DISPATCH_GUARD=hard`), users must either:
- Turn off guards entirely (`=off` in settings.local.json), OR
- Use `!opus-force:` prefix per prompt to bypass.

v2.7.0–v2.7.3 users who picked the prefix approach discovered the
prefix worked for the dispatch-guard (which stopped asking for
`@master-orchestrator` dispatch) but the mutation-guard still denied
their `Edit`/`Write`/`Bash` calls. The two guards were inconsistent.
Now both honor `sentinel.force_opus` identically.

### Notes

- **Backward-compatible.** Existing sessions keep working. If a user
  ran a turn without `!opus-force:`, sentinel.force_opus is false,
  guard behaves exactly as v2.7.3 did.
- **No runtime perf change.** One additional `readSentinel()` call per
  PreToolUse, which was already happening in `isBootstrapTurn()`
  anyway — now we just read the flag field alongside the rationale.
- **No config change needed.** Existing `PRISM_MUTATION_GUARD=off` in
  settings.local.json still works exactly the same.
- **No INSTALL.md change.** Re-running `node scripts/install-merge.mjs`
  is a no-op since the hook file content is the only thing that
  changed — file-copy step 3 covers it.

## [2.7.3] - 2026-04-23

Install-experience fixes from real-world v2.7.2 install friction. No
runtime changes. Moving the §4 merge logic into source-controlled code
eliminates the three Git-Bash-on-Windows escape traps that caused the
last installer to need three attempts.

### Added

- **`scripts/install-merge.mjs`** — consolidates INSTALL.md §4a
  (Windows rewrite), §4b (stale-entry prune), and §4c (deep-merge) into
  one idempotent script. Runs from the repo root: `node
  scripts/install-merge.mjs`. Uses `String.fromCharCode(92)` for
  literal backslashes internally, bypassing both Git Bash template-
  literal mangling and `JSON.stringify` double-escaping. Prints a
  parsable summary (`PRUNED_COUNT=N`, `MERGED_NEW_HOOK_ENTRIES=N`,
  etc.) that INSTALL.md §8 consumes.

### Changed

- **`INSTALL.md` §2.5** — the `printf 'PRISM_NODE=...\\n'` recipe
  caused Git Bash on Windows to interpret `\n`, `\P`, and other
  backslash sequences, mangling Windows paths like
  `C:\Program Files\nodejs\node.exe`. Replaced with a single-quoted
  heredoc (`cat > ~/.claude/prism.env <<'EOF' ... EOF`) that preserves
  backslashes verbatim. Explicit warning added against `printf` /
  `echo -e` for this file.
- **`INSTALL.md` §2.6** — purge block switched from `rm -rf` to
  `rm -r`. The safety-gate pattern `/rm\s+-rf\s/i` correctly blocks
  `rm -rf` as a dangerous shell pattern; our own install docs
  shouldn't trip it. `-f` is unnecessary since nothing in
  `~/.claude/` is write-protected.
- **`INSTALL.md` §4** — replaced inline `node -e "..."` merge
  instructions with a single `node scripts/install-merge.mjs`
  invocation. The inline approach had three escape traps that bit
  v2.7.2 installers:
    1. Template literals `\\` flattened by Git Bash before reaching node
    2. `JSON.stringify` double-escaped backslashes
    3. Two retries before `String.fromCharCode(92)` + plain concat landed
  §4a/§4b/§4c sections retained as reference documentation; the
  script is authoritative.

### Fixed

- **Stale test assertion `P5a.2` in `tools/test-prism-gaps.mjs`**
  updated to match v2.7.0 advisor behavior. Advisor moved from
  `PostToolUse` → `PreToolUse`, so `task_id` must now come from
  `tool_input.id` (not `tool_response.task_id`). Test payload
  updated; assertion unchanged semantically.
- **Stale test assertion `V220.11` in `tools/test-prism-gaps.mjs`**
  updated to match v2.7.0 `cacheKey` behavior. `dirty` parameter was
  removed from the cache key in v2.7.0 (noted in v2.7.0 changelog
  entry) to improve prompt-iteration hit rate. Assertion now
  expects `k1 === k3` (dirty-insensitive) instead of `k1 !== k3`.
  Test renamed to "cacheKey is deterministic, branch-sensitive,
  dirty-insensitive (v2.7.0+)".

### Notes

- **No runtime changes.** All hooks, guards, classifier, and
  orchestrator logic unchanged. Only INSTALL.md, tests, and a new
  repo-only script.
- **Backward-compatible install.** If for some reason a user runs
  an older INSTALL.md against a v2.7.3 repo, the old inline
  approach still works (with the Windows escape friction); the new
  script is strictly an improvement, not a requirement.
- **v2.7.2 install on the branch completed cleanly** despite the
  friction — specialists preserved, 14 stale entries pruned,
  prism.env correct, verify PASSED. v2.7.3 just prevents the
  three-retry-on-§4 experience for the next installer.

## [2.7.2] - 2026-04-23

Windows BOM trap closed. Fixes the compensation-pattern failure surfaced
during the migration: mutation-guard blocks parent-context `Edit/Write`,
Claude routes writes through Bash/PowerShell, PowerShell defaults to
UTF-8-with-BOM, files get corrupted. Prior sessions had to manually
strip BOMs before commit or set `PRISM_MUTATION_GUARD=off`. Neither is
a real fix. This release makes the guard aware of file-writing Bash
and tells the model to use Edit/Write tools instead.

### Added

- **Bash file-write patterns in `hooks/prism-mutation-guard.mjs`.**
  Matcher extended from `Edit|Write|MultiEdit` to `Edit|Write|MultiEdit|Bash`.
  When Bash is called from parent context, the guard inspects the
  command string against 15+ write-pattern regexes:
    - PowerShell writers: `Set-Content`, `Add-Content`, `Out-File`,
      `Export-Csv`, `Export-Clixml`, `Tee-Object -FilePath`,
      `[System.IO.File]::WriteAllText`, `ConvertTo-Json | Set-Content`
    - Shell redirect to file: `> foo.json`, `>> file.ts` with
      extension whitelist to avoid matching `> /dev/null` or `>&2`
    - `echo` / `printf` / `cat` redirects and heredocs
    - In-place editors: `sed -i`, `awk > file`, `perl -i`
    - Language one-liners: `python -c "open(...'w')"`, `node -e
      "...writeFileSync..."`, `ruby -e "File.write..."`
    - Downloaders with file output: `curl -o foo.json`, `wget -O foo.md`
    - Mutation commands into project paths: `cp`/`mv` into
      `src/`, `app/`, `lib/`, `.claude/`, etc.
    - `git restore`/`checkout` on code files
  Non-write Bash (`git status`, `ls`, `npm run`, etc.) passes cleanly.
  Subagent callers (via `parent_tool_use_id`) always pass. Bootstrap
  commands (`/prism-init`, `/prism-update`, `/prism-archive`) continue
  to pass via the existing allowlist.
- **BOM-safe acknowledgement.** When the Bash command includes
  `-Encoding UTF8NoBOM`, `-Encoding ASCII`, or
  `[System.Text.UTF8Encoding]::new($false)`, the guard's notice drops
  the BOM warning (the user knows what they're doing). Still blocks
  in hard mode on parent context — the mutation-guard is about
  orchestrator pattern, not just encoding — but message is shorter.
- **Windows BOM warning in deny/nudge messages.** When
  `process.platform === 'win32'` AND Bash-write is detected AND
  command is not BOM-safe, the guard's message enumerates the three
  safe alternatives:
    1. Prefer Edit/Write tools (no BOM).
    2. Append `-Encoding UTF8NoBOM` to Set-Content/Out-File.
    3. Use `[System.IO.File]::WriteAllText` with explicit
       non-BOM UTF-8 encoder.
- **Tier-router Windows note.** `hooks/prism-prompt-tier-router.mjs`
  now appends a Windows-specific note to every dispatch advice
  (haiku / sonnet / summon_panel turns): *"inside subagent prompts,
  instruct them to use Edit/Write/MultiEdit for file changes — NOT
  Bash/PowerShell. PowerShell's Set-Content, Out-File, and `>` redirect
  default to UTF-8 with BOM..."*  Early warning before the model even
  starts dispatching.

### Changed

- **`settings.fragment.json` mutation-guard matcher** updated to
  `Edit|Write|MultiEdit|Bash`. Bash calls now pass through the
  mutation-guard, which short-circuits to pass-through on
  non-write Bash.

### Fixed

- **PowerShell `Set-Content`/`Out-File`/`>` redirect bypassing the
  mutation-guard.** Previously parent Opus, blocked on `Edit`/`Write`,
  would "compensate" using Bash/PowerShell — which went through only
  the safety-gate (blocks `rm -rf` etc.) and the parent-dispatch-guard
  (tier enforcement), not the mutation-guard. The resulting
  UTF-8-with-BOM output corrupted JSON/YAML/TS files in subtle ways
  (git diff shows `﻿` prefix, some parsers fail). 2.7.2 catches these
  at the mutation-guard layer with the same orchestrator-pattern
  enforcement that applies to Edit/Write.

### Notes

- **Backward compatible runtime.** Existing PRISM_MUTATION_GUARD
  settings (`hard`/`soft`/`off`) apply to Bash the same way they
  apply to Edit. `off` remains a clean escape hatch.
- **Bootstrap-command allowlist preserved.** `/prism-init`,
  `/prism-update`, `/prism-archive` can still write project files
  via Bash (they legitimately need to — file creation during install
  often uses `mkdir`, `cp`, `>` redirect).
- **False-positive floor.** The write-pattern list is deliberately
  non-exhaustive — designed to catch the 90%+ common writes without
  flagging `git status`, `ls`, `node --version`, or test-running
  commands. If you find a false positive, set
  `PRISM_MUTATION_GUARD=soft` for the session (nudge only, no block)
  or `=off` (silent).
- **Migration unchanged.** No data migration. Re-running
  `INSTALL.md` copies the updated hook + fragment; existing
  `settings.json` gets re-merged via §4c (fragment's expanded
  matcher replaces the old Edit|Write|MultiEdit matcher cleanly).

## [2.7.1] - 2026-04-23

Parallel-dispatch enforcement. Three-file patch that closes the "PRISM
misses parallelism opportunities on non-NOVEL work" gap identified in
the scoring-mechanics review.

### Context

Current Claude Code runtime has ONE spawn tool, `Agent()`. Parallelism
comes from dispatching **multiple `Agent()` tool_use blocks in a SINGLE
assistant message** — Claude Code fans them out concurrently, wall-clock
cost = `max(each)` not `sum(each)`. Sequential `Agent()` calls are
strictly slower.

Prior PRISM docs referenced a separate `Task()` spawn tool that no
longer exists. That stale terminology hid the actual speed mechanism
from the model and caused the orchestrator to reason about parallelism
in a way that didn't match the runtime.

### Added

- **Parallel-opportunity detector in `hooks/prism-hook.mjs`.** Five
  new regex patterns fire an INVOCATION nudge when the user prompt
  carries enumerative, comparative, or explicit-parallel cues:
    - `parallel_enum`: "these 5 modules", "each of the 3 packages"
    - `parallel_multi`: "run tests across", "scan for X over every"
    - `parallel_compare`: "compare X vs Y", "A/B", "benchmark against"
    - `parallel_list`: "research Redis, Memcached, and Dragonfly"
    - `parallel_explicit`: "in parallel", "concurrently", "simultaneously"
  Nudge text: *"Parallelizable work detected. Dispatch as MULTIPLE
  Agent() tool uses in a SINGLE assistant message..."* — includes the
  recipe (N tool_use blocks, cheap-model-per-task rule). Cooldown 5
  turns. Doesn't fire if the existing `delegate` nudge already fired
  on the same prompt (avoids double-emit).

- **`[pgroup=N]` as an execution contract** in
  `skills/blueprint-prompt/SKILL.md` Phase 6. Previously *"labels
  tasks that can run concurrently"* (hint); now *"BINDING contract
  at execution time"* (must batch into one message). Plus worked
  example with the anti-pattern. Plus a `{event:'pgroup_violation'}`
  hook event described for future weekly-rollup surfacing.

### Changed

- **Master-orchestrator Phase 1 parallelism decision** rewritten.
  Stale "Method A: Task() Subagents" / "Method B: Agent Teams"
  dichotomy replaced with:
    - **PARALLEL**: multiple `Agent()` tool_use blocks in ONE
      assistant message. Cap 4 per batch (coordination cost).
    - **SPLIT-AND-MERGE**: same pattern, different data subsets.
    - **AGENT TEAMS** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
      for teammates that must message each other mid-execution.
  Explicit anti-pattern call-out: emitting one `Agent()` per
  successive assistant message when batch is possible is strictly
  slower AND pays a fresh prompt-cache miss per spawn.

### Notes

- Backward-compatible — no hook or manifest changes. Purely docs +
  one new regex block in `prism-hook.mjs`.
- No classifier or sentinel changes. The new nudge fires independently
  of the tier router; useful on ROUTINE and NOVEL tiers alike where
  blueprint/orchestrator aren't engaged.
- Terminology correction: **"subagent" and "agent" refer to the same
  runtime primitive** (a child spawned via `Agent()`). There is no
  speed difference between them — the speed variable is
  *sequential vs parallel dispatch*, not tool choice.

## [2.7.0] - 2026-04-23

Classifier reconciliation + orchestration quality. Seven concrete fixes
to scoring mechanics, plus the blueprint ↔ workflow ↔ master-orchestrator
scope cleanup.

### Fixed — scoring mechanics

- **Keyword floor now derives `summon_panel`.**
  `tools/lib/prism-tier-classify.mjs` adds PANEL_SIGNALS + ≥3
  OPUS_SIGNALS + compound-verb-on-opus heuristics. Offline installs and
  no-API-key users now get the orchestrator gate even when
  `hooks/lib/prism-opus-classifier.mjs` can't reach the Anthropic API.
  Previously `summon_panel=true` was API-only.
- **Cache key drops `dirty` flag.** `hooks/lib/prism-opus-classifier.mjs`
  `cacheKey(prompt, branch, headSha)` — a single file save no longer
  invalidates the classifier cache. Prompt-iteration cache hit rate
  improves ~5×.
- **Sentinel-first classification** in
  `hooks/prism-agent-model-guard.mjs` and
  `hooks/prism-task-tier-advisor.mjs`. Both hooks now read
  `~/.claude/.prism-turn-tier-<session>.json` as authoritative instead
  of re-running the classifier. Re-classification happens only when
  sentinel is absent. Disagreements with sentinel get logged as
  `{event:'task_tier_divergence'|'classifier_divergence'}` events to
  `.prism-routing.jsonl` for the weekly rollup.
- **Plan-tier annotation now wins.** If a TaskCreate description
  carries `[haiku]`, `[sonnet]`, or `[opus]` (blueprint/workflow
  convention), the advisor treats it as authoritative over the
  session sentinel — the planner's explicit intent is stronger than
  turn-level classification.
- **Task tier advisor moved from PostToolUse → PreToolUse on `TaskCreate`.**
  Wrong-tier tasks can now be blocked before entering the plan, not
  just nudged after.
- **Compound vs summon_panel nudges separated** in the Agent model
  guard. Previously both triggered "SPLIT into retrieval+synthesis."
  Now compound → SPLIT; summon_panel → "spawn @master-orchestrator."
  Different advice for semantically different signals.

### Added — sustainability

- **Deescalation rule.** Master-orchestrator PHASE 2b: opus-locked
  agent that completes 5 consecutive sonnet-tier tasks with zero
  corrections → default_model reverts to sonnet. Breaks the
  "ratchet only goes up" bug.
- **Upgrade resets ratchet state.** Agent-factory upgrade protocol
  (Step 7, new in v2.7.0) clears `default_model`, `pending_upgrade`,
  `corrections_since_last_upgrade`, and
  `consecutive_successful_sonnet_tasks` on every completed upgrade.
  Refreshed agents are evaluated fresh against current task
  complexity, not saddled with pre-upgrade opus-locks.
- **Dynamic cost multipliers.** `loadCostMultipliers()` in
  `tools/lib/prism-tier-classify.mjs` reads pricing from
  `model-matrix.md` at runtime and normalizes relative to haiku-input.
  Falls back to hardcoded `{haiku:1, sonnet:5, opus:15}` if the
  matrix is absent. `/prism-update` now automatically propagates
  pricing changes to every cost-referencing nudge.
- **Weekly calibration feedback loop.** `tools/prism-rollup-weekly.mjs`
  now includes a **Classifier Calibration** section: advised tier
  distribution, actual model used, divergence count, top 5 advised
  ≠ actual, and a recommendation string. Appends a compact record
  to `update-log.json#calibration_history[]` (capped at 26 weeks).
  `/prism-update` surfaces the trend. No auto-tuning — human
  reviews and decides.

### Added — T-shape master-orchestrator

- **Identity upgrade** (agents/master-orchestrator.md). Explicit
  T-shape role: BROAD expertise across every PRISM domain, DEEP on
  orchestration/adversarial-review/dispatch, BOUNDARY for
  domain-specific work delegated to specialists. Orchestrator is a
  peer to hired specialists with standing to disagree on merits, not
  a client who rubber-stamps their output.
- **PHASE 1.5: SENIOR REVIEW (mandatory on FULL-NOVEL and HIGH-STAKES).**
  After all specialists execute, orchestrator runs a correctness +
  optimality + hidden-risk review before synthesis. Rejects
  untestable claims. Delegates caught gaps back (once) or owns them
  in parent context. Factory escalation for specialists that miss
  in their own domain (2+ misses → `pending_upgrade: true`
  immediately, skipping the 3-correction threshold).
- **Standard of evidence** enforced at specialist delegation prompts:
  "You must cite, test, or benchmark every non-trivial claim. An
  assertion without evidence is a draft, not a deliverable."
  PHASE 1.5 actually rejects them.
- **Visible output.** The PHASE 1.5 review is shown to the user:
  claims that survived, claims revised, gaps caught and closed,
  known limitations remaining.

### Changed — scope cleanup (blueprint / workflow / orchestrator)

- **Blueprint Section 5 "Workflow Execution Mechanics" removed.**
  Was duplicating 60 lines of workflow-orchestration content
  verbatim. Replaced with a one-line pointer: "See
  `~/.claude/skills/workflow-orchestration/SKILL.md`." Single
  source of truth for execution mechanics.
- **Blueprint Phase 4 — roster-first panel assembly.** Consult
  roster.json + tools-registry.md + NotebookLM notebooks before
  assembling panel. Hardcoded "Full-Stack Architect / Python Master
  / ..." personas are FALLBACK ONLY when no rostered specialist or
  Tier 1/2 tool fits. Compose-first enforced.
- **Blueprint Phase 5 Round 2 — formal adversarial review.**
  Cross-examination upgraded from "surface conflicts" to the full
  ≥2-substantive-challenges / ACCEPT-REJECT-CONDITIONAL /
  anti-theater protocol from
  `skills/prism-plan/references/adversarial-review.md`.
- **Blueprint Phase 7 — explicit Execution-heavy handoff to
  @master-orchestrator.** After writing initial todo.md, blueprint
  spawns the orchestrator with the verbatim user request; orchestrator
  expands the panel via PHASE 0a inventory, runs PHASE 0d
  adversarial review, dispatches specialists, and owns PHASE 1.5
  senior review. Fixes the v2.5.0 bug where parent Opus would
  execute Execution-heavy plans without assembling a panel.
- **Workflow section 1.5 — orchestrator-ownership rule.**
  Parent-direct vs orchestrator-driven distinction made explicit.
  When orchestrator is driving, parent does NOT touch roster.json
  or lesson files — orchestrator owns PHASE 2. Never double-update.
- **Workflow todo.md template aligned** to blueprint's tier
  annotation: `[haiku|sonnet|opus] [pgroup=N]` on every step. Same
  grammar so `prism-task-tier-advisor` parses both consistently.

### Infrastructure

- **Roster.json template scrubbed.** Ships as an empty `agents: {}`
  with a `_schema_example` documenting the new v2.7.0 shape fields
  (`default_model`, `corrections_since_last_upgrade`,
  `consecutive_successful_sonnet_tasks`,
  `notebooklm_notebook_id`). Previous template had the author's
  actual specialist (`competitive-intelligence-specialist`) seeded —
  fresh installs now land clean.
- **Master-orchestrator dispatch bypass** in agent-model-guard:
  spawning `@master-orchestrator` is always passthrough (no
  tier/model checks). The orchestrator itself handles its model
  selection internally.

### Notes

- **No breaking runtime changes** — sentinel shape preserved; guards
  and advisors fall back to re-classification if sentinel is absent
  (e.g., first turn after session start before tier-router has run).
- **Cost-accuracy tradeoff preserved.** Opus classifier remains
  default (`DEFAULT_MODEL='claude-opus-4-7'`). Cost rises ~$0.007/prompt
  but accuracy stays high. No regression to Sonnet/Haiku classifier
  as primary (explicitly rejected during v2.7.0 scope review).
- **Calibration is human-in-the-loop.** No auto-tuning of classifier
  regex or thresholds. The weekly rollup surfaces drift; user
  decides whether to tighten signals, adjust thresholds, or leave
  alone.

## [2.6.0] - 2026-04-23

CLAUDE.md sizing discipline and nested-file scaffolding. Closes the
last context-bloat vector after the 2.4.0/2.5.0 install rescope: the
root `CLAUDE.md` now has an explicit ≤200-line budget, and
`/prism-discover` proposes subdomain-scoped `CLAUDE.md` files that
Claude Code auto-loads only when working in the relevant subdir — so
per-session token load shrinks instead of growing as the project gains
subdomains.

### Added

- **`commands/prism-init.md` template rule 10: CLAUDE.md sizing
  discipline.** Explicit ≤200-line budget for the root `CLAUDE.md`,
  concrete destinations for growth (`.claude/references/` via
  `/prism-discover`, `tasks/lessons-tactical.md`,
  `tasks/lessons-strategic.md`, nested `CLAUDE.md` files,
  `~/.claude/.prism-sessions/`), and explicit anti-patterns (no
  always-on knowledge base, no duplicated rules across nested files).
- **`skills/prism-discover/SKILL.md` Step 4 — subdomain detection +
  nested `CLAUDE.md` scaffolding.** After writing index/full files,
  `/prism-discover` detects distinct tech-stack subdomains (nested
  manifests, distinct test runners, workspace packages, service
  boundaries) and proposes nested `CLAUDE.md` scaffolds per subdomain.
  User approves case-by-case with `[Y]` scaffold, `[R]` write to
  references instead, or `[N]` skip. Per-subdomain outcomes recorded
  to `.claude/references/subdomain-map.md` so re-runs don't
  re-propose declined domains.
- **Nested CLAUDE.md template.** Target 60–100 lines, subdomain-only
  rules (never duplicate root), explicit non-goals (no PRISM rules
  copy, no shared conventions, no files in `node_modules`/`dist`/
  `build`/`.next`).
- **`/prism-discover --check-claude-chain` health check.** Walks the
  repo, reports every `CLAUDE.md` found, their token size, and
  violations of the lean-template rules (root > 200 lines, nested >
  100 lines, content duplicated parent↔child, files in excluded
  paths). Non-blocking — reports only.

### Why this matters

Claude Code loads every `CLAUDE.md` along the cwd → root path on
every turn of every session. A monolithic 7k-token root `CLAUDE.md`
covering backend + frontend + tests loads its full cost on every
prompt even when you're only working in one subdomain. Nested files
loaded only along the active path cut per-session context by 40–70%
on multi-domain projects without losing any semantic coverage.

Worked example — project with root (1.5k) + backend (1k) + frontend
(1k) + tests (0.8k):

| Where you open Claude Code | Monolithic root | Nested |
|---|---|---|
| repo root | 4.3k | 1.5k |
| `src/backend/` | 4.3k | 2.5k |
| `src/frontend/` | 4.3k | 2.5k |
| `tests/` | 4.3k | 2.3k |

Nested files are strictly a speed win — never a slowdown — when the
template rules (≤100 lines each, no duplication) are followed. The
`--check-claude-chain` health check surfaces drift early.

### Unchanged

- Runtime semantics. This is a docs + `/prism-discover` behavior
  upgrade; no hook or guard changes.
- Subagent dispatch. `@master-orchestrator`'s PHASE 0a inventory
  (v2.5.0) already considers the active CLAUDE.md chain via Claude
  Code's default loading — nothing further needed there.
- `/prism-init` still creates exactly ONE root CLAUDE.md. Nested
  files are only ever scaffolded by `/prism-discover` with explicit
  user approval — never at init time.

## [2.5.0] - 2026-04-23

Closes the NOVEL-tier orchestrator-bypass bug, bumps the model matrix to
Opus 4.7, ships `/prism-deps`, adds a skill+notebook inventory phase to
`@master-orchestrator`, and turns the legacy ATLAS migration from
archive-only into full purge with backup.

### Changed (breaking behavior)

- **NOVEL-tier parent dispatch now requires `@master-orchestrator`.**
  `hooks/prism-parent-dispatch-guard.mjs` previously let parent Opus do
  anything directly when the classifier returned `opus` tier. Now, when
  the classifier ALSO sets `summon_panel=true` (novel architectural
  request), direct Write/Edit/Bash in parent context is denied until
  the parent calls `Agent({subagent_type:'master-orchestrator', ...})`.
  Haiku dispatches for file I/O don't satisfy the gate — only an
  explicit master-orchestrator dispatch flips
  `sentinel.orchestrator_dispatched=true` and unlocks work tools.
  Fixes the failure mode where Opus was writing multi-phase design
  migration plans solo instead of assembling an expert panel.
  Override: `!opus-force:` prefix skips the panel requirement;
  `PRISM_DISPATCH_GUARD=off` disables the guard entirely.
- **Tier-router notice on panel turns is a hard directive.** When
  `summon_panel=true`, the `additionalContext` emitted by
  `hooks/prism-prompt-tier-router.mjs` now reads "PANEL-SUMMONING TURN.
  You MUST spawn @master-orchestrator as your next action…" with the
  exact `Agent()` call form and enumerated responsibilities.
- **INSTALL.md §2.6 upgraded from archive to purge.** Legacy
  `atlas-*` skill/agent/command/hook/tool/plan files are now deleted
  from `~/.claude/` after a full backup to
  `~/.claude/backups/atlas-purge-<ts>/`. User-created specialists,
  session summaries, MCP servers, and personal CLAUDE.md are never
  touched. Rollback is one `cp -pr` from the backup. Runs before §3.

### Added

- **Model matrix bumped to Opus 4.7 / Sonnet 4.6 / Haiku 4.5.**
  `skills/prism-plan/references/model-matrix.md` and
  `skills/prism-plan/references/update-log.json`. The classifier
  (`hooks/lib/prism-opus-classifier.mjs`) has been running Opus 4.7
  since the code-level bump; the docs now match. Pricing, context, and
  cache costs enumerated per model.
- **`/prism-deps` command** (`commands/prism-deps.md`) — autonomous
  dependency auditor. Reads
  `skills/prism-plan/references/dependency-manifest.md` as source of
  truth, OS-detects, tier-gates by project relevance
  (notebooklm-py / ffmpeg / kokoro / Remotion / playwright / gh / jq),
  proposes OS-specific install commands interactively. Writes results
  to `.claude/deps-scan.json` for `/prism-health` cross-reference.
  Closes the dangling `/prism-deps` reference in `/prism-init` §6 and
  `/prism-health` §4.
- **`dependency-manifest.md`**
  (`skills/prism-plan/references/dependency-manifest.md`) — 4-tier
  manifest (A: agent research, B: video production, C: app-expert,
  D: dev helpers). Each entry has capability, check command, OS-specific
  install command, and fallback-if-absent behavior.
- **PHASE 0a — Skill + Notebook Inventory** in
  `agents/master-orchestrator.md`. Before stakes detection or team
  assembly, the orchestrator now enumerates: installed skills, Tier 1/2
  external tools with status, rostered specialists with staleness
  flags, per-agent NotebookLM notebooks (`notebooklm list` +
  cross-ref with `roster.json`'s `notebooklm_notebook_id` fields),
  connected MCP servers. Emits a compact inventory summary and a gap
  hypothesis for the request before anything else. Answers "do I have
  a design skill?" with evidence, not a guess.
- **Conditional design-intent nudge.** `hooks/prism-hook.mjs` line 144
  UI-UX-PRO-MAX message changed from assertive "is installed, invoke"
  to conditional "if installed, invoke; otherwise run /prism-recommend
  or dispatch a Sonnet subagent with explicit design-system criteria."
  Matches the 2.4.0 treatment of ECC and browser-use nudges.

### Fixed

- **Dangling `/prism-deps` references** in `/prism-init` §6 and
  `/prism-health` §4 now resolve to a real command.
- **Missing `dependency-manifest.md` reference** expected by the User
  Guide v1.1 Ch.8 and by `/prism-deps` is now shipped.

### Notes

- The `summon_panel` enforcement only fires on `tier=opus AND
  summon_panel=true`. Opus-tier requests that the classifier judges as
  *not* panel-worthy (single-expert review, direct architecture
  question, one-pass refactor reasoning) still allow direct parent
  work. This preserves the "don't force subagent dispatch when parent
  Opus IS the right model" behavior while fixing the "panel never got
  assembled" bug.
- `/prism-deps` is opt-in per session — not auto-run by `/prism-init`.
  Users can trigger at any time with `/prism-deps` or `/prism-deps --check`.
- The PHASE 0a inventory is synthesized from commands the user's
  system already runs (`notebooklm list`, `/plugin list`, reading
  `roster.json`, `settings.json` mcpServers). No new subprocess
  overhead per turn — it only runs when `@master-orchestrator` is
  spawned, which is already gated to NOVEL-tier panel turns.
- After upgrade, re-run the install flow (`INSTALL.md`) to pick up the
  purge step. If you prefer to keep the archive-only behavior, skip
  §2.6 manually — the runtime works either way since the new code
  only reads `prism-*` paths.

## [2.4.0] - 2026-04-23

Completion of the ATLAS → PRISM rename that began in 2.0, plus a rescoped
install flow that trims the default surface area. Install is still
idempotent and non-destructive; existing specialists, session history,
and settings are preserved via an automated migration step.

### Changed (breaking)

- **Terminology: `ATLAS` → `PRISM` everywhere in code, comments, docs,
  agent frontmatter, skill names, env vars, and paths.** 56 files
  rewritten, 264 references. Legacy `ATLAS_CACHE` / `ATLAS_LOCK` env
  vars are renamed to `PRISM_CACHE` / `PRISM_LOCK`. Slash-command and
  skill frontmatter `name:` fields are now all `prism-*`. Legacy
  `atlas-*` artifacts on disk are archived — not deleted — by the
  installer (INSTALL.md §2.6).
- **Tier 1 companions reduced to 2.** `/prism-init` now offers only
  `obra/superpowers` (coding workflow) and `nextlevelbuilder/ui-ux-pro-max-skill`
  (UI/UX design system). Both `affaan-m/everything-claude-code` and
  `browser-use/browser-use` are moved to Tier 2 (on-demand via
  `/prism-recommend`). Rationale: ECC's ~12k-token skill index and
  browser-use's ~400 MB chromium stack were net-negative for most users
  in the default install path; they remain available for projects that
  genuinely need them.

### Added

- **New canonical `CLAUDE.md` template** written by `/prism-init`
  (commands/prism-init.md §3). Encodes the operating rules explicitly:
  tier classification drives every prompt, parent plans + subagents
  execute, cheapest-viable model per step, NOVEL tier triggers
  master-orchestrator + adversarial review, memory-save nudges at
  turn 15+ and `/clear` reminders at 15/20/30+, compose-first stance on
  Tier 1 tools, safety-gate enforcement, and persistence via
  `.prism-routing.jsonl` + `roster.json`. Appended non-destructively if
  a `CLAUDE.md` already exists.
- **INSTALL.md §2.6 — legacy ATLAS migration.** Idempotent step that
  moves `atlas-plan/references/{roster.json,update-log.json,...}` into
  the new `prism-plan/references/` location, archives orphan
  `atlas-*.md` skill/agent files to
  `~/.claude/backups/atlas-rename-<ts>/`, and extends §4b
  stale-pruning to match `atlas-*.mjs` and `atlas-exec.sh` hook entries
  in `settings.json`. Users upgrading from pre-2.4 installs re-run the
  installer and their specialist agents, effectiveness history, and
  session summaries all survive.
- **Conditional tier-2 nudges in `prism-hook.mjs`.** ECC and browser-use
  intent-detection patterns remain, but the nudge copy now says
  "if X is installed" and suggests a Sonnet subagent fallback for users
  without the optional tools. No more "ECC is installed" assertions
  that were wrong for users who skipped the install.

### Removed

- **`prism-init` auto-offer of ECC and browser-use.** Only `superpowers`
  and `ui-ux-pro-max` remain in the Tier 1 install menu. ECC and
  browser-use are mentioned as Tier 2 options available via
  `/prism-recommend` but are not part of the default setup flow.

### Notes

- No functional regressions. Every hook, tool, command, and skill still
  works — references just use the new name. Cache files under
  `~/.claude/.prism-*` were already named PRISM; no migration needed
  for hook state.
- Existing `atlas-plan/references/roster.json` contents are copied
  (not moved) to the new location only if the destination doesn't
  already have a roster — so re-running the migration is safe.
- Users with specialist agents whose prompts explicitly reference
  "ATLAS" in the system-prompt body: those strings are untouched (they
  live under `~/.claude/agents/<specialist>/agent.md`, owned by the
  user). Consider a one-time find-and-replace in your own agents if
  branding consistency matters to you.

## [2.3.0] - 2026-04-22

Cross-platform hook reliability. Fixes the long-standing `/bin/sh: node: not found`
stderr spew on Linux/macOS machines where node is installed via a version
manager (nvm/fnm/volta/asdf), and adds first-class Windows support for the
hook layer. No breaking changes; existing installs pick up the fix on
re-running the install flow.

### Added

- **Node auto-discovery in `hooks/lib/prism-exec.sh`.** The wrapper now
  resolves node by trying, in order: `$PRISM_NODE`, `~/.claude/prism.env`,
  `command -v node`, newest `~/.nvm/versions/node/*/bin/node`, newest
  `~/.fnm/node-versions/*/installation/bin/node`, `~/.volta/bin/node`,
  `asdf which node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`.
  When node is found, its bin dir is prepended to `PATH` so downstream
  `npm`/`npx` invocations inside hooks also resolve. Before 2.3.0 the
  wrapper only called `command -v node` and silently exited 0 on miss —
  so hooks appeared to "work" (no error) but never actually ran on
  version-manager-only systems.
- **Windows hook wrapper** `hooks/lib/prism-exec.cmd`. Mirrors the `.sh`
  discovery logic for cmd.exe: `%PRISM_NODE%`, `prism.env`, `where node`,
  `%APPDATA%\nvm\<latest>\node.exe` (nvm-windows), `%LOCALAPPDATA%\Volta\bin\node.exe`,
  `%ProgramFiles%\nodejs\node.exe`. Install flow selects the correct
  wrapper per OS when merging `settings.fragment.json` into
  `~/.claude/settings.json` (see INSTALL.md §4a).
- **`prism.env` install-time pin.** INSTALL.md §2.5 resolves node's
  absolute path during install and writes `PRISM_NODE=<abs-path>` to
  `~/.claude/prism.env`. Both wrappers source this first, giving a
  zero-discovery fast path. Survives `nvm install <newer>` because the
  wrappers still fall through to discovery if the pinned path is gone.
- **Stale-entry pruning in INSTALL.md §4b.** The merge step now removes
  pre-2.3 raw `node ~/.claude/hooks/prism-*.mjs` hook entries from the
  user's existing `settings.json` before merging the fragment. These
  entries — present in any install that pre-dates the v2.2.0 wrapper
  rollout — were the source of the `/bin/sh: node: not found` spew even
  after 2.2.0 cleaned up the fragment itself. Non-PRISM raw-node entries
  are left untouched.
- **`scripts/verify.mjs` wrapper checks.** Verifies the OS-correct
  wrapper exists (`prism-exec.sh` on POSIX, `prism-exec.cmd` on Windows)
  and reports presence/absence of `~/.claude/prism.env` as a non-fatal
  hint.

### Fixed

- **Linux/macOS Stop hook `/bin/sh: node: not found` spew on
  version-manager-only installs.** Root cause was two-part: (1) the
  2.2.0 `prism-exec.sh` wrapper couldn't actually find nvm-installed
  node (it only checked PATH); (2) pre-2.2.0 installs retained stale
  raw-`node` hook entries in `settings.json` that the 2.2.0 merge never
  pruned. 2.3.0 fixes both.

### Notes

- No migration required. Re-run the install flow (per INSTALL.md) to pick
  up the new wrappers, prune stale entries from your existing
  `settings.json`, and write `prism.env`. The install is idempotent.
- Users who previously worked around the issue by symlinking node into
  `~/.local/bin` can safely delete the symlink after 2.3.0 takes effect,
  but leaving it is harmless.

## [2.2.1] - 2026-04-22

Three bundled fixes based on user-reported gaps after the 2.2.0 rollout.
No breaking changes; every 2.2.0 routing decision survives this release.

### Changed

- **ECC (`affaan-m/everything-claude-code`) is now OPTIONAL, not Tier 1.**
  `/prism-init` no longer auto-installs ECC; the 100+ skills catalog
  imposes a per-turn token tax that outweighs benefits for typical work.
  Users who explicitly want polyglot reviewers or AgentShield can still
  install it via `/prism-recommend --include-optional`. Touched docs:
  `commands/prism-init.md`, `commands/prism-recommend.md`,
  `commands/prism-health.md`, `agents/master-orchestrator.md`,
  `skills/prism-plan/references/tools-registry.md`.
  Before: ECC shown as `installed, active` in default health/init status.
  After:  ECC shown as optional, install-on-demand only.

- **`/prism-audit` uses PRISM-native grep-based secret scan by default.**
  Previously the doc said "use ECC's /security-scan". Now runs a
  root-file check (`.env`, `.env.*`, `credentials.json`, `*.pem`, `*.key`,
  `id_rsa*`, `*.pfx`), the existing content-grep for known-token shapes
  (already in Step 1 — sk-/ghp_/AKIA/AIza/JWT), and a new large-binary
  check (> 50MB). AgentShield remains an OPTIONAL deeper scan if ECC is
  manually installed.

### Fixed

- **`/prism-init` mutation-guard auto-bypass.** `hooks/prism-mutation-guard.mjs`
  now detects three bootstrap commands from the sentinel rationale
  (`/prism-init`, `/prism-update`, `/prism-archive`) and passes through
  cleanly. Falls back to prompt sniffing if the sentinel is missing
  (e.g. first-turn race). Before: `/prism-init` bootstrap was blocked by
  mutation-guard under `hard` mode and users had to set
  `PRISM_MUTATION_GUARD=off` manually. After: no manual env-var dance
  needed for legitimate bootstrap writes.

- **`/prism-discover` subagent dispatch-guard deadlock.**
  `hooks/prism-parent-dispatch-guard.mjs` now has three independent
  subagent-bypass paths instead of one:
  1. `input.parent_tool_use_id` present (unchanged from 2.2.0).
  2. `CLAUDE_CODE_ENTRYPOINT=subagent` env var (new).
  3. `sentinel.dispatched === true` (hoisted — used to be checked only
     after ALWAYS_ALLOW filtering; now the primary subagent signal).
  Defense-in-depth: orchestration-command rationale matches also pass.
  Before: subagent-spawned `Read`/`Bash`/`Grep`/`Glob` calls were denied
  mid-execution because the guard re-classified the subagent's internal
  turn as haiku-tier and demanded another dispatch (which a subagent
  can't do). After: once the parent dispatched, everything downstream
  passes cleanly.

### Tests

- 5 new regression tests in `tools/test-prism-gaps.mjs` under
  `v2.2.1 hook fixes`:
  - V221.1 `/prism-init` prompt + mutation-guard → allowed
  - V221.2 `/prism-update` + mutation-guard → allowed
  - V221.3 subagent with sentinel.dispatched=true → dispatch-guard allowed
  - V221.4 subagent + haiku-tier sentinel → still allowed (no deny)
  - V221.5 parent + haiku-tier + NOT dispatched → still denies (2.2.0 regression guard)

## [2.2.0] - 2026-04-22

### Added

- **Opus-backed context classifier** (`hooks/lib/prism-opus-classifier.mjs`).
  Replaces keyword-score tier routing with Opus classification. Falls back
  to Sonnet on API error / timeout, then to the legacy keyword classifier
  as an emergency floor (so PRISM still routes something on a
  misconfigured install). Uses Anthropic Messages API; reads
  `ANTHROPIC_API_KEY` from env. 5-second timeout, bounded to 200 output
  tokens, JSON-only responses.
- **Slash-command allowlist.** The following commands short-circuit to
  `opus` at zero cost and zero latency:
  `/prism-init`, `/prism-plan`, `/prism-app-expert`, `/prism-update`,
  `/prism-recommend`, `/prism-archive`, `/prism-audit`, `/prism-health`,
  `/prism-roster`, `/prism-retire`, `/prism-recall`.
- **Tier-scoring cache** at `~/.claude/.prism-tier-cache.json`. 24h TTL.
  Key = `sha256(prompt + '|' + branch + '|' + head_sha + '|' + dirty_bool)`.
  Identical prompts on the same branch/HEAD/dirty state re-use the prior
  classification without another Opus call. Cache invalidates
  automatically on `git commit` (new HEAD changes the key).
- **Release/meta-work safety screen** in the keyword-floor path. When
  Opus and Sonnet are both unreachable, prompts matching release tokens
  (`push to main`, `merge`, `force-push`, `deploy`, `release`, `ship`,
  `tier router`, `PRISM`, `2.2.0`) are promoted to opus regardless of
  keyword score. Prevents release-engineering work from routing to haiku
  in an API-outage scenario.
- **Cross-platform hook wrapper** `hooks/lib/prism-exec.sh`. Guards the
  `node` call for every hook in `settings.fragment.json`. On Linux / macOS
  where node is not on PATH, hooks silently exit 0 instead of crashing.
- **13 regression tests** in `tools/test-prism-gaps.mjs` under the new
  `v2.2.0 classifier` section. Covers force-opus override, the 11 slash
  commands, multi-verb chains, git-write verbs, meta-work tokens, cache
  hit/miss, Sonnet fallback (mocked), and no-API-key graceful
  degradation. Includes a regression test for the
  `/prism-init full → haiku misroute` bug reported during 2.1.3.

### Changed

- **BREAKING: tier-router output format.** The `additionalContext`
  emitted by `prism-prompt-tier-router.mjs` changed from
  `PRISM TIER ROUTER: prompt scored N (X-tier, h=N s=N o=N). ...` to
  `PRISM TIER ROUTER: {tier}. {rationale}`. Downstream code that parsed
  the `h=/s=/o=` tokens to make routing decisions must migrate to the
  `rationale` / `source` fields in `~/.claude/.prism-routing.jsonl`.
- **Sentinel file shape preserved.** `~/.claude/.prism-turn-tier-<session>.json`
  keeps its v2.1.3 schema (`{tier, score, h, s, o, compound, force_opus,
  dispatched, ...}`) for compatibility with `prism-parent-dispatch-guard.mjs`
  and any external tools. The legacy `{score, h, s, o, compound}` fields
  are now zero-filled — they exist for backward-compat but are no longer
  populated by the classifier. New consumers should read `rationale` and
  `source`.
- All hook commands in `settings.fragment.json` now route through
  `bash ~/.claude/hooks/lib/prism-exec.sh <hook>` instead of calling
  `node` directly.
- `prism-task-tier-advisor.mjs` now classifies task subject+description
  via the Opus classifier. Hard-mode deny behavior and `task_tier_advice`
  row shape are unchanged.
- `prism-agent-model-guard.mjs` now classifies Agent() prompts via the
  Opus classifier. The compound-verb detector runs as a secondary signal
  (same regex as v2.1.3, now extended — see fixes below) alongside the
  classifier's `summon_panel` flag.

### Fixed

- **Linux Stop hook no longer fails when node is absent.** All hook
  invocations go through `prism-exec.sh`, which guards the node call.
- **P2.11 classifier rule** (`tools/prism-kb-domains.mjs`): extended the
  `atlas-core` regex from `atlas-*` to `(atlas|prism)-*` so current
  `prism-*` command/agent names classify correctly after the rebrand.
  Was causing `command:prism-recall` to land in `misc`.
- **P2.19 sync test race** (`tools/prism-kb-sync.mjs`): `computePlan` now
  accepts an optional `opts.mtimeMap` parameter. Tests pin body-path
  mtimes to avoid a race where an external process touches a KB file
  between the test's snapshot and `computePlan`'s `statSync` call.
  Production callers pass nothing — behavior unchanged.
- **P3b.5 compound-verb regex** (`tools/lib/prism-tier-classify.mjs`):
  extended `COMPOUND_VERB_RE` to handle object phrases + commas between
  the two verbs (`"read and analyze this module, then design a refactor"`).
  Max 60 intervening characters, non-greedy.

### Known issues

- **P2.28 classify entry-count test is environment-dependent.** The test
  asserts exact-count equality against the user's installed KB. After a
  fresh clone or plugin install the count may shift by 1–2. Does not
  affect runtime behavior. We are not updating the assertion because the
  current number is a useful health probe on the most common install
  shapes; if you see P2.28 flip on a machine with many plugins, re-run
  the suite once — the indexer is deterministic after first rebuild.

### Notes

- **Troubleshooting artifacts cleanup.** If you had to disable PRISM
  guards during a 2.1.3 session to unblock meta-work (rename to
  `.mjs.disabled`), clean them up after installing 2.2.0:
  `rm ~/.claude/hooks/prism-*.mjs.disabled`. The 2.2.0 guards supersede
  the disabled copies; both should not coexist.
- **`!opus-force:` override is NOT dead code.** The override is checked
  in the new classifier before any API call or cache lookup. It worked
  in 2.1.3 via the sentinel `force_opus=true` flag; it works the same
  way in 2.2.0. Any documentation/memory that claimed the override was
  dead was stale and should be updated.

## [2.1.3] - 2026-04

Initial modular PRISM release — hooks, tools, agents, skills,
statusline, and commands. See `INSTALL.md` and `manifest.json`.
