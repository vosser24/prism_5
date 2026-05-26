---
name: 2026-05-26-packaging-fix-handoff
description: Resume handoff for the post-v4.1 packaging-fix session. v4.1 mega-PR pushed; claude-master's review surfaced 6 packaging gaps that drag PRISM from engineered-like-9/10 to packaged-like-4/10. This handoff seeds the URGENT pre-merge fixes + the v4.2 Phase 0 plan.
metadata:
  type: project
---

# 2026-05-26 — Session handoff (post-v4.1 packaging fix-up to reach 9/10)

**Status:** Locked
**Date:** 2026-05-26
**Captured by:** end-of-session, post v4.1 push + claude-master packaging review
**Related:** [[2026-05-26-v4.1-shipped-handoff]] [[2026-05-26-v4.1-roadmap]] [[D007-agent-creator-vs-factory]] [[feedback-handoff-backlog-reverify]] [[feedback-parallel-pgroup-review-lenses]]

## One-sentence summary

v4.1 mega-PR is pushed (HEAD `6de3e93` at `origin/claude/prism-v3-phase-1-0eVY1`, 27 commits ahead of `main`, 97 tests across 6 suites green); claude-master's review (verified by me) identified 6 packaging gaps that drag the score from "engineered like 9/10" to "packaged like 4/10" — 2 of them are URGENT pre-merge fixes (plugin.json drift makes the marketplace install path literally non-functional for v4.0+v4.1 features), the rest seed v4.2 Phase 0.

## Branch state at handoff write

- **Branch:** `claude/prism-v3-phase-1-0eVY1` (pushed)
- **HEAD:** `6de3e93` (v4.1 fix-batch + ship handoff + CHANGELOG)
- **Remote:** `origin/claude/prism-v3-phase-1-0eVY1` (in sync; pushed earlier this session)
- **Ahead of `origin/main`:** 27 commits
- **PR status:** NOT YET OPENED — user owes the `gh pr create` invocation
- **Compare URL:** https://github.com/vosser24/prism_master/compare/main...claude/prism-v3-phase-1-0eVY1
- **Test baseline:** 97 across 6 suites green (25 git-hygiene + 14 freshness + 12 telemetry + 34 bootstrap + 9 evidence-rules + 3 thin-wrapper)

## Resume protocol for the new session

**DO NOT re-execute v4.0 + v4.1 reviews. They're done.** Apply the handoff's diagnosis directly.

1. Read this handoff in full + glance at `[[2026-05-26-v4.1-shipped-handoff]]` for the v4.1 ladder context.
2. Per `[[feedback-handoff-backlog-reverify]]`, **re-verify** the URGENT gaps before treating them as work. Exact commands at "Verification checklist" below. If any gap is no longer present (because a teammate fixed it, or the audit was stale), skip it.
3. Execute Phase 0 (URGENT, pre-merge — see below). Stop and check in with user after Phase 0 ships.
4. If user approves continuation: execute v4.2 Phase A (packaging polish), then Phase B (plugin-scoped factory), then Phase C (outside verification).

## Verification checklist (run FIRST in next session)

```bash
# Gap 1 — plugin.json version drift
node -e "const p=require('./.claude-plugin/plugin.json'); console.log('plugin.json version:', p.version);"
# Expected if gap still present: "plugin.json version: 3.8.9"
# Fix needed if NOT "4.1.0"

# Gap 1b — plugin.json hooks block drift
node -e "const p=require('./.claude-plugin/plugin.json'); const s=require('./settings.fragment.json'); console.log('plugin.json hook keys:', Object.keys(p.hooks).sort().join(',')); console.log('settings.fragment.json hook keys:', Object.keys(s.hooks).sort().join(','));"
# Expected if gap still present: plugin.json missing SessionEnd
# Fix needed if hook keys differ

# Gap 2 — drift-guard test does not exist
ls tests/v3/state/test-plugin-manifest-drift.mjs 2>&1
# Expected if gap still present: "No such file or directory"

# Gap 3 — DISABLE_TELEMETRY / DO_NOT_TRACK env vars not honored
grep -rE "DISABLE_TELEMETRY|DO_NOT_TRACK" tools/ hooks/ commands/ 2>&1 | head -3
# Expected if gap still present: (no output)

# Gap 4 — marketplace.json absent
ls .claude-plugin/marketplace.json 2>&1
# Expected if gap still present: "No such file or directory"

# Gap 5 — telemetry default
grep -nE "Default = recommended-on" commands/prism-bootstrap.md
# Expected if gap still present: hit on line ~265 (the v4.1 Step 7b default)
```

If `git status` is not clean at session start, STOP and surface to user — the working tree should be clean post-fix-batch commit. (Per `[[feedback-handoff-backlog-reverify]]`, never act on stale assumptions.)

## What's already shipped (do NOT redo)

| Surface | Status | Tests | Notes |
|---|---|---|---|
| v4.0 project-master + master-orchestrator skill | ✓ shipped | 3 + 9 | D004 spec |
| v4.0 evidence rules (PHASE 1.5 EVIDENCED/UN-CITED/REJECTED) | ✓ shipped | 9 | D004 §J |
| v4.0 bootstrap 7-phase + statusline subcommands | ✓ shipped | 34 | D004 §B + Phase K |
| v4.1 git-hygiene hook bundle (4 hooks + flag helper) | ✓ shipped | 25 | Phase A; verified hook decision-control matrix |
| v4.1 D005 Phase F bundle (clean-nudge + precompact-nudge) | ✓ shipped | (covered by 25 above) | Phase A; flag-file + SessionStart pickup |
| v4.1 SessionStart freshness sweep (6 audit Qs) | ✓ shipped | 14 | Phase B; 24h throttle, off-switch |
| v4.1 telemetry opt-in + aggregate helper + prism-updater consumption | ✓ shipped | 12 | Phase C; consent gate at `~/.claude/prism-policy.json` |
| v4.1 fix-batch (10 review findings, 1 CRITICAL + 5 HIGH + 2 MEDIUM + 1 LOW + 1 NIT) | ✓ shipped | — | applied pre-push |
| v4.1 CHANGELOG entry + ship handoff doc | ✓ shipped | — | — |

**Do not re-dispatch the v4.1 parallel pgroup=review** — that was done at the end of the v4.1 ladder and the findings are already in the fix-batch (`6de3e93`).

## Diagnosis: claude-master's packaging audit (verified)

claude-master (the project's Windows-first Claude Code specialist agent) reviewed the v4.1 ship readiness with the question "what does PRISM need to be the best Claude Code plugin?". Verdict: **engineered like 9/10, packaged like 4/10. ~5.7 weighted average.** Substance carries the score; presentation drags it down ~3 points.

The full audit + my verification is in this session's transcript; the actionable findings are below.

### Scoreboard (claude-master's 1–10 per area)

| Area | Score | Why |
|---|---|---|
| Engineering substance | **9** | 97 tests, 6 suites, drift-guards, evidence rules. Best-in-class. |
| `plugin.json` completeness | **3** | Version drift + no icon/screenshots/category/docs/example_prompts. |
| First-run UX (`/prism-bootstrap`) | **7** | Solid; lacks 60-second video / GIF. |
| Documentation depth | **8** | CHANGELOG + MIGRATION + adjudications exemplary. |
| Documentation discoverability | **5** | No FAQ, no troubleshooting page, no "compare vs alternatives." |
| Cross-platform coverage | **6** | Windows + Linux verified; macOS native untested; no CI matrix. |
| Privacy posture | **5** | Local-only telemetry correct but defaulted on; ignores standard env vars. |
| Plugin-ecosystem fit | **4** | Global-agent-write conflicts with plugin sandboxing; no multi-plugin interop test. |
| Marketing surface | **3** | No screenshot, no GIF, no comparison vs `superpowers`, no install-count badge. |
| Update hygiene | **7** | `/prism-update` exists; freshness sweep auto-prompts; version field wrong, which poisons downstream. |

### URGENT (must fix BEFORE the mega-PR is merged)

**1. `plugin.json` is stuck at v3.8.9 with stale hooks block.** This is the most consequential gap by far — anyone who installs PRISM via `/plugin install prism@PRISM` from the marketplace gets the v3.8.9 surface. The v4.0 (project-master, evidence rules) and v4.1 (git-hygiene, freshness sweep, telemetry) features DO NOT FIRE for marketplace installs.

Concrete drift:
- `.claude-plugin/plugin.json:3` — version `"3.8.9"` (repo is v4.1)
- Hooks block has 12 entries from v3.8.9 era — missing:
  - `PostToolUse` `prism-agent-write-register.mjs` (added v3.11.0)
  - `SessionEnd[matcher=clear]` (added v4.1 Phase A)
  - `SessionEnd` catch-all (added v4.1 Phase A)
  - `PreCompact` `prism-precompact-nudge-flag.mjs` (added v4.1 Phase A)
  - `PreToolUse[Bash]` `prism-prepush-review.mjs` (added v4.1 Phase A)
- Still wires the old `prism-session-start.mjs` under `PreCompact` (removed from `settings.fragment.json` in `6de3e93`, never updated in plugin.json)

**2. No drift-guard test asserts `plugin.json` ≡ `settings.fragment.json`.** This is the only structural mitigation. Without a test, the drift WILL recur every time someone touches one and not the other (which is what just happened across 4 releases).

### HIGH (pre-v4.2, but fine to land in a follow-up PR after the URGENT ones)

3. **Plugin-vs-global factory write conflict.** When PRISM is plugin-installed, `@agent-factory` writes new agents to `~/.claude/agents/<name>.md` (global) — outside the plugin sandbox. These agents survive `/plugin uninstall`, leak across users on shared machines, aren't restorable from plugin backup. Architectural fix: detect `CLAUDE_PLUGIN_ROOT` env var; write to `${CLAUDE_PLUGIN_ROOT}/agents/` when running under plugin install, keep global for manual install. Or add `--global` flag and default to plugin-scoped.

4. **Telemetry default is "recommended-on" — wrong for privacy-sensitive first-install UX.** The Step 7b prompt in `commands/prism-bootstrap.md` defaults to recommended-on. Flip to default-off framed as "PRISM ships a local routing log at `~/.claude/.prism-routing.jsonl`; enable rollup? (no network, ever)". Also honor industry-standard env vars: `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1` — both currently checked nowhere.

5. **Outside-user marketplace install never tested.** `README.md:34` literally admits this. Before the mega-PR merges, run the `/plugin marketplace add` → `/plugin install` flow from a clean `~/.claude/` on a second machine and verify the new features fire.

6. **`plugin.json` missing discoverability keys.** No `icon`, `screenshots`, `category: "orchestration"`, `documentation` URL, `example_prompts`. Marketplace card renders as wall-of-text. Also: `.claude-plugin/marketplace.json` sibling missing.

### v4.1-handoff-backlog corrections (re-prioritization claude-master called out)

The v4.2 backlog in `[[2026-05-26-v4.1-shipped-handoff]]` had three priority calls that need flipping:

| Item | Old priority | New priority | Reason |
|---|---|---|---|
| Tested on macOS native | LOW | **MEDIUM** | macOS dev share dominates Claude Code users; #1 marketplace listing blocker |
| User hook customization preservation | MEDIUM | **HIGH** | "I'll uninstall this because it wiped my custom hook" failure mode |
| `bootstrap status` column alignment when phase names >12 chars | LOW | **CUT** | Purely cosmetic; defer indefinitely |

## Plan — Phase 0 (URGENT, pre-merge) + v4.2 Phases A / B / C

### Phase 0 — plugin.json sync + drift-guard test (MUST do before merge)

**Budget:** ~0.3d.

**Tasks:**

1. **Update `.claude-plugin/plugin.json`:**
   - Bump `version` to `"4.1.0"`.
   - Replace the `hooks` block verbatim with the contents of `settings.fragment.json`'s `hooks` block. The plugin manifest uses `${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs` paths via Node (no `bash` wrapper since plugins run cross-platform); transform each `"command": "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/<name>.mjs"` to `"command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs\""`. Verify the transform is correct against the existing entries in plugin.json.
   - DO NOT include the `statusLine` block from `settings.fragment.json` — plugins don't ship a statusLine; it's opt-in via `/prism-bootstrap install-statusline`.
   - DO NOT include the `env` block — that's a user setting, not a plugin contract.

2. **Write `tests/v3/state/test-plugin-manifest-drift.mjs`** — a drift-guard test that asserts:
   - `plugin.json.version` matches the top entry of `CHANGELOG.md` (strip `[` `]` markers; semver match).
   - `Object.keys(plugin.json.hooks).sort()` matches `Object.keys(settings.fragment.json.hooks).sort()`.
   - For each hook event present in both, the count of registered handlers matches.
   - For each handler, the SCRIPT NAME is present in both (path prefix may differ — plugin uses `${CLAUDE_PLUGIN_ROOT}/hooks/`, settings uses `~/.claude/hooks/`, both end in the same `.mjs` basename).
   - Skip the test gracefully if either file is missing — but fail if BOTH exist and drift.

3. **Run all 6 test suites** — confirm 98+ green (97 existing + drift-guard suite).

4. **Sync dev install** — `cp .claude-plugin/plugin.json ~/.claude/.claude-plugin/plugin.json` (if a dev plugin install exists at `~/.claude/.claude-plugin/`; otherwise N/A).

5. **Commit:** `fix(prism): v4.2 Phase 0 — plugin.json sync to v4.1 + drift-guard test`.

**Stop after Phase 0. Check in with user. They may want to merge the URGENT fix as part of the v4.1 mega-PR or as a separate follow-up PR — that's their call.**

### v4.2 Phase A — packaging polish (HIGH, ~1.0d)

**Goal:** flip the marketplace card from 3/10 to 7/10.

**Tasks:**

1. **Flip telemetry default in `commands/prism-bootstrap.md` Step 7b** — change the AskUserQuestion prompt's default from "recommended-on" to "off." Update MIGRATION.md to match.
2. **Honor `DISABLE_TELEMETRY=1` + `DO_NOT_TRACK=1`** — `tools/prism-telemetry-aggregate.mjs` checks consent gate; extend the check: if either env var is `"1"`, behave as if opt_in is false (exit 13 silently). Same in `tools/prism-bootstrap.mjs` `set-telemetry-consent` — if the env vars are set, force-write opt_in:false regardless of the CLI arg, and stderr a note explaining why.
3. **Add discoverability keys to `.claude-plugin/plugin.json`:**
   - `"icon": ".claude-plugin/icon.svg"` (write the SVG — a simple 64×64 prism geometry would work)
   - `"category": "orchestration"`
   - `"documentation": "https://github.com/vosser24/prism_master/blob/main/README.md"`
   - `"example_prompts": ["plan a multi-step refactor", "review this code", "summon the panel", "update prism"]` (4 example invocations that surface PRISM's signature features)
4. **Write `.claude-plugin/marketplace.json`** — the curated 30-second pitch (reuse the README pitch verbatim) + a "what's included" table + comparison vs `superpowers`.
5. **Tests + dev sync + commit:** `feat(prism): v4.2 Phase A — packaging polish (telemetry default + plugin.json discoverability + marketplace.json)`.

### v4.2 Phase B — plugin-scoped factory writes (HIGH, ~1.5d)

**Goal:** fix the plugin-vs-global write conflict.

**Tasks:**

1. **`agents/agent-factory.md` protocol change** — Step "ALWAYS write agent to GLOBAL path: `~/.claude/agents/`" becomes a conditional: if `$CLAUDE_PLUGIN_ROOT` is set, write to `${CLAUDE_PLUGIN_ROOT}/agents/<name>/`; else write to `~/.claude/agents/<name>/`. Update the DUAL FILE REQUIREMENT section accordingly.
2. **Update the dual-file copy step** to use the same resolution.
3. **Roster.json location decision:** roster is the SHARED source of truth for the orchestrator. Even when factory writes to plugin-scoped path, roster should remain global (`~/.claude/skills/prism-plan/references/roster.json`). Otherwise multi-plugin scenarios fragment the index. Document this in `agents/agent-factory.md` + `skills/master-orchestrator/SKILL.md`.
4. **Sandboxing tests** for the new path-resolution helper.
5. **MIGRATION.md** — document the plugin-vs-manual install behavior difference + how to migrate global agents under a plugin sandbox (if user wants).
6. **Tests + dev sync + commit:** `feat(prism): v4.2 Phase B — plugin-scoped factory writes (Q-packaging-fit)`.

### v4.2 Phase C — outside verification + multi-plugin interop (HIGH, ~1.0d, partially manual)

**Goal:** flip plugin-ecosystem fit from 4/10 to 7/10; cross-platform from 6/10 to 8/10.

**Tasks:**

1. **Clean-machine marketplace install test.** Manual: spin up a clean `~/.claude/` (rename existing to `~/.claude.bak`); run `/plugin marketplace add vosser24/prism_master`; run `/plugin install prism@PRISM`; verify all v4.0 + v4.1 features fire (run `/prism-help`, `/prism-bootstrap`, `/prism-update --status`). Record findings in `docs/prism/lessons/2026-05-26-outside-install-verify.md`.
2. **Multi-plugin interop test** — write a documented walkthrough: install `superpowers` + `firecrawl` + PRISM together; verify `/prism-index` discovers their skills; verify no hook stacking deadlocks (PRISM owns 4 UserPromptSubmit hooks; another plugin adding more could blow the 30s timeout).
3. **macOS native test** — needs someone with a Mac. Document the test plan in a `docs/prism/lessons/macos-test-plan.md`; defer execution to whoever has a Mac available.
4. **Commit:** `feat(prism): v4.2 Phase C — outside install + interop verification`.

## What to NOT do (scope discipline)

- Do not re-run v4.0 or v4.1 reviews — they're done.
- Do not refactor anything that doesn't show up in the gaps above.
- Do not add features beyond the 3 phases above without user approval.
- Do not push commits without user's say-so. The `git push` for v4.1 was user-approved this session; v4.2 phases need fresh approval.
- Do not open the PR yet — Phase 0 needs to land first, then PR opens with the URGENT fix included.

## Open questions for the new session

1. **Phase 0 ship strategy.** Land Phase 0 on the same `claude/prism-v3-phase-1-0eVY1` branch (mega-PR grows to 28 commits) or open a separate `claude/v4.2-phase-0-plugin-manifest-fix` branch? Recommendation: same branch — Phase 0 is a hotfix for the v4.1 ship, belongs with it.
2. **`/plugin marketplace add` URL** — needs to be the canonical marketplace path. README:34 says marketplace add of `vosser24/prism_master`; verify this matches what `/plugin marketplace list` would return when listing the user's available marketplaces.
3. **Telemetry default flip** — does the user agree with claude-master's "default off, honor DO_NOT_TRACK" call? Worth confirming before flipping (it's a UX call, not just a fix).

## References (for the new session)

- **Live audit transcript:** in this session's transcript (claude-master's report + my verification of plugin.json drift + DISABLE_TELEMETRY absence + marketplace.json absence)
- **v4.1 ship handoff:** [[2026-05-26-v4.1-shipped-handoff]]
- **v4.1 roadmap:** [[2026-05-26-v4.1-roadmap]]
- **D004 (v4 product vision):** `docs/prism/adjudications/D004-v4-product-vision.md`
- **D005 (Phase F hook API):** `docs/prism/adjudications/D005-phase-f-hook-api-incompatibility.md`
- **D007 (agent-creator skill vs factory):** `docs/prism/adjudications/D007-agent-creator-vs-factory.md`
- **plugin.json (the artifact to fix):** `.claude-plugin/plugin.json`
- **settings.fragment.json (the truth-source):** `settings.fragment.json`
- **CHANGELOG.md** (for version sync): top of file

## Strategic lesson worth capturing post-Phase-0

If Phase 0 ships cleanly, capture as a memory: **"plugin.json + settings.fragment.json are TWO sources of truth that drift silently. A drift-guard test is non-optional."** This is the third time this kind of drift has bitten PRISM (per claude-master): v3.5.0 missed it, v4.0 missed it, v4.1 caught it only via post-ship review. The pattern needs structural mitigation, not just discipline.
