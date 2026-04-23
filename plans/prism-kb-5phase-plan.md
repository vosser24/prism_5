# PRISM Knowledge-Base Architecture — 5-Phase Plan

**Last updated:** 2026-04-20
**Purpose:** Durable reference so future Claude Code sessions (post `/clear`) can resume execution without re-deriving the plan.
**Recovery path if this file is lost:** `grep "Phase 5" ~/.claude/projects/C--Users-ServosY-Documents-utilities-projects-GA4-Audit/e3f79604-9234-4e3d-b378-0bb24614bdc2.jsonl` — original planning discussion lives there.

---

## Status at-a-glance

| Phase | Status | Location of artifacts |
|---|---|---|
| Phase 1 — Local KB Index + Router | DONE | `~/.claude/tools/prism-kb-indexer.mjs`, `~/.claude/hooks/lib/prism-router.mjs`, `~/.claude/tools/prism-kb-rebuild.mjs` |
| Phase 2 — NotebookLM Cloud Sync + Tier-2 hint | DONE | `~/.claude/tools/prism-kb-{domains,notebook-init,sync,query,classify,promote-domain}.mjs`, `~/.claude/hooks/prism-hook.mjs` (Tier-2 band) |
| Phase 3a — Auto-sync wiring (prereq) | DONE | `~/.claude/tools/prism-kb-rebuild.mjs` with `--sync` / `--quiet` flags |
| Phase 3b — Agent model-selection guard | DONE | `~/.claude/hooks/prism-agent-model-guard.mjs`, registered in settings.json, log at `~/.claude/.prism-routing.jsonl` |
| Phase 3c — Auto-sync on file writes (gap closure) | DONE | `~/.claude/hooks/prism-kb-autosync.mjs` (PostToolUse), Stop-hook enhancement, dirty-flag drain |
| Phase 3 — `/prism-recall` unified command | DONE | `~/.claude/tools/prism-recall.mjs`, `~/.claude/commands/prism-recall.md`, 9 new tests |
| Phase 4 — Analytical SQLite FTS + cost telemetry | DONE | `~/.claude/tools/prism-db.mjs`, `prism-db-migrate.mjs`, `prism-rollup-weekly.mjs`; hook dual-write in `prism-subagent-stop.mjs`/`prism-session-end.mjs`; tier-3 SQL in `prism-recall.mjs`; telemetry in `prism-kb-query.mjs`/`prism-kb-sync.mjs`; 14 new tests in `test-prism-gaps.mjs` (118/118 passing) |
| Phase 5a — Pre-execution tier advisor (PREREQ for 5) | DONE 2026-04-21 | `~/.claude/tools/lib/prism-tier-classify.mjs`, `prism-task-tier-advisor.mjs` hook (PostToolUse:TaskCreate), prism-plan+blueprint-prompt SKILL `[tier]` format, rollup "Plan-Tier Adherence" section, `task_tier_advice` table, 5 new tests (123/123 green) |
| Phase 5 — Opus-chair planner + tier-routed execution + lesson extraction | DONE 2026-04-21 | `scoreToTier`/`complexityScore`/`classifyWithScore` in tier-classify lib, `[pgroup=X]` parallel-dispatch annotation in prism-plan + blueprint-prompt SKILLs, lesson extractor (user_correction/error_seen/claude_md_write) in Stop hook → `.prism-lessons.jsonl`, 3 new tests (126/126 green). **Scope intentionally trimmed** — dropped synchronous pre-answer recall, recall cache, budget counter, metrics dashboard, code-work detector per user direction (quality uncompromised, speed preserved, optimization only from execution delegation). |

---

## What's already on disk (Phase 1 + 2 DONE)

- **Local index** at `~/.claude/.prism-kb-index.json` (version 2 schema, 244 entries, 12 domains tagged)
- **Cloud sync meta** at `~/.claude/.prism-kb-meta.json` (241/244 synced — 3 claude-mem skills rejected server-side: `smart-explore`, `timeline-report`, `claude-code-plugin-release`)
- **12 NotebookLM notebooks** titled `PRISM-KB: <domain>` covering: prism-core, dev-languages, dev-frameworks, dev-testing-quality, dev-debug-perf, dev-infra-data, dev-security, design-ui, content-creative, ops-business-domain, ai-agents-infra, project-rules
- **Test suite** at `~/.claude/tools/test-prism-gaps.mjs` — 81/81 passing

---

## Phase 3a — Auto-sync wiring (PREREQ, ~20min)

**Why:** without this, local index drifts from cloud the moment a new skill/agent/plugin lands. Manual `rebuild + sync --push` is forgettable.

**Scope:**
- Enhance `~/.claude/tools/prism-kb-rebuild.mjs` with `--sync` flag that chains rebuild -> `prism-kb-sync.mjs --push`
- Add `--quiet` flag suitable for scheduled (cron / Windows Task Scheduler) runs
- Document scheduling:
  - Linux/macOS cron: `0 6 * * * node ~/.claude/tools/prism-kb-rebuild.mjs --sync --quiet`
  - Windows Task Scheduler: daily 06:00 trigger, action = `node %USERPROFILE%\.claude\tools\prism-kb-rebuild.mjs --sync --quiet`
- Add test: running with `--sync` against a synthetic new entry produces an `add` op in meta

**Acceptance:** `node ~/.claude/tools/prism-kb-rebuild.mjs --sync` prints rebuild stats + sync stats + exits 0 on happy path; meta updated with new entries.

---

## Phase 3b — Agent model-selection guard (~45min)

**Why:** observed a real miss this session — parent Opus-4.7 spawned a subagent without `model` param, child inherited Opus when Haiku would have been ~15x cheaper for pure text extraction. PRISM's existing hook only nudges based on user prompts, not subagent dispatches. Gap closure required.

**Scope:**
- New hook `~/.claude/hooks/prism-agent-model-guard.mjs` on `PreToolUse: Agent`
- **Classifier** scores the prompt against three tiers (score-based, NOT verb-match):

  | Tier | Model | Signals (any 1-2 hit moves the score) |
  |---|---|---|
  | Haiku | `haiku` | bounded output (`return`, `list`, `count`, `extract`, `find all`, `JSON`), verbatim tasks (`quote`, `copy`, `dump`), single-file/small-scope, "under N words", schema-defined outputs |
  | Sonnet | `sonnet` | cross-file pattern recognition, refactor identification, test writing from clear spec, doc lookup + reformulation, bug reproduction |
  | Opus | `opus` | architecture decisions, trade-off analysis, root-cause diagnosis, design, "decide whether", multi-stakeholder synthesis, security review with reasoning |

  Max-tier wins. Ties round UP (prefer over-pay to under-perform).

- **Soft mode (default)**: hook emits `"PRISM: about to spawn <subagent_type> without model override. <Tier> task detected — add model:'<tier>' to save ~<Nx>"` and passes through.
- **Hard mode** (opt-in via env `PRISM_MODEL_GUARD=hard`): mutates `tool_input` to inject `model: <tier>` before dispatch.
- **Compound-verb detector**: regex for `read and (analyze|design|decide)|extract then (synthesize|decide)` → emits nudge to SPLIT into two `Agent()` calls (Haiku extract + Opus synthesize) rather than forcing one tier.
- **Cascading**: hook fires on every `Agent()` call from any nesting depth (grandchildren too).
- **Logging**: every decision (pass-through, nudge, auto-inject) appended to `~/.claude/.prism-routing.jsonl` with fields `{ts, session_id, parent_model, subagent_type, tier_detected, action, prompt_hash}`.

**Tests** (~6 assertions): classifier tiers, compound-verb detection, log line shape, soft-vs-hard-mode toggle, cascading (nested Agent call).

**Acceptance:** running a retrieval-style `Agent()` call without `model` flag produces soft-nudge output on stderr/stdout and appends a routing log line.

---

## Phase 3 — `/prism-recall` unified command (real Phase 3, ~2h)

**Scope per original plan:**

1. **Intent classifier** (`~/.claude/tools/prism-recall-classifier.mjs`):
   - Analytical → Tier 3: keywords `cost`, `sum`, `total`, `how many`, `average`, `count`, `per day`, `this week`, `spend`
   - State → Tier 2: keywords `turn`, `session`, `current`, `what is my`, `state`, `config`, `history`
   - Semantic → Tier 1: everything else (free-form questions)
2. **Tier 1 backend** — reuse `prism-kb-query.mjs` from Phase 2 (router + NotebookLM).
3. **Tier 2 backend** (`~/.claude/tools/prism-recall-tier2.mjs`): reads state JSONs (`~/.claude/.prism-global-state.json`, project `.prism-state.json`).
4. **Tier 3 backend** (`~/.claude/tools/prism-recall-tier3.mjs`): aggregates JSONL (`~/.claude/.prism-spend.jsonl`, session summaries). Phase 4 replaces this with SQL.
5. **Dispatcher** (`~/.claude/tools/prism-recall.mjs`): classifier → backend → formatted answer.
6. **Slash command** (`~/.claude/commands/prism-recall.md`): `/prism-recall <query>` entry point.
7. **Tests** (~12 assertions): classifier accuracy per tier, Tier-2 reads correct fields, Tier-3 aggregates correctly, dispatcher routes right tier, slash command invokes dispatcher.

**Acceptance:** `/prism-recall "what's my total spend today"` → Tier-3 aggregate. `/prism-recall "current turn count"` → Tier-2 read. `/prism-recall "how do I run TDD"` → Tier-1 cloud search.

---

## Phase 4 — Analytical SQLite FTS + cost telemetry (~3h) — DONE 2026-04-20

**Shipped:**
- **DB** at `~/.claude/.prism.db` (WAL, busy_timeout=2000). Tables: `spend(UNIQUE(ts,session_id,agent,model))`, `model_routing(UNIQUE(ts,prompt_hash,action))`, `sessions(PK session_id, upsert via ON CONFLICT)`, `api_calls` (append-only telemetry), plus FTS5 virtual `transcripts_fts(session_id UNINDEXED, content)`. Owner: `~/.claude/tools/prism-db.mjs` — exports `openDb`, `close`, `appendSpend`, `appendRouting`, `upsertSession`, `appendApiCall`, `appendTranscriptChunk`, `safeLogApiCall`.
- **Migration** at `~/.claude/tools/prism-db-migrate.mjs` — reads `.prism-spend.jsonl`, `.prism-routing.jsonl`, `.prism-sessions/*.md`. Idempotent via UNIQUE constraints + PK upserts. Verified: second run inserts 0 spend/routing rows, sessions re-upsert.
- **Dual-write hooks** — `prism-subagent-stop.mjs` and `prism-session-end.mjs` both mirror their JSONL/MD writes into SQLite via `await import(pathToFileURL(j(H,'.claude','tools','prism-db.mjs')).href)` (Windows-safe). Errors swallowed so JSONL remains source-of-truth fallback.
- **Tier-3 SQL** — `prism-recall.mjs` `tier3Aggregate` is now async. Runs parameterized SQL over the DB; envelope includes `backend: "sqlite"` or `"jsonl"` (fallback when DB missing). Measured ~22ms cold (includes module load); warm queries <5ms.
- **NotebookLM telemetry** — `prism-kb-query.mjs` (`askNotebook`) and `prism-kb-sync.mjs` (`addSource`, `deleteSource`) log every spawn into `api_calls` via `safeLogApiCall` with `{kind,notebook,source_id,duration_ms,status,error}`.
- **Weekly rollup** — `~/.claude/tools/prism-rollup-weekly.mjs` writes markdown digest to `~/.claude/.prism-rollups/<YYYY-Www>.md` (top models/agents/projects, session list, routing, API telemetry). Same-week re-run overwrites. Schedule via Windows Task Scheduler Sunday 02:00: `node %USERPROFILE%\.claude\tools\prism-rollup-weekly.mjs --quiet`, or cron `0 2 * * 0 node ~/.claude/tools/prism-rollup-weekly.mjs --quiet`.
- **Tests** — 14 new Phase 4 assertions in `test-prism-gaps.mjs` (P4.1–P4.8), all passing alongside the pre-existing 104 → **118/118 green**. Tests self-scrub via `TEST-p4-%` LIKE patterns; sentinel/phash/nb are per-run random to survive UNIQUE constraint residue.

**Gotchas observed during rollout:**
- ESM dynamic `import()` on Windows with a backslash path crashes with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Fix: `pathToFileURL(abs).href`.
- FTS5 MATCH parses hyphens as operators — test tokens must be alphanumeric or explicitly quoted.
- `invokedDirectly` guard crashed under ESM dynamic import because `process.argv[1]` is undefined in that context — gated behind truthiness check.

---

## Phase 5a — Pre-execution tier advisor (PREREQ for Phase 5, ~90min)

**Gap this closes (observed during Phase 4 rollout):** The Phase 3b model-selection guard only fires on `Agent()` dispatches. Multi-step work executed directly in the main context (like all 7 steps of Phase 4) bypasses the guard entirely — every Edit/Write is billed at the parent tier even when individual subtasks (JSONL parsing, hook edits, test scaffolding, MD rollup) are clearly Haiku- or Sonnet-tier by the classifier's own rubric. The prism-plan SKILL already documents that its output should include "Model assignments per step (haiku/sonnet/opus)" (SKILL.md line 108–145), but the actual task format `- [ ] Step — done when: ...` never carries that annotation. The documented contract is unkept.

**Panel-synthesized plan (4 sub-parts, strictly ordered):**

### 5a.1 — Extract shared classifier library (~15min)
- New file `~/.claude/tools/lib/prism-tier-classify.mjs`. Exports:
  - `classifyTier(prompt, description) -> {tier, reason, h, s, o}`
  - `detectCompound(prompt, description) -> boolean`
- Lift verbatim from `prism-agent-model-guard.mjs:95` and `:111` (both are already pure functions with clean signatures per the 2026-04-20 research leg).
- Refactor `prism-agent-model-guard.mjs` to import from the lib; zero behavioral change.
- Test parity: existing Phase 3b assertions must still pass untouched.

### 5a.2 — PostToolUse TaskCreate tier advisor hook (~30min)
- New hook `~/.claude/hooks/prism-task-tier-advisor.mjs` registered on `PostToolUse` with `matcher: "TaskCreate"`. Matcher syntax confirmed to work by precedent (settings.json lines 37/46/57 use `Bash`, `Agent`, `Write|Edit|MultiEdit`).
- Reads the just-created task's `subject + description`, runs `classifyTier`, and emits one line of visible hook output: `PRISM TIER task <id> "<subject-first-60-chars>": <tier> — consider Agent({model:'<tier>'})`.
- Also appends a structured row to `~/.claude/.prism.db` table `task_tier_advice` (new) with `{ts, task_id, subject, tier, reason, h, s, o}` — feeds the rollup adherence metric below.
- **Recursion guard:** hook only matches `TaskCreate`, never `TaskUpdate`. The advisor does NOT call TaskUpdate itself — writing advice to SQLite avoids the loop entirely.
- **Soft mode (default):** emit nudge only.
- **Hard mode (opt-in via env `PRISM_TASK_TIER=hard`):** reject TaskCreate if detected tier ≥ Opus AND description lacks `metadata.tier_ack: "opus"`. Design intent: you must explicitly acknowledge an Opus-tier subtask rather than drift into one.
- **Compound-verb detector:** if `detectCompound` returns true, nudge emits: `consider splitting into <Haiku extract> + <Opus synthesize> sub-tasks via two Agent() calls`.

### 5a.3 — Skill contract update (~20min)
- `~/.claude/skills/prism-plan/SKILL.md` and `~/.claude/skills/blueprint-prompt/SKILL.md` — change the task-output template from
  `- [ ] Step — done when: [criterion]` to
  `- [ ] [tier] Step — done when: [criterion]` where `[tier]` ∈ `haiku|sonnet|opus`.
- Update `~/.claude/skills/prism-plan/references/prompt-templates.md` with one worked example.
- **Why belt-and-suspenders with the hook:** the skill format gives users visible tier annotations at plan-read time; the hook gives enforcement at task-creation time. Each catches what the other misses.

### 5a.4 — Rollup adherence observability (~25min)
- `prism-rollup-weekly.mjs` grows a "Plan-Tier Adherence" section.
- New SQLite table `task_tier_advice(id, ts, task_id, subject, tier, reason, h, s, o)` added to `prism-db.mjs` schema (append-only, no UNIQUE).
- Weekly query: join `task_tier_advice` against `model_routing` on near-time correlation (advice emitted at time T, Agent() call follows within K seconds). Report:
  - % of advised tasks whose follow-up Agent() call used the advised tier
  - % of TaskCreate calls whose subject starts with a bracketed `[tier]` marker (skill adherence)
  - Cost savings estimate: for each advised-but-ignored task, `(actual_cost - tier_equivalent_cost)` summed
- Surfaces as a table in the weekly markdown digest.

**Tests (~5 assertions to add to `test-prism-gaps.mjs`):**
- Shared lib exports parity with the original hook's classifier output on canned prompts.
- PostToolUse:TaskCreate hook emits nudge line and writes `task_tier_advice` row on synthetic payload.
- Hard-mode rejects Opus-tier TaskCreate without ack.
- Rollup section renders non-empty when advice rows exist.
- Recursion guard: TaskUpdate does not re-trigger the advisor.

**Acceptance:**
- All 118 current tests still pass; ~5 new tests green → 123/123.
- A synthetic `TaskCreate({subject:"Parse and dump JSONL to CSV", description:"extract every row"})` produces nudge `PRISM TIER task <id>: haiku — consider Agent({model:'haiku'})` in visible hook output.
- Next `prism-rollup-weekly.mjs` run includes a "Plan-Tier Adherence" table.

**Why as 5a (prereq), not inside 5:** Phase 5's compound learning loop extracts lessons from transcripts. One of the most valuable lesson classes is "tier decisions that correlated with rework or over-spend". If 5a ships first, Phase 5's lesson extraction inherits a clean tier-adherence signal for free; if it ships after, Phase 5 has to re-derive it from raw spend data.

---

## Phase 5 — Compound Learning Loop + pre-answer recall with cache/budget (~3h)

**Scope:**
- **Lesson extraction** (Stop hook enhancement): on session end, scan transcript for "first-time-seen" patterns (new errors encountered, new insights written into CLAUDE.md, correctness fixes). Extract to `~/.claude/.prism-lessons.jsonl` and optionally push to a dedicated NotebookLM source in `prism-core` domain.
- **Pre-answer recall** (UserPromptSubmit hook): before Claude sees the prompt, call `/prism-recall <prompt>` with short timeout (1.2s) and inject result as context. Guarded by env `PRISM_PREANSWER_RECALL=1`.
- **Cache layer** at `~/.claude/.prism-recall-cache.sqlite` (SHA256(prompt) → answer, 7-day TTL). First-call hits cloud, subsequent identical prompts instant.
- **Budget cap**: per-session limit (default 10 cloud calls). After cap, recall short-circuits with "budget exhausted — raise PRISM_RECALL_BUDGET if needed".
- **Metrics dashboard** (`~/.claude/tools/prism-metrics.mjs`): time-series on resolution rate (did the recall help?), cost per session, router hit rate (Tier-1 local-vs-cloud), classifier confidence distribution. Outputs markdown to stdout, pushes weekly digest to NotebookLM.

**Tests:** lesson-extraction on synthetic transcript, cache hit/miss, budget cap enforcement, recall-injection shape.

---

## Cross-cutting cleanup (slot anywhere)

- **Fix 3 claude-mem upload rejections** (Phase 2 gap): investigate `smart-explore`, `timeline-report`, `claude-code-plugin-release`. Try stdin-pipe text upload or trim frontmatter. Target 244/244 cloud coverage.
- **CLAUDE.md docs**: add PRISM-KB section to `~/.claude/CLAUDE.md` — covers 12-notebook layout, sync commands, when Tier-2 fires, `/prism-recall` usage (after Phase 3).
- **Multi-notebook parallel queries**: `prism-kb-query.mjs` currently queries top-N domains sequentially. Parallelize with `Promise.all`.
- **Hook Tier-2 noise**: hook fires on `<task-notification>` system strings, not just real user prompts. Minor polish: add a guard for messages that start with `<task-notification>`.

---

## Lessons learned this session (for Phase 5 ingestion)

1. **NotebookLM CLI `--title` only works for text sources** — file uploads use filename as title. Workaround shipped: `addSource` in `prism-kb-sync.mjs` renames immediately after upload.
2. **NotebookLM rejects some files with "Failed to get SOURCE_ID from registration response"** — reproducible on 3 claude-mem skills; likely content-related (still needs diagnosis).
3. **Basename collisions** — plugin skills are all `SKILL.md`; reconciliation by filename alone can't distinguish them. Rename-after-upload required for unique cloud titles.
4. **Agent model inheritance** — subagents inherit parent model if `model` param is omitted. Opus-to-Opus cascade burns unnecessary cost. Phase 3b closes this gap.
5. **Sync resilience** — original executePlan threw on per-entry failures; fixed to catch + continue + checkpoint every 10 ops.
6. **Hook Tier-2 noise** — hook fires on `<task-notification>` system strings, not just real user prompts.

---

## Phase 6 — Unified PRISM+PRISM installer (HANDOFF FOR FRESH SESSION, 2026-04-21)

**Context:** User currently maintains two installers: `E:\Other computers\My Computer\Python\PRISM\atlas_2125.py` (PRISM v2.1.25, 7424 lines) and `Prism_pro_111.py` (PRISM Code Pro v1.1.1, 6917 lines). PRISM evolved FROM PRISM (skill renames: `prism-plan → prism-plan`, `prism-discover → prism-discover`, `/prism-health → /prism-health`, etc.). The live `~/.claude/` is a hybrid from running both over time. User wants ONE unified installer going forward.

**Hard constraint — do NOT destroy state:** the live `~/.claude/` contains months of compounded memory that the installer must preserve.

### Preserve-or-die list (back up BEFORE any writes)
- `~/.claude/.prism.db` — SQLite WAL with `spend`, `model_routing`, `sessions`, `api_calls`, `transcripts_fts`, `task_tier_advice`
- `~/.claude/.prism-sessions/` — per-session markdown digests
- `~/.claude/.prism-lessons.jsonl` — lesson corpus (new, Phase 5)
- `~/.claude/.prism-kb-index.json` + `.prism-kb-meta.json` — local index + cloud sync state (244 entries, 12 NotebookLM domains)
- `~/.claude/.prism-spend.jsonl` — legacy spend ledger
- `~/.claude/.prism-routing.jsonl` — Phase 3b routing log
- `~/.claude/.prism-state.json` + `.prism-global-state.json` — turn counters
- `~/.claude/.prism-rollups/` — weekly digest archive
- `~/.claude/.prism-kb-dirty` — dirty flag (if present)
- `~/.claude/skills/prism-plan/references/roster.json` — agent usage tracking
- any NotebookLM auth/session tokens (typically in `~/.notebooklm/` or pip-config-dir; check `~/AppData/Local/notebooklm-py`)

### Fresh-session task list
- [ ] [haiku] 6.1 Audit current `~/.claude/` for PRISM vs PRISM artifacts — `find ~/.claude -maxdepth 3 -name "prism-*" -o -name "prism-*"` — list which namespace owns each skill/agent/command/hook. Done when: clear inventory of duplicates + PRISM-only survivors documented.
- [ ] [sonnet] 6.2 Decide retention — default: keep PRISM names (Phase 5a+5 is built on them), retire `prism-*` duplicates, KEEP PRISM-only capabilities (video-production skill, agent-factory, specific commands). Done when: retention decision table committed.
- [ ] [opus] 6.3 Design unified installer structure `prism_unified_2126.py` — version `2.1.26`, sections: (a) preserve-memory backup, (b) config write, (c) smoke tests, (d) migration from `prism-*` names. Must be idempotent. Done when: architecture doc in this plan.
- [ ] [sonnet] 6.4 Read live `~/.claude/` files into variables and assemble the new installer. Key reads: all Phase 5a+5 files (see Phase 5a DONE row for list). Done when: full installer script produced and saved.
- [ ] [sonnet] 6.5 Smoke-test on a COPY of `~/.claude/` (e.g. `~/.claude-test/`) before touching the real one. Run `node ~/.claude-test/tools/test-prism-gaps.mjs` — must return 126/126 green. Done when: isolated test directory passes full suite.
- [ ] [sonnet] 6.6 Produce `prism_unified_2126.py` with first-run `prism-backup-YYYY-MM-DD/` behavior. Done when: user can run it without losing memory.

### What to flag during the rebuild
- If `classifyTier`/`detectCompound`/`scoreToTier` in the embedded lib differ from live file (drift bugs)
- If the settings.json PostToolUse matcher for TaskCreate is missing from the target writer
- If PRISM's SessionStart hook conflicts with PRISM's (same event, different scripts)
- If any `prism-*` command still routes to a file that the unified installer no longer writes
- If NotebookLM credentials need re-authentication after the install

### Rollback path
Backup dir `~/.claude/prism-backup-YYYY-MM-DD/` contains the full pre-install tree. Rollback = `rm -rf ~/.claude/{prism-*.mjs,skills/prism-*,...} && cp -r prism-backup-YYYY-MM-DD/* ~/.claude/`.

### Acceptance for "safe to run"
1. `prism_unified_2126.py --dry-run` prints planned writes without executing.
2. `prism_unified_2126.py` creates timestamped backup BEFORE any writes.
3. Full 126/126 test suite green after install.
4. Existing `.prism.db` data row counts match pre-install counts (spend, model_routing, sessions, task_tier_advice unchanged).
5. `/prism-recall "what's my total spend this week"` returns non-zero (proves SQLite still has history).

---

## Commands reference (current)

```bash
# Local only
node ~/.claude/tools/prism-kb-rebuild.mjs        # rebuild local index (+ --sync after Phase 3a)
node ~/.claude/tools/prism-kb-classify.mjs       # domain distribution report

# Cloud ops
node ~/.claude/tools/prism-kb-notebook-init.mjs  # idempotent cloud bootstrap
node ~/.claude/tools/prism-kb-sync.mjs --push    # push delta to cloud
node ~/.claude/tools/prism-kb-query.mjs "<q>"    # Tier-2 cloud search

# Add a new domain
node ~/.claude/tools/prism-kb-promote-domain.mjs <key> "<title>"

# Tests
node ~/.claude/tools/test-prism-gaps.mjs
```

**After Phase 3:** `/prism-recall <query>` becomes the unified entry point.
