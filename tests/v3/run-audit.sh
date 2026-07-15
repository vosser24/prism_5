#!/usr/bin/env bash
# PRISM v3.6.0 audit-suite runner.
# Sets up throwaway HOME, runs synthetic audit, calls analyzer, reports.
#
# Usage:
#   bash tests/v3/run-audit.sh                       # run all scenarios
#   bash tests/v3/run-audit.sh --category classifier # filter by category
#   bash tests/v3/run-audit.sh --output /tmp/x.jsonl # custom output
#   bash tests/v3/run-audit.sh --keep-home           # don't cleanup HOME (debug)
#   bash tests/v3/run-audit.sh --help

set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date -u +%Y%m%d_%H%M%S)
OUTPUT="${PRISM_AUDIT_OUTPUT:-/tmp/prism-audit-run-$TS.jsonl}"
KEEP_HOME=0
CATEGORY=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --category)  shift; CATEGORY="$1" ;;
        --output)    shift; OUTPUT="$1" ;;
        --keep-home) KEEP_HOME=1 ;;
        --help)
            cat <<EOF
PRISM v3.6.0 audit-suite runner.

Usage:
  bash tests/v3/run-audit.sh [--category <name>] [--output <path>] [--keep-home]

Modes:
  (no flag)            Run all scenarios from tests/v3/audit-scenarios.json
  --category <name>    Filter scenarios by category
  --output <path>      Custom output JSONL path (default: /tmp/prism-audit-run-<ts>.jsonl)
  --keep-home          Preserve the throwaway HOME for debugging
  --help               This message

Pipeline:
  1. Create throwaway HOME (\$TMPDIR-rooted)
  2. node tools/prism-audit-runner.mjs --output <output> [--category <name>]
  3. node tests/v3/analyze-audit.mjs <output>  > <output>-report.md
  4. Cleanup HOME (unless --keep-home)
EOF
            exit 0 ;;
        *) echo "[run-audit] unknown arg: $1" >&2; exit 1 ;;
    esac
    shift
done

# Throwaway HOME for audit isolation — the runner pipes payloads to hook
# subprocesses that may write sentinels, counters, etc. Don't pollute real
# ~/.claude.
TEST_HOME=$(mktemp -d)
export HOME="$TEST_HOME"
export USERPROFILE="$TEST_HOME"
mkdir -p "$HOME/.claude/skills/prism-plan/references"

cleanup() {
    if [ "$KEEP_HOME" -eq 0 ]; then
        rm -rf "$TEST_HOME"
    else
        echo "[run-audit] kept HOME at $TEST_HOME"
    fi
}
trap cleanup EXIT

echo "[run-audit] PRISM v3.6.0 audit"
echo "[run-audit]   HOME=$TEST_HOME (throwaway)"
echo "[run-audit]   output=$OUTPUT"
[ -n "$CATEGORY" ] && echo "[run-audit]   category=$CATEGORY"

# Step 1 — synthetic audit run
ARGS="--output $OUTPUT"
[ -n "$CATEGORY" ] && ARGS="$ARGS --category $CATEGORY"

echo ""
echo "[run-audit] step 1: synthetic audit"
set +e
node "$REPO/tools/prism-audit-runner.mjs" $ARGS
RUNNER_EXIT=$?
set -e

# Step 2 — analyzer
REPORT="${OUTPUT%.jsonl}-report.md"
if [ -f "$REPO/tests/v3/analyze-audit.mjs" ] && [ -f "$OUTPUT" ]; then
    echo ""
    echo "[run-audit] step 2: analyzer"
    node "$REPO/tests/v3/analyze-audit.mjs" "$OUTPUT" > "$REPORT" || true
    echo "[run-audit]   report: $REPORT"
fi

# Final
echo ""
echo "[run-audit] DONE (runner exit=$RUNNER_EXIT)"
exit "$RUNNER_EXIT"
