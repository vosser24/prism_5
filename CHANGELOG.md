# Changelog

All notable changes to PRISM are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), the versioning follows
[Semantic Versioning](https://semver.org/).

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
