# PRISM

## Project Identity
- **Domain:** Cognitive-tier orchestration for agentic coding — tier routing, adversarial expert panels, and persistent project memory for Claude Code sessions.
- **Stack:** Node.js (ESM, dep-free deterministic hooks + CLI tools under `tools/` and `hooks/`); Python (for the bundled monitor + subagent-summary helpers); PowerShell + Bash install/uninstall scripts. Local-first, no network at the core.
- **Related projects:** Installs into `~/.claude/` (global Claude Code config). Shipped/distributed as `prism_5` (see README install section).

## PRISM Operating Rules

PRISM is active on this project. These rules govern every prompt.

### 1. Classification — every prompt is tier-routed

The UserPromptSubmit hook classifies each prompt via
`hooks/lib/prism-opus-classifier.mjs` — a deterministic, dependency-free
keyword/score classifier (no model API call). Precedence: `!opus-force:`
prefix → slash-command allowlist → 24h cache → keyword-floor regex/score.
The conversation model can self-override the tier as its first action of a
turn (the next-turn sentinel-write). The classification is written to
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

When the classifier returns `opus` tier the master orchestrator leads the
work. The **expert panel fires ONLY on explicit user request** (`/panel`,
"run the panel", "summon the panel" — EXPLICIT_PANEL_RE). On opus turns
without an explicit panel request the master works directly. As a best-effort
judgment call the master MAY offer the panel in one line when it sees an
irreversible/high-stakes decision — plain chat, no mechanism, never blocks
work. (Legacy auto-fire behind `PRISM_LEXICAL_PANEL=1` — D034.)

When the panel IS summoned (explicitly), the flow is:

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

`hooks/prism-safety.mjs` hard-blocks dangerous shell commands: `rm -rf` on
**dangerous/unverifiable targets** (`/`, `~`, home/system paths) — a specific
relative subdir like `rm -rf ./build` or `node_modules` is **allowed**
(target-aware, UAT-4); pipe-to-shell installers (`curl … | bash`, `wget … | sh`);
`DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE TABLE`,
`git push --force`, `mkfs.*`, `dd if=*of=/dev/*`. No override. Run a genuinely
blocked command manually outside Claude Code if required.

### 9. Persistence + evolution

- `~/.claude/.prism-routing.jsonl` — every hook decision appended here. Use
  `tools/prism-monitor` to tail it.
- `skills/prism-plan/references/roster.json` — agent usage counts,
  effectiveness, last-used dates. Updated by `hooks/prism-subagent-stop.mjs`.
- `/prism-roster` — inspect the roster.
- `/prism-health` — overall PRISM state.
- `/prism-retire @name` — archive unused specialists.
- `/prism-update` — self-update (model-matrix, registries) every ~15 days.

### 10. CLAUDE.md sizing discipline

This file is a **routing table, not a knowledge base**. Claude Code loads
every CLAUDE.md along the path from cwd up on every turn, so growth here
is paid on every prompt forever. Detail lives elsewhere.

- **Target: ≤200 lines for this root CLAUDE.md.** Over that, move
  detail OUT to one of the destinations below.
- **What stays here:** project identity, stack summary, operating
  rules, build/test/lint commands, 1–2 line routing pointers like
  *"for DB schema, read `.claude/references/db-index.md`"*.
- **What moves OUT:**
  - Indexed scans (DB schema, codebase map, API specs) →
    `.claude/references/<domain>-{index,full}.md` via `/prism-discover`.
  - Subdomain-specific conventions (backend vs frontend stack rules) →
    nested `CLAUDE.md` in that subdir (auto-loaded only when working
    there — not always-on). `/prism-discover` detects candidates.
  - Accumulated code-level lessons → `tasks/lessons-tactical.md`
    (append-only).
  - Architecture decisions + trade-off rationale → `tasks/lessons-strategic.md`.
  - Per-session recap → written by the Stop hook to
    `~/.claude/.prism-sessions/<session_id>.md`.
  - Personal overrides that must not be committed → `CLAUDE.local.md`
    (gitignored).
- **Nested CLAUDE.md files** (only when subdomains diverge):
  - Each stays ≤100 lines.
  - Covers ONLY what differs from root — never repeats project-wide
    rules (those cascade from root automatically).
  - `/prism-discover` proposes nested files when it detects distinct
    tech-stack subdomains; user approves per-subdomain.
  - Scaffolded subdomain map lives at `.claude/references/subdomain-map.md`.
- **Health check (manual):** ask `/prism-discover` to audit the CLAUDE.md
  chain — an LLM-driven repo walk warning on size/duplication violations
  (see `skills/prism-discover/SKILL.md`); no standalone CLI flag exists.

## Reference Files

Indexed by `/prism-discover`. Load the compact index first; read full detail on demand.

- Codebase map (compact) → `.claude/references/codebase-map.md`
- Codebase detail (full) → `.claude/references/codebase-detail.md`
- Subdomain map → `.claude/references/subdomain-map.md`

## Build / Test / Lint

- **Install (idempotent, in-place upgrade):** `node tools/prism-installer.mjs install`
  (wrappers: `pwsh ./install.ps1` on Windows, `bash install.sh` on POSIX).
- **Verify install:** `node tools/prism-installer.mjs verify`
- **Tests (full suite):** `bash tests/v3/run-all.sh --static-only` — ~6 min, 242
  discovered / 235 runnable files as of 2026-07-29. Discovery is `git ls-files`-based, NOT `find`, so the
  count reproduces across checkouts (a bare `find` picks up gitignored and
  machine-local files). The script prints its discovery mode every run.
- **Expected failure — do NOT "fix" it:** `dispatch-preamble.test.mjs` assertion
  6e is a **locked, permanent** red per
  `docs/prism/adjudications/D057-absence-claim-tripwire-and-chestertons-fence.md` §6.
  A green full suite would mean someone narrowed it. Everything else must pass.
- **Single file:** `node <test-file>.mjs`. Excluded from the suite: `tests/v3/bench/`
  (gitignored benchmark tree) and a short `NON_TEST_FILES` list in run-all.sh —
  both non-tests, not hidden reds. `tools/test-prism-gaps.mjs` tests an *installed*
  `~/.claude`, not this repo, and is intentionally separate.

## Conventions

- Hooks and tools are **ESM `.mjs`, dependency-free at the core** — no network,
  no API keys. Keep new hooks deterministic and side-effect-isolated.
- Hooks live in `hooks/`, CLI tools in `tools/`, install/uninstall in `scripts/`.
- Locked design decisions live in `docs/prism/adjudications/` (D00x files) —
  consult them before changing phase machinery or schema.
- State schema is owned by `tools/lib/prism-state.mjs`; the phase machine by
  `tools/prism-bootstrap.mjs`.
