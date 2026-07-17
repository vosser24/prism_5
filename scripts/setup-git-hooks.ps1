# scripts/setup-git-hooks.ps1 — one-time activation of the tracked pre-commit
# gate at .githooks/pre-commit (the manifest-completeness guards).
#
# .git/hooks/ is never version-controlled, so a tracked hook script only
# fires once each clone points core.hooksPath at it. Idempotent; safe to
# re-run.

$ErrorActionPreference = 'Stop'

$repoRoot = (git -C (Join-Path $PSScriptRoot '..') rev-parse --show-toplevel).Trim()
Set-Location $repoRoot

git config core.hooksPath .githooks

Write-Host "[setup-git-hooks] core.hooksPath -> .githooks (pre-commit manifest guards active)"
