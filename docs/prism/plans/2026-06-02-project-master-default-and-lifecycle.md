# Project-master by default + knowledge lifecycle — build plan (v5.1)

Date: 2026-06-02 · Status: BUILDING · Owner: this session · Follows the v5.0 independent-agent-panel work.

## Why
The project-master is the prerequisite for real dispatched panels (STEP 0: dispatch is main-loop-only). User decision (2026-06-02): make it the **default** for every project (their work is all code — apps/agents/scripts), with the master carrying project knowledge across sessions. Simple asks still route simply (tier-router unaffected).

## Decisions (confirmed with user, 2026-06-02)
- **Bootstrap auto-creates `master-<basename>` by DEFAULT**; `--no-master` opt-out. (Was opt-in via `--with-deep-dive`.)
- **RELOAD = automatic** — the master's `.claude/agents/MEMORY.md` auto-injects when it's the session agent. Nothing to do.
- **CAPTURE = `/prism-clean`** (model-driven, on a real turn) folds a distilled summary into MEMORY.md. Reality check (claude-master, cited): no wipe-edge hook can drive a model capture — `/clear` fires `SessionEnd`+`SessionStart`, NOT `PreCompact`; command hooks can't run `/` commands. So capture happens DURING the session, not at the wipe edge.
- **Nudge** (`prism-memory-save-nudge`, UserPromptSubmit) reminds to run `/prism-clean` before `/clear` — the only place the model gets a turn to act.
- `/prism-deep-dive` stays for big REBUILDS. `/prism-update` NOT overloaded (it's PRISM self-update).
- `/clear` ≠ `/prism-clean`: save (clean) then close (clear).

## Build parts (TDD)
1. **Bootstrap default-on master.** Flip planner: default plan INCLUDES `project-master`; `--no-master` skips. `phase-project-master` handler does the full non-interactive create (`agent-write` + `memory-seed` + `settings-write` via the deep-dive helpers), idempotent (`agent-write` exit 7 = already exists = skip); `slug-derive` exit 6 (can't derive a clean slug non-interactively) → soft fallback "run /prism-deep-dive". `--with-deep-dive` becomes an accepted no-op (back-compat). Update `test-prism-bootstrap.mjs` (line ~115 default-plan assertion + the project-master phase tests).
2. **`/prism-clean` → MEMORY.md fold.** New `append-summary` subcommand folds a distilled ≤few-bullet session summary into MEMORY.md under a NEW anchor (reuse `writeMemoryMdAtomic`'s 25 KB cap + `appendUnderAnchor`). Add the anchor to `renderMemoryMd` template in prism-deep-dive.mjs. Update `commands/prism-clean.md` Step 4 + `test-prism-clean.mjs` (+ seed anchor).
3. **Nudge extension.** `hooks/prism-memory-save-nudge.mjs` directive (line ~92) names `/prism-clean` + the master's MEMORY.md. Add a unit test (none exists today).
4. **Doc sweep (default-flip).** LIVE docs flip opt-in→default: `commands/prism-bootstrap.md` (phase table/flags/phase-6 narrative/final report), `commands/prism-deep-dive.md`, `commands/prism-help.md`, `README.md`, `docs/prism/MIGRATION.md`, `prism-bootstrap.mjs` comments. HISTORICAL (leave as record): `CHANGELOG.md`, `docs/prism/adjudications/D004*`, archived plan doc.

## Recon pointers
- Phases: `tools/lib/prism-state.mjs` `PHASES` (project-master already at pos 5). Handler: `prism-bootstrap.mjs` ~675–726. Planner: ~156–170. Args: ~82–107.
- Deep-dive helpers (non-interactive, spawnSync): `slug-derive`(exit6=needs-prompt), `agent-write`(exit7=exists), `memory-seed`(exit8=>25KB; pass --profile as tempfile per Windows arg-len), `settings-write`(exit9=bad settings).
- `prism-clean.mjs`: `writeMemoryMdAtomic` (25 KB cap, exit 8), `appendUnderAnchor`, `readMemoryMd`; subcommands `append-decision`/`append-lesson`. MEMORY.md at `<root>/.claude/agents/MEMORY.md`.
- Nudge: `hooks/prism-memory-save-nudge.mjs` directive line ~92; kill-switch `PRISM_MEMORY_NUDGE=off`.
- Hook facts (cited code.claude.com): `/clear`→`SessionEnd("clear")`+`SessionStart("clear")`; `PreCompact` only on manual/auto compact; command hooks can't trigger `/`-commands; only SessionStart+UserPromptSubmit inject additionalContext.

## claude-mem decision (2026-06-02, user-confirmed) — REVISED ARCHITECTURE
User has/considers `claude-mem` (thedotmack/claude-mem) — an automatic ambient-memory tier (continuous capture via PostToolUse/Stop hooks, SQLite at `~/.claude-mem/`, SessionStart auto-injection, FTS5 search). It OVERLAPS our capture/nudge layer (both hook UserPromptSubmit; both summarize sessions) but NOT the master *agent* (orchestration, different altitude). So:
- **claude-mem = offered Tier** (like NotebookLM): bootstrap detects it; if absent, offers install (`npx claude-mem install`; needs Node≥20+Bun, auto-installed); consent→install, decline→fallback. Canonical detect signal = `~/.claude-mem/` dir.
- **Mode A (claude-mem present):** it owns ambient memory. PRISM's save-nudge STANDS DOWN. `/prism-clean` stays MANUAL (handoff doc + curated `docs/prism/` adjudications). Master just reads claude-mem's injected context.
- **Mode B (claude-mem absent):** PRISM-native fallback — nudge ACTIVE; `/prism-clean` folds session summary into the master's MEMORY.md + handoff. Same outcome (master carries knowledge), curated vs automatic.
- One-liner: claude-mem = automatic memory; PRISM-native = curated memory; bootstrap offers A, falls back to B. **Nothing lost either way.**

## Status
- [x] **Part 1 — bootstrap default-on master — DONE (2026-06-02, TDD).** `prism-bootstrap.mjs`: `--no-master` flag; planner flipped (default INCLUDES project-master; `--no-master` skips); `phase-project-master` handler does full non-interactive create (slug-derive → agent-write → memory-seed[fresh-only] → settings-write), idempotent (agent-write exit 7 = skip + NEVER re-seed MEMORY.md), slug-derive exit 6 → /prism-deep-dive fallback. `--with-deep-dive` = no-op. Tests: bootstrap 35/35, deep-dive helpers 27/27.
- [x] **claude-mem detection + nudge stand-down — DONE (2026-06-02, TDD).** New `hooks/lib/prism-claude-mem-detect.mjs` (`claudeMemInstalled(home)`; `~/.claude-mem/` dir primary signal + settings.json corroborating). `prism-memory-save-nudge.mjs`: stands down when claude-mem present; Mode-B directive now points at `/prism-clean` + the master's MEMORY.md + handoff. Registered in install-manifest. Tests: new `test-prism-claude-mem-detect.mjs` (4/4) + `test-prism-memory-save-nudge.mjs` (3/3); manifest-coverage 8/8, installer-coverage 2/2.
- [ ] **Part 2 — `/prism-clean` `append-summary`** (Mode-B capture + curated layer) — fold distilled summary into MEMORY.md under a new anchor; add anchor to `renderMemoryMd`; update `commands/prism-clean.md` Step 4 + tests.
- [ ] **NEW — `/prism-clean` writes a handoff doc** (both modes).
- [ ] **NEW — bootstrap claude-mem install-offer** (NotebookLM-style: detect → offer → consent-install / decline-fallback). Prose in `commands/prism-bootstrap.md` + a `detect-claude-mem` helper subcommand.
- [ ] **Part 4 — doc sweep** (default-flip + document the two memory modes).
