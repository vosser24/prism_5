---
name: 2026-05-26-v4-line-landed-on-main
description: PR #1 merged — the entire v4 product line (v3.11.0 → v4.0.0 → v4.1.0 → v4.2.0 → v4.3.0, 38 feature commits + merge commit) is now on `main`. Phase C remains the next deferred work.
metadata:
  type: project
---

# 2026-05-26 — v4 product line landed on `main` (PR #1 merged)

**Status:** Locked
**Date:** 2026-05-26
**Captured by:** end-of-session, immediately post-merge
**Related:** [[2026-05-26-v4.3-phase-b-shipped]] [[feedback-handoff-backlog-reverify]] [[feedback-handoff-doc-convention]] [[project-v4-2-private-distribution]]

## One-sentence summary

Bundled v4 release line (5 release slices, 38 commits) landed on `main` as one merge commit; `main` now ships `4.3.0`; Phase C (clean-machine `/plugin install` smoke + multi-plugin interop) is the unchanged carry-over.

## New `main` state

- **Branch:** `main`
- **HEAD:** `384a3017` — `Merge pull request #1 from vosser24/claude/prism-v3-phase-1-0eVY1`
- **Pre-merge tip:** `9f7ec82c` (the v3.8.9 baseline `main` lived at before this session)
- **PR:** https://github.com/vosser24/prism_master/pull/1 — MERGED at `2026-05-26T13:01:51Z`
- **Merge strategy:** `--merge --delete-branch` (per-release commits preserved; remote feature branch deleted)
- **Local feature branch:** deleted (`claude/prism-v3-phase-1-0eVY1`)
- **Working tree:** clean (only untracked `.claude/`)
- **Plugin version:** `4.3.0` (matches CHANGELOG top)
- **Test baseline on merged `main`:** 233 / 233 across 14 files (9 hooks + 224 state)

## What landed (5 release slices in one PR)

| Version | Headline | Commits |
|---|---|---|
| 3.11.0 | Foundation hardening (`/prism-sync`, schema v2 prep) | included in 38 |
| 4.0.0 | Project-master surface (`master-<slug>` + skill migration + Phase J evidence rules) | " |
| 4.1.0 | Observability + hygiene (git-hygiene bundle, freshness sweep, telemetry opt-in) | " |
| 4.2.0 | Packaging + privacy hardening | " |
| 4.3.0 | Plugin-vs-manual provenance + `/prism-uninstall-cleanup` | " |

Bundled diff: 49 files changed, +7,564 / −94. 17 docs / 10 feat / 6 fix / 5 test.

## What got done this session

1. **State re-verification.** Per [[feedback-handoff-backlog-reverify]], re-ran every claim in the v4.3 Phase B handoff against current repo. Found that "PR still open" was stale — no PR existed at all in `vosser24/prism_master` at session start. The lesson held: handoff predictions decay.
2. **Stage 1 — ship-readiness sweep.** 233/233 tests green. No TODO/FIXME/XXX/HACK in release docs. CHANGELOG ↔ plugin.json sync verified. No WIP commits in range.
3. **gh CLI install workaround.** `winget install GitHub.cli` hit UAC (admin required). Workaround: fetched the official `gh_2.92.0_windows_amd64.zip` directly from the GitHub releases API, extracted to `C:\Users\ServosY\bin\bin\gh.exe`, added to User PATH (no admin scope). Authed via `gh auth login --web` (device-code flow). Works for all subsequent sessions.
4. **Stage 2 — PR check.** `gh pr list --head <branch>` → empty array, confirmed via repo-wide list. Re-scoped to "create PR now."
5. **Stage 2.5 — PR creation.** Drafted PR title + body to tempfile (`.pr-body.md`) per [[feedback-heredoc-backslash-mangling]]. Created PR #1 with `gh pr create --body-file`. State: OPEN, `MERGEABLE`, no required reviews, no status checks.
6. **Stage 3 — merge strategy.** User confirmed merge commit (preserves per-release commit trail anchored to CHANGELOG entries).
7. **Stage 4 — merge execution.** `gh pr merge 1 --merge --delete-branch` → merged at `384a3017`.
8. **Stage 5 — cleanup.** Local main fast-forwarded; tests re-verified green on merged main; feature branch deleted; this handoff written.

## Verification snapshot (re-runnable next session)

```bash
git log --oneline -1
# Expected: 384a3017 Merge pull request #1 from vosser24/claude/prism-v3-phase-1-0eVY1

node -e "console.log(require('./.claude-plugin/plugin.json').version)"
# Expected: 4.3.0

node tests/v3/hooks/test-agent-write-register.mjs | tail -1
for f in tests/v3/state/test-*.mjs; do node "$f" | tail -1; done
# Expected: every line "X passed, 0 failed"; 9 + 224 = 233 total
```

## What's deferred (Phase C — unchanged from v4.3 Phase B handoff)

Verbatim carry-over from `[[2026-05-26-v4.3-phase-b-shipped]]` §"What's deferred":

- Clean-machine `/plugin install` smoke test (rename `~/.claude/` → `.bak`, install from private repo, smoke v4.0 + v4.1 + v4.2 + v4.3 features) → record in `docs/prism/lessons/2026-05-26-outside-install-verify.md`
- Multi-plugin interop walkthrough (superpowers + firecrawl + PRISM); verify `/prism-index` discovers all + no hook-stacking timeout
- macOS test plan doc (defer execution to whoever has a Mac)
- Smoke that `/prism-uninstall-cleanup` works end-to-end from inside an actual plugin install (the unit tests pin behavior in a temp HOME; the real install path is unverified)

Phase C remains in scope under friends-only distribution per [[project-v4-2-private-distribution]].

## Strategic lessons captured this session

1. **Handoff `PR still open` claims must be re-verified — they are exactly the decaying-fact case `[[feedback-handoff-backlog-reverify]]` warns about.** This session, the v4.3 handoff said "PR still open"; the actual repo had no PR at all. The cost of re-verifying via `gh pr list` was one command; the cost of *not* re-verifying would have been planning a merge against a phantom PR. **Lesson:** every handoff claim about external-system state (PR open, branch deployed, ticket assigned, build green) is just frozen prose — verify before acting on it, even when the handoff sounds confident.

2. **`winget` is not always admin-free; portable-zip fallback works on Windows.** `GitHub.cli` via winget hit UAC. Direct download of the official release zip + extract to `%USERPROFILE%\bin` + add to User-scope PATH = no admin needed and persists across sessions. Worth capturing as a generic pattern, not just for gh. See [[feedback-winget-portable-fallback]] (memory worth writing for future Windows installs).

3. **Bundling 5 release slices into one PR was the right call here.** The argument for splitting (one PR per release) was real — easier review, easier rollback per slice. The argument that won was: each slice's CHANGELOG entry is already self-contained, the audit trail is *in the commits themselves*, and the per-slice handoff docs in `docs/prism/lessons/` already capture context. A merge commit preserves the per-release commits in history without forcing the human review path through 5 separate PR ceremonies. **When to do this:** single-owner repo, all slices already passed self-review at ship time, no per-slice CI surface to validate.

## Open questions for the new session

1. **Phase C scheduling:** does the user want to attempt the clean-machine smoke this session (now that the merge is done), or split it as a separate session?
2. **macOS execution:** the test plan doc is ship-it-anyway; the actual run still needs a Mac. Defer or skip?
3. **Branch hygiene:** Anthropic-managed `claude/*` branches accumulate. After this merge the remote `claude/prism-v3-phase-1-0eVY1` is deleted, but earlier `claude/*` branches may still exist. Worth a sweep?

## References

- PR: https://github.com/vosser24/prism_master/pull/1
- Merge commit: `384a3017`
- Prior handoff: `docs/prism/lessons/2026-05-26-v4.3-phase-b-shipped.md`
- Migration guide: `docs/prism/MIGRATION.md`
- CHANGELOG anchor: `CHANGELOG.md` §"[4.3.0]" (and the 4 prior release entries)
