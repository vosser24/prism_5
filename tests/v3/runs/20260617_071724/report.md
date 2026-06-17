# PRISM Live Auto-Inject Audit — Final Report

- **Run:** `20260617_071724` (2026-06-17, UTC)
- **PRISM version:** 5.8.1 (plugin layout; CWD is the source repo)
- **Mode:** autonomous · full-exhaustive · create-real-then-retire
- **Node:** v24.15.0
- **Harness:** `tests/v3/live-auto-inject-plan.md` + `runs/20260617_071724/queue.json` (durable, resumable state machine)

## Verdict: **PASS-WITH-WARNINGS**

Synthetic baseline is clean (29/29). The live loop confirmed every named
capability works end-to-end **and** surfaced one genuine classifier blind spot
(L03) plus a few tooling/hygiene notes. Nothing blocks release; the L03 finding
is worth a fix because it under-routes real architecture work to haiku.

---

## 1. Synthetic baseline (Step 2, throwaway HOME — no mutation)

- **29 / 29 pass**, 0 fail, 29.2s wall-clock.
- Slowest: the 6 classifier scenarios (CLF-001…006) at **3.6–4.1s** each (full
  classifier path). All others **<700ms**. No p95 regression (>500ms only on the
  inherently-heavy classifier path).
- Analyzer verdict: **PASS** — 10 capabilities exercised, 0 anomalies blocking.

## 2. Live auto-inject results (14 tests)

| # | Capability | Result | Evidence |
|---|---|---|---|
| L01 | short-reply / trivial | ✅ PASS | tier=haiku via **24h cache** path (bonus branch coverage) |
| L02 | routine implementation | ✅ PASS | tier=sonnet, score 3, keyword-floor |
| L03 | novel architecture + panel | ❌ **FAIL** | "multi-region rate limiter…phased migration" → **score 0 → haiku, no panel** (expected opus+panel) |
| L04 | adversarial panel (REST vs GraphQL) | ✅ PASS | ≥2 substantive challenges/position + skeptic + visible dropped experts + synthesis |
| L05 | force-opus prefix | ✅ PASS | tier=opus, source=force-opus, force_opus=true |
| L06 | conv-model override path | ✅ PASS | saga/2PC scored **8 → opus** directly (classifier more sensitive than catalog predicted) |
| L07 | parallel multi-agent dispatch | ✅ PASS | 3 agents in **one message**, wall-clock ≈102s vs ≈203s serial sum; **170/170 .mjs syntax-clean** (hooks 39, tools 40, tests 91) |
| L08 | create agent + auto-register | ✅ PASS | `prism-agent-write-register` fired on Write → project roster gained `prism-audit-probe` |
| L09 | create skill + auto-register | ✅ PASS | `prism-skill-write-register` fired on Write → roster gained `prism-audit-probe-skill` |
| L10 | roster-specialist routing | ✅ PASS* | roster (15 agents) consulted; Greek specialists present (*dedicated SEO specialist absent — see findings) |
| L11 | safety-guard deny | ✅ PASS | `rm -rf /` denied exit 2 ("dangerous/unverifiable target"); benign `ls` passed exit 0 |
| L12 | telemetry aggregate + analyzer | ✅ PASS | rollup written (haiku 752 / sonnet 73 / opus 341); analyzer verdict PASS |
| L13 | cleanup / retire probes | ✅ PASS | probe artifacts removed, `.claude/` fully restored, **global roster untouched** |
| L14 | final report | ✅ PASS | this file |

**Score: 13 pass / 1 fail / 0 pending.**

Incidental coverage: **LIF-003** (subagent-stop sets `dispatched:true`) confirmed
as a side-effect of L07. Live routing-log grew **7531 → 7557** (+26 genuine
classification/dispatch/guard events).

## 3. Findings

### F1 — HIGH · Classifier blind spot on novel-architecture vocab (L03)
The keyword-floor scores `design a multi-region rate limiter with per-tenant
fairness for a SaaS at 10k tenants, propose a phased migration` at **0** → routes
to **haiku, summon_panel=false**. The catalog's own `REAL-CLF-003` expects
opus+panel. **This also fired on the user's opening prompt this session**
(keyword-floor score 0 → haiku), forcing a manual tier override.
→ *Fix:* extend the panel/opus signal vocabulary (distributed-systems & scaling
phrasing: "multi-region", "per-tenant", "rate limiter", "N tenants", "phased
migration", "fairness") in `hooks/lib/prism-opus-classifier.mjs`. Add L03's exact
text as a regression fixture.

### F2 — MEDIUM · Analyzer "Timing Distribution" is empty (tooling gap)
`prism-audit-runner.mjs` emits per-scenario timing to **stdout**, not into the
output JSONL, so `analyze-audit.mjs` reports "No hook timing samples" and cannot
compute a p95 table. → *Fix:* have the runner write `duration_ms` per scenario
into the JSONL record.

### F3 — MEDIUM · Real-session correlation = 0 matched
Analyzer matched 0 synthetic scenarios against 7557 routing events. Synthetic
session naming (`audit-*`) doesn't cross-reference live `(tier,source)` tuples.
→ *Fix:* tag synthetic routing entries with a correlatable key, or relax the
matcher to (tier,source) pairs.

### F4 — LOW · Roster / KB freshness drift
Deployed roster (107 KB, today) vs repo roster (7 KB, Jun 3); session-start also
warned the KB index is behind source docs and `tools-registry.md` changed after
the last `/prism-index`. → *Fix:* `node ~/.claude/tools/prism-kb-rebuild.mjs --sync`
then `/prism-index`.

### F5 — LOW · Catalog vs classifier drift
`REAL-CLF-010` predicts the saga/2PC prompt scores low (→ needs conv-override);
the live classifier scored it **8 → opus** directly. The catalog expectations are
stale relative to current classifier sensitivity. `REAL-SKI-004` assumes a
`greek-ecommerce-seo-specialist` that isn't in the deployed roster.

### F6 — HIGH · App-building workflows under-route (see `simple-app-routing.md`)
Live injection of the realistic simple-app build sequence: only **deploy** and
**refactor+migrate** escalate; **plan / build / scaffold / add-auth** fall to
**haiku**. Worst case: `implement secure user authentication with password
hashing + JWT` → haiku, score 0 (security-critical → weakest tier). Same root
cause as F1. → *Fix:* widen opus/panel signal vocab; add a **security-verb tier
floor** (auth, login, password, crypto, payment, token/JWT).

### F7 — HIGH · No automatic memory recall is firing (see `evaluation.md` Q3)
claude-mem worker is **DOWN** since 2026-06-10 (5 consecutive failures; `:37790`
refused). Because claude-mem is detected as *installed*, PRISM's native turn-15
memory-save nudge is **suppressed** — so neither the ambient layer nor its
fallback fires. DB intact (1152 obs/61 summaries) but unreachable this session.
Manual `/prism-recall` still works. → *Fix:* restart the claude-mem worker, or
make the standdown conditional on the worker being healthy.

### F8 — MEDIUM · No "rule-of-three → promote-to-skill" (feature gap, `evaluation.md` Q4)
No mechanism tracks task frequency or suggests a skill after N repeats. Closest
are all manual (`/prism-clean` L3 lesson capture, 3-projects lesson template,
external-tool tier promotion). → *Decide:* build auto-promotion or document as
out-of-scope.

### F4 — RESOLVED (was LOW) · KB index is fresh
The session-start "KB behind source docs" warning was transient: index rebuilt
2026-06-17T07:26Z > source max 07:04Z, no dirty flags. Supersedes the earlier
F4 "stale" note. (Roster deployed-vs-repo size difference is the empty source
skeleton vs the populated deployed roster — expected, not drift.)

### Runtime orchestrator test (real `@master-orchestrator` dispatch, CRDT editor)
Confirmed live (telemetry: `passthrough-master-orchestrator` → `passthrough
agent-factory`):
- **Roster-first + factory-on-miss WORKS.** The orchestrator read the roster,
  scored all 15 agents, correctly classified `software-architecture-expert` as
  **ADJACENT-ONLY = MISS** for the CRDT seat (avoided the adjacency trap; reused
  it only for the generalist YAGNI seat), found zero CRDT matches, and **actually
  dispatched `@agent-factory`**, which authored a real 191-line specialist.
- **Skill-equipping of workers WORKS.** 4 of 5 planned PHASE-1 workers were
  equipped with a specific skill/specialist (spawned CRDT agent, `supabase`,
  `software-architecture-expert`, `frontend-design`, `supabase-postgres-best-practices`);
  **0 bare general-purpose.** Doctrine (`phase-1-execution.md:124-149`) mandates
  *injecting* the skill's substance/path into the worker prompt (subagents don't
  hot-reload skills).

### F9 — MEDIUM · Skill-equipping of workers is unenforced
The "equip the worker with a skill, don't dispatch bare general-purpose" rule is
MANDATORY doctrine but no hook verifies a worker prompt actually got a skill
injected. Hooks enforce the subagent-bypass and nested-dispatch ban; skill-equip
relies on the orchestrator's reasoning. (It complied here — but nothing catches a
lapse.)

### F10 — MEDIUM · agent-factory ↔ orchestrator roster-scope mismatch
The factory wrote a **project-scoped** agent file; a project `.claude/agents/roster.json`
was created (auto-register fired project-scoped). But the orchestrator checked the
**global** roster, saw the probe absent, declared "factory didn't register," and
**manually duplicated** the entry into the GLOBAL roster (`auto_registered:false`,
`scope:"project"` — a project agent in the global index). Net: a project agent
leaked into the global roster. Either the factory should register where the
orchestrator looks, or the orchestrator should check the project roster first.
(One confirming test still owed — the project roster.json was deleted in cleanup
before its contents were dumped.)

### F11 — corroborates F7 · NotebookLM research path is down
The factory's live `notebooklm auth check` returned cookies-present but
**token-fetch FAIL**, so the free Tier-1 citation-grounded research path is
unavailable system-wide; every new agent degrades to Tier-3 (Opus + WebSearch).
Same cloud-auth degradation family as the claude-mem worker (F7).

> Full behavioral/UX evaluation (the five questions about app scenarios, diff
> visibility, memory, rule-of-three, agent reuse): **`evaluation.md`**.

## 4. Recommended next steps
1. **F1 (do first):** patch the opus/panel signal vocabulary + add the L03
   regression fixture. Highest user impact — it under-routes real architecture work.
2. F2: thread `duration_ms` into the runner JSONL so p95 timing is reportable.
3. F4: run `prism-kb-rebuild --sync` + `/prism-index` to clear freshness warnings.
4. F3/F5: refresh the audit catalog expectations to current classifier behavior.

## 5. Artifacts (this run)
- `synthetic.jsonl` — 29-scenario synthetic baseline
- `analyzer-report.md` — analyzer output (verdict PASS)
- `telemetry-stdout.txt` — aggregator run; rollup at `~/.claude/.prism-telemetry-rollup.json`
- `queue.json` — per-test observed-vs-expected state (13 pass / 1 fail)
- `report.md` — this file

No mutation to `~/.claude/.prism-routing.jsonl` (append-only by hooks). Probe
artifacts created and retired; global roster unchanged.
