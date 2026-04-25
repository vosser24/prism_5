---
name: prism-health
description: System health check across PRISM core, agents, hooks, external tools, video pipeline
---

Comprehensive status check of the PRISM installation (v2.1.23).

## PROTOCOL

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
- ~/.claude/skills/prism-plan/references/tools-registry.md (v2.1.23)
- ~/.claude/skills/prism-plan/references/skill-effectiveness.md (v2.1.23)

Report missing with severity.

### Step 2 — Agent roster health
Read roster.json, count:
- Total agents
- ACTIVE (< 90 days since last_used)
- STALE (90-180 days) — flag
- VERY STALE (180-365) — recommend upgrade
- DEAD (> 365) — recommend retire

Top 5 most-used by task count.

### Step 3 — External tools status (NEW in v2.1.23)

Read tools-registry.md. For each entry, check install status:
  Tier 1 check methods:
    /plugin list                              (superpowers)
    which uipro || npm ls -g uipro-cli        (ui-ux-pro-max)

  Tier 2 check methods:
    /plugin list | grep everything-claude-code
    uv pip list | grep browser-use
    cat ~/.claude/settings.json | grep <mcp-name>

Output:
  EXTERNAL TOOLS
    Tier 1 (auto-installed by /prism-init):
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

### Step 5 — Audit status (NEW in v2.1.23)
Read audit-log.json (if exists):
- Show last audit date
- Show findings summary
- Recommend re-run if > 7 days

### Step 6 — Orphan scans (existing)
ORPHAN SCAN, DEDUPLICATION, RETIREMENT CHECK, COST SUMMARY.

### Step 7 — NotebookLM integration

Check:
  - command -v notebooklm
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
1. Security critical (from /prism-audit)
2. Missing Tier 1 companions
3. Missing dependencies (kokoro, ffmpeg) if video work detected
4. Dead agents (> 365 days)
5. Stale scans (> 30 days)
6. Pending archive consolidation
7. Overdue updates
8. Stale agents

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
