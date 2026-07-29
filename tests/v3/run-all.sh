#!/usr/bin/env bash
# PRISM v3.0 master test-suite orchestrator.
#
# Runs the FULL .mjs test suite (every real test under tests/v3/, see Stage 1
# below), then prompts the user to run the Claude Code manual tests, then
# analyzes the routing log and produces a final report from
# tests/v3/report-template.md.
#
# (The legacy bash static runner tests/v3/run-static.sh was retired in v5.1
# along with the shell installer it exercised; the .mjs test suites are the
# trusted, cross-platform coverage.)
#
# Task #30 audit (2026-07-27) found this runner's Stage 1 glob had silently
# covered only tests/v3/state/test-*.mjs (100 of 105 files even in that one
# dir — acl-*.test.mjs and testbed-edge-cases.mjs don't match the `test-*`
# prefix) since it was written (git 07adadd2e, 2026-06-03), while hooks/,
# cli/, tools/, skills/, agents/ and 22 more top-level tests/v3/*.mjs
# accumulated and were never executed by this script. git history shows this
# was NOT a deliberate exclusion (hooks/ already had a test file the day this
# glob was written; the commit message never mentions hooks/) — it is scope
# drift. Stage 1 below now discovers tests via `git ls-files` (not a bare
# `find`) so the suite is reproducible BY CONSTRUCTION across checkouts: a
# `find`-based walk sees machine-local and gitignored files that a fresh
# clone does not, which is not a hypothetical — tests/v3/memory-field-normalize.test.mjs
# is explicitly gitignored (.gitignore:56, machine-local: its 4 CANDIDATE_DIRS
# are absolute paths hardcoded to one machine/OneDrive tenancy) and a `find`
# walk on THIS machine silently included it, inflating the count and running
# a file nobody else's checkout has. `git ls-files --cached --others
# --exclude-standard` structurally cannot include a gitignored path, so this
# class of drift is closed, not just this one instance. Falls back to `find`
# (old behavior) only if git is unavailable, and PRINTS which mode ran —
# never silently degrades. Excludes only files confirmed NOT to be tests (CLI
# report generators that require args, stub-factory helper modules) and
# tests/v3/bench/ (gitignored; benchmark-harness + fixture-export tree for an
# unrelated project, not PRISM regression tests). Full run takes ~6 minutes
# (235 files, sequential, as of 2026-07-29).
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

# ===== Stage 1: Full .mjs test suite =====
# Every real test under tests/v3/ (top level + state/, hooks/, cli/, tools/,
# skills/, agents/). Two exclusion categories, kept structurally distinct so
# neither is ever misread as "hiding a red":
#   NON_TEST_FILES  — real files, NOT tests: CLI report generators that
#     require args or exercise live system state (no pass/fail assertions of
#     their own), and stub-factory helper modules imported via
#     PRISM_ACL_FACTORY (not meant to run standalone — running them bare is a
#     silent no-op, not a test). These exist in every checkout; they're just
#     not tests.
#   LOCAL_ONLY / NOT_IN_REPO — real tests, but not part of the repo on a
#     fresh clone: currently tests/v3/memory-field-normalize.test.mjs, which
#     .gitignore:56 marks machine-local (its CANDIDATE_DIRS are absolute
#     paths hardcoded to one machine/OneDrive tenancy — on any other checkout
#     all dirs report not-mounted and it would trivially "pass" having
#     scanned nothing, a false green worse than a false red; it is a
#     deliberate opt-in diagnostic, never a portable regression test). In git
#     mode this file is structurally excluded by discovery itself (a
#     gitignored path cannot appear in `git ls-files`), not by this list —
#     the list only matters as a fallback when git is unavailable.
# tests/v3/bench/** (benchmark-harness + fixture-export tree for an unrelated
# project) is ALSO gitignored, so git-mode discovery excludes it the same
# structural way; no separate handling needed.
#
# Discovery is git-based, not a bare `find`, specifically because `find` sees
# machine-local/gitignored files a fresh clone does not (see header comment)
# — this makes the suite reproducible BY CONSTRUCTION. Falls back to `find`
# only if git is unavailable, and always prints which mode ran.
: > "$STATIC_LOG"
STATIC_EXIT=0

NON_TEST_FILES="
$REPO/tests/v3/analyze-audit.mjs
$REPO/tests/v3/analyze-log.mjs
$REPO/tests/v3/rerank-spike.mjs
$REPO/tests/v3/skill-listing-budget-audit.mjs
$REPO/tests/v3/cli/acl-stub-factory.mjs
$REPO/tests/v3/cli/acl-stub-upgrade-factory.mjs
$REPO/tests/v3/lib/make-fixture-home.mjs
"

# Fallback-only (find mode can't query gitignore state itself).
LOCAL_ONLY_FILES="
$REPO/tests/v3/memory-field-normalize.test.mjs
"

is_in_list() {
  local candidate="$1" list="$2" item
  for item in $list; do
    [ "$candidate" = "$item" ] && return 0
  done
  return 1
}

if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  DISCOVERY_MODE="git"
  echo "[1/3] Running full test suite — discovery: git ls-files (tracked + untracked-not-ignored; gitignored paths structurally excluded)"
  TEST_FILES=$(git -C "$REPO" ls-files --cached --others --exclude-standard -- "tests/v3/*.mjs" | sed "s|^|$REPO/|" | sort)
  IGNORED_LOCAL_TESTS=$(git -C "$REPO" ls-files --others --ignored --exclude-standard -- "tests/v3/*.mjs" | grep -v '^tests/v3/bench/' || true)
  if [ -n "$IGNORED_LOCAL_TESTS" ]; then
    echo "  (gitignored, excluded from discovery — real test(s), not part of this checkout: $IGNORED_LOCAL_TESTS)"
  fi
else
  DISCOVERY_MODE="find (git unavailable — reproducibility NOT guaranteed across machines)"
  echo "[1/3] Running full test suite — discovery: $DISCOVERY_MODE"
  TEST_FILES=$( { find "$REPO/tests/v3" -maxdepth 1 -name "*.mjs"; \
                   find "$REPO/tests/v3/state" "$REPO/tests/v3/hooks" "$REPO/tests/v3/cli" \
                        "$REPO/tests/v3/tools" "$REPO/tests/v3/skills" "$REPO/tests/v3/agents" \
                        -maxdepth 1 -name "*.mjs" 2>/dev/null; } | sort )
fi

DISCOVERED=0
RUN=0
EXCLUDED_NON_TEST=0
EXCLUDED_LOCAL_ONLY=0
for t in $TEST_FILES; do
  DISCOVERED=$((DISCOVERED+1))
  if is_in_list "$t" "$NON_TEST_FILES"; then
    EXCLUDED_NON_TEST=$((EXCLUDED_NON_TEST+1))
    continue
  fi
  if [ "$DISCOVERY_MODE" != "git" ] && is_in_list "$t" "$LOCAL_ONLY_FILES"; then
    EXCLUDED_LOCAL_ONLY=$((EXCLUDED_LOCAL_ONLY+1))
    continue
  fi
  RUN=$((RUN+1))
  if node "$t" >>"$STATIC_LOG" 2>&1; then
    echo "  ok  $(basename "$t")"
  else
    # Task #90: a file-level FAIL verdict was previously echoed ONLY to this
    # script's own stdout (never into $STATIC_LOG), and — separately — a test
    # process that dies before flushing its own output (killed by a signal,
    # crashes on require/module-resolution before its first console.log, etc.)
    # leaves $STATIC_LOG with no trace of the file at all even though its own
    # PASS/FAIL lines ARE captured via `>>"$STATIC_LOG" 2>&1` above when the
    # process gets far enough to print them. Either way, a reader who greps
    # only $STATIC_LOG (the documented habit) could see a clean log and miss
    # a real file-level failure recorded elsewhere. Write an unambiguous,
    # always-present banner with the exit code INTO the static log itself so
    # the log alone is enough to know this file failed and how.
    NODE_EXIT=$?
    echo "  FAIL $(basename "$t") (exit $NODE_EXIT)"
    { echo ""; echo "=== FILE-LEVEL FAIL: $(basename "$t") — node exit code $NODE_EXIT ==="; echo ""; } >>"$STATIC_LOG"
    STATIC_EXIT=1
  fi
done
echo ""
echo "Ran $RUN test files ($DISCOVERED discovered via $DISCOVERY_MODE, $EXCLUDED_NON_TEST excluded non-tests, $EXCLUDED_LOCAL_ONLY excluded local-only; tests/v3/bench/ excluded entirely)."
if [ "$STATIC_EXIT" -ne 0 ]; then
  echo ""
  echo "⚠ Test suite had failures. Review: $STATIC_LOG"
  echo "  Expected-red (do NOT fix): dispatch-preamble.test.mjs assertion 6e — LOCKED"
  echo "  per docs/prism/adjudications/D057-absence-claim-tripwire-and-chestertons-fence.md"
  echo "  §6. If tests/v3/state/test-prism-mutation-guard-teams-asymmetry.mjs is red, that"
  echo "  is also expected — task #38, unfixed D043 agent-teams gap, not this suite's bug."
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
