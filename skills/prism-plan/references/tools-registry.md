# ATLAS — External Tools Registry

This registry is consulted by:
- prism-hook.mjs for intent detection on every user prompt
- /prism-recommend for project-fit scoring
- @agent-factory --skill-research as the first lookup before external research
- /prism-init for which companions to auto-install
- @master-orchestrator before creating a new agent (check if external skill handles it)

ATLAS's compose-first stance (permanent): we recommend and invoke, we don't replicate.

---

## Tier classification

TIER 1 (auto-installed during /prism-init):
  Pre-vetted, high-fit, broadly useful. Hook uses INVOCATION tone.

TIER 2 (registered, not auto-installed):
  Useful for specific project types. Hook uses MID tone for recommendation.

TIER 3 (discovered via skill-research, pending promotion):
  Found dynamically. Auto-promoted to Tier 2 after 3+ successful recs.

---

# TIER 1 — Auto-installed during /prism-init

## 1. obra/superpowers
Category: Coding workflow (TDD, debugging, code review, git worktrees)
Install: /plugin install superpowers@claude-plugins-official
Stars: 152k | License: MIT | Maintained: Active

Intent keywords:
  TDD:   test-driven, write tests first, proper tests, test coverage,
         production-ready, red-green
  Debug: debug, root cause, systematic debug, can't figure out + hours,
         why won't this, keeps crashing, intermittent
  Review: code review, review my code, before ship, before PR, refactor this
  Worktree: git worktree, parallel branches, isolate this branch

Hook tone: INVOCATION (tool is installed)

## 2. affaan-m/everything-claude-code (OPTIONAL — heavy)
Category: Polyglot toolbox (10 language reviewers, security scan, skills catalog)
Install: /plugin marketplace add https://github.com/affaan-m/everything-claude-code
         /plugin install everything-claude-code@everything-claude-code
Stars: 159k | License: MIT | Maintained: Active

Status: OPTIONAL as of PRISM 2.2.1 — NOT auto-installed during /prism-init.
Why: 100+ skills catalog imposes a large per-turn token tax. Multiple users
reported high context costs outweighing benefits for everyday work. Install
manually via /prism-recommend --include-optional if you explicitly want
language-specific reviewers or AgentShield's deeper security scan.

Intent keywords:
  Language review: review my {typescript|python|go|java|kotlin|rust|swift|php|perl|c++|ruby} code
  Security: security scan, vulnerabilities, OWASP, CVE, secrets in config
  Polyglot: across multiple languages, frontend X backend Y

Hook tone: MID (was INVOCATION in 2.2.0 and earlier — demoted because tool is
no longer assumed installed). /prism-audit performs a PRISM-native
grep-based secret scan instead; use ECC's AgentShield for deeper coverage
only when installed.

## 3. nextlevelbuilder/ui-ux-pro-max-skill
Category: UI/UX design system generation (161 industry rules)
Install: npm install -g uipro-cli && uipro init --ai claude --global
Stars: 67k | License: MIT | Maintained: Active

Intent keywords:
  Design: design system, landing page, dashboard design, mobile UI,
          color palette, typography, style guide
  Styles: glassmorphism, neumorphism, bento grid, minimalism
  References: similar to Notion/Linear/Stripe/Apple
  Visual: make it look good, professional, polished, modern look

Hook tone: INVOCATION

## 4. browser-use/browser-use
Category: General browser automation library
Install: uv init && uv add browser-use && uv sync && uvx browser-use install
Stars: 83.5k | License: MIT | Maintained: Active

Intent keywords:
  Forms: fill form, apply for {job|loan}
  Shop/book: book flight/hotel/appointment, buy online
  Scrape: scrape site, extract data from site
  Auto: automate browser, log into X and

Hook tone: INVOCATION (distinct from ATLAS's app-expert which is for video screenshots)

---

# TIER 2 — Registered, install on demand

## 5. Anthropic Filesystem MCP
Install: add to settings.json mcpServers
Keywords: access files outside project, cross-project file work
Tone: MID

## 6. Anthropic GitHub MCP
Install: add to settings.json mcpServers (requires PAT)
Keywords: list issues, create PR, review this PR, search github for
Tone: MID

## 7. Context7 MCP (Upstash)
Install: add @upstash/context7-mcp to settings.json
Keywords: latest docs for, use the X API, how does X v{N}
Tone: MID

## 8. Playwright MCP
Install: add @playwright/mcp to settings.json
Keywords: screenshot this page, click through this flow, visual regression
Tone: MID
NOTE: Useful alongside ATLAS's app-expert pattern.

---

## Health check schedule
Agent-factory runs weekly (when invoked):
  ACTIVE (< 90d): no action
  STALE (180+d): flag in /prism-health
  DETERIORATING (90+d, issues climbing): pre-emptive backup research
  DEAD (365+d or archived): immediate rotation (Option A), mark DEPRECATED_DEAD,
    add researched alternative, notify user

## Auto-promotion Tier 3 → Tier 2 (ALL required)
- 3+ different intent contexts
- 2+ installs
- 14+ days since first rec
- Score > 5/7
- License permissive (MIT/Apache/BSD)
- Last commit < 90 days

## Demotion triggers (any)
- 3+ consecutive declines
- User came back within 7 days with same need after installing
- Flagged by /prism-audit tool-health check
- Manual /atlas-registry remove

---

Version: 1.0 (2026-04-18)
