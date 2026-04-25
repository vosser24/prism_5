# PRISM v3.1 — Productization + Tier 3 Surgical

Blueprint source: blueprint-prompt skill invocation, 2026-04-24 (v3.1 cycle).
Scope: Tier 1 productization (6 items) + 2 Tier 3 items (team roster, central policy).
Branch: `claude/audit-pending-pushes-Rg1p8` at `/home/user/PRISM`.

## Direction

Ship as one coherent v3.1 release. 8 items, ~1500 LOC across 14 files. Three new enforcement hooks fire at distinct trigger points (parallel-guard on PreToolUse(Agent), panel-guard on SubagentStop, skill-trigger-guard on UserPromptSubmit) so no PreToolUse pile-up. Centrally-managed policy at `~/.claude/prism-policy.json` with `PRISM_POLICY_OVERRIDE=1` user escape hatch. Telemetry is LOCAL aggregation + export-to-JSON only (future-compatible with SaaS, valuable today as cost/calibration insight). Team roster surgical: `team_id` field + `--team` filter. README preserves install/contributing/license tail.

## Execution Plan

### Group A — Independent file work [pgroup=1] (parallel-safe)

5 disjoint deliverables. Same pgroup → MUST dispatch in one assistant message with 5 Agent() calls.

- [ ] [sonnet] [pgroup=1] **A1** Write 3 new enforcement hooks: `hooks/prism-parallel-guard.mjs` (PreToolUse(Agent), tracks Nth-call dependency-graph in turn, blocks unsafe-sequential of pgroup=1 tasks; honors `!opus-force:` and three-path bypass; reads `prism-policy.json` then env), `hooks/prism-panel-guard.mjs` (SubagentStop, scans subagent output for hallucinated persona names vs roster.skills/agents/tools, warns/denies based on policy), `hooks/prism-skill-trigger-guard.mjs` (UserPromptSubmit, keyword→required-skill map from new `skills/prism-plan/references/skill-triggers.md`, advisory nudge if matching skill not invoked). All three: header `(v3.1.0)`, three-path bypass, sentinel-aware, atomic state writes if any. Done when: all 3 files pass `node --check`; each implements policy → env → default precedence.

- [ ] [sonnet] [pgroup=1] **A2** Write `scripts/install.sh` one-command installer. Detects platform (Linux/macOS/Windows-bash), finds node via PRISM's resolution chain, clones repo if not present (default `~/PRISM`), runs `install-merge.mjs` + `verify.mjs`, reports backup path. Modes: `--dry-run` (reports what would happen), default (executes). Done when: dry-run on this machine outputs sane plan; actual run from `/tmp/test-install` produces verified install.

- [ ] [sonnet] [pgroup=1] **A3** Write `commands/prism-doctor.md` slash command. Symptom-driven diagnostic flow: scans recent `.prism-routing.jsonl` (last 50 events), checks env (ANTHROPIC_API_KEY visible, node path), checks roster integrity, settings.json wiring, hook syntax, `prism-policy.json` if present. Reports per-symptom diagnostic + ONE proposed fix per finding; never auto-applies — confirms each fix interactively. Done when: command spec is clear, includes 8+ symptom→fix mappings.

- [ ] [sonnet] [pgroup=1] **A4** Replace `README.md` with landing-page version. Preserves existing install/contributing/license sections (re-located, not deleted). New top sections: 30-second pitch, 3 use cases (cost discipline / parallel orchestration / specialist dispatch), one-line install via `scripts/install.sh`, status table with works/half-works/known-gaps. Adds CHANGELOG link, v3.0 test-suite link. Done when: README opens with pitch + use cases + status; install/contrib/license preserved.

- [ ] [sonnet] [pgroup=1] **A5** Write team-roster + central-policy + telemetry artifacts: (i) extend `roster.json` schema with optional `team_id` field per agent in `_schema_example_agent`; (ii) write `references/prism-policy.example.json` template documenting all guard knobs; (iii) write `commands/prism-telemetry.md` with `--opt-in`, `--opt-out`, `--export <path>`, `--status` subcommands; LOCAL aggregation only (parses `.prism-routing.jsonl` into structured rollup at `~/.claude/.prism-telemetry-rollup.json`); no network. Done when: roster schema has team_id documented; policy example covers all 5 guard knobs; telemetry command has 4 subcommands documented.

### Group B — Manifest + settings + glue [sequential after A]

- [ ] [sonnet] **B1** Update `manifest.json`: bump version 3.0.0 → 3.1.0; add 3 new hook entries (parallel-guard, panel-guard, skill-trigger-guard); add `commands/prism-doctor.md`, `commands/prism-telemetry.md`; add `skills/prism-plan/references/skill-triggers.md`. Verify all 4 are reachable from manifest src paths.

- [ ] [sonnet] **B2** Update `settings.fragment.json`: register 3 new hooks at correct events (parallel-guard PreToolUse on Agent matcher; panel-guard SubagentStop; skill-trigger-guard UserPromptSubmit).

- [ ] [sonnet] **B3** Extend `commands/prism-roster.md` with `--team <id>` filter mode. Surgical: 10 lines added near display section.

### Group C — Tests + validation [sequential after B]

- [ ] [sonnet] **C1** Extend `tests/v3/run-static.sh` with new assertions for v3.1: (i) install.sh exists + is +x; (ii) prism-policy.example.json valid JSON; (iii) skill-triggers.md present; (iv) all 3 new hooks pass node --check; (v) settings.fragment.json declares the new events. Target: +5–8 PASS lines.

- [ ] [sonnet] **C2** Extend `tests/v3/run-claude.md` with new manual prompts that flip the documented-fail tests to documented-pass: T10.3 (parallel-guard now blocks sequential dispatch of pgroup=1), T13.4 (skill-trigger-guard now nudges when ui-ux-pro-max not invoked on UX prompt). Add new categories for panel-guard, doctor, telemetry, team-roster, central-policy.

- [ ] [sonnet] **C3** Extend `tests/v3/analyze-log.mjs` to surface new event types: `panel_hallucination_detected`, `skill_trigger_advisory`, `policy_loaded`, `parallel_guard_block`. Compute new metrics: hallucination rate, skill-coverage rate, policy-vs-env override frequency.

### Group D — Final glue [sequential after C]

- [ ] [haiku] **D1** Update `scripts/install-merge.mjs` internal log label `(v3.0.0)` → `(v3.1.0)`.

- [ ] [haiku] **D2** Bump `roster.json` schema_version to "3.1.0", add `team_id` to `_schema_example_agent`, add policy-precedence note to `schema_notes`.

- [ ] [opus] **D3** Write `CHANGELOG.md` v3.1.0 section. Subsections: Added (8 items), Fixed (T10.3 + T13.4 documented gaps now closed by hooks), BREAKING (none — all additive). Migration: zero (additive). Closes audit findings DOCTRINE-DRIFT-001 (panel-guard) and the v3.0-target gaps for parallel + skill invocation.

- [ ] [opus] **D4** Local verify: run `tests/v3/run-static.sh` (target: PASS count rises by +5–8). Run `node scripts/install-merge.mjs` and confirm `bumped 3.0.0 → 3.1.0`. Run `node scripts/verify.mjs` and confirm 80+ manifest entries + 0 failures.

- [ ] [opus] **D5** Single commit + push. Well-formed commit message. PHASE 1.5 senior review: independently read every modified file before commit, confirm no half-finished features, no scope creep. Report total LOC added.

## Risks & Blockers

- **Hook chain latency**: 3 new hooks at *distinct* triggers (PreToolUse(Agent), SubagentStop, UserPromptSubmit) — NOT all on PreToolUse. Avoids the 4-hook pile-up Risk Voice flagged. Each hook target <50ms.
- **Policy precedence ambiguity**: `prism-policy.json` → env var → default. User escape: `PRISM_POLICY_OVERRIDE=1` flips precedence so env wins over policy. Session-start emits one-time notice when policy is detected. Documented loudly.
- **Telemetry scope creep**: explicitly LOCAL-only. No HTTP, no SaaS, no shipping. Aggregation + export-to-JSON only. Future SaaS will read same rollup format.
- **Sandbox limitation**: master-orchestrator subagent_type not registered in this Linux harness. Parent-as-orchestrator executes Group A's parallel dispatch directly. On Windows production with full PRISM, the literal Agent({subagent_type:'master-orchestrator'}) call would work.

## Hand-off

Sandbox harness limit acknowledged: parent-as-orchestrator dispatching 5 parallel general-purpose subagents in one assistant message for Group A. After that completes, parent runs Groups B/C/D sequentially.

Production equivalent: blueprint would dispatch `Agent({subagent_type:'master-orchestrator',model:'opus',prompt:...})` and orchestrator would handle the parallel internally.
