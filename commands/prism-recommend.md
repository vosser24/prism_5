---
name: atlas-recommend
description: Scan project and recommend external tools with fit-scoring
---

Analyze the current project and recommend external tools from the registry.

## PROTOCOL

### Step 1 — Read project context
- CLAUDE.md → Project Identity (name, domain, stack)
- package.json / requirements.txt / Gemfile / go.mod / pyproject.toml
- .claude/references/codebase-map.md if exists

### Step 2 — Read the registry
~/.claude/skills/prism-plan/references/tools-registry.md

Check install status:
- /plugin list for plugin-based tools
- uv pip list | grep for Python packages
- cat settings.json for MCP servers

### Step 3 — Compute fit score per tool (0-5)

SUPERPOWERS:
  +2 if project has test files
  +1 if git repo with active development
  +1 if production-facing (CI config, deployment docs)
  +1 if codable (has source files)

ECC (OPTIONAL — high token tax; recommend only when fit ≥ 4):
  +2 if polyglot (2+ language files)
  +1 if team project (multiple contributors)
  +1 if sensitive config (secrets, auth, payments)
  +1 if compliance mentioned (GDPR, SOC2, HIPAA)
  Note: NOT shown in default output unless fit ≥ 4. User must opt in.

UI-UX-PRO-MAX:
  +3 if frontend framework (React, Vue, Next.js, Svelte, SwiftUI)
  +2 if HTML/CSS files present
  +1 if CLAUDE.md mentions design/marketing
  -2 if pure backend

BROWSER-USE:
  +2 if scraping/automation/web-testing context
  +1 if playwright/puppeteer/selenium in deps
  +1 if CLAUDE.md mentions automation
  Default: 1

Clamp 0-5.

### Step 4 — Present recommendations

Format table (Tier 1 auto-installed tools shown by default):
  TOOL                    FIT   STATUS          ACTION
  ─────────────────────────────────────────────────────
  superpowers             5/5   installed       ready to invoke
  ui-ux-pro-max          2/5   installed       ready to invoke
  browser-use             4/5   installed       ready to invoke

ECC is OPTIONAL — shown only if fit ≥ 4 AND user passes --include-optional:
  everything-claude-code  4/5   not installed   optional — /plugin install

### Step 5 — Offer to install high-fit Tier 2 tools (fit ≥ 3)

Ask: Install all / Select / Skip

### Step 6 — Save results

Write to .claude/tools-scan.json for /prism-health cross-ref.

## FLAGS
/prism-recommend             → full scan + offer installs
/prism-recommend --check     → scan only
/prism-recommend --re-check <tool>  → re-score specific tool

## RULES
- Never install silently — always confirm
- Never install paid tiers (Browser Use Cloud, ElevenLabs)
- Respect OS (brew on macOS, apt on Linux)
- Skip already-installed tools
- If tool is DEPRECATED in registry: don't recommend
