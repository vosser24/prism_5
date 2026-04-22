# Changelog

All notable changes to PRISM are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), the versioning follows
[Semantic Versioning](https://semver.org/).

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
