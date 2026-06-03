# D004 — PRISM v4.0 "Project-Master Edition"

**Status:** Locked
**Date:** 2026-05-25
**Decision owner:** PRISM core (user adjudication)
**Target releases:** v3.11.0 (foundation) + v4.0 (project-master surface)
**References:** D001-bootstrap-unification.md, D002-v3.10-hooks-drift-scope.md, D003-bootstrap-scaffold-scope.md
**Adversarial review:** claude-master agent (2026-05-25); all 7 load-bearing Claude Code feature claims verified against code.claude.com

## Context

v3.10.0 ships `/prism-bootstrap` Phase 1 + 2 (state schema + 5-phase orchestrator) per D001/D002/D003. The remaining D002 work (`/prism-sync`, `/prism-clean`, agent-write hook) is unbuilt.

User requirement set (2026-05-25): PRISM should evolve into a "per-project chief-of-staff" tool. Each project should have a senior designer agent that learns the codebase, owns lessons + decisions, hires + challenges specialists, evaluates work before commit, and produces handoffs before `/clear`. Speed and accuracy are paramount; per-turn latency taxes are unacceptable.

Adversarial review by the project-local `claude-master` agent (Windows-first Claude Code specialist, all citations verified) flagged:
- A topology error in initial layered-orchestrator design (subagents-spawning-subagents is forbidden per https://code.claude.com/docs/en/sub-agents).
- Two per-`UserPromptSubmit` hooks (context-budget estimator, repetition detector) adding 160-500 ms per turn on PS 5.1 for accuracy gains the heuristic cannot deliver.
- A duplication (cross-file impact analyzer vs `/code-review --effort high`).
- A premature adversarial-floor bump (≥2 → ≥3 challenges) without telemetry justification.

This adjudication locks the corrected design.

## Decision summary

**The "project-master" architecture**: each project gets its own named master agent (`master-<slug>`) that is the **session agent** (main thread identity, set via `.claude/settings.json` `agent:` field). It owns project memory, dispatches specialists as subagents (leaf level), evaluates their output before commit, and produces handoffs via `/prism-clean`.

This is layered ON v3.10.0's bootstrap unification, not a replacement.

## Locked decisions

### 1. Naming convention — `master-<slug>`

Per-project master agent names: `master-<project-slug>`. Hyphens at the implementation layer (Claude Code subagent naming constraint per https://code.claude.com/docs/en/sub-agents — lowercase letters, digits, hyphens, ≤64 chars). User-facing docs may use underscore spellings (`master_grabber`) for readability.

**Slug derivation precedence**:
1. User-clarified during deep-dive AskUserQuestion turn
2. CLAUDE.md `## Project Identity` `name:` field
3. Directory basename, kebab-cased (e.g., `Y:\…\nexus_reporting_4` → `nexus-reporting-4`)
4. Fallback prompt if directory name is generic (`repo`, `code`, `project`, `app`)

The chosen slug is locked in `.claude/.prism-state.json.project_slug` for determinism across re-runs.

### 2. Topology — `master-<slug>` is the session agent

`master-<slug>` runs as the **main thread** via `<project>/.claude/settings.json` `agent: master-<slug>`. The main thread directly dispatches specialists as subagents (leaf-level, no further dispatch). Docs-compliant per https://code.claude.com/docs/en/sub-agents § Subagents cannot spawn other subagents.

Two-level topology only. Specialists return findings; `master-<slug>` decides next dispatch.

### 3. master-orchestrator → skill (with thin agent wrapper for backward compat)

The orchestration protocol (PHASE 0a inventory, PHASE 0d adversarial review, PHASE 1.5 senior review) moves to `~/.claude/skills/master-orchestrator/SKILL.md`. Every `master-<slug>` loads this skill via its `skills: [master-orchestrator]` frontmatter field.

The existing `~/.claude/agents/master-orchestrator.md` file is preserved as a thin wrapper whose body just loads the same skill. This preserves backward compat with `@master-orchestrator` mentions and non-project sessions.

**Single source of truth** for orchestration protocol; per-project memory stays per-project.

### 4. Bootstrap → 7 phases (schema v2)

Phase sequence: `identity → structure → plugin-validate → discovery → roster → project-master → health`. Schema bumped v1 → v2 in `tools/lib/prism-state.mjs`.

**Each phase MUST write a sentinel**: `phases.<name> = { status: in-progress|complete|failed, started_at, completed_at, artifact_hashes[] }`. On re-run: `complete` → skip, `in-progress` → restart, missing artifacts (hash mismatch) → warn-then-skip (user has hand-edited). Detect-and-adopt marks phases `synthesized: true` ONLY if no sentinel exists AND artifacts are demonstrably present on disk.

This closes the "synthesized: true on partial failure" data-loss class the adversarial review flagged.

### 5. master-<slug> MEMORY.md = router (≤25 KB injected slice)

Auto-injected slice at subagent start: first 200 lines or 25 KB per https://code.claude.com/docs/en/sub-agents § Enable persistent memory. The full file may be larger; only the slice loads.

**Sections** (router, not knowledge base):
- Project profile (stack, datasources from deep-dive, active workstreams)
- Recent decisions (last 10 with `[[D###]]` pointers)
- Recent lessons (last 10 with `[[lessons-tactical#date]]` pointers)
- Active specialists hired for this project
- Available plugin tools (from `/prism-validate-plugins`)

**Knowledge evolution rhythms**:
- **Per-decision**: panel concludes → `D###-<slug>.md` written → MEMORY.md gets a pointer line.
- **Per-session**: `/prism-clean` appends to `tasks/lessons-tactical.md` → MEMORY.md pointer updated.
- **Per-quarter** (v4.0): **manual only**. `agent-factory --upgrade master-<slug>` re-synthesizes with diff preview; user approves before write. Auto-rerun deferred to v4.1 with telemetry.

Hard validator in `tools/lib/prism-state.mjs`: refuse to write MEMORY.md >25 KB; suggest manual upgrade.

### 6. Two nudge hooks (not three)

| Hook | Event | Behaviour |
|---|---|---|
| **clear-archive nudge** | `SessionEnd[matcher=clear]` | Emit `additionalContext`: "captured X panel decisions + Y deviations this session. Run `/prism-clean` first to archive?" |
| **precompact nudge** | `PreCompact` | Same nudge before auto-compact at 95% |

Both:
- Emit `additionalContext` ONLY (no exit 2 / no blocking)
- Off-able via `PRISM_DISABLE_CLEAR_NUDGE=1` and `PRISM_DISABLE_PRECOMPACT_NUDGE=1`
- Implemented in PowerShell with `"shell": "powershell"` on Windows; bash variant for POSIX
- Combined into a single hook script when both fire from the same event (reduces PS 5.1 spawn cost)

**Third nudge (70%-context-budget) CUT.** Per-turn `UserPromptSubmit` cost (~80-250 ms PS 5.1 cold-start) for a heuristic that's 20-40% inaccurate. Replaced by a CLAUDE.md instruction: *"At 70% context, suggest /context all and consider /compact or /clear."*

### 7. Adversarial floor stays at ≥2 (v2.7.0 baseline)

PHASE 0d adversarial review keeps "at least two substantive challenges" for NOVEL-tier work. Bump to ≥3 deferred to v4.1 pending telemetry showing the 3rd challenge caught real bugs the first two missed. Premature bump = 30-50% latency increase on NOVEL turns without measured accuracy lift.

### 8. Migration UX — opt-in deep-dive

v3.10.0 → v4.0 path:
1. User pulls v4.0 PRISM
2. Runs `/prism-bootstrap` on existing project → first 5 phases run idempotently (detect-and-adopt back-fills as before)
3. New phase 6 (`project-master`) is **skipped by default** with a one-line nudge: *"Run `/prism-bootstrap --with-deep-dive` to create your project-master."*
4. User runs with `--with-deep-dive` when ready → discovery findings synthesized → AskUserQuestion clarifying turn → `agent-factory --master-<slug>` generates the agent → seeded MEMORY.md → `.claude/settings.json` updated with `agent: master-<slug>`

No forced migration. Users on v3.10.0 can stay there indefinitely.

## Cuts (intentionally NOT in v4.0)

| Cut | Rationale | When |
|---|---|---|
| Per-turn context-budget estimator (D-6) | 80-250 ms PS 5.1 per turn; heuristic too inaccurate; `/context` exists | v4.1 with telemetry |
| Per-turn repetition detector (D-7) | Same per-turn tax; NLP normalization misfires | v4.1 with telemetry |
| 70%-context-budget nudge (3rd hook) | Subsumes D-6 defect; CLAUDE.md instruction covers | Never |
| Cross-file impact analyzer (Phase I) | Duplicates `/code-review --effort high` | Replaced by PreToolUse hook on `Bash(git commit *)` invoking `/code-review` |
| ≥3 challenges floor bump (D-5) | Premature without telemetry; 30-50% NOVEL latency hit | v4.1 |
| Per-quarter auto re-synth MEMORY.md | Risky auto-rewrite | v4.1 (manual only in v4.0) |
| `Agent` tool dispatch hop (master-orch → master-<slug>) | Architecturally forbidden (subagents can't spawn subagents) | Replaced by main-session-as-agent topology |

## Phase plan — split release

### v3.11.0 — foundation (~6 days focused work)

| Phase | Days | Deliverables |
|---|---|---|
| **A. Finish D001/D002 baseline** | 3 | `/prism-sync` (conservative drift), `/prism-clean` (5-level importance classifier per D002 §6), agent-write auto-fire hook (D002 §4) |
| **B. Bootstrap → 7-phase + schema v2 + sentinels** | 2 | Schema migration v1→v2, `phase-plugin-validate` stub, `phase-project-master` stub (opt-in only), sentinel writes per phase, crash-resume tests |
| **C. /prism-validate-plugins** | 1 | Shell out to `claude plugin list --json`; report broken hooks, MCP reachability, version drift, skill conflicts; `--fix` flag opt-in only |

**Gate to v4.0**: 1-week soak on testbed project, all `/prism-bootstrap` idempotency tests pass, zero PS 5.1 hook regressions, zero data-loss on Ctrl-C-mid-phase tests.

### v4.0 — project-master surface (~5 days focused work)

| Phase | Days | Deliverables |
|---|---|---|
| **D. /prism-deep-dive + agent-factory --master-\<slug\>** | 3 | Discover → AskUserQuestion ≤5 questions → generate `<project>/.claude/agents/master-<slug>.md` with `memory: project` + `skills: [master-orchestrator]` → seed MEMORY.md → write `<project>/.claude/settings.json` `agent: master-<slug>` |
| **E. master-orchestrator → skill migration** | 0.5 | Move protocol body to `~/.claude/skills/master-orchestrator/SKILL.md`; rewrite agent file as thin skill-loading wrapper; verify `@master-orchestrator` mentions still work |
| **F. Two nudge hooks** | 1 | `SessionEnd[clear]` + `PreCompact` PowerShell hooks (combined where possible); env-var off-switches; PS 5.1 + Git Bash + WSL tested |
| **H. Knowledge evolution rhythms** | 0.5 | Per-decision pointer append; per-session pointer update via `/prism-clean`; manual `agent-factory --upgrade master-<slug>` |
| **J. Tightened evidence rules** | 0.3 | PHASE 1.5 senior review rejects un-cited claims more aggressively; no challenge-count bump |
| **K. Hide subsumed + docs + release prep** | 0.7 | `/prism-help` cleaned; README + CHANGELOG; migration guide; release notes |

**Total**: 11 days focused work across two releases.

## Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Slug collision when two projects derive the same name | Medium | Medium | `roster.json` filters by `project_slug`; bootstrap warns on duplicate; user picks override |
| 2 | MEMORY.md grows past 25 KB silently truncated | Medium | High | Hard validator in `tools/lib/prism-state.mjs` refuses to write >25 KB; suggests manual upgrade |
| 3 | v3.10.0 → v4.0 unexpected deep-dive prompt | Low | Medium | Opt-in via `--with-deep-dive`; default bootstrap behaves identically to v3.10.0 |
| 4 | PS 5.1 hook spawn cost on two-nudge hooks | Medium | Low | Combined into single PowerShell script <100 ms total cold-start; env-var off-switch |
| 5 | Plugin validation false-positive on legitimate plugins | Medium | Medium | Report-only default; `--fix` opt-in only; never auto-apply |
| 6 | master-orchestrator skill vs agent file divergence | Low | High | Agent file body = `Load skill: master-orchestrator` one-liner only; CI assert keeps them in sync |
| 7 | Schema v1↔v2 forward/backward compat regression | Low | High | `tests/state-schema-compat.mjs` covers both codepaths; v1.bak preserved one release |
| 8 | Detect-and-adopt synthesizes phase as complete on partial failure | Medium | Critical | Sentinel `{started_at, completed_at, artifact_hashes}` per phase; restart on `in-progress` without `completed_at` |
| 9 | Specialist subagent runs into a wall and can't dispatch sub-subagent | High by design | Low | Specialist returns findings; `master-<slug>` (main thread) hires the next specialist. Document this pattern in skill |
| 10 | Two-release cycle increases ship overhead | Medium | Low | Strict 1-week soak between releases; release-prep checklist re-used |

## Migration recipe

### v3.10.0 → v3.11.0 (foundation)

1. `git pull` PRISM repo
2. Re-run install (plugin: `/plugin update prism@PRISM`; manual: `node tools/prism-installer.mjs install`, or the `bash install.sh` / `.\install.ps1` wrappers) <!-- v5.1: legacy scripts/install.{sh,ps1} retired; canonical installer is tools/prism-installer.mjs -->
3. On any existing project: `/prism-bootstrap` runs idempotently
   - Existing 5 phases detect-and-adopt as before
   - New `plugin-validate` phase runs first time (~2 sec)
   - `project-master` phase **skipped** with one-line nudge
4. Use `/prism-sync` for ongoing maintenance (new in v3.11.0)
5. Use `/prism-clean` before any `/clear` (new in v3.11.0)

### v3.11.0 → v4.0 (project-master)

1. `git pull` + re-install
2. On each project where you want a master: `/prism-bootstrap --with-deep-dive`
3. Answer ≤5 clarifying questions about stack, datasources, primary workflow
4. Bootstrap generates `<project>/.claude/agents/master-<slug>.md` + updated settings.json
5. **Next session in that project**: main thread automatically runs as `master-<slug>`

### Rollback

Each release ships with an uninstall path that preserves user data (per v3.8.4 hotfix). `~/.claude/backups/pre-prism-<ts>/` keeps the prior state file and config.

## Test plan (gates between releases)

### v3.11.0 ship gates
- [ ] `/prism-bootstrap` on a fresh project completes all 7 phases (project-master skipped by default)
- [ ] `/prism-bootstrap` Ctrl-C mid-phase → re-run resumes correctly per sentinel
- [ ] `/prism-bootstrap` on a v3.10.0 project → detect-and-adopt back-fills phases 1-5, phase 6 skipped, phase 7 runs
- [ ] `/prism-sync` runs in <30s on testbed; detects modified-since-last-discovery correctly
- [ ] `/prism-clean` 5-level classifier surfaces real adjudications and skips trivia
- [ ] Agent-write auto-fire hook registers a new global agent within 100 ms
- [ ] `/prism-validate-plugins` reports correctly on installed plugins; `--fix` never auto-applies
- [ ] Zero PS 5.1 install.ps1 regressions (post-v3.8.5 stability preserved)
- [ ] 7-day soak on testbed, no false-positive `/prism-clean` nudges, no hook errors

### v4.0 ship gates (additional)
- [ ] `/prism-bootstrap --with-deep-dive` on testbed produces working `master-<slug>` agent
- [ ] `master-<slug>` as session agent loads master-orchestrator skill correctly
- [ ] `master-<slug>` dispatches specialists; specialists return; `master-<slug>` evaluates output
- [ ] MEMORY.md stays <25 KB across 4 simulated sessions
- [ ] `SessionEnd[clear]` nudge fires once per session; off-switch works
- [ ] `PreCompact` nudge fires once per session; off-switch works
- [ ] `@master-orchestrator` mentions still work (backward compat)
- [ ] Non-project sessions (no `.claude/settings.json`) still use master-orchestrator agent
- [ ] `agent-factory --upgrade master-<slug>` shows diff before write; user must approve

## Lock

This adjudication is locked when v3.11.0 implementation begins (Phase A start).
Subsequent design changes require a new D005 entry referencing this and D001/D002/D003.

## Related

- D001-bootstrap-unification.md — parent bootstrap design
- D002-v3.10-hooks-drift-scope.md — locked hook strategy (partially overridden by §6 re-adding 2 nudges)
- D003-bootstrap-scaffold-scope.md — scaffold scope (extended to 7 phases here)
- `agents/claude-master.md` — project-local Claude Code specialist that adversarially reviewed this plan
- `~/.claude/skills/master-orchestrator/SKILL.md` — new in Phase E; protocol body migrated from agent file
- `~/.claude/agents/master-orchestrator.md` — preserved as thin skill-loading wrapper in Phase E
