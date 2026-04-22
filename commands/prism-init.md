---
name: atlas-init
description: Initialize ATLAS structure + install companion tools
---

Two modes:
  /prism-init       → FAST mode (~1 min): structure + offer companion installs
  /prism-init full  → COMPREHENSIVE (3-5 min): full setup + auto-install companions
                      + stack detection + MCP suggestions + dependencies check

## BOTH MODES — STEP 0: Ensure Git Repository

ATLAS agents require a git repo to spawn (worktree isolation).

Run: git rev-parse --is-inside-work-tree

If NOT a git repo:
  Run: git init
  Create .gitignore with:
    node_modules/
    .env
    .env.local
    *.pyc
    __pycache__/
    .claude/.prism-state.json
    .claude/tools-scan.json
    CLAUDE.local.md
    kokoro-v1.0.onnx
    voices-v1.0.bin
    out/*.mp4
  Run: git add -A && git commit -m "Initial commit — ATLAS project init"
  Report: "Initialized git repo (required for ATLAS agent spawning)."

If ALREADY a git repo: skip silently.

## FAST MODE (default)

### Step 1 — Read README.md if exists
Detect project name and domain.

### Step 2 — Create ATLAS project structure
  CLAUDE.md                            ← Project Identity section
  .claude/references/                  ← Indexed knowledge
  .claude/rules/                       ← Project-specific rules
  tasks/todo.md                        ← Active work
  tasks/lessons-tactical.md            ← Execution lessons
  tasks/lessons-strategic.md           ← Architecture lessons
  CLAUDE.local.md                      ← Gitignored personal notes
  .mcp.json                            ← Empty MCP config

### Step 3 — Offer companion tool installation (v2.1.23)

Print to user:

  ATLAS composes with 4 companion tools for coding, design, and
  automation work. Install them now so ATLAS can route tasks to the
  right tool automatically.

  COMPANIONS (install time: ~2-3 min total):

    [1] obra/superpowers            — TDD, debugging, code review, git worktrees
        /plugin install superpowers@claude-plugins-official

    [2] affaan-m/everything-claude-code — Language reviewers, security scan, skills
        /plugin marketplace add https://github.com/affaan-m/everything-claude-code
        /plugin install everything-claude-code@everything-claude-code

    [3] nextlevelbuilder/ui-ux-pro-max-skill — UI/UX design system
        npm install -g uipro-cli && uipro init --ai claude --global

    [4] browser-use/browser-use     — General browser automation
        uv init && uv add browser-use && uv sync

  How should I proceed?
    [A] Install all 4 (recommended)
    [B] Show me what each does first
    [C] Skip — I'll install selectively later via /prism-recommend
    [D] Let me choose which to install

### Step 4 — Execute user's choice

If [A] install all:
  - Check if already installed before running each command
  - Run sequentially (don't parallelize — plugin marketplace adds are fragile)
  - Report per-tool: INSTALLED | ALREADY PRESENT | FAILED

If [B] show details:
  - Display registry entries for each tool
  - Re-present menu [A/C/D]

If [C] skip:
  - Write note to CLAUDE.md (Companion Tools section)
  - Continue with step 5

If [D] choose:
  - List each, ask yes/no, install selected

### Step 5 — Write tool status to CLAUDE.md

Append section (at top, before other content):

  ## ATLAS — External Tools

  Status (as of {ISO date}):
  - ✓ obra/superpowers              — installed
  - ✓ affaan-m/everything-claude-code — installed
  - ✓ nextlevelbuilder/ui-ux-pro-max-skill — installed
  - ✓ browser-use/browser-use        — installed

  Registry: ~/.claude/skills/prism-plan/references/tools-registry.md
  Run /prism-recommend for project-specific fit analysis.
  Run /prism-audit to scan ATLAS surface for hygiene issues.

### Step 6 — Autonomous dependency check

Scan for:
  - notebooklm-py (always, enables free Tier 1 agent research)
  - ffmpeg (check if Remotion detected — needed for video production)
  - kokoro-tts (if video-production will be used — highly recommended)
  - kokoro model files (kokoro-v1.0.onnx, voices-v1.0.bin)
  - playwright + chromium (if app-expert pattern may be used)

If missing:
  "Your project uses {stack}. ATLAS features need:

   · kokoro-tts — free TTS for video voiceover
     Install: pip install kokoro-tts
     Models: ~620MB download, one-time

   · ffmpeg — audio mixing, final render
     Install (macOS): brew install ffmpeg
     Install (Linux): apt install ffmpeg
     Install (Windows): https://ffmpeg.org/download.html

   · playwright — app-expert screenshot automation
     Install: npm install -D @playwright/test
              npx playwright install chromium

   Run /atlas-deps to install these now."

### Step 7 — Final report

  ═══════════════════════════════════════════════════════════
  ATLAS — Project Initialized
  ═══════════════════════════════════════════════════════════

  PROJECT: {name}
  STACK:   {detected}
  DOMAIN:  {domain}

  CREATED: (list of created files/directories)

  COMPANION TOOLS: {N}/4 installed
    {list}

  DEPENDENCIES: {N}/4 ready
    notebooklm-py: ✓/✗
    ffmpeg:        ✓/✗
    kokoro-tts:    ✓/✗
    playwright:    ✓/✗

  NEXT STEPS:
    → /prism-recommend     Get project-specific tool fit analysis
    → /prism-discover      Index database/codebase/APIs
    → /prism-health        Check overall ATLAS status
    → /prism-audit         Scan ATLAS surface for secrets + hygiene
    → /prism-archive       Consolidate agent learnings
    → /prism-app-expert    Create a Playwright app companion

  ═══════════════════════════════════════════════════════════

## COMPREHENSIVE MODE (/prism-init full)

Everything in FAST mode, PLUS:

### A — Run Claude Code native /init first
Claude Code generates a project CLAUDE.md based on codebase analysis.
ATLAS then enriches it.

### B — Detailed stack detection
Parse package.json, requirements.txt/pyproject.toml, Gemfile, go.mod,
composer.json, Dockerfile, .env.example.

### C — Language-specific rules
Based on detected stack, create .claude/rules/{lang}.md templates.

### D — MCP suggestions based on stack
Read mcp-registry.md, match detected stack to relevant MCPs.

### E — Install companion tools automatically
Unlike FAST mode (asks), COMPREHENSIVE mode defaults to installing
all 4 companions unless user explicitly declined.

### F — Offer to install dependencies automatically
kokoro-tts, ffmpeg, playwright if relevant to detected work.

## CRITICAL RULES

- Never install without showing command first
- Never install paid tiers (Browser Use Cloud, ElevenLabs, etc.)
- Respect OS (brew on macOS, apt on Debian, manual on Windows)
- Skip already-installed tools
- If install fails, continue — don't abort init
- Report honestly what succeeded/failed
- Never re-init existing projects — offer to merge/update

## WHAT /prism-init DOES NOT DO

- Doesn't install MCP servers automatically (suggests only)
- Doesn't install paid services
- Doesn't modify existing CLAUDE.md content (appends only)
- Doesn't commit changes to git (user decides)
- Doesn't download Kokoro model files automatically (asks first — 620MB)
