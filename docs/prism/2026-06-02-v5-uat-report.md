<!-- PRISM v5.x ship-readiness UAT — live fresh-project run (2026-06-02, Session 4) -->
# PRISM v5.x — ship-readiness UAT report (fresh project, live, real install)

> ✅ **ALL FOUR FINDINGS FIXED (same day, TDD'd, synced live, audit 29/29).** UAT-1
> (EPERM rename retry, `prism-state.mjs` + 3 tests), UAT-2 (token-count locale
> format), UAT-4 (target-aware `rm -rf` — allows `./build`/`node_modules`, still
> blocks root/home/glob/traversal/absolute/bare; +11 tests), UAT-3/5 (explicit
> panel triggers now honored + sonnet middle-tier for code-structure edits; +15
> tests, zero panel-false-positive regression). Verdict upgraded to **🟢 GO
> (unconditional)** for the validated surface.

**Method:** Built a real coffee-ledger app from scratch in a brand-new folder
(`utilities_projects/test_prism_5`), then ran the full PRISM command surface +
prompt/guard battery **live against the real `~/.claude` install** (v5.0.0,
carrying this session's v5.1 + finding-#1 work). App = Django 6.0.5 + DRF 3.17.1
on Python 3.14, 12 tests green, 2 commits. PRISM = system under test. All counts
ground-truthed (not trusted from subagent reports, per [[feedback-subagent-test-count-decay]]).

## VERDICT: 🟢 GO (conditional) — no ship-blockers; 2 robustness fixes recommended before a *wide public* ship

Every core capability works end-to-end on a fresh real project. The v5.1 feature
set and the finding-#1 deadlock fix are all validated live. The findings are
robustness/ergonomics items, none critical. For a private/friends distribution
([[project-v4-2-private-distribution]]) it is **shippable as-is**; for a wide
public release, fix UAT-1 (EPERM retry) and UAT-4 (safety over-fire) first.

---

## What passed (live evidence)

### Bootstrap — all 7 phases ✅
identity → structure → plugin-validate → discovery → roster → **project-master** → health, all `completed`, `pending: []`.
- **v5.1 headline — project-master DEFAULT-ON:** `phase-project-master` with **no** `--with-deep-dive` flag created `master-test-prism-5.md`, seeded `MEMORY.md`, and wired `settings.json "agent": "master-test-prism-5"` — fully non-interactive. ✅
- **v5.1 P2 — Session-log anchor ships in seeded MEMORY.md** (`## Session log` + `<!-- /prism-clean appends session-summary lines here. -->`). ✅
- Master agent carries the v5.x identity ("Principal solution architect + sole dispatcher") + `skills: [master-orchestrator]`. ✅
- Offer detectors correct: claude-mem absent → Mode B; statusline/telemetry already configured. ✅

### Lifecycle ✅
- **P2 `append-summary`** folds `- [2026-06-02] …` into `## Session log`; `append-decision`→`[[D001]]`, `append-lesson`→`[[lessons-tactical#…]]` all land correctly in the fresh master MEMORY.md. ✅
- `prism-context-audit` works (SessionStart token-tax report). `prism-recall` correctly requires opt-in KB init (F4 engine proven by 148 KB/recall unit tests). `prism-roster` maintenance subcommands intact.

### Prompt + guard battery ✅
| Check | Result |
|---|---|
| classifier: "what time is it" / "fix typo" → haiku | ✅ |
| classifier: "design/architect a migration strategy" → opus | ✅ |
| dispatch-guard: normal-file Read on haiku turn → **deny (exit 2)** | ✅ |
| **dispatch-guard: override-file Read (finding #1 fix) → allow (exit 0)** | ✅ live |
| dispatch-guard: override-file Write → allow | ✅ |
| safety: `ls` allow / recursive-delete block / `curl\|bash` block | ✅ |
| panel: notification/empty/short-approval turn → **panel=false** (no false-positive) | ✅ |
| panel: "design a new event-sourcing architecture" → **panel=true** (reachable) | ✅ |
| **finding-#1 root cause:** release-screen→panel **decoupled in v5.0.x** (code-confirmed) | ✅ |

### Productivity loop ✅
Dispatched a worker to add an optional `note` field to `Purchase` under strict TDD (red: `KeyError: 'note'` → green: 12/12), migration `0002_purchase_note.py`, committed `5036177`. The plan→dispatch→TDD→commit loop works on a real project.

---

## Findings (none are ship-blockers)

### UAT-1 🟡 — `writeStateAtomic` EPERM-on-rename race (Windows/SMB)
Intermittent (~1 in 4 here, 0 on other runs): `EPERM: operation not permitted, rename '…prism-state.json.tmp.xxx' -> '…prism-state.json'` at `prism-state.mjs:375`. A file-watcher/indexer/AV momentarily holds the target during the atomic rename. **When it fires the state write is lost (exit 1).** Affects **every** PRISM state write (bootstrap, deep-dive, clean). Same family as the `git index.lock` races seen all session on this `//grhqecomm/` SMB mount.
**Fix:** retry-with-backoff on `EPERM`/`EBUSY` around the rename in `writeStateAtomic`. **Recommended before a wide public ship** (it's the closest thing to a blocker for users on Windows network drives / aggressive AV).

### UAT-4 🟡 — safety gate over-fires on dangerous tokens in quoted data / labels / legit `rm -rf <path>`
The gate blocked **legitimate** UAT commands **4 times** because the dangerous *substring* appeared in quoted test data, echo labels, or a legit `rm -rf <specific-dir>` cleanup. It blocks **all** `rm -rf`, not just dangerous targets, and fires on the pattern even inside string literals. Correctly blocks the real dangers (`rm -rf /`, `curl|bash`), but the over-fire has real ergonomic cost.
**Fix:** de-quote before scanning ([[feedback-safety-scanner-dequote]] — apparently not fully deployed/sufficient) and allow `rm -rf <non-root-relative-path>`.

### UAT-2 🟢 — `prism-context-audit` number formatting (cosmetic)
Prints "~2.405 tokens" for what is ~2,405 tokens (locale thousands-separator rendered as a decimal point). Misleading but harmless.

### UAT-3/5 🟢 — tier + panel calibration (observation, by-design tension)
- **Middle tier (sonnet) under-selected:** "add a field to the Purchase model" (a real dev task) → haiku. The classifier rarely picks sonnet (corroborates the v5.0 stress-test finding).
- **Panel auto-summon is narrowly calibrated:** fires on "design a new … architecture" but misses "re-architect … as a distributed system" and "novel schema redesign + migration" (under-fire). This is a reasonable conservative stance after the finding-#1 false-positive, but means auto-panel is unreliable.
- **Explicit triggers ("summon the panel", "run the panel", "PRISM this") do NOT set the router's `summon_panel`** — those are `prism-chat` (chat-mode) skill triggers; in Claude Code the panel comes via the model override or `prism-plan`/`master-orchestrator`. Worth confirming the explicit-trigger UX in a live CC session.

---

## What only a live session can confirm (manual checklist for the user)
These need a real Claude Code session **cwd'd into the fresh project** — I drove the deterministic + hook surface, but not these interactive/multi-turn paths:
1. Real `AskUserQuestion` rendering for the bootstrap offers (statusline / telemetry / claude-mem install).
2. A real end-to-end **panel**: type a novel-architecture prompt, confirm the dispatch-guard forces `@master-orchestrator` and a multi-agent panel actually runs (and that explicit "run the panel" works in CC, not just chat).
3. Real `/clear` lifecycle (SessionEnd/SessionStart) + the memory-save nudge + claude-mem Mode-A/B switchover.
4. `npx claude-mem install` then re-bootstrap → confirm Mode A (nudge stands down).

## Substrate
`utilities_projects/test_prism_5` — real coffee-ledger (Django+DRF+SQLite backend, Vite/React frontend stub, 12 tests). Commits `5a810a9` (scaffold) + `5036177` (note feature). PRISM scaffold (`.claude/`, `CLAUDE.md`, `.mcp.json`, `tasks/`) created by bootstrap, uncommitted (a real user would commit or gitignore these).
