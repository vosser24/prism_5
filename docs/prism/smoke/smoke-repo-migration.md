# Force-replace canonical repo's main with feature-branch history

**Status:** Locked
**Date:** 2026-05-26
**Captured by:** /prism-clean
**Related:** [[D006-prism-master-canonical]]

## When to use

You're migrating a working tree from one canonical GitHub repo to another (e.g., renaming the canonical home, or moving to a freshly-created repo). The destination's `main` is either:
- Empty / a single `Initial commit` placeholder, OR
- Otherwise considered disposable (you have explicit permission to overwrite).

This procedure replaces the destination's `main` with the local feature branch's entire history. **Do not use this when the destination's `main` has meaningful work others have committed** — you'd lose it.

## Prereqs

- Local clone of the source repo, with your feature branch checked out.
- Push access to the destination repo (HTTPS or SSH).
- `git` >= 2.30 (for `--force-with-lease`).
- Destination repo exists on GitHub.

## Procedure

### 1. Verify destination state before touching anything

```bash
# Confirm the destination repo is reachable
git ls-remote https://github.com/<owner>/<new-repo> HEAD

# What's on its main? If you see one commit and "Initial commit" prose,
# you're in the safe case. If you see meaningful history, STOP and reconsider.
git ls-remote --heads https://github.com/<owner>/<new-repo>
```

### 2. Repoint origin (or add as a second remote)

```bash
# Replace origin URL — simplest path; every existing command using
# 'origin' now points at the new repo.
git remote set-url origin https://github.com/<owner>/<new-repo>
git remote -v   # verify
```

If you want to keep the old remote accessible under a different name first:

```bash
git remote rename origin old-origin
git remote add origin https://github.com/<owner>/<new-repo>
```

### 3. Fetch + check divergence

```bash
git fetch origin --quiet
git log --oneline origin/main -3
git merge-base HEAD origin/main && echo "shared ancestor exists" || echo "no shared history"
```

If `merge-base` returns empty / non-zero, the histories are disjoint — confirming you're in the force-replace case.

### 4. Force-push HEAD to main

```bash
# --force-with-lease aborts if the remote changed since your last fetch.
# Safer than --force which clobbers unconditionally.
git push origin HEAD:main --force-with-lease
```

Expected output: `+ <old-sha>...<new-sha> HEAD -> main (forced update)`.

### 5. Push the feature branch too (audit trail)

```bash
git push -u origin <feature-branch-name>
```

This preserves the branch reference on the new remote even if `main` later moves forward.

### 6. Prune stale tracking refs

After changing the remote URL, your local `refs/remotes/origin/*` still references branches from the old repo. Prune them:

```bash
git remote prune origin
```

Output lists pruned refs. Verify the result with `git branch -vv`.

### 7. Create a local `main` if it doesn't exist

If you only had the feature branch locally, set up `main`:

```bash
git branch main origin/main
git branch -vv   # confirm tracking
```

### 8. Audit any install / clone references in the codebase

Search for the OLD repo URL across the working tree:

```bash
git grep -E '<old-owner>/<old-repo>|<stale-branch-name>'
```

Update active install surfaces (`plugin.json`, `README.md`, `INSTALL.md`, install scripts, `package.json` `repository` fields, etc.). Deliberately preserve historical artifacts (changelogs, dated test baselines, snapshots) — those are records of past state.

Commit the retarget as a single `chore(repo): retarget install URLs to <new-owner>/<new-repo>` commit and fast-forward `main` to include it so fresh clones get the corrected URLs.

## Pitfalls

| Pitfall | What goes wrong | Fix |
|---|---|---|
| `--force` instead of `--force-with-lease` | Overwrites concurrent pushes from collaborators with no warning. | Always use `--force-with-lease` unless you're certain you're the sole writer. |
| Forgetting to prune | Stale `refs/remotes/origin/*` make `git branch -a` and tab-completion misleading. | `git remote prune origin` after every URL change. |
| Leaving install scripts pointing at the old URL | Fresh clones via the install script silently land in the wrong repo. | The codebase audit (step 8) catches this; do not skip it. |
| Pushing only the branch, not main | Destination still shows the placeholder `Initial commit`; first-time visitors see an empty repo. | Step 4 (force-push HEAD to main) is mandatory, not optional. |
| Old repo has commits you pushed by accident before redirect | They sit as an orphan branch on the old repo. | Delete the orphan branch via `gh api -X DELETE repos/<old-owner>/<old-repo>/git/refs/heads/<branch>` (if `gh` is installed) or the GitHub web UI. |

## Verification (post-migration)

```bash
# 1. origin points at the new repo
git remote -v | grep -F '<new-owner>/<new-repo>'

# 2. main and the feature branch both land on the new remote
git ls-remote --heads origin

# 3. Local branches track the new origin
git branch -vv

# 4. No stale URL references in active install surfaces
git grep -E '<old-owner>/<old-repo>' -- ':!CHANGELOG.md' ':!docs/**/*-snapshot.json'
```

If all four checks pass, the migration is complete.
