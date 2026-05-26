---
name: 2026-05-26-phase-k-docs-release-prep
description: Implementation plan for v4.0 Phase K — final v4.0 phase covering /prism-help creation, README + CHANGELOG + migration guide, prism-bootstrap.md 7-phase prose sweep, statusline install fold, untracked-files cleanup, cross-implementation review, dog-food migration walkthrough, and ship handoff. Subagent-driven execution per Phase J pattern.
metadata:
  type: project
---

# Phase K — docs + release prep (v4.0 final phase)

**Date:** 2026-05-26
**Branch:** `claude/prism-v3-phase-1-0eVY1`
**Baseline:** `ee5efb9` (Phase J handoff)
**Scope source:** [[D004-v4-product-vision]] §K (line 146) + §Migration recipe (lines 165-188) + [[2026-05-26-v4.0-phase-j-handoff]] "Outstanding for next session" section
**Budget:** 0.7d (D004) + ~0.2d statusline fold = ~0.9d
**Execution model:** subagent-driven (Phase J pattern); two-stage per-task review (spec compliance → code quality); final cross-implementation review per Phase J lesson.

## Decisions captured from user (pre-plan)

| Decision | Choice | Implication |
|---|---|---|
| Untracked-files policy | **Track all 4** | T7 adds D004, claude-master.md, older handoffs, plans/ in one commit |
| Backlog folding | **Fold statusline only** | T6 implements bootstrap statusline; KNOWN_LEGACY_HOOKS deferred to v4.1 |

## Task list

Per `superpowers:subagent-driven-development`, implementation tasks serialize (single implementer + two-stage review). `[tier]` annotations follow `prism-plan` 5a.1 classifier. Implementation tasks have NO `[pgroup]`; the two review tasks (T8 + T8b) share `[pgroup=review]` and dispatch in parallel in one assistant message — they read shared artifacts but write different review notes, so there is no edit-conflict risk.

- [ ] **T1** `[haiku]` `commands/prism-bootstrap.md` 7-phase prose sweep — done when: zero `/5[\s-]?phase|five phase/i` matches remain; test suite stays green (9 suites).
- [ ] **T2** `[sonnet]` Create `commands/prism-help.md` — curated slash-command listing; hide subsumed commands (`/prism-init`, `/prism-discover`, `/prism-roster`, `/prism-health` per D002 + line 261 of bootstrap.md); surface Phase D/E/H/J/K additions (`/prism-deep-dive`, `/prism-clean`, `/prism-validate-plugins`, master-orchestrator skill). Done when: file written + present in commands/ listing + cross-references resolve.
- [ ] **T3** `[sonnet]` `CHANGELOG.md` — add v3.9.0–v3.11.0 (foundation: Phases A/B/C) and v4.0.0 (project-master: Phases D/E/H/J/K) entries in Keep-a-Changelog format. Pull commits from `git log 9f7ec82..HEAD` and D004 phase table. Done when: entries land at top of CHANGELOG (above v3.8.9); each entry names commits + deliverables.
- [ ] **T4** `[sonnet]` `README.md` updates — refresh capability matrix to surface Phase D/E/H/J/K additions; link to new MIGRATION.md; remove any v3.10 stale callouts. Done when: README reflects current v4.0 surface + cross-links land + first-time-reader can locate `/prism-deep-dive` and master-orchestrator skill from README alone.
- [ ] **T5** `[sonnet]` `docs/prism/MIGRATION.md` — build D004 §165-188 into standalone guide; cover v3.10→v3.11 (foundation) + v3.11→v4.0 (project-master) paths; include rollback section per D004 §186-188. Done when: file committed + cross-referenced from README + CHANGELOG.
- [ ] **T6** `[sonnet]` Statusline install in `/prism-bootstrap` — implement detection (parse `~/.claude/settings.json` for `statusLine` key) + offer-to-install prompt (opt-in only, no silent write); write `tools/lib/prism-statusline.mjs` (or extend existing bootstrap lib); add test coverage. Done when: bootstrap detects missing statusline + prompts user + writes settings.json line on yes + test asserts no auto-write on no.
- [ ] **T7** `[haiku]` Track 4 long-untracked files — `git add` `docs/prism/adjudications/D004-v4-product-vision.md`, `agents/claude-master.md`, `docs/prism/lessons/2026-05-25-session-handoff.md`, `docs/prism/plans/*.md` (already untracked). One commit per the policy decision. Done when: `git status` reports clean modulo Phase K new artifacts.
- [ ] **T8** `[opus] [pgroup=review]` Final cross-implementation review — **internal-consistency lens** (Phase J lesson, mandatory regardless of phase size). Read ALL Phase K artifacts together (CHANGELOG, README, MIGRATION.md, /prism-help, bootstrap.md, statusline impl). Cross-check: phase counts consistent (7 everywhere), v3.11.0 vs v4.0 version callouts aligned, no broken `[[wikilinks]]`, /prism-help completeness vs commands/ directory, statusline doc matches statusline impl. Writes findings to: review section below. Done when: findings written; any inconsistencies fixed in follow-up commits.
- [ ] **T8b** `[opus] [pgroup=review]` Claude Code best-practices code review — **external-compliance lens** via `agents/claude-master.md` persona. Dispatch a fresh agent (preferred: `general-purpose` briefed with the full `agents/claude-master.md` body as system context; secondary: `claude-code-guide` for any Q&A follow-ups). Review every Phase K artifact against Claude Code conventions: slash-command YAML frontmatter (name, description, allowed-tools), agent file structure (name, description, model, tools), skill SKILL.md structure (name + description frontmatter, body), settings.json schema (statusLine block format), hook event/output combinations (cross-check against [[reference-claude-code-hook-decision-control]]), tool-naming and permission conventions, `~/.claude/` vs `.claude/` install paths, MEMORY.md ≤25 KB rule. Writes findings to: claude-master review section below. Done when: per-artifact verdict (COMPLIANT / NEEDS-FIX / DEFER) issued; any NEEDS-FIX resolved before T9.
- [ ] **T9** `[opus]` Dog-food migration walkthrough — execute MIGRATION.md against synthetic v3.10/v3.11 starting state (use `tests/v3/state/testbed-edge-cases.mjs` scaffold or `/prism-bootstrap` on a fresh dir). Walk the v3.10→v3.11→v4.0 path; note rough edges. Done when: walkthrough log appended below; pass/fail verdict per migration recipe step; any blocker fixed in-phase, any non-blocker captured as v4.1 backlog.
- [ ] **T10** `[sonnet]` Phase K + v4.0 ship handoff — write `docs/prism/lessons/2026-05-26-v4.0-phase-k-handoff.md`. Capture: what shipped in K, full v4.0 commit count, branch state, push strategy options (single PR vs chunked, per [[2026-05-26-v4.0-phase-j-handoff]] Open Question #2), tactical lessons, v4.1 backlog (Phase F flag-file hooks per [[D005]], MEMORY.md auto-resynth, KNOWN_LEGACY_HOOKS catchup). Done when: handoff committed + open questions resolved or deliberately carried.

## Checkpoint gates (mandatory — Phase K is stakeholder-facing release prep)

1. **After T7** (all docs + statusline + tracking done, before reviews):
   present what shipped, invite spot-check, wait for go → dispatch T8 + T8b in parallel.

2. **After T8 + T8b BOTH complete** (consistency + claude-master compliance):
   present BOTH sets of findings together, apply fixes (single follow-up commit per review where possible),
   invite go → T9. Block on any NEEDS-FIX from T8b until resolved.

3. **After T9** (dog-food walkthrough done, before T10 handoff):
   present dog-food results + verdict, invite go → T10.

4. **After T10** (phase complete):
   present push-strategy options (single PR / chunked-by-phase / rebase-then-PR);
   user decides whether to push, merge to main, or hold.

## Pre-execution hygiene

Per Phase J lesson "Plan-as-spec discipline matters" — re-read this plan as a reviewer before T1 starts:

- [ ] Heading strings stable across mentions (e.g. CHANGELOG, MIGRATION.md, /prism-help)
- [ ] Tier assignments match work shape (T1/T7 haiku = bounded; T8/T9 opus = synthesis/judgment; rest sonnet)
- [ ] Cross-task dependencies acyclic (T8 depends on T1-T7; T9 depends on T5; T10 depends on T9)
- [ ] Done-when criteria are checkable, not vibes ("test suite green", "git status clean", "review findings written")

## Tactical lessons applied from Phase J

- **Drift-guard regexes pin uppercase tokens case-sensitively** — T1 sweep uses case-insensitive grep to FIND but case-sensitive replacement to AVOID re-introducing "5-phase" in lower-case prose.
- **Plan-as-spec discipline** — re-read pre-execution hygiene block above.
- **Final cross-implementation review is non-negotiable** — T8 is gated, not optional.
- **Subagent-driven scales to sub-day phases** — Phase J was 0.3d / 9 commits / zero 529s; Phase K is ~0.9d / projected ~10-12 commits.

## v4.0 phase plan status after Phase K ships

| Phase | Status | Ship date |
|---|---|---|
| A — D001/D002 foundation | ✓ | (v3.11.0 baseline) |
| B — Bootstrap 7-phase + schema v2 | ✓ | (v3.11.0) |
| C — /prism-validate-plugins | ✓ | (v3.11.0) |
| D — /prism-deep-dive + master-`<slug>` | ✓ | 2026-05-25 |
| E — master-orchestrator → skill | ✓ | 2026-05-25 |
| ~~F~~ — nudge hooks | DEFERRED to v4.1 per [[D005]] | — |
| H — Knowledge evolution rhythms | ✓ | 2026-05-26 |
| J — Tightened evidence rules | ✓ | 2026-05-26 |
| K — Docs + release prep | **THIS PLAN** | 2026-05-26 (target) |

After Phase K: v4.0 is shippable. Push-strategy decision in T10 handoff.

## Dog-food walkthrough log (T9 — executed 2026-05-26)

Synthetic testbed: `$TEMP/prism-dogfood-test/` with pre-populated v3.8.9-style `.claude/` tree (agents/roster.json + empty hooks/skills/references/commands dirs + CLAUDE.md with `## PRISM Operating Rules`). Sandboxed HOME at `$TEMP/dogfood-home2/` for statusline tests. Executed inline by orchestrator (T-shape mode — bounded execution + observation pairs with full context better than fresh subagent dispatch).

### Per-step results

| Migration recipe step | Result | Notes |
|---|---|---|
| **v3.10/v3.8.9 → v3.11.0** | | |
| `init-state-if-missing` detect-and-adopt | ✅ PASS | 4 phases adopted (identity, structure, discovery, roster); v2-only phases (`plugin-validate`, `project-master`) correctly start at `status: null` |
| `plan` after adopt | ✅ PASS | Pending = `[plugin-validate, health]`; project-master correctly excluded (opt-in default) |
| `phase-plugin-validate` stub | ✅ PASS | Output matches doc: *"plugin-validate phase: stub (Phase C wires the real validator)"* |
| `start-phase` / `complete-phase health` sentinel cycle | ✅ PASS | `last_command` set on start, cleared on complete; sentinel fields populated correctly |
| `status` report | ✅ PASS | Matches MIGRATION.md verification step — all 7 phases reported; project-master shows `(pending)` since not opt-in |
| **v3.11.0 → v4.0.0** | | |
| `slug-derive --source auto` | ✅ PASS | Auto-derived `prism-dogfood-test` from basename |
| `phase-project-master --with-deep-dive` | ✅ PASS | Slug locked in state with `slug + source` meta; correctly defers agent generation to slash command |
| `agent-write --slug` | ✅ PASS | Wrote `agents/master-prism-dogfood-test.md` with correct frontmatter (`memory: project`, `skills: [master-orchestrator]`, `model: opus`, `prism_phase: D`) |
| `memory-seed --slug --profile <inline>` | ✅ PASS | Wrote `agents/MEMORY.md` at 890 bytes (well under 25 KB cap). Path matches T8b-corrected MIGRATION.md |
| `settings-write --slug` | ✅ PASS | Atomic merge preserved pre-existing `agent: master-foo` key when overwriting; final value = `master-prism-dogfood-test` |
| **Statusline (T6 surface)** | | |
| `detect-statusline` fresh sandbox | ✅ PASS | All three booleans return false; matches Step N.1 "script absent → log gap, do not prompt" branch |
| `detect-statusline` real `$HOME` | ✅ PASS | Returns `settings_exists: true, installed: false, source_script_exists: false` — the third triggers correct "script absent" branch in user's actual env |
| `install-statusline` against seeded sandbox | ✅ PASS | Wrote canonical `{type, command: "bash <path>", padding: 0}` shape; preserved pre-existing `agent` key |
| `install-statusline` re-run (idempotency) | ✅ PASS | Exit code **11** with clear message *"statusLine key already present ... pass --force to overwrite"* |
| `install-statusline --force` | ✅ PASS | Overwrote with exit 0 |

### Non-blocker observations (captured as v4.1 backlog)

- **`memory-seed --profile` not surfaced in MIGRATION.md manual flow.** Helper requires `--profile <json-file-or-inline>` (exit 5 if missing), but MIGRATION.md only documents the slash-command path where `/prism-deep-dive` builds the profile from AskUserQuestion. Users invoking helpers directly (scripting / automation) would hit a confusing exit-5. **Action:** v4.1 — add a "Manual / scripted invocation" appendix to MIGRATION.md or to `commands/prism-deep-dive.md` explaining the helper contract.
- **User's dev install lacks `~/.claude/statusline-command.sh`.** The PRISM `manifest.json` does copy it (`statusline-command.sh → ~/.claude/statusline-command.sh`), but my current dev install was set up before that manifest entry shipped (or via partial copy). Means the Step N.1 statusline-offer branch *"script absent → log gap, do not prompt"* will fire for me until I re-run the full installer or `scripts/install-statusline-only.sh`. **Not a Phase K bug** — Phase K's Step N.1 correctly handles this state. **Action:** none in Phase K; user can run `scripts/install-statusline-only.sh` if they want the statusline now.
- **`status` column alignment** has a small visual nit when phase names exceed 12 chars (`plugin-validate| 2026-...` instead of `plugin-validate | 2026-...`). Cosmetic only; not a Phase K regression (existed before). **Action:** v4.1 cleanup pass.

### Dog-food verdict

**PASS.** All MIGRATION.md steps execute successfully against a synthetic v3.8.9-style state. The v3.11.0 detect-and-adopt path works as documented; the v4.0 project-master path produces all three artifacts (`agents/master-<slug>.md`, `agents/MEMORY.md`, `settings.json` `agent:` field) at the canonical paths the post-T8b-fix MIGRATION.md describes. The new T6 statusline-install surface honors all four behavioural branches (already-installed, install-prompt, script-absent, parse-error). No blockers; 3 non-blockers captured as v4.1 backlog. Gate 3 cleared; T10 ship handoff may proceed.

## Cross-implementation review findings (T8 — internal-consistency lens)

Dispatched 2026-05-26 as `pgroup=review` in parallel with T8b. Verdict: **NEEDS-FIX-OPTIONAL**.

### MAJOR

- **`tools/prism-bootstrap.mjs:25`** — `phase-structure` header comment labeled "Phase 3" under v2; should be "Phase 2" (structure is phase 2 in the canonical 7-phase order). Adjacent line 30 already says "Sub-step of Phase 2 (structure)" — direct internal contradiction. **Fixed** (Phase K post-review commit).
- **`tests/v3/state/README.md:198-199`** — "all five required phases" should be "all seven" under v2 schema. T1 caught the upper walkthrough but missed this lower test-coverage bullet. **Fixed**.

### MINOR (actionable)

- **`CHANGELOG.md:18`** — Phase D's second commit range `5a9a254..d5f3ae7` overlapped into Phase E commits (Phase E is also cited separately on its own line). Trimmed to `5a9a254..8d8e27c` (last Phase D commit). **Fixed**.
- **`README.md:3, 75`** — "16 hooks" undercount; `hooks/*.mjs` count is 17 (added `agent-write-register` in v3.11.0 Phase A.3 but README count was not bumped). **Fixed** (both occurrences).

### MINOR (deferred — stylistic / out-of-scope)

- **`commands/prism-help.md:38-42`** — no self-listing for `/prism-help`. Stylistic; defer.
- **`README.md:95`** — D006 adjudication exists but isn't cited in CHANGELOG v4.0 or MIGRATION. Stylistic; defer (D006 is about prism-master canonicalisation, not v4.0 itself).
- **`docs/prism/MIGRATION.md:113-118`** — could call out Phase letters explicitly in §v4.0. Stylistic; defer.

## Claude-master code review findings (T8b — Claude Code best-practices lens)

Dispatched 2026-05-26 as `pgroup=review` in parallel with T8. Verdict: **NEEDS-FIX-OPTIONAL**.

### Per-artifact verdict matrix

| Artifact | Verdict | Notes |
|---|---|---|
| `commands/prism-help.md` | **COMPLIANT** | Well-formed frontmatter; terse description; no body/description duplication |
| `commands/prism-bootstrap.md` (T1 + T6 changes) | **COMPLIANT** | Step N.1 follows file's existing LLM-judged-step pattern; explicit confirm-before-write; AskUserQuestion usage correct |
| `CHANGELOG.md` (v4.0.0 + v3.11.0) | **NEEDS-FIX → fixed** | Wrong file attribution for MEMORY.md 25 KB cap (Finding 1) |
| `README.md` (modified surface) | **COMPLIANT** | Status table accurate; architecture matches reality; statusline correctly flagged opt-in |
| `docs/prism/MIGRATION.md` | **NEEDS-FIX → fixed** | MEMORY.md path drift (Finding 2) — was `.claude/MEMORY.md`, canonical is `.claude/agents/MEMORY.md` |
| `tools/prism-bootstrap.mjs` (statusline impl) | **COMPLIANT** | JSON shape matches Claude Code statusLine schema; atomic tmp+rename; STATUSLINE_COMMANDS git-guard bypass sound; `--home` mirrors `--root` convention; exit codes 9/11/12 well-chosen; matches `scripts/install-statusline-only.sh` shape exactly |
| `tests/v3/state/test-prism-bootstrap.mjs` (statusline tests) | **COMPLIANT** | All 10 tests follow file precedent (`mkdtempSync` sandbox, subprocess spawn, `assertEq/assert`, `--home` override, no real `~/.claude/` touch) |

### Findings detail

**Finding 1 (NEEDS-FIX, applied): `CHANGELOG.md:69-70`** — v4.0.0 entry attributed the MEMORY.md 25 KB cap enforcer to `tools/lib/prism-state.mjs`. Verified via Grep: that file does NOT contain the cap. Actual enforcers: `tools/prism-clean.mjs:88` (`MEMORY_MD_HARD_CAP_BYTES = 25 * 1024`, enforced in `append-decision`/`append-lesson` at line 104) and `tools/prism-deep-dive.mjs:284` (same constant, enforced in `memory-seed`). Misattribution would misdirect `/prism-doctor` lookups on "MEMORY.md > 25 KB" failures. **Fixed** — CHANGELOG now points at the two real enforcers.

**Finding 2 (NEEDS-FIX, applied): `docs/prism/MIGRATION.md:158, 185`** — used `<project>/.claude/MEMORY.md` for the project-local memory file. Verified via Grep: canonical path is `<project>/.claude/agents/MEMORY.md` (cited at `tools/prism-deep-dive.mjs:211` and `tools/prism-clean.mjs:20`). The `agents/` segment matters because Claude Code's subagent memory loader scopes to `.claude/agent-memory/<name>/MEMORY.md` (or the project equivalent) — without `agents/` in the path, no loader picks it up. **Fixed** — both occurrences in MIGRATION.md updated, including the verification checklist at line 185.

## Consolidated review verdict (T8 + T8b)

**Both reviews:** NEEDS-FIX-OPTIONAL. Six findings applied (2 MAJOR + 2 actionable MINOR from T8 + 2 NEEDS-FIX from T8b). Three stylistic findings deferred. Phase K artifacts are now internally consistent (T8 lens) AND Claude Code best-practices compliant (T8b lens). Gate 2 cleared; T9 dog-food may proceed.
