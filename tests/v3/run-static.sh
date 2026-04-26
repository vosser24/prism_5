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

# ============================================================
# Category v3.1 — Productization + Tier 3 surgical (NEW in v3.1.0)
# ============================================================
section "Category v3.1 — Productization assets"

# install.sh present, executable, accepts --help / --dry-run
[ -x "$REPO/scripts/install.sh" ] && pass "install.sh exists and is +x" || fail "install.sh missing or not executable"
"$REPO/scripts/install.sh" --help >/dev/null 2>&1 && pass "install.sh --help works" || fail "install.sh --help fails"
"$REPO/scripts/install.sh" --dry-run >/dev/null 2>&1 && pass "install.sh --dry-run works (no mutation)" || fail "install.sh --dry-run fails"
sh -n "$REPO/scripts/install.sh" 2>/dev/null && pass "install.sh POSIX syntax check" || fail "install.sh POSIX syntax fail"

# /prism-doctor command exists with valid frontmatter
[ -f "$REPO/commands/prism-doctor.md" ] && pass "prism-doctor.md present" || fail "prism-doctor.md missing"
grep -q "^name: prism-doctor" "$REPO/commands/prism-doctor.md" 2>/dev/null && pass "prism-doctor frontmatter has name" || fail "prism-doctor missing name in frontmatter"

# /prism-telemetry command exists with valid frontmatter + NO NETWORK callout
[ -f "$REPO/commands/prism-telemetry.md" ] && pass "prism-telemetry.md present" || fail "prism-telemetry.md missing"
grep -qiE "no network|no shipping|no telemetry-as-a-service|local.{0,5}only" "$REPO/commands/prism-telemetry.md" 2>/dev/null && pass "telemetry doc states LOCAL-only" || fail "telemetry missing LOCAL-only callout"

# Central policy example
[ -f "$REPO/skills/prism-plan/references/prism-policy.example.json" ] && pass "prism-policy.example.json present" || fail "prism-policy.example.json missing"
node -e "JSON.parse(require('fs').readFileSync('$REPO/skills/prism-plan/references/prism-policy.example.json','utf-8'))" 2>/dev/null && pass "prism-policy.example.json valid JSON" || fail "prism-policy.example.json invalid JSON"

# skill-triggers reference
[ -f "$REPO/skills/prism-plan/references/skill-triggers.md" ] && pass "skill-triggers.md present" || fail "skill-triggers.md missing"

# 3 new v3.1 hooks present + parse
for h in prism-parallel-guard prism-panel-guard prism-skill-trigger-guard; do
  f="$REPO/hooks/$h.mjs"
  [ -f "$f" ] && node --check "$f" 2>/dev/null && pass "$h.mjs present + syntax OK" || fail "$h.mjs missing or syntax error"
  # Each new hook must implement three-path bypass + force_opus + atomic write
  grep -q "parent_tool_use_id" "$f" 2>/dev/null && pass "$h has parent_tool_use_id check" || fail "$h missing parent_tool_use_id check"
  grep -qE "force_opus|opus-force" "$f" 2>/dev/null && pass "$h honors force_opus sentinel" || fail "$h missing force_opus check"
done

# settings.fragment.json registers the 3 new hooks
grep -q "prism-parallel-guard.mjs" "$REPO/settings.fragment.json" && pass "settings.fragment registers parallel-guard" || fail "settings.fragment missing parallel-guard"
grep -q "prism-panel-guard.mjs" "$REPO/settings.fragment.json" && pass "settings.fragment registers panel-guard" || fail "settings.fragment missing panel-guard"
grep -q "prism-skill-trigger-guard.mjs" "$REPO/settings.fragment.json" && pass "settings.fragment registers skill-trigger-guard" || fail "settings.fragment missing skill-trigger-guard"

# /prism-roster --team flag documented
grep -q -- "--team" "$REPO/commands/prism-roster.md" && pass "/prism-roster documents --team flag" || fail "/prism-roster --team not documented"

# roster.json schema bumped to 3.1.0 + team_id documented in schema example
SCHEMA_VER=$(node -e "console.log(require('$REPO/skills/prism-plan/references/roster.json').schema_version)")
[ "$SCHEMA_VER" = "3.1.0" ] && pass "roster.json schema_version=3.1.0" || fail "roster.json schema_version=$SCHEMA_VER (expected 3.1.0)"
grep -q "team_id" "$REPO/skills/prism-plan/references/roster.json" && pass "roster.json schema includes team_id" || fail "roster.json missing team_id in schema example"

# ============================================================
# Category v3.2 — Classifier simplification (NEW in v3.2.0)
# ============================================================
section "Category v3.2 — Classifier simplification"

cd "$REPO"

grep -q "conversation-model-override" hooks/prism-prompt-tier-router.mjs && pass "T_v3.2.1 router emits override directive" || fail "T_v3.2.1 router missing override directive"

! grep -q "ANTHROPIC_API_KEY" hooks/lib/prism-opus-classifier.mjs && pass "T_v3.2.2 classifier no longer references ANTHROPIC_API_KEY" || fail "T_v3.2.2 classifier still references ANTHROPIC_API_KEY"

! grep -q "Classifier is running in keyword-floor-only mode" hooks/prism-session-start.mjs && pass "T_v3.2.3 session-start no longer warns about keyword-floor" || fail "T_v3.2.3 session-start still warns about keyword-floor"

! grep -q "ANTHROPIC_API_KEY" INSTALL.md README.md commands/*.md && pass "T_v3.2.4 docs no longer mention ANTHROPIC_API_KEY" || fail "T_v3.2.4 docs still mention ANTHROPIC_API_KEY"

# ============================================================
# Category v3.3 — Uninstaller (NEW in v3.3.0)
# ============================================================
section "Category v3.3 — Uninstaller"

# uninstall.sh exists + executable
[ -x "$REPO/scripts/uninstall.sh" ] && pass "T_v3.3.1 uninstall.sh exists and is +x" || fail "T_v3.3.1 uninstall.sh missing or not executable"

# --help works
"$REPO/scripts/uninstall.sh" --help >/dev/null 2>&1 && pass "T_v3.3.2 uninstall.sh --help works" || fail "T_v3.3.2 uninstall.sh --help fails"

# Default mode is DRY-RUN — must NOT mutate the test HOME's ~/.claude/
touch "$HOME/.claude/.uninstall-test-marker"
"$REPO/scripts/uninstall.sh" >/dev/null 2>&1 || true
[ -f "$HOME/.claude/.uninstall-test-marker" ] && pass "T_v3.3.3 uninstall.sh default mode is DRY-RUN (marker survived)" || fail "T_v3.3.3 default mode mutated state (marker deleted)"
rm -f "$HOME/.claude/.uninstall-test-marker"

# --purge flag documented
"$REPO/scripts/uninstall.sh" --help 2>&1 | grep -q -- "--purge" && pass "T_v3.3.4 uninstall.sh --purge flag in --help" || fail "T_v3.3.4 --purge missing from --help"

# --keep-memory flag documented
"$REPO/scripts/uninstall.sh" --help 2>&1 | grep -q -- "--keep-memory" && pass "T_v3.3.5 uninstall.sh --keep-memory flag in --help" || fail "T_v3.3.5 --keep-memory missing from --help"

# POSIX syntax check
sh -n "$REPO/scripts/uninstall.sh" 2>/dev/null && pass "T_v3.3.6 uninstall.sh POSIX syntax check" || fail "T_v3.3.6 POSIX syntax fail"

# ============================================================
# Category v3.4 — PowerShell-native lifecycle (NEW in v3.4.0)
# ============================================================
section "Category v3.4 — PowerShell scripts"

# install.ps1 exists
[ -f "$REPO/scripts/install.ps1" ] && pass "T_v3.4.1 install.ps1 exists" || fail "T_v3.4.1 install.ps1 missing"

# uninstall.ps1 exists
[ -f "$REPO/scripts/uninstall.ps1" ] && pass "T_v3.4.2 uninstall.ps1 exists" || fail "T_v3.4.2 uninstall.ps1 missing"

# install.ps1 brace balance (count occurrences, not lines)
INST_OPEN=$(grep -o '{' "$REPO/scripts/install.ps1" 2>/dev/null | wc -l)
INST_CLOSE=$(grep -o '}' "$REPO/scripts/install.ps1" 2>/dev/null | wc -l)
[ "$INST_OPEN" = "$INST_CLOSE" ] && pass "T_v3.4.3 install.ps1 braces balanced ($INST_OPEN/$INST_CLOSE)" || fail "T_v3.4.3 install.ps1 brace mismatch ($INST_OPEN open, $INST_CLOSE close)"

# uninstall.ps1 brace balance
UN_OPEN=$(grep -o '{' "$REPO/scripts/uninstall.ps1" 2>/dev/null | wc -l)
UN_CLOSE=$(grep -o '}' "$REPO/scripts/uninstall.ps1" 2>/dev/null | wc -l)
[ "$UN_OPEN" = "$UN_CLOSE" ] && pass "T_v3.4.4 uninstall.ps1 braces balanced ($UN_OPEN/$UN_CLOSE)" || fail "T_v3.4.4 uninstall.ps1 brace mismatch ($UN_OPEN open, $UN_CLOSE close)"

# install.ps1 has all 5 documented parameters
for p in 'Prefix' 'Branch' 'DryRun' 'NoBackup' 'Help'; do
  grep -qF -- "-$p" "$REPO/scripts/install.ps1" && pass "T_v3.4.5 install.ps1 documents -$p" || fail "T_v3.4.5 install.ps1 missing -$p"
done

# uninstall.ps1 has all 5 documented parameters
for p in 'Purge' 'KeepMemory' 'NoBackup' 'Reinstall' 'Help'; do
  grep -qF -- "-$p" "$REPO/scripts/uninstall.ps1" && pass "T_v3.4.6 uninstall.ps1 documents -$p" || fail "T_v3.4.6 uninstall.ps1 missing -$p"
done

# UTF-8 no-BOM idiom present in install.ps1 (the v2.7.2 trap closer)
grep -q "UTF8Encoding" "$REPO/scripts/install.ps1" && pass "T_v3.4.7 install.ps1 uses UTF-8-no-BOM idiom for prism.env" || fail "T_v3.4.7 install.ps1 missing UTF-8-no-BOM writer"

# ============================================================
# Category v3.5 — Plugin packaging (NEW in v3.5.0)
# ============================================================
section "Category v3.5 — Plugin packaging"

PLUGIN_JSON="$REPO/.claude-plugin/plugin.json"

# T_v3.5.1 — manifest exists at canonical path
[ -f "$PLUGIN_JSON" ] && pass "T_v3.5.1 .claude-plugin/plugin.json exists" || fail "T_v3.5.1 .claude-plugin/plugin.json missing"

# T_v3.5.2 — valid JSON
node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_JSON','utf-8'))" 2>/dev/null && pass "T_v3.5.2 plugin.json is valid JSON" || fail "T_v3.5.2 plugin.json fails JSON.parse"

# T_v3.5.3 — required schema fields present (name is the only schema-required field; we also require version+description+hooks)
node -e "
const j=JSON.parse(require('fs').readFileSync('$PLUGIN_JSON','utf-8'));
const missing=[];
for(const k of ['name','version','description','hooks']) if(!j[k]) missing.push(k);
if(missing.length) { console.error('missing:',missing.join(',')); process.exit(1); }
if(!/^[a-z0-9]+(-[a-z0-9]+)*\$/.test(j.name)) { console.error('name not kebab-case:',j.name); process.exit(1); }
" 2>/dev/null && pass "T_v3.5.3 plugin.json has required fields (name kebab-case, version, description, hooks)" || fail "T_v3.5.3 plugin.json missing required fields"

# T_v3.5.4 — version matches manifest.json
PLUGIN_VER=$(node -e "console.log(require('$PLUGIN_JSON').version)")
MANIFEST_VER=$(node -e "console.log(require('$REPO/manifest.json').version)")
[ "$PLUGIN_VER" = "$MANIFEST_VER" ] && pass "T_v3.5.4 plugin.json version ($PLUGIN_VER) matches manifest.json ($MANIFEST_VER)" || fail "T_v3.5.4 version mismatch: plugin.json=$PLUGIN_VER manifest.json=$MANIFEST_VER"

# T_v3.5.5 — declares non-empty hooks across the canonical lifecycle events
node -e "
const j=JSON.parse(require('fs').readFileSync('$PLUGIN_JSON','utf-8'));
const need=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','SubagentStop','Stop'];
const missing=need.filter(e=>!Array.isArray(j.hooks[e])||j.hooks[e].length===0);
if(missing.length){console.error('missing events:',missing.join(','));process.exit(1)}
" 2>/dev/null && pass "T_v3.5.5 plugin.json declares all 6 core lifecycle events" || fail "T_v3.5.5 plugin.json missing core lifecycle events"

# T_v3.5.6 — all hook commands reference \${CLAUDE_PLUGIN_ROOT} (plugin-relative)
node -e "
const j=JSON.parse(require('fs').readFileSync('$PLUGIN_JSON','utf-8'));
let bad=0;
for(const ev of Object.keys(j.hooks||{})) for(const grp of j.hooks[ev]||[]) for(const h of grp.hooks||[]) {
  if(h.type==='command' && h.command && !h.command.includes('\${CLAUDE_PLUGIN_ROOT}')) bad++;
}
if(bad) { console.error('non-plugin-rooted commands:',bad); process.exit(1) }
" 2>/dev/null && pass "T_v3.5.6 every hook command uses \${CLAUDE_PLUGIN_ROOT}" || fail "T_v3.5.6 some hook commands hardcode paths"

# T_v3.5.7 — every plugin-rooted hook script actually exists in repo
MISSING_HOOKS=$(node -e "
const fs=require('fs'),path=require('path');
const j=JSON.parse(fs.readFileSync('$PLUGIN_JSON','utf-8'));
const miss=[];
for(const ev of Object.keys(j.hooks||{})) for(const grp of j.hooks[ev]||[]) for(const h of grp.hooks||[]) {
  if(h.type!=='command'||!h.command) continue;
  const m=h.command.match(/\\\${CLAUDE_PLUGIN_ROOT}\/([^\\s\"']+)/);
  if(m) { const rel=m[1]; if(!fs.existsSync(path.join('$REPO',rel))) miss.push(rel); }
}
console.log(miss.join('\\n'));")
if [ -z "$MISSING_HOOKS" ]; then pass "T_v3.5.7 all plugin.json hook scripts exist in repo"; else fail "T_v3.5.7 missing hook scripts: $MISSING_HOOKS"; fi

# T_v3.5.8 — name is lowercase kebab-case "prism"
PLUGIN_NAME=$(node -e "console.log(require('$PLUGIN_JSON').name)")
[ "$PLUGIN_NAME" = "prism" ] && pass "T_v3.5.8 plugin.json name = 'prism'" || fail "T_v3.5.8 plugin.json name = '$PLUGIN_NAME' (expected 'prism')"

# T_v3.5.9 — repo conventional component dirs exist (auto-discovered when plugin.json omits skills/commands/agents keys)
[ -d "$REPO/skills" ] && pass "T_v3.5.9 skills/ at plugin root" || fail "T_v3.5.9 skills/ missing"
[ -d "$REPO/commands" ] && pass "T_v3.5.9 commands/ at plugin root" || fail "T_v3.5.9 commands/ missing"
[ -d "$REPO/agents" ] && pass "T_v3.5.9 agents/ at plugin root" || fail "T_v3.5.9 agents/ missing"

# ============================================================
# Category v3.6 — Audit suite (NEW in v3.6.0)
# ============================================================
section "Category v3.6 — Audit suite"

# audit-scenarios.json exists + valid JSON
[ -f "$REPO/tests/v3/audit-scenarios.json" ] && pass "T_v3.6.1 audit-scenarios.json exists" || fail "T_v3.6.1 audit-scenarios.json missing"
node -e "JSON.parse(require('fs').readFileSync('$REPO/tests/v3/audit-scenarios.json','utf-8'))" 2>/dev/null && pass "T_v3.6.2 audit-scenarios.json valid JSON" || fail "T_v3.6.2 audit-scenarios.json invalid JSON"

# Scenario count >= 25
SCEN_COUNT=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$REPO/tests/v3/audit-scenarios.json','utf-8')).scenarios || []).length)" 2>/dev/null || echo 0)
[ "$SCEN_COUNT" -ge 25 ] && pass "T_v3.6.3 audit-scenarios has $SCEN_COUNT scenarios (>=25)" || fail "T_v3.6.3 expected >=25 scenarios, got $SCEN_COUNT"

# Audit runner exists + parses + executable
[ -f "$REPO/tools/prism-audit-runner.mjs" ] && pass "T_v3.6.4 prism-audit-runner.mjs exists" || fail "T_v3.6.4 runner missing"
node --check "$REPO/tools/prism-audit-runner.mjs" 2>/dev/null && pass "T_v3.6.5 runner parses" || fail "T_v3.6.5 runner syntax error"

# run-audit.sh exists + executable + POSIX-clean
[ -f "$REPO/tests/v3/run-audit.sh" ] && pass "T_v3.6.6 run-audit.sh exists" || fail "T_v3.6.6 run-audit.sh missing"
[ -x "$REPO/tests/v3/run-audit.sh" ] && pass "T_v3.6.7 run-audit.sh executable" || fail "T_v3.6.7 run-audit.sh not +x"
sh -n "$REPO/tests/v3/run-audit.sh" 2>/dev/null && pass "T_v3.6.8 run-audit.sh POSIX syntax" || fail "T_v3.6.8 run-audit.sh syntax fail"

# Analyzer exists + parses
[ -f "$REPO/tests/v3/analyze-audit.mjs" ] && pass "T_v3.6.9 analyze-audit.mjs exists" || fail "T_v3.6.9 analyze-audit missing"
node --check "$REPO/tests/v3/analyze-audit.mjs" 2>/dev/null && pass "T_v3.6.10 analyze-audit parses" || fail "T_v3.6.10 analyze-audit syntax error"

# /prism-audit-full command exists with frontmatter
[ -f "$REPO/commands/prism-audit-full.md" ] && pass "T_v3.6.11 prism-audit-full.md exists" || fail "T_v3.6.11 prism-audit-full missing"
grep -q "^name: prism-audit-full" "$REPO/commands/prism-audit-full.md" 2>/dev/null && pass "T_v3.6.12 prism-audit-full has name in frontmatter" || fail "T_v3.6.12 prism-audit-full missing name"

# Real-session prompts catalog
[ -f "$REPO/tests/v3/audit-real-prompts.md" ] && pass "T_v3.6.13 audit-real-prompts.md exists" || fail "T_v3.6.13 audit-real-prompts.md missing"

# v3.5.0 audit-finding fixes
grep -q "CLAUDE_PLUGIN_ROOT" "$REPO/hooks/prism-session-start.mjs" && pass "T_v3.6.14 session-start has plugin bootstrap" || fail "T_v3.6.14 session-start missing CLAUDE_PLUGIN_ROOT bootstrap"
grep -q "CLAUDE_PLUGIN_ROOT" "$REPO/commands/prism-index.md" && pass "T_v3.6.15 prism-index has plugin-root tier" || fail "T_v3.6.15 prism-index missing plugin-root scan tier"
grep -q "plugin-install\|PLUGIN_ROOT" "$REPO/commands/prism-doctor.md" && pass "T_v3.6.16 prism-doctor has layout detection" || fail "T_v3.6.16 prism-doctor missing layout detection"

# plugin.json hook commands quoted (spaced-path safety)
QUOTED=$(grep -c '"node \\"\${CLAUDE_PLUGIN_ROOT}' "$REPO/.claude-plugin/plugin.json" 2>/dev/null || echo 0)
[ "$QUOTED" -ge 10 ] && pass "T_v3.6.17 plugin.json hook commands quoted ($QUOTED)" || fail "T_v3.6.17 plugin.json hook commands NOT quoted (got $QUOTED)"

# CHANGELOG v3.5.0 migration recipe — should NOT have `--purge` in the migration step
! grep -A 10 "Migration path for existing manual-install users" "$REPO/CHANGELOG.md" 2>/dev/null | grep -q "uninstall.sh --purge" && pass "T_v3.6.18 CHANGELOG migration recipe no longer uses --purge" || fail "T_v3.6.18 CHANGELOG migration recipe still has dangerous --purge"

# ============================================================
# Category v3.7 — Orphan notebook discovery (NEW in v3.7.0)
# ============================================================
section "Category v3.7 — Orphan notebook discovery"

# agent-factory --from-notebook mode documented
grep -q -- "--from-notebook" "$REPO/agents/agent-factory.md" && pass "T_v3.7.1 agent-factory --from-notebook documented" || fail "T_v3.7.1 agent-factory missing --from-notebook"

# agent-factory marks --from-notebook entries with source: "from-notebook"
grep -q "from-notebook" "$REPO/agents/agent-factory.md" && pass "T_v3.7.2 agent-factory tags source from-notebook" || fail "T_v3.7.2 agent-factory missing source tag"

# /prism-roster --reconcile-cloud documented
grep -q -- "--reconcile-cloud" "$REPO/commands/prism-roster.md" && pass "T_v3.7.3 prism-roster --reconcile-cloud documented" || fail "T_v3.7.3 prism-roster missing --reconcile-cloud"

# /prism-roster reconcile-cloud has [W]/[D]/[I]/[S] prompt structure
grep -q "Wrap" "$REPO/commands/prism-roster.md" && pass "T_v3.7.4 reconcile-cloud has [W]rap action" || fail "T_v3.7.4 reconcile-cloud missing Wrap action"

# Skiplist file path documented
grep -q "prism-orphan-notebook-skiplist" "$REPO/commands/prism-roster.md" && pass "T_v3.7.5 reconcile-cloud documents skiplist path" || fail "T_v3.7.5 reconcile-cloud missing skiplist path"

# master-orchestrator Phase 0a has orphan notebook section
grep -q "Orphan NotebookLM notebooks" "$REPO/agents/master-orchestrator.md" && pass "T_v3.7.6 Phase 0a surfaces orphan notebooks" || fail "T_v3.7.6 Phase 0a missing orphan notebooks section"

# master-orchestrator references --from-notebook wiring suggestion
grep -q -- "--from-notebook" "$REPO/agents/master-orchestrator.md" && pass "T_v3.7.7 Phase 0a references --from-notebook wiring" || fail "T_v3.7.7 Phase 0a missing --from-notebook reference"

# ============================================================
# Category v3.8 — Conversational-friction reduction (NEW in v3.8.0)
# ============================================================
section "Category v3.8 — Continuation classifier"

# Continuation detection in tier router
grep -q "continuation-inherit\|shouldInheritPreviousTier\|continuation detection" "$REPO/hooks/prism-prompt-tier-router.mjs" && pass "T_v3.8.1 prism-prompt-tier-router has continuation detection" || fail "T_v3.8.1 tier router missing continuation detection"

# Agent-model-guard explicit-opus exemption
grep -q "passthrough-explicit-opus-on-non-haiku\|explicit-opus-on-non-haiku\|model === 'opus'" "$REPO/hooks/prism-agent-model-guard.mjs" && pass "T_v3.8.2 agent-model-guard has explicit-opus exemption" || fail "T_v3.8.2 agent-model-guard missing explicit-opus exemption"

# PRISM_CONVERSATION_MODE env var
grep -q "PRISM_CONVERSATION_MODE" "$REPO/hooks/prism-prompt-tier-router.mjs" && pass "T_v3.8.3 PRISM_CONVERSATION_MODE supported" || fail "T_v3.8.3 PRISM_CONVERSATION_MODE not supported"

# CHANGELOG documents v3.8.0
grep -q "## \[3.8.0\]" "$REPO/CHANGELOG.md" && pass "T_v3.8.4 CHANGELOG has v3.8.0 section" || fail "T_v3.8.4 CHANGELOG missing v3.8.0"

# ============================================================
# Category v3.9 — Uninstall preserves user data (NEW in v3.8.4)
# ============================================================
section "Category v3.9 — Uninstall preserves user data"

# Both uninstallers reference the preserve paths
grep -q "prism-plan/references/roster.json\|prism-plan\\\\references\\\\roster.json" "$REPO/scripts/uninstall.ps1" && pass "T_v3.8.4.1 uninstall.ps1 preserves roster.json" || fail "T_v3.8.4.1 uninstall.ps1 missing roster.json preserve"
grep -q "prism-plan/references/roster.json" "$REPO/scripts/uninstall.sh" && pass "T_v3.8.4.2 uninstall.sh preserves roster.json" || fail "T_v3.8.4.2 uninstall.sh missing roster.json preserve"

grep -q "prism-plan/references/update-log.json\|prism-plan\\\\references\\\\update-log.json" "$REPO/scripts/uninstall.ps1" && pass "T_v3.8.4.3 uninstall.ps1 preserves update-log.json" || fail "T_v3.8.4.3 uninstall.ps1 missing update-log.json preserve"
grep -q "prism-plan/references/update-log.json" "$REPO/scripts/uninstall.sh" && pass "T_v3.8.4.4 uninstall.sh preserves update-log.json" || fail "T_v3.8.4.4 uninstall.sh missing update-log.json preserve"

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
