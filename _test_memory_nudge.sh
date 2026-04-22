#!/usr/bin/env bash
# Test harness for prism-memory-save-nudge.mjs.
# Simulates 30 UserPromptSubmit events for a single session and verifies
# that the nudge fires exactly at turns 15, 20, 25, 30.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
HOOK="$REPO/hooks/prism-memory-save-nudge.mjs"
SID="nudge-test-$$"
PASS=0; FAIL=0
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }

# Fresh counter
[ -f ~/.claude/.prism-memory-save-counter-$SID.json ] && unlink ~/.claude/.prism-memory-save-counter-$SID.json

for turn in $(seq 1 30); do
  out=$(echo "{\"session_id\":\"$SID\",\"prompt\":\"turn $turn\"}" | node "$HOOK")
  has_directive=$(echo "$out" | grep -c "MEMORY-SAVE NUDGE" || true)
  if [ "$turn" = "15" ] || [ "$turn" = "20" ] || [ "$turn" = "25" ] || [ "$turn" = "30" ]; then
    if [ "$has_directive" -ge 1 ]; then pass "turn $turn nudge fired"; else fail "turn $turn nudge MISSING (out='$out')"; fi
  else
    if [ "$has_directive" = "0" ]; then pass "turn $turn silent"; else fail "turn $turn nudge fired unexpectedly"; fi
  fi
done

# Verify counter state
final_turn=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-memory-save-counter-$SID.json')).turn_count)")
[ "$final_turn" = "30" ] && pass "counter at 30" || fail "counter=$final_turn"

last_nudge=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-memory-save-counter-$SID.json')).last_nudge_turn)")
[ "$last_nudge" = "30" ] && pass "last_nudge=30" || fail "last_nudge=$last_nudge"

# PRISM_MEMORY_NUDGE=off test
off_out=$(PRISM_MEMORY_NUDGE=off bash -c "echo '{\"session_id\":\"off-test\",\"prompt\":\"x\"}' | node $HOOK")
[ -z "$off_out" ] && pass "off mode silent" || fail "off mode emitted: $off_out"

# Custom thresholds test (first=3, interval=2 -> nudges at 3,5,7)
for turn in 1 2 3 4 5 6 7; do
  out=$(PRISM_MEMORY_NUDGE_FIRST=3 PRISM_MEMORY_NUDGE_INTERVAL=2 bash -c "echo '{\"session_id\":\"custom-test\",\"prompt\":\"t\"}' | node $HOOK")
  has=$(echo "$out" | grep -c "MEMORY-SAVE NUDGE" || true)
  if [ "$turn" = "3" ] || [ "$turn" = "5" ] || [ "$turn" = "7" ]; then
    [ "$has" -ge 1 ] && pass "custom turn $turn fired" || fail "custom turn $turn missing"
  else
    [ "$has" = "0" ] && pass "custom turn $turn silent" || fail "custom turn $turn unexpected"
  fi
done

# Cleanup counter files
for f in ~/.claude/.prism-memory-save-counter-$SID.json ~/.claude/.prism-memory-save-counter-off-test.json ~/.claude/.prism-memory-save-counter-custom-test.json; do
  [ -f "$f" ] && unlink "$f"
done

echo
echo "===== RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" = "0" ] && exit 0 || exit 1
