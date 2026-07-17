#!/usr/bin/env bash
# scripts/setup-git-hooks.sh — one-time activation of the tracked pre-commit
# gate at .githooks/pre-commit (the manifest-completeness guards).
#
# .git/hooks/ is never version-controlled, so a tracked hook script only
# fires once each clone points core.hooksPath at it. Idempotent; safe to
# re-run.
set -e

REPO_ROOT=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
cd "$REPO_ROOT"

chmod +x .githooks/pre-commit 2>/dev/null || true
git config core.hooksPath .githooks

echo "[setup-git-hooks] core.hooksPath -> .githooks (pre-commit manifest guards active)"
