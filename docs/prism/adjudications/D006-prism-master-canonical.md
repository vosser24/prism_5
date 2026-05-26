# prism_master is the canonical PRISM home for v4.0+

**Status:** Locked
**Date:** 2026-05-26
**Captured by:** /prism-clean
**Related:** [[D004-v4-product-vision]]

## Decision

`https://github.com/vosser24/prism_master` is the canonical remote for the PRISM v4.0 line and forward. The previous repo `https://github.com/vosser24/PRISM` is deprecated — no new work lands there. All active install surfaces (plugin manifest, install scripts, README, INSTALL.md) point at `vosser24/prism_master`.

## Why

This session shipped Phase H end-to-end (knowledge-evolution rhythms) and the user directed the migration mid-session: *"what ever we do we are going to push https://github.com/vosser24/prism_master"*. Two concrete drivers:

1. **Name hygiene.** `prism_master` (snake_case, lowercase) follows the project's naming conventions; `PRISM` (uppercase) was a v3.x artifact that diverged from the broader v4.0 surface where everything else uses kebab/snake case.
2. **Clean break.** `prism_master/main` was a placeholder `Initial commit` (`f6c28fc`), so migrating meant force-replacing an empty main with the full v4.0 history — zero loss of meaningful work on the destination.

## What changed (this session)

1. **`git remote set-url origin https://github.com/vosser24/prism_master`** — repointed the local origin from `vosser24/PRISM`.
2. **Force-pushed local HEAD (107 commits = Phase A through Phase H) to `prism_master/main`** via `git push origin HEAD:main --force-with-lease`. The placeholder Initial commit on prism_master was overwritten.
3. **Pushed `claude/prism-v3-phase-1-0eVY1` feature branch to prism_master** for audit-trail preservation.
4. **Pruned 5 stale tracking refs** from the old remote via `git remote prune origin`.
5. **Created local `main` tracking `origin/main`** so the standard branch is locally reachable.
6. **Retargeted 7 active install surfaces** to `vosser24/prism_master` (commit `07b98fd`):
   - `.claude-plugin/plugin.json` (homepage + repository)
   - `INSTALL.md` (manual clone command)
   - `README.md` (clone + curl/iwr statusline + PR submission URL)
   - `scripts/install.{ps1,sh}` (REPO_URL / git clone target)
   - `scripts/install-statusline-only.{ps1,sh}` (REPO_RAW + stale branch ref → `main`)
7. **Fast-forwarded `prism_master/main`** to include the retargeting commit, so fresh clones from main get the corrected URLs.

## Deliberately left untouched (historical/audit records)

These 4 files still reference `vosser24/PRISM` or the stale branch `claude/audit-pending-pushes-Rg1p8` *as a record of past state*. Rewriting them would falsify history:

- `CHANGELOG.md:356` — release-note entry recording the install command at v3.x.
- `tests/v3/hook-baseline-2026-04-27.json` — empirical baseline snapshot from a dated test run.
- `docs/prism-feedback/phase0-roster-consumers.md` — historical doc from Phase 0.
- `tasks/todo.md` — v3.1 planning snapshot.

## Follow-ups

- **Orphan branch on `vosser24/PRISM`.** Earlier in this session, before the redirect, 62 commits were pushed to `vosser24/PRISM/claude/prism-v3-phase-1-0eVY1`. They sit there as an unreferenced branch. Cleanup requires `gh` CLI (not installed yet) or manual deletion via the GitHub web UI at `https://github.com/vosser24/PRISM/branches`. Tracked as a pending session item.
- **Old repo deprecation note.** The README on `vosser24/PRISM` doesn't yet announce the move. If users still find that repo via search, they'll get stale instructions. Decide whether to push a one-line "moved to vosser24/prism_master" notice or archive the GitHub repo entirely.
- **Tag the v4.0 cut.** No version tag has been pushed to `prism_master` yet. Once Phase J + K (release prep) land, cut `v4.0.0` on the appropriate commit.

## Scope of this decision

- **In scope.** Canonical home for PRISM v4.0+ source, install URLs, PR submission target, plugin marketplace reference.
- **Out of scope.** Whether to delete the old `vosser24/PRISM` repo entirely (still serves the v3.x install instructions referenced in CHANGELOG.md). Default position: leave it accessible read-only; revisit after a v4.0 GA tag.

## Verification

- `git remote -v` → `origin https://github.com/vosser24/prism_master`
- `git ls-remote --heads origin` → `main` + `claude/prism-v3-phase-1-0eVY1`, both at `07b98fd`
- `grep -r 'vosser24/PRISM' --include='*.{md,sh,ps1,json}'` → only the 4 historical artifacts above
