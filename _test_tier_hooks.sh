#!/usr/bin/env bash
# Test harness for tier-routing hooks. Runs 9 cases via piped stdin.
# Writes sentinels to ~/.claude/.prism-turn-tier-test*.json -- cleans up at end.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
ROUTER="$REPO/hooks/prism-prompt-tier-router.mjs"
GUARD="$REPO/hooks/prism-parent-dispatch-guard.mjs"
PASS=0; FAIL=0
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }

echo "=== Test 1: simple grep prompt haiku ==="
out=$(echo '{"session_id":"test1","prompt":"find where i have the word test in this document"}' | node "$ROUTER")
tier=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test1.json')).tier)")
[ "$tier" = "haiku" ] && pass "sentinel.tier=haiku" || fail "sentinel.tier=$tier"
# v2.2.0 output format: "PRISM TIER ROUTER: haiku. {rationale}" (no hyphenated "haiku-tier" token).
echo "$out" | grep -q "haiku" && pass "advice mentions haiku" || fail "advice missing haiku tier"

echo "=== Test 2: Grep in parent with test1 session DENY ==="
out=$(echo '{"session_id":"test1","tool_name":"Grep","tool_input":{"pattern":"test"}}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:2" && pass "exit 2" || fail "expected exit 2, got: $out"
echo "$out" | grep -q "DISPATCH-GUARD" && pass "deny JSON has DISPATCH-GUARD" || fail "no DISPATCH-GUARD message"

echo "=== Test 3: Agent dispatch with test1 ALLOW + mark dispatched ==="
out=$(echo '{"session_id":"test1","tool_name":"Agent","tool_input":{"model":"haiku"}}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:0" && pass "exit 0" || fail "expected exit 0, got: $out"
dispatched=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test1.json')).dispatched)")
[ "$dispatched" = "true" ] && pass "sentinel.dispatched=true" || fail "dispatched=$dispatched"

echo "=== Test 4: Grep in parent after dispatch ALLOW ==="
out=$(echo '{"session_id":"test1","tool_name":"Grep","tool_input":{"pattern":"test"}}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:0" && pass "exit 0 (post-dispatch)" || fail "expected exit 0, got: $out"

echo "=== Test 5: create-skill prompt sonnet-tier ==="
echo '{"session_id":"test2","prompt":"find and create a skill about pasta cooker"}' | node "$ROUTER" > /dev/null
tier=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test2.json')).tier)")
score=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test2.json')).score)")
[ "$tier" = "sonnet" ] && pass "sentinel.tier=sonnet (score=$score)" || fail "sentinel.tier=$tier score=$score"

echo "=== Test 6: Write in parent with test2 DENY ==="
out=$(echo '{"session_id":"test2","tool_name":"Write","tool_input":{"file_path":"/tmp/x"}}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:2" && pass "exit 2" || fail "expected exit 2, got: $out"

echo "=== Test 7: opus-force prompt opus-tier ==="
echo '{"session_id":"test3","prompt":"!opus-force: refactor the backend"}' | node "$ROUTER" > /dev/null
tier=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test3.json')).tier)")
force=$(node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/.prism-turn-tier-test3.json')).force_opus)")
[ "$tier" = "opus" ] && [ "$force" = "true" ] && pass "tier=opus force_opus=true" || fail "tier=$tier force=$force"

echo "=== Test 8: Write in parent with test3 (opus) ALLOW ==="
out=$(echo '{"session_id":"test3","tool_name":"Write","tool_input":{"file_path":"/tmp/x"}}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:0" && pass "exit 0 (opus allowed)" || fail "expected exit 0, got: $out"

echo "=== Test 9: Write in subagent context (parent_tool_use_id set) ALLOW ==="
out=$(echo '{"session_id":"test1","tool_name":"Write","tool_input":{"file_path":"/tmp/x"},"parent_tool_use_id":"sub-123"}' | node "$GUARD"; echo "EXIT:$?")
echo "$out" | grep -q "EXIT:0" && pass "exit 0 (subagent bypass)" || fail "expected exit 0, got: $out"

SENTINEL_DIR=$(node -e "console.log(require('os').homedir()+'/.claude')")
node -e "
const fs=require('fs');
const d=require('os').homedir()+'/.claude';
['test1','test2','test3'].forEach(id=>{
  const p=d+'/.prism-turn-tier-'+id+'.json';
  try{fs.unlinkSync(p);}catch{}
});
console.log('Sentinels cleaned up');
"

echo
echo "===== RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" = "0" ] && exit 0 || exit 1
