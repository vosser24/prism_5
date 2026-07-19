---
name: prism-health
description: System health check across PRISM core, agents, hooks, external tools, video pipeline
---

Comprehensive status check of the PRISM installation (v6.0.0).

## PROTOCOL

### Step 0 — PRISM version (deterministic — run first)

Report the installed and shipped PRISM version before anything else.

**Read sources in this exact priority order:**

1. **Installed version** — read `~/.claude/.prism-version` (written by the
   installer on every `install` / `update` run). This is what is actually
   running on this machine.
2. **Shipped version (fallback)** — if `~/.claude/.prism-version` is absent,
   read `tools/install-manifest.json` and extract the `prism_version` field.
   Report it as "shipped (installer marker absent)".
3. **When both are available**, compare them. If they differ, report:
   - `Installed: X.A.B` (the running version)
   - `Shipped: X.Y.Z` (the repo / plugin version)
   - Freshness signal: "update available — run `node tools/prism-installer.mjs update`"

**NEVER read `skills/prism-plan/references/update-log.json` to determine the
PRISM version.** That file is a history log recording when updates were last
checked; its `prism_version` field may lag behind the actual installed
version and is NOT authoritative.

Output format:
```
PRISM VERSION
  Installed : X.A.B  (source: ~/.claude/.prism-version)
  Shipped   : X.Y.Z  (source: tools/install-manifest.json → prism_version)
  Status    : up-to-date | update available
```

### Step 1 — Verify core installation

**Layout detection (NEW in v3.6.0)**: at the very top of the report,
print which install layout is in effect:

- If `${CLAUDE_PLUGIN_ROOT}` env var is set → `Layout: plugin-install`
- Otherwise → `Layout: manual-install`

Then run the layout-appropriate file checks below.

**Plugin-install layout** (`${CLAUDE_PLUGIN_ROOT}` set):
- `${CLAUDE_PLUGIN_ROOT}/hooks/prism-*.mjs` (16 expected)
- `${CLAUDE_PLUGIN_ROOT}/commands/prism-*.md` (14 expected)
- `${CLAUDE_PLUGIN_ROOT}/skills/*` (8 PRISM-owned expected: prism-plan,
  prism-discover, blueprint-prompt, workflow-orchestration,
  claude-code-expert, notebooklm, video-production, prism-chat)
- `${CLAUDE_PLUGIN_ROOT}/agents/*` (3 core expected: master-orchestrator,
  agent-factory, prism-updater)
- Plus, regardless of layout, the bootstrapped reference files at
  `~/.claude/skills/prism-plan/references/`:
  - adversarial-review.md, model-matrix.md, prompt-templates.md,
    tools-registry.md, mcp-registry.md, roster.json
  (These are seeded by the SessionStart hook on first plugin run; if
  any are missing AND `${CLAUDE_PLUGIN_ROOT}` is set, suggest
  restarting Claude Code or running `/prism-doctor`.)

**Manual-install layout** (no `${CLAUDE_PLUGIN_ROOT}`):
- ~/.claude/ directory
- ~/.claude/CLAUDE.md (with ## PRISM section)
- ~/.claude/settings.json (hooks registered)
- ~/.claude/hooks/prism-*.mjs (5 files)
- ~/.claude/skills/prism-plan/SKILL.md + references/
- ~/.claude/skills/prism-discover/SKILL.md
- ~/.claude/skills/video-production/SKILL.md
- ~/.claude/agents/master-orchestrator.md, agent-factory.md, prism-updater.md
- ~/.claude/commands/ (9 commands: health, roster, update, init, retire,
  app-expert, archive, recommend, audit)
- ~/.claude/skills/prism-plan/references/tools-registry.md (v6.0.0)
- ~/.claude/skills/prism-plan/references/skill-effectiveness.md (v6.0.0)

Report missing with severity.

### Step 1b — Installed-vs-repo drift (deterministic, v6.3.2)

Step 0's version markers can MATCH while the installed hook/tool CONTENT is
stale — on 2026-07-14 a session built 6 mechanisms into the repo while the
live session ran old hooks from `~/.claude/` (three hook files missing from
the install entirely). This step catches that class deterministically.

Run (only when the cwd is a PRISM repo clone — i.e. `tools/install-manifest.json`
exists; the tool self-reports `not-applicable` otherwise and that is NOT a
warning):
```
node tools/prism-drift-check.mjs
```
It sha256-compares every manifest file + directory tree (minus
`preserve_files` user state) in the repo against `~/.claude/`, and reports
drift ONLY for files whose repo copy is committed (clean vs git HEAD) —
uncommitted work-in-progress is counted as `skipped_dirty`, never flagged,
so a developer mid-edit cannot make this cry wolf.

- exit 0, `no drift` → report "installed copy matches committed repo state."
- exit 1 → report LOUDLY: the live session is NOT running what the repo
  ships. Surface each `MISSING`/`STALE` file verbatim and carry into
  Step 10 as a **priority 1** item with the fix:
  `node tools/prism-installer.mjs update`
- `skipped_dirty > 0` → mention the count in one line (informational).

This check deliberately lives HERE and not in SessionStart: measured
2026-07-16, hashing the 152 manifest file pairs over SMB took ~10-12s —
far over the SessionStart latency budget. A deliberate health run can
afford it.

### Step 2 — Agent roster health
Read roster.json, count:
- Total agents
- ACTIVE (< 90 days since last_used)
- STALE (90-180 days) — flag
- VERY STALE (180-365) — recommend upgrade
- DEAD (> 365) — recommend retire
- Report OOB Phase 1.5 arming: count roster agents with `requires_phase_1_5: true`. If 0, flag: "Phase-1.5 OOB reviewer is DORMANT — no agent tagged; see `node tools/prism-roster.mjs --tag-1-5 <agent>`."

Top 5 most-used by task count.

### Step 3 — External tools status (v6.0.0)

Read tools-registry.md. For each entry, check install status:
  Tier 1 check methods (detect by EXECUTION, not a bare PATH probe — AppLocker
  can resolve the PATH while denying the .exe, [[feedback-applocker-exe-detection]]):
    /plugin list                              (superpowers)
    uipro --version || npm ls -g uipro-cli    (ui-ux-pro-max; PATH resolves but
                                               --version fails ⇒ report blocked)

  Tier 2 check methods:
    /plugin list | grep everything-claude-code
    uv pip list | grep browser-use
    cat ~/.claude/settings.json | grep <mcp-name>

Output:
  EXTERNAL TOOLS
    Tier 1 (auto-installed by /prism-bootstrap):
      ✓ obra/superpowers                     installed, active
      ✓ nextlevelbuilder/ui-ux-pro-max-skill installed, active

    Tier 2 (on-demand via /prism-recommend):
      · affaan-m/everything-claude-code  OPTIONAL — not checked by default
        (~12k token index; install only for language-specific reviewers
        or AgentShield. Run /prism-health --include-optional to check.)
      · browser-use/browser-use          OPTIONAL — ~400 MB chromium
        Install only for general browser automation.
      ✗ Filesystem MCP     not installed
      ✗ GitHub MCP         not installed
      ✓ Context7 MCP       installed
      ✗ Playwright MCP     not installed (recommended for app-expert)

    Registry last checked: {date} ({N} days ago)

Cross-reference with .claude/tools-scan.json if present.

### Step 4 — Dependencies
Read dependency-manifest.md, run check commands, report missing.

PRISM-specific dependency checks:
  - notebooklm-py (always)
  - ffmpeg (video audio mixing)
  - kokoro-tts (primary TTS)
  - kokoro-v1.0.onnx + voices-v1.0.bin (model files, 620MB)
  - @playwright/test (app-expert pattern)
  - Remotion project (if in video project)

### Step 5 — Audit status (v6.0.0)
Read audit-log.json (if exists):
- Show last audit date
- Show findings summary
- Recommend re-run if > 7 days

### Step 6 — Orphan scans (existing)
ORPHAN SCAN, DEDUPLICATION, RETIREMENT CHECK, COST SUMMARY.

### Step 6b — Self-blindness canary (v6.3)

A hook can log the same bail/no-op action ~100% of the time forever and
nothing notices — e.g. phase-1-5-oob logging `no-agent-name` ~29,618× on
one install while the whole reviewer path was silently dead. This step
catches that class of failure.

Run:
```
node tools/prism-telemetry-aggregate.mjs --blindness-canary
```
(or `node ~/.claude/tools/prism-telemetry-aggregate.mjs --blindness-canary`
on a plugin/manual install). It inspects the last ~2000 entries of
`~/.claude/.prism-routing.jsonl`, buckets them by hook (`event`), and for
every hook with ≥20 logged entries computes its most common `action` and
that action's share. It fail-opens: a missing/unreadable log yields
`status: "no-data"`, never an error.

- `status: "no-data"` → report "no routing log yet — canary has no signal
  to check" and move on. This is NOT a warning.
- `flagged` non-empty → report LOUDLY (surface each `message` verbatim)
  and carry it into Step 10 as a **priority 1** item — a flagged hook
  means a mechanism is likely silently dead.
- `flagged` empty and `hooks_checked > 0` → report "canary checked N
  hooks, all within normal action-diversity bounds."

### Step 6c — cross-check with `tools/prism-telemetry-aggregate.mjs --tuning`
(guard-deny concentration) for a second signal on the same log — the two
checks are complementary, not redundant: `--tuning` flags guards that deny
a disproportionate SHARE of denies; `--blindness-canary` flags hooks whose
output has collapsed to a single no-op value.

### Step 7 — NotebookLM integration

Check:
  - notebooklm availability by EXECUTION: `notebooklm --version` || `python -m notebooklm --version` (NOT bare `command -v` — AppLocker/WDAC can resolve the PATH while denying the `.exe`, a false "available"). Report `blocked` if PATH resolves but neither runs.
  - Agents with notebooklm_notebook_id count (N/total)
  - Last /prism-archive timestamp
  - Pending archive candidates (agents with 5+ unarchived notes)

### Step 8 — Video production readiness

If any project artifact suggests video work (remotion in deps, out/ dir, etc.):
  VIDEO PRODUCTION
    ✓/✗ Remotion project detected
    ✓/✗ ffmpeg available
    ✓/✗ Kokoro TTS ready (CLI + model files)
    ✓/✗ Playwright ready (for app-expert screenshots)
    ✓/✗ CONTEXT.md present in project root
    Recent renders: {list out/*.mp4 from last 7 days}

### Step 9 — Project state (if in a project)
Project name, stack, CLAUDE.md, tasks/, references/, tools-scan.json freshness.

### Step 10 — Generate suggested actions (prioritized)
1. Self-blindness canary flags from Step 6b (likely silently-dead hooks)
2. Security critical (from /prism-audit)
3. Missing Tier 1 companions
4. Missing dependencies (kokoro, ffmpeg) if video work detected
5. Dead agents (> 365 days)
6. Stale scans (> 30 days)
7. Pending archive consolidation
8. Overdue updates
9. Stale agents

## FLAGS
/prism-health               → full check
/prism-health --quick       → skip dependency checks
/prism-health --tools       → external tools only
/prism-health --agents      → roster only
/prism-health --video       → video production readiness only
/prism-health --project     → current project only

## EXIT CODES (for CI)
0: all green | 1: warnings | 2: errors

## NOT THIS
- Not a repair tool (use /prism-update or /prism-recommend)
- Not an audit (use /prism-audit)
- Not a benchmark (use benchmarks.md)

## AUTO-REPAIR (safe operations only)
Create missing directories, empty files where safe. Never touches content.
