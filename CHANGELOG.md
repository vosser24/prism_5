# Changelog

All notable changes to PRISM are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), the versioning follows
[Semantic Versioning](https://semver.org/).

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
