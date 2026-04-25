# PRISM v3.0 — Claude Code Manual Prompt Pack

Paste each prompt into a fresh Claude Code session. Record the outcome in the Observed column of `report-template.md`.

**Precondition for every test:** you've already run `tests/v3/run-static.sh` and it passed. `~/.claude/` is a real PRISM install of v3.0+. As of v3.2.0, keyword-floor is the only classifier path; no API key is required or used.

**Telemetry per turn:** after each prompt, the classifier writes `~/.claude/.prism-turn-tier-<session>.json` and appends to `~/.claude/.prism-routing.jsonl`. The log analyzer reads both.

**Cleanup between categories:** close Claude Code, delete stale sentinels, reopen:
```powershell
Remove-Item -Force "$env:USERPROFILE\.claude\.prism-turn-tier-*.json" -ErrorAction SilentlyContinue
```
or
```bash
rm -f ~/.claude/.prism-turn-tier-*.json
```

---

## Category 5 — Classifier routing

For each: open fresh Claude Code, paste the prompt, record `sentinel.tier`, `summon_panel`, `source`. As of v3.2.0, classifier `source` is one of `keyword-floor`, `cache`, `allowlist`, `force-opus`, or `conversation-model-override`.

### T5.1 — Trivial lookup (expect tier=haiku)
```
what does SIGTERM mean
```
**Verify**: `jq '.tier,.summon_panel,.source' ~/.claude/.prism-turn-tier-*.json` → `haiku`, `false`, source one of `keyword-floor`/`cache`/`conversation-model-override`.

### T5.2 — Routine implementation (expect tier=sonnet)
```
write a debounce function in TypeScript with leading and trailing edge control
```
**Verify**: tier=`sonnet`, summon_panel=`false`.

### T5.3 — Novel architecture (expect tier=opus, summon_panel=true)
```
design a rate limiter for a multi-region SaaS with 10k tenants and per-tenant fairness guarantees
```
**Verify**: tier=`opus`, summon_panel=`true`.

### T5.4 — Force prefix (expect force_opus=true)
```
!opus-force: check the git log
```
**Verify**: `jq '.force_opus' ~/.claude/.prism-turn-tier-*.json` → `true`, source=`force-opus`.

### T5.5 — Slash-command allowlist (expect tier=opus, source=allowlist)
```
/prism-health
```
**Verify**: tier=`opus`, source=`allowlist`.

### T5.6 — Cache hit on repeat
Re-send the exact prompt from T5.1 within 24h. Expect `source=cache`.

### T5.7 — Conversation-model self-override (v3.2.0)
Send a prompt that keyword-floor would misclassify (e.g., a deeply technical question phrased casually):
```
just a quick thought — should we use distributed sagas or 2PC for cross-service consistency
```
**Expected**: keyword-floor likely classifies as haiku (low score, no architecture keywords match well). The conversation-model receives the override directive, recognizes this is sonnet/opus complexity, and writes a corrected sentinel as its first action. **Verify**: jq the resulting sentinel for `source: "conversation-model-override"`.

---

## Category 6 — Guards

**Preconditions vary — see each test.**

### T6.1 — Mutation-guard blocks parent Edit on sonnet turn
Prompt:
```
edit README.md and add a single line "test-line" to the end
```
**Expected**: mutation-guard denies; message mentions "dispatch via Agent".

### T6.2 — Agent-model-guard nudges on sonnet turn without model
Prompt:
```
dispatch an agent to summarize the last 10 commits, don't specify a model
```
**Expected** (default `PRISM_MODEL_GUARD=soft`): advisory nudge visible in hook stderr; call still executes.

### T6.3 — Parent-dispatch-guard on novel turn
Prompt:
```
design a rate limiter for multi-region SaaS (from T5.3), then immediately try to edit a file
```
**Expected**: on the follow-up edit, parent-dispatch-guard denies with "requires @master-orchestrator".

### T6.4 — Subagent bypass (dispatch a sonnet subagent and have it edit)
Prompt:
```
dispatch a sonnet subagent to edit /tmp/test-edit.txt and append "subagent-test"
```
**Expected**: subagent's Edit call passes (three-path bypass: parent_tool_use_id / CLAUDE_CODE_ENTRYPOINT / sentinel.dispatched).

### T6.5 — Force override passes all guards
Prompt:
```
!opus-force: edit /tmp/force-test.txt with "hello"
```
**Expected**: all guards pass through; file written.

### T6.6 — Strict mode preserves old-hard (requires env var set)
Set `PRISM_MODEL_GUARD=strict`, restart Claude Code, prompt:
```
dispatch a sonnet subagent without declaring model
```
**Expected**: denied ("non-opus without explicit model").

### T6.7 — Hard mode softened (v2.9.1)
Set `PRISM_MODEL_GUARD=hard`, restart, prompt:
```
dispatch a sonnet subagent without declaring model
```
**Expected**: advisory nudge only, no deny (v2.9.1 semantic change).

### T6.8 — Hard mode still denies opus without model
Same env, prompt:
```
dispatch an opus subagent without declaring model
```
**Expected**: denied.

### T6.9 — Safety guard blocks dangerous Bash
Prompt:
```
run: rm -rf /
```
**Expected**: safety-guard denies.

---

## Category 7 — Roster & reconcile

### T7.1 — Manual agent file, reconcile picks it up
1. Create `~/.claude/agents/test-specialist.md`:
```yaml
---
name: test-specialist
description: Test-only specialist for v3 suite
model: sonnet
core_domains: [testing, test-harness]
---
Body.
```
2. Inside Claude Code: `/prism-roster --reconcile`
3. **Verify**: `jq '.agents["test-specialist"]' ~/.claude/skills/prism-plan/references/roster.json` returns a real entry (not null).

### T7.2 — Core agents skipped
After T7.1, verify `agent-factory`, `master-orchestrator`, `prism-updater` are NOT added to `roster.agents` by reconcile (they may be absent entirely — expected; they're PRISM-owned).

### T7.3 — Dual layout dedup
Create both `~/.claude/agents/dual.md` AND `~/.claude/agents/dual/agent.md`. Reconcile. Verify only one `dual` entry in roster.

### T7.4 — Re-reconcile is no-op
Run `/prism-roster --reconcile` twice. Second run prints "already reconciled".

### T7.5 — Display mode flags orphans
Drop an agent file without reconciling, then run `/prism-roster`. Expected: table shown, orphan flagged with suggestion to reconcile.

**Cleanup after T7**: remove `test-specialist.md`, `dual.md`, `dual/`, re-reconcile to clean roster.

---

## Category 8 — Resource-index

### T8.1 — Fresh roster is empty
Post-install, pre-`/prism-index`:
```bash
jq '.skills,.tools,.mcps,.index_meta.last_indexed' ~/.claude/skills/prism-plan/references/roster.json
```
**Expected**: `{}`, `{}`, `{}`, `null`.

### T8.2 — /prism-index populates
Inside Claude Code:
```
/prism-index
```
**Verify**: same jq now shows non-empty `skills` (at minimum the PRISM-owned ones), `index_meta.last_indexed` set to a recent ISO timestamp, `indexer_version="2.9.0"` or later.

### T8.3 — Dry run
```
/prism-index --dry-run
```
**Expected**: reports what would change, does NOT mutate roster.json.

### T8.4 — Skills-only refresh
```
/prism-index --skills-only
```
**Expected**: skills block refreshed; tools/mcps unchanged.

### T8.5 — New plugin skill detected
Install a new Claude Code plugin that ships a skill (any), re-run `/prism-index`. Expected: new skill appears in `skills` block with `source: "plugin:<name>"`.

### T8.6 — Enrichment mode (costs ~$0.30)
```
/prism-index --enrich
```
**Expected**: keywords + trigger_phrases arrays are richer vs default (subjective — compare before/after).

---

## Category 9 — Blueprint-prompt

### T9.1 — Populated index path
After `/prism-index`, prompt:
```
plan a migration of our database from MySQL to PostgreSQL
```
**Expected**: blueprint-prompt activates (keyword "plan"). Panel composition picks indexed resources (e.g., if `supabase` MCP or a Postgres specialist is in roster, it's used). NO hallucinated "Rachel" or "Priya" names unless flagged as explicit fallback.

### T9.2 — Empty-index warning
1. Revert the index: `jq '.skills={},.tools={},.mcps={},.index_meta.last_indexed=null' roster.json > /tmp/r.json && mv /tmp/r.json roster.json`
2. Same prompt as T9.1.
3. **Expected**: panel output opens with "Resource-index not populated — hallucination risk HIGH" notice. Fallback personas clearly labeled.

### T9.3 — Advisory task full workshop
```
analyze the trade-offs between REST and GraphQL for our public API
```
**Expected**: blueprint full workshop — 3-5 experts, adversarial challenges visible, synthesis with open questions.

### T9.4 — Execution-heavy hand-off
```
implement a new feature across 3 services plus docs plus tests — auth token rotation
```
**Expected**: blueprint alignment pass only (1 primary + 1 risk voice), explicit handoff to `@master-orchestrator`.

### T9.5 — Adversarial review visible
From T9.3 output: count challenges per expert position. Pass criterion: ≥2 substantive challenges per position (specific failure mode + scenario, not vague disagreement).

---

## Category 10 — Parallel dispatch (KNOWN GAP expected)

### T10.1 — Explicit pgroup in plan
After `/prism-plan` with 3 independent tasks, orchestrator returns plan with `[pgroup=1]` annotations. When dispatched:
```
execute the plan
```
**Expected**: ONE assistant message with 3 `Agent()` blocks. Wall-clock < sum of individual durations.

### T10.2 — Parallel-opportunity hint
When a user prompt implies independent work, `prism-hook.mjs` emits hint. Check `~/.claude/.prism-routing.jsonl` for `{event:"parallel_opportunity"}` entries.

### T10.3 — Sequential dispatch of pgroup=N (v3.1.0 — gap CLOSED)
Manually dispatch 3 pgroup=1 tasks in 3 separate messages. **Expected outcome as of v3.1.0**: `prism-parallel-guard.mjs` detects the second sequential pgroup-tagged Agent call within 60s and emits an advisory (soft mode, default) or denies (hard mode). **Expected pass — gap closed in v3.1.0.**

---

## Category 12 — Cost/tier discipline

### T12.1 — Soft mode (default)
No env override. Prompt any sonnet work. Expected: nudges visible, no denies.

### T12.2 — Hard mode (v2.9.1 semantics)
`PRISM_MODEL_GUARD=hard`. Sonnet dispatch without model → nudge only. Opus dispatch without model → DENY.

### T12.3 — Strict mode
`PRISM_MODEL_GUARD=strict`. Any non-opus without model → DENY.

### T12.4 — v2.9.1 migration notice
After upgrading to v2.9.1 for the first time with `PRISM_MODEL_GUARD=hard` pre-set, first session-start emits migration notice. Flag file `~/.claude/.prism-v2.9.1-migration-shown` written. Second session: notice suppressed.

### T12.5 — Weekly rollup calibration
After a week of real use, open `~/.claude/.prism-rollups/` (if present) and inspect classifier calibration section. Expected: `pgroup_violation` events listed if any occurred. (Optional, long-tail test.)

---

## Category 13 — Skills invocation (PARTIAL GAP expected)

### T13.1 — Domain skill auto-trigger
With `ui-ux-pro-max` installed, prompt:
```
review this landing page for UX quality and accessibility
```
**Expected**: Claude Code loads `ui-ux-pro-max` via its description match. Check response for domain-specific vocabulary (WCAG, contrast ratios, etc.).

### T13.2 — blueprint-prompt keyword trigger
```
plan an upgrade to React 19 across our frontend
```
**Expected**: blueprint-prompt activates.

### T13.3 — prism-chat trigger
```
/panel evaluate whether to adopt tRPC
```
**Expected**: prism-chat activates, full panel protocol.

### T13.4 — Skill NOT auto-invoked when match exists (v3.1.0 — gap CLOSED, advisory)
Prompt something where a specialist is rostered but Claude chooses generic approach:
```
what are best practices for Greek e-commerce SEO
```
With `greek-ecommerce-seo-specialist` rostered. **Expected outcome as of v3.1.0**: `prism-skill-trigger-guard.mjs` reads `~/.claude/skills/prism-plan/references/skill-triggers.md`, matches the SEO regex, emits an advisory: "your prompt mentioned <SEO>; consider invoking <greek-ecommerce-seo-specialist>". Hook is advisory-only in v3.1; hard mode coerced to soft per spec. **Expected pass (advisory). Hard-mode enforcement deferred to v3.2.**

---

## Category 15 — Windows-specific (Windows only)

### T15.1 — install-merge rewrites hook commands
After running install-merge on Windows, inspect `~/.claude/settings.json`:
```powershell
Select-String -Path "$env:USERPROFILE\.claude\settings.json" -Pattern 'cmd /c.*prism-exec\.cmd'
```
**Expected**: matches found.

### T15.2 — prism-exec.cmd present
```powershell
Test-Path "$env:USERPROFILE\.claude\hooks\lib\prism-exec.cmd"
```
Expected: `True`.

### T15.3 — prism.env with Windows node path
```powershell
Get-Content "$env:USERPROFILE\.claude\prism.env"
```
Expected: a `PRISM_NODE=C:\Program Files\nodejs\node.exe` line (or wherever node lives).

### T15.4 — No BOM in hook-written JSON
After a classifier run, inspect a sentinel:
```powershell
$bytes = [System.IO.File]::ReadAllBytes("$env:USERPROFILE\.claude\.prism-turn-tier-*.json")
$bytes[0..2] -join ','
```
Expected: NOT `239,187,191` (BOM absent).

### T15.5 — Mutation-guard blocks PowerShell writes
Inside Claude Code, on sonnet turn, prompt:
```
run bash command: echo hello > test.txt
```
Expected: mutation-guard denies (v2.7.2 patterns catch `> path` redirects).

---

---

## Category 16 — Panel-hallucination guard (v3.1+)

### T16.1 — Hallucinated persona triggers warning
Prompt blueprint-prompt with the index empty (`/prism-index` never run). Run an Advisory task that produces a panel with hardcoded fallback names. Expected: `prism-panel-guard.mjs` (SubagentStop) scans the output, identifies fallback names that AREN'T in the §6 hardcoded-fallback whitelist (Architect, Security, Performance, Cost, Skeptic, etc.) — none should be flagged, all are recognized fallbacks. Pass.

### T16.2 — Truly hallucinated names flagged
Force a panel that uses invented names like "Rachel" or "Priya" (paste an example that does this). Expected: panel-guard flags them as unindexed personas; in soft mode emits a warn line listing flagged names; in hard mode denies SubagentStop with re-assemble suggestion.

### T16.3 — Indexed specialist names pass cleanly
Run `/prism-index` first to populate; prompt a panel that picks a real rostered agent (e.g., `greek-ecommerce-seo-specialist`). Expected: no flag — name matches roster.agents.

---

## Category 17 — /prism-doctor (v3.1+)

### T17.1 — Run doctor on clean install
```
/prism-doctor
```
Expected: scans, reports 0 symptoms found OR only INFO-level findings (e.g., "prism-policy.json not present — opt-in feature, no action needed"). Exit 0.

### T17.2 — Doctor no longer flags keyword-floor (v3.2.0)
Run `/prism-doctor` on a clean install. Expected: doctor does NOT flag "Classifier in keyword-floor only" — keyword-floor is the standard mode in v3.2.0+, not a degraded state.

### T17.3 — Doctor catches stale sentinels
Manually create stale sentinel files (`touch ~/.claude/.prism-turn-tier-fake-uuid.json` with timestamp >1h old). Run doctor. Expected: flags + proposes deletion command.

---

## Category 18 — /prism-telemetry (v3.1+, LOCAL-ONLY)

### T18.1 — Opt-in
```
/prism-telemetry --opt-in
```
Expected: writes/updates `~/.claude/prism-policy.json` with `telemetry.opt_in: true`. Confirms before write.

### T18.2 — Status
```
/prism-telemetry --status
```
Expected: shows opt-in state, last-aggregation timestamp, rollup file size. No network activity (verify with `lsof -i` — should show no PRISM-originated connections).

### T18.3 — Aggregate
```
/prism-telemetry --aggregate
```
Expected: parses `~/.claude/.prism-routing.jsonl` → writes `~/.claude/.prism-telemetry-rollup.json` with the schema documented in the command. Validate the JSON parses + has expected keys.

### T18.4 — Export
```
/prism-telemetry --export /tmp/prism-rollup.json
```
Expected: copies rollup to chosen path. Anonymizes session_ids. NO raw prompts in the export.

### T18.5 — Opt-out
```
/prism-telemetry --opt-out
```
Expected: flips `telemetry.opt_in` to false. Existing rollup preserved. Aggregation no longer triggered at session-end.

---

## Category 19 — Centrally-managed policy (v3.1+)

### T19.1 — Policy file detected on session start
Place `~/.claude/prism-policy.json` with `{guards:{mutation:"hard"}}`. Restart Claude Code. Expected: session-start emits one-time notice that a policy file is active.

### T19.2 — Policy beats env var (default precedence)
Set `PRISM_MUTATION_GUARD=soft` in shell. Place policy file with `{guards:{mutation:"hard"}}`. On a sonnet turn, attempt parent-context Edit. Expected: mutation-guard denies (policy `hard` won over env `soft`).

### T19.3 — User escape via PRISM_POLICY_OVERRIDE=1
With same policy file, set `PRISM_POLICY_OVERRIDE=1` AND `PRISM_MUTATION_GUARD=soft`. Same Edit attempt. Expected: mutation-guard advisory only (env `soft` wins because override is on).

---

## Category 20 — /prism-roster --team filter (v3.1+)

### T20.1 — Team filter scopes display
Manually edit roster.json to add `team_id: "platform-team"` to one agent and `team_id: "eng-uk"` to another. Run:
```
/prism-roster --team platform-team
```
Expected: only the matching agent shown.

### T20.2 — `--team -` shows team-less
```
/prism-roster --team -
```
Expected: only agents with `team_id: null` or absent shown.

### T20.3 — No filter shows all
```
/prism-roster
```
Expected: all agents shown with Team column populated for the tagged ones.

---

## Category 21 — One-command installer (v3.1+, fresh machine simulation)

### T21.1 — Help works
```
bash scripts/install.sh --help
```
Expected: usage block with all 5 flags listed.

### T21.2 — Dry-run prints plan, no mutation
```
bash scripts/install.sh --dry-run
```
Expected: ~30-line plan output, exit 0, no changes to `~/.claude/`.

### T21.3 — Real install on throwaway HOME
```
mkdir -p /tmp/test-prism-install
HOME=/tmp/test-prism-install bash scripts/install.sh --no-backup
```
Expected: clones, installs, verifies. Exit 0. `verify.mjs` reports clean.

---

## Cleanup after running the full suite

```bash
rm -f ~/.claude/.prism-turn-tier-*.json
rm -f ~/.claude/agents/test-specialist.md
rm -rf ~/.claude/agents/dual/ ~/.claude/agents/dual.md
/prism-roster --reconcile  # clear test entries from roster
```

## Reporting

After running all Claude-side tests, copy the console output + `~/.claude/.prism-routing.jsonl` into `tests/v3/report-template.md` under each category. Then run the analyzer:

```bash
node tests/v3/analyze-log.mjs ~/.claude/.prism-routing.jsonl >> v3-report-<date>.md
```

The analyzer extracts routing decisions, guard fires, force-overrides, and tier distribution from the JSONL log and produces a structured summary.

---

## Category 22 — Automated uninstaller (v3.3+)

### T22.1 — Help works
```
bash scripts/uninstall.sh --help
```
**Expected**: usage block lists all 5 flags (`--purge`, `--keep-memory`, `--no-backup`, `--reinstall`, `--help`).

### T22.2 — Default mode is DRY-RUN, mutates nothing
```
bash scripts/uninstall.sh
```
**Expected**: prints inventory + "would delete" lines for every PRISM artifact. `~/.claude/` is unchanged. Diff `ls -la ~/.claude/hooks/` before vs after — should be identical.

### T22.3 — Real uninstall + reinstall round-trip on throwaway HOME
```
mkdir -p /tmp/test-uninstall
HOME=/tmp/test-uninstall bash scripts/install.sh --no-backup
HOME=/tmp/test-uninstall bash scripts/uninstall.sh --purge --no-backup
ls -la /tmp/test-uninstall/.claude/hooks/   # expect: no prism-* files
HOME=/tmp/test-uninstall bash scripts/install.sh --no-backup
HOME=/tmp/test-uninstall node scripts/verify.mjs
```
**Expected**: install OK → uninstall removes PRISM hooks → reinstall OK → verify clean.

### T22.4 — `--keep-memory` preserves session data
After install + populating `.prism-sessions/` via real Claude Code use:
```
bash scripts/uninstall.sh --purge --keep-memory
ls ~/.claude/.prism-sessions/
```
**Expected**: session files still present; everything else removed.

### T22.5 — `--reinstall` chain
```
bash scripts/uninstall.sh --purge --reinstall ~/PRISM
```
**Expected**: uninstall completes, then `install.sh` runs immediately. End state: clean reinstall from scratch.

### T22.6 — settings.json surgery preserves non-PRISM hooks
Before uninstall, manually add a custom non-PRISM hook entry to `~/.claude/settings.json` (e.g., a personal logging hook). Run `--purge`. Verify the custom entry is still there afterward; only PRISM hook entries removed.

---

## Category 23 — PowerShell-native lifecycle (v3.4+, Windows)

Windows users with PowerShell 5.1+ no longer need Git Bash. Both
`install.ps1` and `uninstall.ps1` ship as native PowerShell.

### T23.1 — install.ps1 -Help works
```powershell
.\scripts\install.ps1 -Help
```
**Expected**: usage block lists all 5 parameters: `-Prefix`, `-Branch`, `-DryRun`, `-NoBackup`, `-Help`. Exit 0.

### T23.2 — install.ps1 -DryRun mutates nothing
```powershell
.\scripts\install.ps1 -DryRun
```
**Expected**: prints plan + would-do lines; ~/.claude/ is unchanged. Diff `Get-ChildItem -Recurse $env:USERPROFILE\.claude` before/after — should be identical.

### T23.3 — uninstall.ps1 -Help works
```powershell
.\scripts\uninstall.ps1 -Help
```
**Expected**: usage block lists all 5 parameters: `-Purge`, `-KeepMemory`, `-NoBackup`, `-Reinstall <path>`, `-Help`.

### T23.4 — uninstall.ps1 default mode is DRY-RUN
```powershell
.\scripts\uninstall.ps1
```
**Expected**: prints inventory + would-delete lines; ~/.claude/ is unchanged. INVERTED default vs install.ps1 — same safety stance as the .sh.

### T23.5 — Full PowerShell round-trip on throwaway HOME
```powershell
$bk = $env:USERPROFILE
$env:USERPROFILE = "$env:TEMP\prism-test-$(Get-Random)"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude" | Out-Null
.\scripts\install.ps1 -NoBackup
.\scripts\uninstall.ps1 -Purge -NoBackup
Test-Path "$env:USERPROFILE\.claude\hooks\prism-mutation-guard.mjs"
.\scripts\install.ps1 -NoBackup
node scripts\verify.mjs
$env:USERPROFILE = $bk
```
**Expected**: install OK → uninstall removes hooks (`Test-Path` returns False) → reinstall OK → verify clean.

### T23.6 — UTF-8 NO BOM check on prism.env
After install.ps1 runs:
```powershell
$bytes = [System.IO.File]::ReadAllBytes("$env:USERPROFILE\.claude\prism.env")
$bytes[0..2] -join ','
```
**Expected**: NOT `239,187,191` (BOM absent). Closes the v2.7.2 BOM trap.
