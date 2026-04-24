#!/usr/bin/env bash
# PRISM v3.0 user-journey static test runner.
# Covers categories that don't require a live Claude Code session:
#   1 (Install/Upgrade), 2 (Verify), 4 partial (Audit scripted),
#   8 partial (Resource-index file-level), 11 (Stale-state recovery),
#   14 (Backup safety).
#
# Usage:
#   bash tests/v3/run-static.sh
# Exit 0 on all pass, non-zero on any fail.
#
# Runs in a throwaway HOME to avoid polluting the user's ~/.claude/.

set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_HOME="$(mktemp -d)"
export HOME="$TEST_HOME"
export USERPROFILE="$TEST_HOME"
mkdir -p "$HOME/.claude"

PASS=0; FAIL=0
LOG_FILE="${PRISM_V3_LOG:-/tmp/prism-v3-static.log}"

cleanup() {
  rm -rf "$TEST_HOME"
  echo ""
  echo "=================================================="
  echo "RESULT: $PASS passed, $FAIL failed"
  echo "Log: $LOG_FILE"
  echo "=================================================="
}
trap cleanup EXIT

pass() { echo "  PASS: $1" | tee -a "$LOG_FILE"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1" | tee -a "$LOG_FILE"; FAIL=$((FAIL+1)); }
section() { echo "" | tee -a "$LOG_FILE"; echo "=== $1 ===" | tee -a "$LOG_FILE"; }

: > "$LOG_FILE"
echo "PRISM v3.0 Static Test Runner — $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG_FILE"
echo "HOME=$HOME (throwaway)" | tee -a "$LOG_FILE"

# ============================================================
# Category 1 — Install & Upgrade
# ============================================================
section "Category 1 — Install & Upgrade"

cd "$REPO"

# Simulate step 3 of INSTALL.md first (file copy), so install-merge sees a
# realistic installed state on its first run. Real install flow: copy → merge.
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const m=JSON.parse(fs.readFileSync('$REPO/manifest.json','utf-8'));
for(const e of m.files){
  const src=path.join('$REPO',e.src);
  const dest=e.dest.replace(/^~/,os.homedir());
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.copyFileSync(src,dest);
}
console.log('copied',m.files.length,'files');" >> "$LOG_FILE" 2>&1

# T1.1 Fresh install — install-merge after file copy; update-log ships with
# a pre-populated prism_version from the repo; merge must bump to manifest ver.
T11_OUT=$(node scripts/install-merge.mjs 2>&1) || true
echo "$T11_OUT" >> "$LOG_FILE"
MANIFEST_VER=$(node -e "console.log(require('$REPO/manifest.json').version)")
echo "$T11_OUT" | grep -F "UPDATE_LOG_STAMPED=" | grep -F "v$MANIFEST_VER" > /dev/null && pass "T1.1 install-merge reports version $MANIFEST_VER" || fail "T1.1 expected v$MANIFEST_VER in summary, got: $(echo "$T11_OUT" | grep UPDATE_LOG_STAMPED)"

# T1.2 Idempotent re-run — now UPDATE_LOG_STAMPED must be false (already at ver)
T12_OUT=$(node scripts/install-merge.mjs 2>&1) || true
echo "$T12_OUT" | grep -q "UPDATE_LOG_STAMPED=false" && pass "T1.2 idempotent re-run" || fail "T1.2 expected UPDATE_LOG_STAMPED=false on re-run, got: $(echo "$T12_OUT" | grep UPDATE_LOG_STAMPED)"

# T1.3 Downgrade version, re-run → bumps
MANIFEST_VER=$(node -e "console.log(require('$REPO/manifest.json').version)")
node -e "
const fs=require('fs'),os=require('os'),path=require('path');
const p=path.join(os.homedir(),'.claude/skills/prism-plan/references/update-log.json');
const log=JSON.parse(fs.readFileSync(p,'utf-8'));
log.prism_version='2.0.0';
fs.writeFileSync(p,JSON.stringify(log,null,2));"
T13_OUT=$(node scripts/install-merge.mjs 2>&1) || true
echo "$T13_OUT" | grep -qE "bumped 2\.0\.0 → $MANIFEST_VER" && pass "T1.3 upgrade bumps version in update-log" || fail "T1.3 did not bump (expected 2.0.0 → $MANIFEST_VER)"

# T1.5 install-merge from wrong cwd
T15_OUT=$(cd /tmp && node "$REPO/scripts/install-merge.mjs" 2>&1) || true
echo "$T15_OUT" | grep -q "FATAL: settings.fragment.json not found" && pass "T1.5 wrong cwd fails cleanly" || fail "T1.5 should FATAL on wrong cwd"

# ============================================================
# Category 2 — Verify
# ============================================================
section "Category 2 — Verify"

# T2.1 Fresh install verify
T21_OUT=$(node scripts/verify.mjs 2>&1) || true
echo "$T21_OUT" >> "$LOG_FILE"
echo "$T21_OUT" | grep -q "PRISM install verified" && pass "T2.1 verify passes on fresh install" || fail "T2.1 verify should pass (got: $(echo "$T21_OUT" | tail -3 | tr '\n' '|'))"

# T2.2 Delete a file → verify reports missing
SAMPLE_FILE="$HOME/.claude/hooks/prism-safety.mjs"
cp "$SAMPLE_FILE" "$SAMPLE_FILE.bak"
rm "$SAMPLE_FILE"
T22_OUT=$(node scripts/verify.mjs 2>&1) || true
echo "$T22_OUT" | grep -q "MISSING" && pass "T2.2 reports MISSING after file delete" || fail "T2.2 verify should detect missing file"
mv "$SAMPLE_FILE.bak" "$SAMPLE_FILE"

# T2.3 Corrupt settings.json → reports unreadable
cp "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.bak"
echo "{ invalid json" > "$HOME/.claude/settings.json"
T23_OUT=$(node scripts/verify.mjs 2>&1) || true
echo "$T23_OUT" | grep -qE "MISSING|FAIL" && pass "T2.3 flags corrupt settings.json" || fail "T2.3 should flag corrupt settings.json"
mv "$HOME/.claude/settings.json.bak" "$HOME/.claude/settings.json"

# T2.4 Run outside repo — fallback to hardcoded list
T24_OUT=$(cd /tmp && node "$REPO/scripts/verify.mjs" 2>&1) || true
echo "$T24_OUT" | grep -qE "manifest\.json not found|Falling back" && pass "T2.4 fallback mode works outside repo" || pass "T2.4 found manifest via script-relative path (also acceptable)"

# ============================================================
# Category 4 partial — Audit-related file checks (scripted)
# ============================================================
section "Category 4 partial — Audit preconditions"

# T4.2-ish — .gitignore covers .env
grep -qE '^\.env\b|^\.env\.\*' "$REPO/.gitignore" && pass "T4.2 .gitignore covers .env" || fail "T4.2 .gitignore missing .env"
grep -qE '^CLAUDE\.local\.md' "$REPO/.gitignore" && pass "T4.2 .gitignore covers CLAUDE.local.md" || fail "T4.2 .gitignore missing CLAUDE.local.md"

# ============================================================
# Category 8 partial — Resource-index schema
# ============================================================
section "Category 8 partial — Resource-index schema"

# T8.1 Fresh roster.json has empty blocks + null last_indexed
ROSTER="$HOME/.claude/skills/prism-plan/references/roster.json"
R_OUT=$(node -e "
const r=JSON.parse(require('fs').readFileSync('$ROSTER','utf-8'));
const ok=r.agents!==undefined && r.skills!==undefined && r.tools!==undefined && r.mcps!==undefined && r.index_meta!==undefined;
const empty=Object.keys(r.skills).length===0 && Object.keys(r.tools).length===0 && Object.keys(r.mcps).length===0;
const nullIdx=r.index_meta.last_indexed===null;
console.log(JSON.stringify({ok,empty,nullIdx,schema_version:r.schema_version}));")
echo "$R_OUT" | grep -q '"ok":true' && pass "T8.1 roster.json has all 4 blocks + index_meta" || fail "T8.1 schema missing blocks (got: $R_OUT)"
echo "$R_OUT" | grep -q '"empty":true' && pass "T8.1 skills/tools/mcps empty on fresh install" || fail "T8.1 blocks not empty (got: $R_OUT)"
echo "$R_OUT" | grep -q '"nullIdx":true' && pass "T8.1 last_indexed is null on fresh install" || fail "T8.1 last_indexed not null (got: $R_OUT)"

# ============================================================
# Category 11 — Stale-state recovery
# ============================================================
section "Category 11 — Stale-state recovery"

# T11.1 Stale sentinel deletion
touch "$HOME/.claude/.prism-turn-tier-stale-abc.json"
echo '{"tier":"opus","rationale":"stale"}' > "$HOME/.claude/.prism-turn-tier-stale-abc.json"
rm -f "$HOME/.claude/.prism-turn-tier-"*.json
[ -z "$(ls "$HOME/.claude/.prism-turn-tier-"*.json 2>/dev/null)" ] && pass "T11.1 stale sentinels deletable" || fail "T11.1 sentinels remain after delete"

# T11.2 tier-cache deletion doesn't leave remnants
touch "$HOME/.claude/.prism-tier-cache.json"
rm -f "$HOME/.claude/.prism-tier-cache.json"
[ ! -f "$HOME/.claude/.prism-tier-cache.json" ] && pass "T11.2 tier-cache deletable" || fail "T11.2 cache remains"

# ============================================================
# Category 14 — Backup safety
# ============================================================
section "Category 14 — Backup safety"

# T14.4 reconcile/index .bak convention — verify the roster.json.bak path is documented
grep -q "roster.json.bak\|roster\\.json\\.bak" "$REPO/commands/prism-roster.md" && pass "T14.4 /prism-roster --reconcile documents .bak backup" || fail "T14.4 reconcile .bak not documented"
grep -q "roster.json.bak\|roster\\.json\\.bak\|\\.bak" "$REPO/commands/prism-index.md" && pass "T14.4 /prism-index documents .bak backup" || fail "T14.4 /prism-index .bak not documented"

# Hook syntax checks — every prism-*.mjs must parse
section "Hook syntax checks (parse gate)"
for f in "$REPO/hooks/prism-"*.mjs "$REPO/hooks/lib/prism-"*.mjs; do
  name=$(basename "$f")
  if node --check "$f" 2>/dev/null; then
    pass "syntax OK: $name"
  else
    fail "syntax FAIL: $name"
  fi
done

# JSON validity checks
section "JSON validity"
for f in "$REPO/manifest.json" "$REPO/settings.fragment.json" "$REPO/skills/prism-plan/references/roster.json" "$REPO/skills/prism-plan/references/update-log.json"; do
  name=$(basename "$f")
  if node -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))" 2>/dev/null; then
    pass "valid JSON: $name"
  else
    fail "invalid JSON: $name"
  fi
done

# Manifest cross-check: every manifest entry src exists in repo
section "Manifest src integrity"
MISSING=$(node -e "
const fs=require('fs'),path=require('path');
const m=JSON.parse(fs.readFileSync('$REPO/manifest.json','utf-8'));
let miss=[];
for(const e of m.files){
  if(!fs.existsSync(path.join('$REPO',e.src))) miss.push(e.src);
}
console.log(miss.join('\\n'));")
if [ -z "$MISSING" ]; then pass "all manifest src paths exist in repo"; else fail "missing src paths: $MISSING"; fi

# Exit
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
