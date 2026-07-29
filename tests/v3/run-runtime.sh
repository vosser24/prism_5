#!/bin/bash
# PRISM runtime test harness
# Validates that hooks behave correctly on synthetic inputs.
# Exit 0 = all pass, 1 = any fail.
#
# Usage:  bash tests/v3/run-runtime.sh
#         PRISM_ROOT=/path/to/prism bash tests/v3/run-runtime.sh
#
# Requirements: bash, node (no jq, no external test framework)
# Cross-platform: Linux, macOS, Windows Git Bash

set -euo pipefail

PRISM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS="$PRISM_ROOT/hooks"
PASS=0
FAIL=0

color_green='\033[0;32m'
color_red='\033[0;31m'
color_reset='\033[0m'

# Unique run-stamp: prevents continuation-inherit false results across re-runs.
# Each invocation of this harness gets a new stamp so no test shares a session
# with a prior sentinel on disk.  We use $EPOCHSECONDS on bash ≥5; fall back
# to date +%s on bash 4 / macOS / Git Bash.
if [[ -n "${EPOCHSECONDS:-}" ]]; then
  _STAMP="$EPOCHSECONDS"
else
  _STAMP="$(date +%s 2>/dev/null || echo "0")"
fi

# ---------------------------------------------------------------------------
# run_test <name> <hook.mjs> <json-input> <grep-pattern>
#
# Executes the hook via `node`, piping JSON input on stdin.
# Both stdout and stderr are captured (hooks may print errors to stderr).
# Test passes when grep-pattern appears anywhere in the combined output.
# ---------------------------------------------------------------------------
run_test() {
  local name="$1"
  local hook="$2"
  local input="$3"
  local expect_pattern="$4"

  local actual
  actual=$(printf '%s' "$input" | node "$HOOKS/$hook" 2>&1 || true)

  if printf '%s' "$actual" | grep -q "$expect_pattern"; then
    printf "${color_green}PASS${color_reset}  %s\n" "$name"
    PASS=$((PASS + 1))
  else
    printf "${color_red}FAIL${color_reset}  %s\n" "$name"
    printf "  hook:     %s\n" "$hook"
    printf "  expected: pattern '%s' in output\n" "$expect_pattern"
    printf "  got:      %s\n" "$(printf '%s' "$actual" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# run_test_skip <name> <reason>
#
# Records a known-broken test without executing it.  The test is counted as
# a FAIL so CI stays red until the underlying issue is fixed.
# ---------------------------------------------------------------------------
run_test_skip() {
  local name="$1"
  local reason="$2"
  printf "${color_red}FAIL${color_reset}  %s\n" "$name"
  printf "  SKIP (known issue): %s\n" "$reason"
  FAIL=$((FAIL + 1))
}

printf "PRISM Runtime Test Harness\n"
printf "==========================\n"
printf "\n"

# ---------------------------------------------------------------------------
# T_runtime.1 — prism-prompt-tier-router → opus on an architectural prompt
#
# "design a panel of expert agents" hits PANEL_SIGNALS + OPUS_SIGNALS,
# producing tier=opus + summon_panel=true.  The additionalContext field of
# the JSON output contains "PRISM TIER ROUTER: opus".
#
# Session ID includes the run-stamp so a leftover sentinel from a prior run
# never triggers continuation-inherit for this session.
# ---------------------------------------------------------------------------
run_test \
  "T_runtime.1: tier router → opus on architectural prompt" \
  "prism-prompt-tier-router.mjs" \
  '{"prompt":"design a panel of expert agents to architect this migration","session_id":"rt-opus-'"${_STAMP}"'","cwd":"/tmp"}' \
  "opus"

# ---------------------------------------------------------------------------
# T_runtime.3 — prism-prompt-tier-router → haiku on a trivial prompt
#
# "what is 2+2" scores 0 on all signal sets → keyword-floor returns haiku.
#
# IMPORTANT: a unique session ID (never seen before this run) is mandatory.
# The continuation-inherit logic in v3.8.0 will re-use the previous turn's
# tier when: (a) a sentinel exists for the session, (b) the sentinel is
# opus/sonnet, (c) it is <5 min old, AND (d) the prompt is <8 words or an
# approval phrase.  "what is 2+2" (4 words) satisfies (c)+(d), so reusing a
# session that already has an opus sentinel would return opus instead of
# haiku.  The run-stamp suffix ensures a fresh sentinel is written (or none
# exists yet), producing a clean keyword-floor classification.
# ---------------------------------------------------------------------------
run_test \
  "T_runtime.3: tier router → haiku on trivial prompt" \
  "prism-prompt-tier-router.mjs" \
  '{"prompt":"what is 2+2","session_id":"rt-haiku-'"${_STAMP}"'","cwd":"/tmp"}' \
  "haiku"

printf "\n"
printf "==========================\n"
printf "Total: %d  Pass: %d  Fail: %d\n" "$((PASS + FAIL))" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
