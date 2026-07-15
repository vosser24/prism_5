# Model Capability Matrix
# Last updated: 2026-06-25 (PRISM v6.0.2)
# Update via /prism-update or @prism-updater (15-day cadence)

## Fable 5 (claude-fable-5) — OPTIONAL TOP TIER
- Cost: $10/MTok input, $50/MTok output (cache: $12.50 write / $1.00 read)
- Context: 1M tokens
- Use for: tasks requiring maximum capability beyond Opus — only when Opus
  demonstrably falls short (very long-horizon reasoning, highest-stakes review)
- Never for: routine work; cost is 2× Opus
- Note: Mythos 5 (same tier) is Project-Glasswing-only; not available for
  general use. Use Fable 5 for this tier.

## Opus 4.8 (claude-opus-4-8) — DEFAULT OPUS
- Cost: $5/MTok input, $25/MTok output (cache: $6.25 write / $0.50 read)
- Context: 1M tokens (with `[1m]` suffix); 200K tokens otherwise
- Use for: architecture, system design, security review, complex debugging,
  contract/legal, strategy, financial modeling, new agent creation,
  master-orchestrator dispatch, adversarial review synthesis, panel chairing
- Never for: boilerplate, scaffolding, simple edits, file discovery
- Note: current default Opus. The PRISM classifier (`hooks/lib/prism-opus-classifier.mjs`)
  should use `claude-opus-4-8` as DEFAULT_MODEL. Opus 4.7 (legacy/active, same
  $5/$25 price) and Opus 4.6 (legacy/active, same $5/$25 price) still work if
  explicitly requested. Opus 4.1 is DEPRECATED — retires 2026-08-05, do not use.

## Opus 4.7 (claude-opus-4-7) — LEGACY/ACTIVE
- Cost: $5/MTok input, $25/MTok output (cache: $6.25 write / $0.50 read)
- Context: 1M tokens (with `[1m]` suffix); 200K tokens otherwise
- Use for: same as Opus 4.8 when explicitly pinned; prefer 4.8 for new work
- Note: previous-gen default; still available and priced identically to 4.8.

## Sonnet 4.6 (claude-sonnet-4-6)
- Cost: $3/MTok input, $15/MTok output (cache: $3.75 write / $0.30 read)
- Context: 1M tokens
- Use for: ~80% of tasks — implementation, bug fixes, tests, code review,
  docs, refactoring, data transformation, agent upgrades, classifier fallback
- Never for: architecture decisions, complex system design, adversarial review

## Haiku 4.5 (claude-haiku-4-5-20251001)
- Cost: $1/MTok input, $5/MTok output (cache: $1.25 write / $0.10 read)
- Context: 200K tokens
- Use for: exploration, file discovery, scaffolding, data extraction,
  schema scanning, formatting, boilerplate, Pass 1 of two-pass pattern,
  trivial edits (typo fix, rename, docstring)
- Never for: nuanced reasoning, complex trade-offs, architecture, panel work

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
