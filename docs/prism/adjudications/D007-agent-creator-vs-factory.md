# D007 — Agent-creator skill vs factory: decision-tree placement

**Status:** Locked
**Date:** 2026-05-26
**Decision owner:** PRISM core (user adjudication via v4.1 Phase 0)
**Target releases:** v4.1 (this lock); revisit eligibility at v4.2 if Phase C telemetry shifts the picture
**References:** [[D004-v4-product-vision]] §1–3, [[D005-phase-f-hook-api-incompatibility]] (same v4.1 cycle), [[2026-05-26-v4.1-roadmap]] §Phase 0 + Q8
**Adversarial review:** post-Phase-K two-lens governance audit (claude-master persona + feature-dev:code-reviewer dispatched in parallel pgroup=review)

## Context

The post-Phase-K governance audit asked Q8: should agent creation be gated by a thin `agent-creator` skill that owns the decision tree (use an existing agent? `--skill-research` mode? full create mode?) and delegates to the factory only on the "create" branch, or should master-orchestrator continue to own that tree inline?

The decision tree exists in TWO places today:

1. **`skills/master-orchestrator/SKILL.md`** — Phase 0 "Team Assembly" section: registry consultation (`tools-registry.md` hit → use Tier 1/2 tool, no agent), then agent-hiring flow (missing → spawn factory; exists → staleness check; >180d → refresh-or-rebuild gate; gaps → targeted upgrade).
2. **`agents/agent-factory.md`** — `--skill-research` mode's "Decision tree: agent-creation vs skill-research" (Q1 workflow/tooling need → `--skill-research`; Q2 domain-expertise need → standard create flow).

The two surfaces are not contradictory — they implement different layers of the same decision (orchestrator decides *whether* to invoke factory; factory decides *which mode* once invoked). The seam between them is in prose rather than code, which is the audit's concern.

## What an `agent-creator` skill would look like (the audit's hypothetical)

A standalone skill that the orchestrator delegates to in Phase 0 when the team-assembly step lands on "I need to consider creating something":

- **Skill body:** the unified decision tree, currently split between orchestrator + factory.
- **Orchestrator change:** replaces the inline "Team Assembly" hiring-flow branch with a Skill tool invocation (`Skill('agent-creator', …)`).
- **Factory change:** keeps `--from-notebook` / `--skill-research` / standard create modes, but the choice of WHICH mode is made by the skill upstream, not by the factory's own prose.

Cost: one indirection layer between orchestrator and factory; one new skill file; some prose duplication removed in favor of a single source of truth.

## Why this is hard to evidence either way

The audit verdict on Q8 was **NEEDS ADJUDICATION**. The audit's verdict on Q10 was that telemetry has no consuming surface and `~/.claude/.prism-routing.jsonl` carries 34 lines total with zero `factory` entries (verified at lock time: `grep -c factory ~/.claude/.prism-routing.jsonl` → 0).

We have no data on:

- How often the factory is invoked
- How often the orchestrator's decision tree picks the wrong branch (e.g., spawns factory when a Tier 1 tool would have sufficed, or invokes `--skill-research` when a custom agent was warranted)
- How often the prose seam between orchestrator + factory surfaces causes a user-visible failure

Without that data, the case **for** extracting an `agent-creator` skill rests on theoretical separation-of-concerns. The case **against** rests on (a) inline prose is concrete and reviewable today, (b) extraction adds a Skill tool call to the orchestrator's hot path on every plan, (c) the audit's own recommendation defaulted to status quo "unless telemetry shows otherwise."

## Decision

**(a) Status quo. Master-orchestrator owns the decision tree inline; factory remains the sole creation surface. No `agent-creator` skill ships in v4.1.**

### Why

1. **No telemetry yet justifies the extraction.** The Phase C deliverable (telemetry auto-opt-in, per v4.1 roadmap §Phase C) is the missing data source. Extracting a skill BEFORE the data exists would be designing for a hypothetical use-pattern we cannot measure. The audit's own recommendation ("default to (a) unless telemetry shows excess factory invocations") explicitly conditions extraction on data we don't have.

2. **The "duplication" is layer-appropriate, not prose-rot.** The orchestrator's tree decides *invoke-or-not* (Phase 0 team assembly: stakes, classification, panel composition matter). The factory's tree decides *which-mode-when-invoked* (`--from-notebook` vs `--skill-research` vs standard: NotebookLM availability + project context matter). Collapsing both into one skill would require either:
   - Pushing factory-internal mode-selection prose up into the skill (couples skill to factory internals — worse cohesion), or
   - Keeping factory mode-selection inline AND having a skill before it (three layers instead of two — strictly worse than today).

3. **PHASE 0a inventory already centralizes the input data.** Master-orchestrator reads `~/.claude/skills/prism-plan/references/roster.json` (the unified resource-index, v2.9.0) at Phase 0a before any team-assembly happens. The decision tree's *input data* is already single-source; only the *consuming prose* is split. The orchestrator-side prose has the right context (stakes, classification, panel composition) that a downstream skill would not see.

4. **Hot-path cost.** A `Skill()` invocation in every Phase 0 adds a measurable cold-start cost to every plan. The audit's own bar for accepting that cost was "telemetry shows excess factory invocations" — i.e., the cost is only worth paying if the savings dwarf it. With zero factory invocations in 34 routing-log lines, no such evidence exists.

### What the single source of truth IS, post-lock

- **`skills/master-orchestrator/SKILL.md`** is the authoritative location for the orchestrator-side branch (registry consultation → existing-agent staleness → spawn-factory-or-not).
- **`agents/agent-factory.md`** is the authoritative location for the factory-side branch (`--from-notebook` vs `--skill-research` vs standard create flow).

The orchestrator's "Team Assembly" section MUST link explicitly to the factory's "Decision tree: agent-creation vs skill-research" so a reader following the flow lands at the second decision without prose-hunting. This cross-link is the only file change shipping with this lock (see Lock §2 below); it is the minimal seam-bridging move that captures the audit's spirit without paying the extraction cost.

Phase B's `roster.json` `domain_groups` work (Q9) reduces orchestrator-side staleness in choosing *which* existing agent fits the request — the closest practical improvement to the audit's underlying concern without introducing a new abstraction layer.

## Side concern raised in the v4.1 roadmap

The v4.1 roadmap (`2026-05-26-v4.1-roadmap.md` §"Pre-existing bugs surfaced and DEFERRED to v4.1") names `agents/agent-factory.md:31-33` with a finding:

> Factory Step 0 auto-runs `git add -A && git commit` without confirmation (violates `agents/claude-master.md:90` rule against `git add .`)

**Verification against the current branch state (HEAD `10c85ed`):**

- Read `agents/agent-factory.md:25-39` — lines 31-33 are the prose intro to the `--from-notebook <notebook-id>` mode, not a "Step 0" with git commands.
- Full-file grep on `agents/agent-factory.md` for `git\s+(add|commit|status)` → **no matches**.
- Diff between the repo file and the dev-installed `~/.claude/agents/agent-factory.md` → identical.
- Re-read the audit-hygiene commit (`2b432aa`) — explicitly lists the finding as "NOT fixed in this commit" and defers it to v4.1, but the underlying claim does not match the present code.

**Disposition:** the finding is stale or a false-positive. Either the audit was reading an earlier branch state that has since been overwritten, or the line numbers were misattributed during audit capture. Either way: **no fix is needed in D007's scope.** The factory's commit/staging behavior is already user-owned per `agents/claude-master.md:88` + `:814` + `:1140` (Git Safety Protocol forbids `git add .` / `git add -A`), and no surface in the factory's current prose violates those rules.

This is exactly the failure mode the `[[feedback-handoff-backlog-reverify]]` memory note describes: a roadmap claim about a code state can decay between when it was captured and when it gets actioned. Phase 0's 0.3d budget assumed the side-concern was real work; recovering ~0.1d of that budget into adjudication-prose time was the right call.

## Triggers to revisit at v4.2

Revisit D007 (potentially reversing to option (b) — extract a thin skill) if any of the following land:

1. **Phase C telemetry surfaces ≥10 factory invocations per month across all rostered projects** AND ≥30% of those invocations were ones where an existing agent or Tier 1 tool would have sufficed (i.e., the decision tree mis-routes at a measurable rate).
2. **A second decision-point emerges** that needs to share the same prose with Phase 0a team-assembly — e.g., if v4.2 adds an "agent-deprecate" or "agent-merge" surface that needs to read the same factory + roster context. Two callers → single skill is a clean re-factor; one caller → one skill remains over-engineering.
3. **User-reported confusion** — three or more user-reported issues that boil down to "PRISM spawned the factory when it shouldn't have" or "PRISM didn't spawn the factory when it should have," catalogued in `lessons/improvements.md` per agent or in `tasks/lessons-strategic.md`.

Absent those triggers, the next adjudication on this surface is **not scheduled** — the decision stands.

## Lock

v4.1 implementations MUST:

1. NOT introduce a `skills/agent-creator/` directory or `skills/agent-creator/SKILL.md` file.
2. Add an explicit cross-link from `skills/master-orchestrator/SKILL.md` "Team Assembly" section pointing readers at `agents/agent-factory.md` "Decision tree: agent-creation vs skill-research," so a reader following the orchestrator's hiring flow does not have to prose-hunt for the factory-side branch. Single-line addition; shipped as part of this Phase 0 commit.
3. NOT re-flag the `agents/agent-factory.md` "Step 0 git add -A" finding in v4.1 Phase A/B/C plans (this lock RESOLVES it as stale).
4. Update the v4.1 roadmap to mark Q8 as resolved by this doc (status flipped from "Phase 0 → D007" to "RESOLVED — D007 lock").

## Process lesson

When a roadmap doc names a specific code surface (file + line range) with a specific bug, the implementer MUST verify the claim against the current code before treating it as in-scope work. This session re-verified `agents/agent-factory.md:31-33` against three sources (current branch HEAD, dev install, full-file grep for `git add`) and recovered budget that would have been wasted on a non-existent bug. The `[[feedback-handoff-backlog-reverify]]` memory note is doing the work it was written to do.

Generalized: re-verification has fixed cost (one grep + one read) and saves arbitrary cost when the finding is stale. The asymmetry argues for verification being a mandatory T0 step in every v4.1 phase plan, not an advisory checklist item.

## Related

- [[D004-v4-product-vision]] §3 (per-project master agent + `skills:[master-orchestrator]` frontmatter — the architecture this skill question hangs off)
- [[D005-phase-f-hook-api-incompatibility]] (Phase F deferred — same v4.1 cycle as this lock)
- `skills/master-orchestrator/SKILL.md` — Phase 0 "Team Assembly" (authoritative orchestrator-side decision; cross-link to factory added with this commit)
- `agents/agent-factory.md` — "Decision tree: agent-creation vs skill-research" (authoritative factory-side decision)
- `docs/prism/lessons/2026-05-26-v4.1-roadmap.md` §Phase 0 + Q8 — sized the budget for this adjudication; roadmap updated post-lock
- [[feedback-handoff-backlog-reverify]] — validated again by the side-concern resolution path
- [[feedback-parallel-pgroup-review-lenses]] — the audit lens that surfaced Q8 in the first place
