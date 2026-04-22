# Model Capability Matrix
# Update via /prism-update or @atlas-updater

## Opus 4.6 (claude-opus-4-6)
- Cost: $5/MTok input, $25/MTok output | Context: 1M tokens
- Use for: architecture, system design, security review, complex debugging,
  contract/legal, strategy, financial modeling, new agent creation, orchestration
- Never for: boilerplate, scaffolding, simple edits, file discovery

## Sonnet 4.6 (claude-sonnet-4-6)
- Cost: $3/MTok input, $15/MTok output | Context: 1M tokens
- Use for: 80% of tasks — implementation, bug fixes, tests, code review,
  docs, refactoring, data transformation, agent upgrades
- Never for: architecture decisions, complex system design

## Haiku 4.5 (claude-haiku-4-5-20251001)
- Cost: $1/MTok input, $5/MTok output | Context: 200K tokens
- Use for: exploration, file discovery, scaffolding, data extraction,
  schema scanning, formatting, boilerplate, Pass 1 of two-pass pattern
- Never for: nuanced reasoning, complex trade-offs, architecture

## Routing Table
| Task | Model |
|------|-------|
| Codebase exploration, file discovery | haiku |
| Research, web search, doc gathering | haiku |
| Boilerplate, scaffolding, templates | haiku |
| Database schema extraction | haiku |
| Feature implementation from spec | sonnet |
| Bug fixing, test writing, code review | sonnet |
| Documentation, content writing | sonnet |
| Refactoring, multi-file edits | sonnet |
| Agent upgrade (incremental) | sonnet |
| Architecture decisions | opus |
| System design, integration planning | opus |
| Security review, vulnerability scan | opus |
| Complex debugging (cross-layer) | opus |
| Contract/legal analysis | opus |
| Strategy, business decisions | opus |
| New agent creation | opus |

## Two-Pass Pattern (saves 40-60%)
Pass 1 (Haiku): explore/scan cheaply → compressed summary (200-500 tokens)
Pass 2 (Sonnet/Opus): execute with targeted context only

## Dynamic Selection Rules (used by orchestrator)
Instead of always using the routing table, adapt based on agent experience:

| Agent Experience | Task Complexity | Model |
|-----------------|----------------|-------|
| New (0-2 tasks) | Complex/novel | opus |
| New (0-2 tasks) | Routine | sonnet |
| Experienced (3+) | Complex/novel | sonnet (try first, escalate if fails) |
| Experienced (3+) | Routine | sonnet |
| Any | Exploration/scanning | haiku |
| Any | Security/financial | opus (always) |

Escalation rule: if sonnet produces output that gets corrected,
log the correction and escalate to opus for the retry.
After 3 escalations for the same agent: update its default model to opus.

Cost tracking: log model used per task step to workspace/model-log.md.
After 10+ tasks, review: were opus calls justified? Could sonnet have handled it?
