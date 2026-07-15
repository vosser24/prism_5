---
name: claude-code-expert
description: >
  Activate this skill for ANY question or task involving Claude Code CLI — including setup,
  configuration, optimization, CLAUDE.md management, skills architecture, hooks design,
  subagents, agent teams, MCP integration, plugins, token cost reduction, model selection,
  performance tuning, capability questions, session management, permission modes, or
  deciding which Claude Code feature to use. Also auto-activates whenever running inside
  a Claude Code session to enforce optimized execution patterns. Trigger on: "how do I",
  "what's the best way", "optimize", "set up", "configure", "which feature", "should I use",
  "help me build", "improve my workflow", "reduce tokens", "cost", "speed up", "automate",
  "agent", "subagent", "hook", "skill", "CLAUDE.md", "plugin", "MCP", "permission",
  "model", "Haiku", "Sonnet", "Opus", "Task tool", "claude --resume", "worktree",
  "parallel", "background agent", "fork", "context window". When in doubt, activate —
  the cost of not activating on a Claude Code task is a suboptimal execution pattern.
model: inherit
effort: high
---

# Claude Code Expert Skill

## Purpose

This skill makes Claude an expert practitioner of Claude Code — always current, always
optimizing for capability, token efficiency, and execution quality. It governs:

1. **Self-updating knowledge** — searches for latest Claude Code capabilities on activation
2. **Capability selection** — decides which feature to use for each task
3. **CLAUDE.md architecture** — keeps the project constitution lean and effective
4. **Token optimization** — minimizes cost without sacrificing output quality
5. **Execution patterns** — enforces best practices across the full Claude Code stack

---

## Step 0 — Self-Update on Activation

**Every time this skill activates, run a targeted web search before advising.**

```
Search: "Claude Code latest features capabilities [current year]"
Search: "Claude Code CLAUDE.md best practices [current year]"
```

Why: Claude Code ships updates frequently. Advising from stale knowledge produces
suboptimal configurations. Always verify against current docs before recommending.

Extract and note:
- Any new features since knowledge cutoff
- Any deprecated patterns to avoid
- Any new model tiers or pricing changes
- Any new hook types, agent capabilities, or MCP integrations

Integrate findings before proceeding. Flag anything that changes the recommendation.

---

## The Claude Code Capability Stack (as of April 2026)

| Layer | Feature | Introduced | Purpose |
|-------|---------|------------|---------|
| Core | CLAUDE.md | Feb 2025 | Project constitution — primary source of truth |
| Core | Skills | Oct 2025 | Domain expertise loaded on-demand |
| Core | Slash Commands | Feb 2025 | Repeatable prompt shortcuts |
| Extension | MCP Servers | Nov 2024 | External tools, databases, APIs (300+ integrations) |
| Extension | Hooks | Sep 2025 | Deterministic actions regardless of model judgment |
| Extension | Plugins | Oct 2025 | Packaged bundle: skills + commands + agents + hooks + MCP |
| Delegation | Subagents | Jul 2025 | Isolated context workers, report to parent |
| Delegation | Agent Teams | Feb 2026 | Peer-to-peer multi-agent coordination |
| Session | --resume / --continue | Feb 2025 | Session persistence and recovery |
| Session | Background agents | 2025 | Async work via Ctrl+B |
| Session | Git worktrees | 2025 | Isolated branches per agent |

---

## Capability Selection Decision Framework

Use this before recommending any Claude Code feature.

```
Does the task require repeatable domain expertise or workflow steps?
  YES → Use SKILL.md
  (Examples: code review standards, security patterns, deployment workflows)

Does the task need to always execute deterministically, regardless of model judgment?
  YES → Use Hook
  (Examples: format on save, block .env access, log all bash commands, notify on completion)

Does the task require external tools, databases, or APIs?
  YES → Use MCP Server
  (Examples: GitHub PRs, PostgreSQL queries, Slack messages, Jira tickets)

Does the task need isolated context to prevent main session bloat?
  YES → Is it ONE subtask or MANY parallel subtasks?
    ONE → Use Subagent via Task tool (general-purpose, Explore, or Plan)
    MANY → Use Agent Team (v2.1.32+, Feb 2026)
  NO → Prompt directly in main session

Does the task bundle multiple capabilities for distribution or reuse?
  YES → Use Plugin (packages skills + commands + agents + hooks + MCP)

Does the task require a repeatable slash command trigger?
  YES → Use Slash Command (single file, /command UX, can invoke skills/agents)
```

---

## CLAUDE.md Architecture

### Core Principle
CLAUDE.md is the agent's constitution. It must be **lean, structured, and evergreen**.
Heavy domain instructions belong in skill files. CLAUDE.md holds only what's always needed.

### Size Budget
- **Target:** Under 200 lines for most projects
- **Maximum:** 500 lines before mandatory refactor into skill files
- **Rule:** If an instruction applies to <30% of tasks, it belongs in a skill, not CLAUDE.md

### Mandatory Sections
```markdown
## Project Context
[What this project is, tech stack, key paths, 5–10 lines max]

## Skills
[Active skills list + session start protocol]

## Constraints
[Hard rules Claude must always follow — short, bullet form]

## Model Selection
[When to use Haiku / Sonnet / Opus for this project]

## Hooks
[Active hooks list and what they govern]

## MCP Servers
[Connected servers and their purpose]
```

### What Does NOT Belong in CLAUDE.md
- Step-by-step domain workflows → move to skill files
- Long examples or templates → move to skill files or `/docs`
- Rarely used instructions → move to skill files with path-based auto-load
- Project history or decisions → move to `docs/decisions/`

### Splitting Strategy
When CLAUDE.md grows too large:
1. Identify instruction clusters by domain (testing, deployment, security, etc.)
2. Create a SKILL.md per cluster in `.claude/skills/[domain]/`
3. Set `paths:` frontmatter to auto-load only when relevant files are open
4. Remove the instructions from CLAUDE.md, add skill reference

---

## Model Selection Strategy

**Always match model to task complexity. Cost difference is 5x between Haiku and Opus.**

| Model | Use for | Cost tier | Context |
|-------|---------|-----------|---------|
| **Haiku** | Exploration, file search, quick reads, subagent scouting | Cheapest | 200K |
| **Sonnet** | General work, most implementation, default | Mid | 1M (beta) |
| **Opus** | Complex reasoning, architecture decisions, hard bugs | 5x Sonnet | 200K |

### Token Optimization Patterns

**Pattern 1 — Exploration-first with Haiku subagents**
Before Sonnet/Opus touches a large codebase, spawn Haiku subagents to explore:
- Map the codebase structure
- Find relevant files for the task
- Return a scoped context summary
Main session then works with the summary, not the raw codebase. Saves 60–80% of input tokens on large repos.

**Pattern 2 — Master-Clone over Lead-Specialist**
Prefer spawning clones of the main agent (Task tool with general-purpose) over custom specialist subagents.
- Specialist subagents gatekeep context — main agent loses reasoning ability
- Clones inherit full CLAUDE.md context — reasoning stays holistic
- Exception: security reviewer, db-reader, or other permission-restricted roles

**Pattern 3 — Skill lazy-loading**
Use `paths:` frontmatter to load skills only when relevant files are open.
A security skill with `paths: "src/**/*.ts"` doesn't consume tokens on Python files.
A deploy skill with `paths: ".github/workflows/**"` only loads during CI work.

**Pattern 4 — Context forking for large tasks**
Use `context: fork` in skill frontmatter for tasks that generate large working context.
The skill runs in an isolated subagent — only the output returns to main session.
Main context stays clean.

**Pattern 5 — Agent Teams for parallel independent work**
When N tasks are independent and each needs full context:
- Subagents: context bloat multiplies (N × working context returns)
- Agent Teams: each agent has own context window, only conclusions shared
Use Agent Teams for: reviewing N modules, researching N topics, testing N scenarios

**Pattern 6 — Hook for zero-token deterministic actions**
Any action that must always run (format, validate, notify) costs zero tokens as a hook.
Using prompts or reminders for these is pure token waste.

---

## Subagent Architecture

### Built-in Subagents (auto-invoked, use these before creating custom)
| Agent | Purpose | Model | Use for |
|-------|---------|-------|---------|
| **Explore** | Fast read-only codebase analysis | Haiku | Mapping, searching, scouting |
| **Plan** | Research and planning | Sonnet | Pre-implementation analysis |
| **General-purpose** | Complex multi-step work | Sonnet | Implementation, modification |

### Custom Subagent Frontmatter Reference
```yaml
---
name: agent-name
description: >
  [Critical — Claude uses this for auto-delegation decisions.
   Include task keywords, domain signals, and when to invoke.]
model: haiku          # haiku / sonnet / opus / inherit
tools: [Read, Grep, Glob, Bash]
disallowedTools: [Write]  # for read-only agents
permissionMode: default   # default / acceptEdits / bypassPermissions / plan
maxTurns: 20
effort: medium        # low / medium / high / max
isolation: true       # git worktree isolation
memory: |
  Update your memory as you discover key paths, patterns, and decisions.
  Write concise notes about what you found and where.
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---
[System prompt here]
```

### Subagent Constraints
- Subagent recursion is fragile: older builds stripped the `Agent` tool from subagents (no recursion at all); current builds may allow a nested spawn, but it readily stalls the tree — treat dispatch as **main-loop-only**
- Subagents report back to parent — they don't communicate peer-to-peer
- For peer-to-peer coordination → use Agent Teams instead

---

## Agent Teams Architecture (Feb 2026, v2.1.32+)

### When to Use
- 3+ independent tasks that each benefit from full context
- Tasks that need to challenge each other's findings
- Parallel research across N domains
- Multi-module review or testing
- Any scenario where subagent context isolation creates reasoning gaps

### Architecture Pattern
```
Lead agent (Sonnet/Opus)
  → coordinates via shared task list
  → spawns teammate agents
  → each teammate: full context window, independent reasoning
  → teammates can message each other directly
  → lead synthesises final output
```

### Agent Team vs Subagent Decision
| Scenario | Use |
|----------|-----|
| One isolated subtask, output summary back | Subagent |
| Multiple subtasks, each needs peer context | Agent Team |
| Tasks need to challenge each other | Agent Team |
| Strict permission/tool isolation needed | Subagent |
| N modules reviewed simultaneously | Agent Team |

---

## Hooks Reference

### Hook Types
| Type | Trigger | Use for |
|------|---------|---------|
| `PreToolUse` | Before any tool executes | Validate, block, log |
| `PostToolUse` | After any tool executes | Notify, format, record |

### Exit Codes
| Code | Effect |
|------|--------|
| 0 | Allow operation |
| 2 | Block operation, feed error to Claude |
| Other | Allow (with warning) |

### High-Value Hook Patterns
```yaml
# Notify on task completion
PostToolUse:
  - matcher: "Bash"
    hooks:
      - type: command
        command: "./scripts/notify-complete.sh"

# Block .env file access
PreToolUse:
  - matcher: "Read"
    hooks:
      - type: command
        command: "./scripts/block-env-files.sh"

# Log all bash commands for audit
PreToolUse:
  - matcher: "Bash"
    hooks:
      - type: command
        command: "./scripts/log-command.sh"

# Format TypeScript after edit
PostToolUse:
  - matcher: "Write"
    hooks:
      - type: command
        command: "./scripts/format-ts.sh"
```

### Hook vs Prompt Decision
- Must always execute regardless of Claude's judgment → **Hook**
- Contextual, depends on reasoning → **Prompt**
- Security/compliance controls → **always Hook** (prompts can be forgotten)

---

## Session Management

### Key Commands
```bash
claude --continue          # Resume most recent session
claude --resume            # Interactive session picker
claude --resume [id]       # Resume specific session by ID
Ctrl+B                     # Send current task to background, keep working
```

### Session History
- All sessions stored at `~/.claude/projects/[project]/`
- Use `--resume` to recover interrupted long-running tasks
- Use session logs for meta-analysis: common errors, permission patterns, failure modes
- Feed meta-analysis findings back into CLAUDE.md and lessons files

### Context Window Management
- Sonnet 4.6: 1M token context (beta), 64K output (128K max)
- Monitor context consumption — at 60%+ consider checkpointing or forking
- Use `tasks/todo.md` checkpoints to survive context exhaustion
- Spawn Haiku subagents early to avoid filling main context with exploration

---

## Plugin Architecture

### When to Use Plugins
- Distributing a capability bundle across projects or teams
- Packaging skills + commands + agents + hooks + MCP as a unit
- Installing curated capability sets via `/plugins`

### Plugin Structure
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json        # manifest
├── skills/
│   └── my-skill/
│       └── SKILL.md
├── agents/
│   └── my-agent.md
└── commands/
    └── my-command.md
```

### Plugin Constraints
- Plugin subagents do NOT support: hooks, mcpServers, permissionMode
- Skills in plugins are namespaced: `/my-plugin:skill-name`
- Plugins installed via `/plugins` command

---

## CLAUDE.md Self-Maintenance Protocol

After every 5 sessions or after any significant correction:

1. **Audit CLAUDE.md size** — if over 300 lines, identify extraction candidates
2. **Review lessons files** — extract durable patterns back into CLAUDE.md or skills
3. **Check skill descriptions** — update trigger phrases if skills are missing activations
4. **Review hook coverage** — identify any repeated prompts that should become hooks
5. **Check MCP utilization** — flag any MCP servers that haven't been used in 10 sessions
6. **Model usage audit** — check if Opus is being used for tasks Sonnet could handle

Log CLAUDE.md changes with rationale:
```markdown
## CLAUDE.md Changelog
- [date] Extracted testing instructions to .claude/skills/testing/SKILL.md (size reduction)
- [date] Added hook for TypeScript formatting (was a repeated prompt)
- [date] Updated model selection: Haiku now default for exploration subagents
```

---

## Integration With Skills Stack

This skill integrates with the full Blueprint + Workflow + Router stack:

| This skill provides | The stack uses it for |
|--------------------|----------------------|
| Capability selection decision tree | Router decides which Claude Code features to activate per task |
| Model selection strategy | Workflow applies correct model tier per execution step |
| CLAUDE.md architecture | Blueprint reads CLAUDE.md structure to understand project context |
| Token optimization patterns | Workflow applies context-saving patterns during execution |
| Hook design | Router enforces deterministic behaviors outside prompt flow |
| Subagent/Team architecture | Workflow's subagent coordination clause applies correct pattern |

When this skill fires in combination with blueprint-prompt and workflow-orchestration:
- Blueprint gains Claude Code-specific expert voice in the panel
- Workflow applies Claude Code-optimized execution patterns
- Router routes tasks to the correct Claude Code feature layer
