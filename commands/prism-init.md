---
name: prism-init
description: Initialize PRISM project structure, write CLAUDE.md operating rules, offer Tier 1 companion tools
---

Two modes:
  /prism-init       → FAST mode (~1 min): structure + CLAUDE.md + offer companion installs
  /prism-init full  → COMPREHENSIVE (3-5 min): everything above + native /init + stack
                      detection + MCP suggestions + dependency check

## BOTH MODES — STEP 0: Ensure Git Repository

PRISM agents require a git repo to spawn (worktree isolation).

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo:
  Run: `git init`
  Create `.gitignore` with:
    ```
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
    ```
  Run: `git add -A && git commit -m "Initial commit — PRISM project init"`
  Report: "Initialized git repo (required for PRISM agent spawning)."

If ALREADY a git repo: skip silently.

## FAST MODE (default)

### Step 1 — Read README.md if it exists
Detect project name, domain, stack. Capture as `{name}`, `{domain}`, `{stack}` for later templating.

### Step 2 — Create PRISM project structure

```
CLAUDE.md                            ← Project identity + PRISM operating rules (see Step 3)
.claude/references/                  ← Indexed knowledge (filled by /prism-discover)
.claude/rules/                       ← Project-specific rules
tasks/todo.md                        ← Active work
tasks/lessons-tactical.md            ← Execution lessons (code-level)
tasks/lessons-strategic.md           ← Architecture decisions (cross-cutting)
CLAUDE.local.md                      ← Personal overrides (gitignored)
.mcp.json                            ← Empty MCP config
```

Do NOT overwrite an existing `CLAUDE.md`. If one is present:
- Read it.
- Detect whether it already contains a `## PRISM Operating Rules` section.
- If yes: skip Step 3.
- If no: APPEND the template from Step 3 at the end (do not reorder existing content).

### Step 3 — Write the PRISM CLAUDE.md template

This is the canonical scaffold. It encodes how PRISM routes every prompt, which
model handles what, when to dispatch to subagents, and the memory / context
hygiene habits. Write it to `CLAUDE.md` verbatim, substituting `{name}`,
`{domain}`, `{stack}` where indicated.

---

```markdown
# {name}

## Project Identity
- **Domain:** {domain}
- **Stack:** {stack}
- **Related projects:** (list siblings that share infra or conventions, if any)

## PRISM Operating Rules

PRISM is active on this project. These rules govern every prompt.

### 1. Classification — every prompt is tier-routed

The UserPromptSubmit hook classifies each prompt via
`hooks/lib/prism-opus-classifier.mjs` (Opus primary → Sonnet fallback →
24h cache → keyword floor). The classification is written to
`~/.claude/.prism-turn-tier-<session>.json` and drives downstream behaviour.

| Tier | Budget | Who executes | Example |
|---|---|---|---|
| **LIGHTWEIGHT** | ~2k tokens | Parent directly | "What's the flexbox centering syntax?" |
| **ROUTINE** | ~15k tokens | Single subagent (Haiku or Sonnet) | "Review this React component for bugs." |
| **NOVEL** | ~50k+ tokens | Master-orchestrator + expert panel | "Plan a real-time analytics dashboard." |

### 2. Orchestrator pattern — parent plans, subagents execute

The parent conversation (Opus) does: classification, planning, evaluation,
dispatch, synthesis. Subagents do: the actual work (reads, edits, searches,
tests). The mutation-guard (`hooks/prism-mutation-guard.mjs`) and
parent-dispatch-guard (`hooks/prism-parent-dispatch-guard.mjs`) enforce this
boundary for ROUTINE+ tiers:

- Parent calling `Edit`/`Write`/`MultiEdit` directly on ROUTINE/NOVEL tiers
  → blocked with a dispatch-first nudge.
- Subagent calls always pass (detected via `parent_tool_use_id`,
  `CLAUDE_CODE_ENTRYPOINT=subagent`, or `sentinel.dispatched=true`).
- Override for one-shot mutations: prefix prompt with `!opus-force:`.

### 3. Model selection — cheapest viable

Use the cheapest model that clears the quality bar. The
agent-model-guard (`hooks/prism-agent-model-guard.mjs`) nudges you on
every `Agent()` call without an explicit `model` field.

| Work | Model | Cost vs Opus |
|---|---|---|
| Typo fix, rename, docstring, trivial edit | `haiku` | ~1/15 |
| Single-file implementation, standard review | `sonnet` | ~1/5 |
| Cross-cutting architecture, novel domain, adversarial review | `opus` | 1× |

Always pass `model=` explicitly on `Agent()` calls. No default implicit to Opus.

### 4. NOVEL flow — panel of experts + master orchestrator

When the classifier returns `opus` tier OR the prompt contains novel
architectural stakes, the flow is:

1. `@master-orchestrator` is invoked (Opus).
2. It reads `~/.claude/skills/prism-plan/references/model-matrix.md`,
   `roster.json`, `mcp-registry.md`, `tools-registry.md`.
3. It identifies required specialists. For each gap it checks
   `tools-registry.md` FIRST (compose-first — see rule 7).
4. It assembles a panel (3–5 expert subagents, each pick their own stance).
5. It chairs **adversarial review** — every position must survive at least
   two substantive challenges before making the final plan.
6. It presents a phased plan with explicit "Deliberately NOT doing" section
   and waits for user approval.
7. On approval, it dispatches work to subagents in parallel where
   dependencies allow.

### 5. Parallel execution

When you have independent work, send multiple `Agent()` tool uses in a
single message. One turn = N parallel subagents, not N sequential turns.
This is the primary speed lever.

### 6. Memory + context hygiene

The session-start hook runs a daily context tax audit. The
UserPromptSubmit hook counts turns per session and nudges:

- **Turn 15:** `/clear` reminder + `memory-save-nudge` fires (save durable
  lessons to `tasks/lessons-*.md` BEFORE clearing).
- **Turn 20+:** strong `/clear` recommendation — quality degrades in long
  sessions.
- **Every 5 turns after 15:** repeat memory-save nudge.
- **Stop hook:** writes a rich session summary to
  `~/.claude/.prism-sessions/<session_id>.md`.

When you see a memory-save nudge, review the session and write any durable
insights to:
- `tasks/lessons-tactical.md` — code-level patterns, gotchas, fixes
- `tasks/lessons-strategic.md` — architecture decisions, trade-off rationale

### 7. Compose-first (Tier 1 tools)

Before building a new specialist agent, check
`~/.claude/skills/prism-plan/references/tools-registry.md`. If a Tier 1
tool handles the need, invoke it. If not, check Tier 2 and consider
installing via `/prism-recommend`. Only spawn the agent-factory when no
existing tool fits.

### 8. Safety

`hooks/prism-safety.mjs` hard-blocks: `rm -rf`, `DROP TABLE/DATABASE/SCHEMA`,
`TRUNCATE TABLE`, `git push --force`, `mkfs.*`, `dd if=*of=/dev/*`. No
override. Run these manually outside Claude Code if genuinely required.

### 9. Persistence + evolution

- `~/.claude/.prism-routing.jsonl` — every hook decision appended here. Use
  `tools/prism-monitor` to tail it.
- `skills/prism-plan/references/roster.json` — agent usage counts,
  effectiveness, last-used dates. Updated by `hooks/prism-subagent-stop.mjs`.
- `/prism-roster` — inspect the roster.
- `/prism-health` — overall PRISM state.
- `/prism-retire @name` — archive unused specialists.
- `/prism-update` — self-update (model-matrix, registries) every ~15 days.

## Build / Test / Lint

(fill in per stack — `npm run dev`, `pytest`, `ruff`, etc.)

## Conventions

(fill in — naming, testing strategy, file layout)
```

---

### Step 4 — Offer Tier 1 companion tools

Print:

```
PRISM composes with 2 Tier 1 companion tools that plug into the
orchestrator pattern. Optional Tier 2 tools are available via
/prism-recommend when the project genuinely needs them.

  TIER 1 (recommended, ~1 min total):

    [1] obra/superpowers            — TDD, debugging, code review, git worktrees
        /plugin install superpowers@claude-plugins-official

    [2] nextlevelbuilder/ui-ux-pro-max-skill — UI/UX design system
        npm install -g uipro-cli && uipro init --ai claude --global

  TIER 2 (on-demand via /prism-recommend, install only if needed):

    [·] affaan-m/everything-claude-code — Polyglot reviewers + AgentShield
        Heavy (~12k tokens of skill index per session). Install only if the
        project genuinely needs language-specific reviewers beyond
        Sonnet-subagent review.

    [·] browser-use/browser-use — General browser automation
        Heavy (~400 MB chromium). Install only if the project needs
        general-purpose form-filling, scraping, or booking flows.
        Consider Playwright MCP first for app-scoped work.

  How should I proceed?
    [A] Install Tier 1 (both — recommended)
    [B] Show me what each Tier 1 tool does first
    [C] Skip — I will use /prism-recommend later
    [D] Let me pick individually
```

Execute the user's choice. Skip silently if a tool is already installed.
Never install Tier 2 tools from this step — they go through `/prism-recommend`.

### Step 5 — Write tool status to CLAUDE.md

Append to `CLAUDE.md` at the end (after PRISM Operating Rules):

```markdown
## External Tools

Status (as of {ISO date}):
- Tier 1:
  - {✓|·} obra/superpowers — {installed|skipped}
  - {✓|·} nextlevelbuilder/ui-ux-pro-max-skill — {installed|skipped}
- Tier 2 (on-demand):
  - affaan-m/everything-claude-code — Tier 2, install via /prism-recommend
  - browser-use/browser-use — Tier 2, install via /prism-recommend

Registry: `~/.claude/skills/prism-plan/references/tools-registry.md`
Run `/prism-recommend` for project-specific fit analysis.
Run `/prism-audit` to scan PRISM surface for hygiene issues.
```

### Step 6 — Autonomous dependency check

Scan for:
- `node >= 18` (required)
- `python >= 3.10` (required)
- `notebooklm-py` (optional — enables free Tier 1 agent research)
- `ffmpeg` (optional — needed only if video-production skill will be used)
- `playwright` (optional — needed only for app-expert pattern)

For each missing one, print the exact install command and the capability it
unlocks. Do NOT auto-install. Tell the user they can run `/prism-deps` to
install any or all.

### Step 7 — Final report

```
═══════════════════════════════════════════════════════════
PRISM — Project Initialized
═══════════════════════════════════════════════════════════

PROJECT: {name}
STACK:   {stack}
DOMAIN:  {domain}

CREATED:
  - CLAUDE.md (with PRISM Operating Rules)
  - .claude/references/
  - .claude/rules/
  - tasks/{todo,lessons-tactical,lessons-strategic}.md
  - CLAUDE.local.md
  - .mcp.json

COMPANION TOOLS (Tier 1): {N}/2 installed
  {list}

DEPENDENCIES:
  node:       {✓/✗}
  python:     {✓/✗}
  notebooklm: {✓/✗}
  ffmpeg:     {✓/✗}
  playwright: {✓/✗}

NEXT STEPS:
  → /prism-discover      Index database, codebase, APIs into .claude/references/
  → /prism-recommend     Project-specific Tier 2 fit analysis
  → /prism-health        Overall PRISM status
  → /prism-roster        Inspect specialist agents

═══════════════════════════════════════════════════════════
```

## COMPREHENSIVE MODE (`/prism-init full`)

Everything in FAST mode, PLUS:

### A — Run Claude Code's native `/init` first
Claude Code generates a deep project CLAUDE.md based on codebase analysis.
PRISM then appends its Operating Rules section (Step 3) if not already present.

### B — Detailed stack detection
Parse `package.json`, `requirements.txt`/`pyproject.toml`, `Gemfile`,
`go.mod`, `composer.json`, `Dockerfile`, `.env.example`. Populate the
**Build / Test / Lint** section of CLAUDE.md with detected commands.

### C — Language-specific rules
For each detected language, create `.claude/rules/{lang}.md` with a
minimal template (naming, testing pattern, typing discipline).

### D — MCP suggestions based on stack
Read `mcp-registry.md`, match detected stack to relevant MCPs, print a
list of suggested installs with exact commands.

### E — Install Tier 1 companions automatically
Unlike FAST mode (asks), COMPREHENSIVE mode defaults to installing both
Tier 1 tools unless the user explicitly declines.

### F — Offer to install optional dependencies
`notebooklm-py`, `ffmpeg`, `playwright` — offer with exact commands.

## CRITICAL RULES

- Never install without showing the command first.
- Never install Tier 2 tools from `/prism-init` — use `/prism-recommend`.
- Never install paid tiers (Browser Use Cloud, ElevenLabs, etc.).
- Respect OS (brew on macOS, apt on Debian, manual on Windows).
- Skip already-installed tools.
- If an install fails, continue — don't abort init.
- Report honestly what succeeded / failed.
- Never re-init an existing project destructively — APPEND to existing CLAUDE.md only.

## WHAT `/prism-init` DOES NOT DO

- Does NOT install MCP servers automatically (suggests only, in COMPREHENSIVE mode).
- Does NOT install paid services.
- Does NOT overwrite existing CLAUDE.md content — only appends.
- Does NOT commit changes to git (user decides).
- Does NOT download large model files (Kokoro, Whisper) automatically.
- Does NOT install Tier 2 companions (ECC, browser-use) — those require `/prism-recommend`.
