# Simple-App Build Workflow — Live Classifier Routing

Injected the realistic prompt sequence a user fires when building a simple app,
through the genuine `prism-prompt-tier-router` hook. Tier = what PRISM would
route to BEFORE any conversation-model override.

| ID | Prompt | Tier | Panel | Verdict |
|----|--------|------|-------|---------|
| A1 | build a simple todo web app (add/complete/delete, localStorage) | haiku | no | borderline-OK (genuinely simple) |
| A2 | **plan** an expense tracker w/ Node backend + React frontend | **haiku** | no | **UNDER-ROUTED** (full-stack planning → weakest tier) |
| A3 | scaffold project structure + build tooling | **haiku** | no | **under-routed** |
| A4 | add a dark mode toggle | haiku | no | OK (small) |
| A5 | fix bug: completed todos don't persist on refresh | sonnet | no | good |
| A6 | write a currency formatter + unit tests | sonnet | no | good |
| A7 | **add user authentication (login/signup)** | **haiku** | no | **UNDER-ROUTED** (security-sensitive → weakest tier) |
| A8 | "same way we added dark mode, add a settings page" | sonnet | no | OK |
| A9 | deploy to production + run release checks | opus | no | correct (RELEASE_SAFETY_RE) |
| A10 | refactor API to service pattern + migrate data access | opus | **yes** | correct |

## Finding F6 (HIGH) — app-building workflows systematically under-route

Only **deploy (A9)** and **refactor+migrate (A10)** escalate. The core
app-building verbs — **plan, build, scaffold, add auth** — score 0–low on the
keyword-floor and fall to **haiku**. Two are clearly wrong:
- **A2 (plan full-stack app) → haiku.** Planning is exactly when you want the
  strongest tier + the panel. This is the same blind spot as F1/L03 (the
  classifier doesn't score "plan … backend … frontend").
- **A7 (add authentication) → haiku.** Auth is security-sensitive; routing it to
  the cheapest tier with no panel is a quality/risk concern.

The **conversation-model override** is the only safety net — and in THIS audit
session the keyword-floor scored the user's prompts 0→haiku **three times**,
each requiring a manual opus override. For a non-expert user building an app, the
override won't happen unless the Opus main loop reliably catches it.

→ Ties directly into recommended fix F1: extend opus/panel signal vocabulary to
cover build/plan/scaffold/auth/full-stack phrasing, and treat security-sensitive
verbs (auth, login, crypto, payment) as a tier floor.

## Refinement probes (confirm the mechanism)

| Prompt | Tier | Score |
|--------|------|-------|
| build a todo app with authentication | haiku | 0 |
| build a **simple** todo app with authentication | haiku | 0 |
| **plan the architecture for** an expense tracker w/ backend+frontend | opus | 8 |
| design and build a full-stack expense tracker application | haiku | 2 |
| implement **secure user authentication w/ password hashing + JWT** | **haiku** | **0** |

Corrected conclusion: **"simple" is NOT a de-escalator** (with/without both score
0). The real mechanism is narrow keyword-triggering — the literal token
"architecture" lifts a prompt to opus(8), but natural app-building phrasing
("build app", "authentication", "secure", "password hashing", "JWT", "backend
API", "frontend", "full-stack") scores 0–2 → haiku. The single most alarming
data point: **"implement secure user authentication with password hashing and
JWT sessions" → haiku, score 0** — security-critical work to the weakest tier.
