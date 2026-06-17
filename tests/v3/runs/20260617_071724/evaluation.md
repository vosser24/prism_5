# PRISM Behavioral & UX Evaluation — Simple-App Build + 4 Questions

Companion to `report.md`. Answers the five things asked: (Q1) run the complex
scenarios a user hits building a simple app, (Q2) message/diff visibility,
(Q3) memory record/recall, (Q4) rule-of-three reuse, (Q5) agent/skill reuse.
Evidence: live classifier injections + 4 parallel read-only code investigations.

---

## Q1 — Simple-app build scenarios: RAN. Routing is the weak point.

Injected the realistic 10-prompt build sequence + 5 refinement probes through the
genuine `prism-prompt-tier-router` (see `simple-app-routing.md`).

**Finding F6 (HIGH) — app-building verbs systematically under-route to haiku.**
Only **deploy** (release-safety regex) and **refactor+migrate** escalate. These
fall to haiku with no panel:
- `plan an expense tracker w/ Node backend + React frontend` → haiku (score 0)
- `scaffold project structure + build tooling` → haiku
- `add user authentication (login/signup)` → haiku
- `implement secure user authentication with password hashing + JWT` → **haiku, score 0** ← worst case: security-critical → weakest tier

Mechanism confirmed: NOT the word "simple" (with/without both score 0). It's
narrow keyword-triggering — the literal token "architecture" lifts to opus(8),
but "build/plan/scaffold/authentication/secure/JWT/backend/frontend/full-stack"
score 0–2. **Safety net = the Opus conversation-model override** — which fired
**3× manually in this very session** on the user's own prompts. A non-expert
user gets whatever tier the keyword-floor picks unless the main loop overrides.

## Q2 — "Do I need to see all the code changes?" → No, by design (correct).

Default visibility: full **plan** (approval-gated; never executes without it),
**live task-list progress**, **high-stakes checkpoints** (pause before
irreversible: DB/schema/prod/deletes), **Phase-2 completion summary**.
Hidden: per-file **subagent diffs** and subagent transcripts (relayed as
summaries per `dispatch-shapes.md:43` / `phase-1-execution.md:113`; transcript
sits collapsed in the sidebar — Claude Code platform behavior). Rationale:
context hygiene — the whole point of tier-routing is keeping worker output out of
your context.
**Verdict:** summary-first + on-demand inspection is the right default for app
builds. **Gap:** discoverability — doctrine never tells the parent to say "expand
the Agent call to see full diffs." "Show me every diff inline" should be a
per-task instruction, not the default.

## Q3 — Memory & lessons: architecture is sound; the live recall path is DOWN.

**RECORD:** (a) `PostToolUse` → `prism-kb-autosync` flags dirty files →
`SessionEnd` rebuilds the KB resource index + F4 knowledge index; (b) `/prism-clean`
runs a 5-level importance classifier → writes `docs/prism/{lessons,adjudications}`
and mirrors pointers into the project-master `MEMORY.md`; (c) claude-mem ambient
layer captures every turn to SQLite + ChromaDB.
**RECALL:** (a) `SessionStart` injects claude-mem context; (b) `/prism-recall` —
3 tiers (semantic BM25 / NotebookLM, session state JSON, spend SQLite);
(c) turn-15 memory-save nudge.

**Finding F7 (HIGH) — no automatic session-context recall is firing right now.**
- claude-mem worker **DOWN** since 2026-06-10 (`curl :37790` → refused; 5
  consecutive hook failures; `supervisor.json` empty). SessionStart context
  injection is not working. DB is intact (prism_3: 1152 observations / 61
  summaries / 133 prompts) but inaccessible to the running session.
- The PRISM-native turn-15 nudge is **suppressed** because claude-mem is detected
  as *installed* (standdown logic). So the fallback doesn't fire either.
- Net: ambient recall down + fallback suppressed = automatic memory recall is off.
  **Manual `/prism-recall` still works** (state, spend, local BM25 KB).
- NotebookLM (Tier-1 cloud augmentation) not initialized (opt-in).
- Project-master `MEMORY.md` never created for prism_3 (`/prism-deep-dive` not run).

**Finding F4 (RESOLVED/CORRECTED):** the session-start "KB index behind source
docs" warning was transient — the index was rebuilt at 2026-06-17T07:26Z (source
max 07:04Z), no dirty flags remain. KB resource index is **fresh**. The earlier
report's F4 "stale" note is superseded.

## Q4 — "Repeatable action after 3× becomes reuse, not rebuild" → DOES NOT EXIST.

No mechanism in `hooks/`, `tools/`, `skills/`, or `docs/prism/` tracks task
frequency or fires a "you've done this 3× — make a skill?" suggestion. The routing
log has no `repeat_detected`/`promote_to_skill` event; no aggregator counts
repeated tasks.
Closest cousins (all **manual** or different scope):
- `/prism-clean` L3: flags "a pattern reused 2+ times *this session*" → captures a
  *lesson* (not a skill).
- `prompt-effectiveness.md`: "lessons seen in 3+ projects → promote to
  core-expertise" — a manual data-entry template for `@agent-factory`.
- `tools-registry.md`: external *tools* auto-promote after 3+ intent contexts —
  telemetry-keyed, external tools only, not user-repeated tasks.
**To get reuse today:** the user must notice the repetition and run `/skill-creator`
manually. **Finding F8 (MEDIUM, feature gap):** the auto "rule-of-three →
promote-to-skill" the user expects is not implemented.

## Q5 — Reuse of agents & skills → strong doctrine, verified live.

Decision flow: incoming task → **Phase 0a** reads the unified `roster.json` →
**roster-first matching** reuses a specialist only on **STRONG fit** (declares the
specific sub-domain in `core_domains`, not mere adjacency) → **staleness ladder**
(<90d hire / 90–180 flag / >180 user checkpoint) → only on a MISS does
`@agent-factory` create new, and it must "CHECK roster.json before creating —
avoid duplicates." `prism-skill-trigger-guard` nudges installed-but-uninvoked
skills; `/prism-index` keeps the roster aware of manually-added/plugin skills.
Verified live this run: L08/L09 author→auto-register fired; deployed roster holds
15 agents (L10).
**Gaps:** (1) if `/prism-index` is stale/never-run the orchestrator dispatches
blind (warning is non-blocking); (2) STRONG-vs-adjacent fitness is prose-enforced,
not hooked; (3) PHASE-1 worker factory-hire test is advisory only; (4)
skill-trigger-guard skips subagents; (5) no auto-`/prism-index` on SessionStart.

---

## Consolidated verdict

| Dimension | State |
|---|---|
| Simple-app scenarios ran | ✅ 10 + 5 probes, live classifier |
| App-build routing quality | ⚠️ **F6 HIGH** — plan/build/scaffold/auth under-route to haiku |
| Message/diff UX | ✅ summary-first correct; minor discoverability gap |
| Memory architecture | ✅ sound (record + 3-tier recall) |
| Memory live health | ⚠️ **F7 HIGH** — claude-mem worker down + fallback suppressed = no auto recall |
| KB index freshness | ✅ **F4 resolved** — fresh as of 07:26Z |
| Rule-of-three reuse | ❌ **F8** — not implemented (manual only) |
| Agent/skill reuse | ✅ strong roster-first doctrine; 5 soft gaps |

**Top 3 actions:** (1) F6 — widen opus/panel signal vocab + security-verb tier
floor (also fixes F1/L03); (2) F7 — restart the claude-mem worker (or fix the
standdown so the native nudge isn't suppressed while the worker is down);
(3) F8 — decide whether to build auto rule-of-three promotion or document it as
out-of-scope.
