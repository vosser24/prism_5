---
name: atlas-app-expert
description: Create or update an app expert agent for a specific application
---

Usage:
  /prism-app-expert <app-name>           → create new app expert
  /prism-app-expert <app-name> --update  → refresh existing app expert's knowledge
  /prism-app-expert --list               → list all app experts in roster

App experts are Playwright-driven specialists that know ONE app as a power user.
Used by video-production skill to capture screenshots on demand.

PROTOCOL:

1. Parse arguments:
   - <app-name>: kebab-case identifier (e.g., "praktiker", "dpharmacy")
   - --update: existing agent flag
   - --list: show all app experts

2. Check preconditions:
   - Playwright installed? If NO: prompt to install:
     npm install -D @playwright/test && npx playwright install chromium
   - Is this project a git repo? (required for factory)

3. Ask user (if not --update):
   - Staging URL?
   - Local dev URL (if any)?
   - Test credentials path? (env var name, 1Password entry, etc.)
   - Which key flows to prioritize? (login, browse, checkout, admin, search)
   - Sensitive data zones? (what to redact — emails, cards, etc.)
   - Tech stack? (helps NotebookLM research)

4. Spawn @agent-factory with the APP EXPERT BLUEPRINT from the
   video-production skill. Pass user inputs as context.
   Expected duration: 20-30 minutes (Tier 1 research).

5. After factory completes:
   - Verify agent has notebook_id in frontmatter
   - Verify references/app-map.md exists and is non-empty
   - Verify references/flows/ contains at least login.ts
   - Register in roster with scope="app", app_name=<name>

6. Test the agent:
   @<app-name>-app-expert Verify you can navigate to the staging URL 
   and capture a homepage screenshot. Report status.

7. Report:
   "Created @<app-name>-app-expert. Try:
     @<app-name>-app-expert capture homepage as public/screenshots/test.png"

USE CASES:
- Proactively creating before a video task (faster when video needed)
- After major app refactor (--update to refresh flows)
- Agency setup (one app expert per client app)
