#!/usr/bin/env bash
# PRISM v3.0 master test-suite orchestrator.
#
# Runs the static suite, then prompts the user to run the Claude Code
# manual tests, then analyzes the routing log and produces a final report
# from tests/v3/report-template.md.
#
# Usage:
#   bash tests/v3/run-all.sh                # interactive
#   bash tests/v3/run-all.sh --static-only  # skip manual prompts
#   bash tests/v3/run-all.sh --ci           # static + analyzer (no interactive)

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TS=$(date -u +%Y%m%d_%H%M%S)
REPORT="$REPO/tests/v3/v3-report-$TS.md"
STATIC_LOG="/tmp/prism-v3-static-$TS.log"
ANALYZER_OUT="/tmp/prism-v3-analyzer-$TS.md"

MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --static-only) MODE="static-only" ;;
    --ci) MODE="ci" ;;
  esac
done

echo "=================================================="
echo "PRISM v3.0 Test Suite Runner"
echo "Mode: $MODE"
echo "Report will be written to: $REPORT"
echo "=================================================="
echo ""

# ===== Stage 1: Static suite =====
echo "[1/3] Running static suite (filesystem + script tests)..."
PRISM_V3_LOG="$STATIC_LOG" bash "$REPO/tests/v3/run-static.sh"
STATIC_EXIT=$?
if [ "$STATIC_EXIT" -ne 0 ]; then
  echo ""
  echo "⚠ Static suite had failures. Review: $STATIC_LOG"
fi

# ===== Stage 2: Manual (interactive only) =====
if [ "$MODE" = "interactive" ]; then
  echo ""
  echo "=================================================="
  echo "[2/3] Manual Claude Code prompts"
  echo "=================================================="
  echo ""
  echo "Open Claude Code in a fresh session and work through:"
  echo "  $REPO/tests/v3/run-claude.md"
  echo ""
  echo "Categories 5, 6, 7, 8, 9, 10, 12, 13, 15 (~45 min)."
  echo "Record observations in the report template as you go."
  echo ""
  read -p "Press Enter when you've completed the manual suite (or Ctrl+C to abort) ... "
fi

# ===== Stage 3: Analyzer =====
echo ""
echo "=================================================="
echo "[3/3] Analyzing routing log"
echo "=================================================="
ROUTING_LOG="$HOME/.claude/.prism-routing.jsonl"
if [ -f "$ROUTING_LOG" ]; then
  node "$REPO/tests/v3/analyze-log.mjs" "$ROUTING_LOG" > "$ANALYZER_OUT"
  echo "Analyzer output: $ANALYZER_OUT"
else
  echo "⚠ Routing log not found at $ROUTING_LOG — no PRISM activity logged."
  echo "(On Windows, path is %USERPROFILE%\\.claude\\.prism-routing.jsonl)"
fi

# ===== Stage 4: Build report =====
echo ""
echo "=================================================="
echo "Assembling final report"
echo "=================================================="
cp "$REPO/tests/v3/report-template.md" "$REPORT"

# Auto-fill sections we know about
{
  echo ""
  echo "---"
  echo ""
  echo "# Auto-captured appendix"
  echo ""
  echo "## Static suite log"
  echo ""
  echo '```'
  tail -10 "$STATIC_LOG" 2>/dev/null || echo "(log not found)"
  echo '```'
  echo ""
  if [ -f "$ANALYZER_OUT" ]; then
    echo "## Analyzer output"
    echo ""
    cat "$ANALYZER_OUT"
  fi
} >> "$REPORT"

echo ""
echo "=================================================="
echo "DONE"
echo "=================================================="
echo ""
echo "Report:           $REPORT"
echo "Static log:       $STATIC_LOG"
echo "Analyzer output:  $ANALYZER_OUT"
echo ""
echo "Fill in the manual-test tables in the report, then share it for review."
echo ""

exit $STATIC_EXIT
