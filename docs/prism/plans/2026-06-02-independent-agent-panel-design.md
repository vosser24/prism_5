# Independent-Agent Panel + Learning Solution-Architect Master — design brief v2 (v5.x)

Date: 2026-06-02 · Status: DESIGN v2 — spikes 0 (zero-nesting) + 0c (no mid-session skill hot-reload) COMPLETE; architecture + skills-toolkit re-decided with user; build items 1–8 DONE (TDD) + item 9 cross-phase review DONE (3 findings fixed, 13 suites green); PENDING user go-ahead: sync-live, Round 13 report, commit · Owner: this session
Related memory: feedback-panel-independent-agents-default, project-panel-roleplay-finding, feedback-panel-summon-eval-deadlock

> **v2 changelog (2026-06-02):** STEP 0 nesting spike ran and returned *zero nesting* (§3a). User then re-decided the architecture in two ways that EXPAND scope beyond the original "make the panel dispatch real experts":
> 1. The per-project master is promoted from "dispatcher/router" to a **top-class, codebase-learning solution architect** who is the *sole dispatcher* and *owns the design* — now a first-class deliverable of THIS plan (not a separate track).
> 2. Experts are **persistent, rostered, and learning** — each accumulates project-specific domain knowledge across sessions (not stateless personas, not ephemeral).
> Execution model = **A** (master is the only context with the `Agent` tool, so it dispatches both expert-seats and workers; experts own *planning*, not dispatch). Sections §1, §3a, §8 keep the historical record; §2/§4/§5/§6/§7 are rewritten to v2.

## 1. Why (origin — unchanged)
v5.0 Round 12 (ShiftForge greenfield stress test) proved — via the orchestrator run transcript (`agent-a168f7095456bfffc.jsonl` in the Prism_ultimate session) — that the master-orchestrator PHASE 0d "adversarial panel" is **single-model role-play**: one Opus voiced all 5 expert seats in its own context; ZERO expert subagents were dispatched; 4/5 "experts" had no backing agent; the 1 mapped to a real agent (debt-settlement-algo-expert, a thin Tier-3 mimic) was not actually dispatched. The panel still caught all 6 ShiftForge traps, but it shares one model's blind spots, carries no researched domain depth, and the "5-expert panel" framing oversells it.

**User decision (2026-06-02):** panels must run with **real, independent, reusable expert agents by default**. Single-model role-play kept only as an opt-in fast mode. (Extended v2: the master that runs them is a genuine learning architect, and the experts persist and learn — see §2.)

## 2. Goals / non-goals (v2 — expanded)
**Goals**
- **Master = top-class learning solution architect.** The per-project `master-<slug>` (the session agent) owns the design, is the *sole dispatcher*, and runs a durable knowledge-growth loop over the project's codebase (recall → design → archive). Identity and protocol rewritten from "dispatcher/evaluator" to "principal solution architect + team captain."
- PHASE 0d panel **dispatches independent subagents** per seat (separate context windows), chaired by the master in the main loop.
- Seats are **real, reusable, LEARNING experts**: a matching rostered specialist if one exists; else agent-factory **creates one and persists it to the roster**. Each expert carries **its own project-domain memory that accumulates across sessions** (not stateless, not ephemeral).
- **Experts own planning; master owns dispatch.** Forced by STEP 0 (dispatched experts have no dispatch tool). Experts return worker specs + reviews; the master dispatches every worker.
- Keep single-model role-play as an **opt-in fast mode** (cost/latency escape) and as the only path for the no-project-master fallback.
- **Experts carry an evolving, reusable set of domain skills.** Beyond memory, each expert owns a toolkit of vertical, task-specific skills (authored/evolved via `skill-creator`) that it equips to the workers the master dispatches for its domain tasks. Skills persist and improve across sessions.
- Cost guardrails so default real-dispatch is affordable.

**Non-goals**
- Not removing role-play (stays, opt-in).
- Not fixing the classifier over-fire here (separate finding: feedback-panel-summon-eval-deadlock).
- Not (yet) building cross-PROJECT expert knowledge sharing — expert memory is per-project for now.

## 3. The hard constraint — subagent nesting depth (RESOLVED)
"Experts spawn their own workers" would be a dispatch tree chair → expert → worker. STEP 0 settled whether that is possible. **It is not.** See §3a.

## 3a. STEP 0 RESULT — nesting spike COMPLETE (2026-06-02)
**Method:** From the main loop, dispatched two LEVEL-1 subagents and asked each to enumerate its dispatch primitives and attempt a LEVEL-2 dispatch.
- **Spike A — `general-purpose` (Tools: `*`):** VERDICT `NO_DISPATCH_TOOL`. Live toolset = Bash, Edit, Glob, Grep, PowerShell, Read, SendUserFile, Skill, ToolSearch, Write. `Agent`/`Task`/`TaskCreate` ABSENT from both the live list AND the deferred registry. The `*` grant does **not** include dispatch when run as a subagent.
- **Spike B — `master-orchestrator` (frontmatter explicitly lists `Agent`):** VERDICT `NO_DISPATCH_TOOL`. Toolset was REDUCED to `Read, Write, Bash, Grep, Glob` — the declared `Agent` tool was **stripped**, and `ToolSearch` itself was disabled, so dispatch could not even be loaded from the registry.

**Conclusion: OUTCOME C — ZERO NESTING.** Subagent dispatch is structurally confined to the main-loop / session context. A dispatched agent — even one that declares `Agent` — cannot spawn ANY further subagent. (Evidence: agents `a69dfafcaf75d1c83`, `a33f9ab607f01b81f`, this session.)

**Hard consequences (all now baked into the v2 design):**
1. The chair MUST be the SESSION-level project-master — it is the *only* context holding the `Agent` tool. CONFIRMED, mandatory.
2. The chair→expert→worker tree is not realisable via the Agent tool → execution model **A** (experts plan, master dispatches).
3. The global `@master-orchestrator` is itself a subagent, so it ALSO cannot dispatch experts → the no-project-master fallback can only do in-context role-play, never a real dispatched panel.
4. Workflow tool is no escape (caps nesting at 1; `workflow()` inside a child throws). Teams give peer messaging but spawning still needs the main-loop `Agent` tool.

## 4. Design v2 (outcome C — session-master is the sole dispatcher AND a learning architect)

### 4.1 The Master — top-class learning solution architect (NEW, first-class)
The `master-<slug>` agent (wired as the session agent via `settings.json agent:`, so it runs in the main loop and *keeps* the `Agent` tool) is rewritten from today's "dispatcher / evaluator / handoff-producer" framing into a **principal solution architect** for the project. It:
- **Owns the design.** It does not merely route to experts; it forms the architectural position, then convenes the panel to stress-test and sharpen it.
- **Is the sole dispatcher.** It dispatches expert seats (PHASE 0d) and all workers (PHASE 1).
- **Runs a durable knowledge-growth loop over the codebase** (the "enhances his knowledge base on each codebase" requirement):
  - *Ingest:* `/prism-discover` indexes the codebase into compact reference files; the master reads them + `MEMORY.md` (auto-injected) at task start.
  - *Recall:* `prism-recall` queries the project RAG for prior decisions/learnings before designing.
  - *Consolidate:* after meaningful work, `prism-archive` folds new learnings into the RAG and the master updates its `MEMORY.md` router (≤25 KB cap).
  - This loop is written INTO the master's operating protocol (run by default), not left as manual slash commands.
- Identity/quality bar: "top-class solution architect" — opinionated, codebase-grounded, owns trade-offs; the panel is its instrument, not its replacement.

### 4.2 The Experts — persistent, rostered, learning (UPGRADED)
For each needed seat (3–5, distinct opposed biases), the master:
1. **Matches the roster** (project + global). If a specialist fits → reuse it.
2. **Else creates one** via agent-factory (Tier-1 NotebookLM when authed; Tier-3 + non-silent notice otherwise) and **registers it in the roster** (reusable next time).
3. Persona / general-purpose subagents are NOT used here — that path belongs only to the opt-in fast mode (4.6).
4. **Each expert owns a persistent, growing project-domain memory.** Across sessions the expert accumulates what it learned about THIS codebase in its domain. Mechanism (pending STEP 0b spike):
   - *Primary:* expert agent frontmatter `memory: project` (Claude Code subagent project memory) — if dispatched experts reliably read+write it across sessions.
   - *Fallback (robust regardless of spike):* **master-brokered memory.** The roster holds a per-expert domain-memory file; the master injects the expert's accumulated notes into the dispatch prompt and persists the expert's returned "what I learned" delta back to that file. Works even if dispatched experts can't self-persist.
   - Design for the fallback; let the spike potentially simplify to primary.
5. **Each expert owns an evolving, reusable set of domain SKILLS** (vertical task knowledge), separate from its memory. The expert authors them via `skill-creator` (spike-proven 2026-06-02 — a dispatched expert HAS the `Skill` tool, `skill-creator` + `writing-skills` are available, and Write works → `EXPERT_CAN_AUTHOR_SKILL`), refines them across sessions (skill-creator's modify/improve path), and the roster records which skills belong to which expert. These skills are what the expert equips to its workers (§4.8).

### 4.3 Panel (PHASE 0d) — multi-agent adversarial dispatch
1. Master dispatches all seats in parallel (one `Agent()` per seat) with the request + assigned bias + the expert's recalled domain memory → collect each expert's position.
2. Cross-challenge round: give each expert the others' positions; require ≥2 substantive challenges to other seats. Independent contexts produce real disagreement, not self-critique.
3. Master synthesizes the adjudicated architecture with explicit exclusions + reasons.
4. `phase-0d-oob-reviewer` reviews panel quality (unchanged).

### 4.4 Execution (PHASE 1) — experts plan, master dispatches (model A)
- Master assigns domain workstreams to the matching expert.
- Each expert returns a **written worker spec** for its domain (tasks, acceptance criteria, file targets) — it cannot spawn workers (STEP 0).
- The **master dispatches the workers** on each expert's spec (sole dispatcher).
- The owning expert **reviews worker output** (round-trip via re-dispatch by the master); the master persists the expert's domain learnings (§4.2).
- phase-1.5 OOB review unchanged.

### 4.5 The no-project-master fallback
The global `@master-orchestrator` is itself dispatched, so by §3a it cannot dispatch experts. When no project-master exists, the panel **degrades to in-context role-play (4.6)** — it cannot run a real dispatched panel. The non-silent notice must say so. The fix is to encourage `/prism-deep-dive` to create the project-master (the only thing that unlocks real panels).

### 4.6 Role-play fast mode (opt-in)
`PRISM_PANEL_MODE=roleplay` (or a low-stakes tier / explicit flag) → the current in-context role-play. Default = real dispatch for NOVEL / high-stakes panels when a project-master chairs.

### 4.7 Cost guardrails
Seat cap (default 3, max 5). Opus master/chair; seats default sonnet (haiku for scout-type seats); workers sized to task. Parallel dispatch (wall-clock = slowest seat). Reuse persisted experts + their memory to amortize creation and re-learning cost. Offer an estimated cost line before a full real-dispatch panel.

### 4.8 Expert domain skills → worker equipping (NEW — reusable + evolving)
User requirement: each expert can create a skill and have it power a worker spawned for a task. Reconciled with STEP 0 (experts can't spawn): **experts author / own / evolve the skills; the master equips the workers with them.**
- **Author + evolve (proven):** a dispatched expert can invoke `skill-creator` / `writing-skills` and Write skill files (spike `a289c1f4e058beb10`, 2026-06-02 → `EXPERT_CAN_AUTHOR_SKILL`). It creates new domain skills and improves existing ones across sessions.
- **Reusable + evolving:** skills persist in a skills dir and are tied to the owning expert in the roster; the expert refines them over time — vertical, task-specific knowledge that compounds (a third persistent asset per expert, alongside identity and domain memory).
- **Equip the worker (STEP 0c spike COMPLETE, 2026-06-02 → `NOT_DISCOVERABLE_MID_SESSION`):** a skill authored mid-session is NOT picked up by a freshly-dispatched worker — the skill registry is snapshotted at session-init and does not hot-reload (file on disk, but `Unknown skill` + not in the worker's skills list; evidence agents a4ae7c92e78df2191, aec69308129183ac0). Therefore a **two-tier** equip model:
  - *Same session (REQUIRED path):* the master **injects the skill file path/content into the worker's dispatch prompt**; the worker Reads + follows it. Works regardless of registration — this is the within-session mechanism.
  - *Across sessions (registered path):* after a session reload the expert-authored skill becomes a first-class registered skill, discoverable by name normally — this IS the "reusable & evolving across sessions" behavior.
  - The disproven "mid-session harness discovery" primary is dropped; the inject-path is not a fallback but the standard same-session mechanism.

## 5. Files to touch (v2)
- `tools/prism-deep-dive.mjs` — `renderMasterAgent` template + `ORCH_PROTOCOL_*`: rewrite master identity to "learning solution architect"; wire the discover/recall/archive loop into the protocol; keep session-agent wiring.
- `skills/master-orchestrator/SKILL.md` — chair protocol; dispatch-vs-roleplay branch; the knowledge-growth loop; sole-dispatcher rule.
- `skills/master-orchestrator/references/phase-0-team-assembly.md` — real-expert seat sourcing + roster persistence + per-expert persistent memory pointer.
- `skills/master-orchestrator/references/phase-0d-adversarial.md` — multi-agent dispatch + cross-challenge (currently role-play only).
- `skills/master-orchestrator/references/dispatch-shapes.md` — model-A shape: expert returns spec → master dispatches worker → expert reviews.
- Roster schema (`roster.json`) — per-expert domain-memory file pointer + `learns: true` flag.
- agent-factory — ensure created experts get `memory: project` + a roster memory file.
- Wherever tier/mode is read — add `PRISM_PANEL_MODE`.
- Tests (see §6).

## 6. TDD plan (write red first)
- A test asserting a dispatch-mode panel performs real per-seat `Agent()` dispatches (dispatch counter ≥ seat count), NOT zero. (Would have caught the role-play-masquerading-as-panel gap.)
- A test for the cross-challenge round yielding ≥2 challenges per seat.
- A test that role-play fast mode still works under `PRISM_PANEL_MODE=roleplay`.
- A test that a freshly created expert is persisted to the roster (reusable next panel).
- **A test that an expert's domain memory persists across two consecutive panels** (write in panel 1, present in panel 2's dispatch prompt) — covers the "experts learn too" requirement via the master-brokered path.
- A test that the master's protocol invokes the recall step before designing and the archive step after (loop wired, not manual).
- A test that an expert can author a domain skill and the master equips a dispatched worker with it via the inject path (worker Reads + follows the injected skill file — same-session, since mid-session registry discovery is disproven per 0c).
- A test that an evolved skill (improved in a later session) carries its changes forward (reusable + evolving).
- If feasible, a smoke test capturing the STEP 0b expert-memory spike result.

## 7. Build sequence (v2)
0. ✅ **Nesting-depth spike — DONE** (zero nesting; §3a).
0b. **Expert-memory persistence spike** — can a dispatched expert read+write its own `memory: project` across sessions, or must the master broker it? Outcome selects primary vs fallback in §4.2. (Small; design for fallback either way.)
0c. ✅ **Skill-equip discoverability spike — DONE** (`NOT_DISCOVERABLE_MID_SESSION`): mid-session skills do not hot-reload; same-session equip = master injects skill file into worker prompt; cross-session = registered skill. §4.8 updated. Build 5b uses the inject path.
1. ✅ **Master identity + learning loop — DONE (2026-06-02, TDD).** `renderMasterAgent` description + `ORCH_PROTOCOL_INLINE` rewritten to "principal solution architect + sole dispatcher" with the recall→design→archive loop; `skills/master-orchestrator/SKILL.md` role section + two new subsections (KNOWLEDGE-GROWTH LOOP, SOLE DISPATCHER). Tests: 2 new in `test-prism-deep-dive.mjs` (26/26), new drift-guard `test-master-orchestrator-v5-architect.mjs` (4/4). Regression: evidence-rules 9/9, thin-wrapper 14/14. Existing markers (Five unbreakable rules, skill-ref thin body) preserved.
2. ✅ **Team-assembly — DONE (2026-06-02, TDD).** `phase-0-team-assembly.md` gains a "Panel seat sourcing (v5.x)" section: match-roster-first → reuse, else `@agent-factory` create+persist; experts persist+learn (`learns`/`domain_memory_file`, recall-on-reuse, master-brokered write-back); experts own an evolving `owned_skills` toolkit (equip via skill-file injection); persona/role-play excluded from real seats. Roster data: added additive `learns: false` / `domain_memory_file: null` / `owned_skills: []` to `prism-agent-write-register.mjs` stub + the roster `_schema_example_agent`. Tests: +1 in `test-agent-write-register.mjs` (12/12), +3 phase-0 drift-guards in `test-master-orchestrator-v5-architect.mjs` (10/10). Regression: roster-lock 11/11. Additive — existing roster entries unaffected.
3. ✅ **PHASE 0d multi-agent dispatch + cross-challenge — DONE (2026-06-02, TDD).** Added `dispatch_mode` + per-position `dispatched_agent_id` to the panel.json schema; new `checkDispatchMode()` gate in `hooks/prism-panel-guard.mjs` BLOCKS (exit 2) a panel that claims `dispatch_mode:"dispatch"` with zero/partial/duplicate real ids (role-play masquerading as dispatch) — THE load-bearing guard. `phase-0d-adversarial.md` rewritten with the real-dispatch + cross-challenge protocol, role-play opt-in, and no-project-master degrade. Tests: new `test-prism-panel-dispatch-guard.mjs` (7/7, incl. the dispatch-count≥seats case), +3 phase-0d doctrine assertions in `test-master-orchestrator-v5-architect.mjs` (7/7). Regression: panel-deadlock 5/5, phase-0d-oob 3/3. Additive (absent dispatch_mode = legacy/unenforced). NOTE: this is §7 item **3** (item 2 was leapfrogged then completed right after — see item 2 above; both ✅).
4. ✅ **Execution (model A) — DONE (2026-06-02, TDD).** `phase-1-execution.md` gains a "Model-A execution" section (experts return written worker specs; master dispatches workers + equips via skill-file injection; expert reviews via master re-dispatch; master-brokered learning write-back). `dispatch-shapes.md` gains a "Who dispatches" rule (dispatch is main-loop-only; teammates message but cannot spawn; route all fan-out through the master). Doctrine-only (no behavioral code). Tests: +2 drift-guards in `test-master-orchestrator-v5-architect.mjs` (12/12).
5. ✅ **Expert learning write-back — DONE (2026-06-02, TDD).** Pivot from recon: REUSE the existing per-agent convention instead of a new memory tree — `domain_memory_file` = `~/.claude/agents/<expert>/experience/context-adapters/<project-slug>.md` (already read at the expert's STARTUP). Doctrine in `phase-0-team-assembly.md`: recall-on-reuse (inject), master-brokered APPEND write-back, cross-session pickup via STARTUP. Zero new tooling (consistent with house style — all such writes are LLM-driven). Test: +1 drift-guard (13/13).
5b. ✅ **Expert domain skills — DONE (2026-06-02, TDD).** Doctrine in `phase-0-team-assembly.md`: author/evolve via `skill-creator` into the project skills root `<project>/.claude/skills/<expert>-<skill>/SKILL.md` (recorded in roster `owned_skills`); same-session equip = inject SKILL.md into worker prompt (STEP 0c); next-session = first-class registered/discoverable skill. Test: +1 drift-guard (14/14).
6. ✅ **PRISM_PANEL_MODE surfacing — DONE (2026-06-02, TDD).** New `hooks/lib/prism-panel-mode.mjs` resolver (`resolvePanelMode`, default `dispatch`, typo→safe-default so a fat-finger never silently degrades a real panel); `prism-session-start.mjs` injects "active panel mode is roleplay" only when overridden (mirrors PRISM_PARALLEL_CAP, no default-noise). Registered in `tools/install-manifest.json` (manifest-coverage 8/8 + installer-coverage 2/2 confirm). Tests: new `test-prism-panel-mode.mjs` (5/5); cap regression 7/7. (The no-project-master role-play degrade was already doctrine'd in item 3.)
7. ✅ **Chair wiring end-to-end — DONE (2026-06-02).** Verified the two halves: `settings-write` points `settings.json agent:` at `master-<slug>` AND the generated master declares the `Agent` tool (sole dispatcher in main loop). Locked with an end-to-end drift-guard in `test-prism-deep-dive.mjs` (27/27). (Regression guard for existing wiring; no new code needed.)
8. ✅ **Cost guardrails — DONE (2026-06-02, TDD).** `phase-0d-adversarial.md` gains a "Cost guardrails" section: seat cap (default 3, max 5), model defaults (opus chair / sonnet seats / haiku scouts / workers sized to task), parallel dispatch, reuse-to-amortize, estimate-before-full-panel + roleplay downshift. Test: +1 drift-guard (15/15).
9. 🔶 **Full review DONE; sync-live + Round 13 report + commit PENDING (user decisions).**
   - ✅ **Cross-phase review (2026-06-02):** two independent reviewers (plan-vs-code drift + integration consistency). Drift reviewer: **8/8 items verified, 0 false claims**, all cited test counts match. Integration reviewer: 1 HIGH + 2 MED findings, ALL FIXED + guarded:
     - HIGH — `command -v notebooklm` in the team-assembly NotebookLM pre-check was a known AppLocker false-positive (pre-existing, Rounds 1–9); replaced with execution detection (`notebooklm --version`), matching agent-factory. Drift-guard added.
     - MED — session-start panel-mode notice now explicitly instructs writing `dispatch_mode:"<mode>"` in panel.json (env→field link). Test strengthened.
     - MED — disambiguated the literal `roleplay` token vs the prose "role-play" in phase-0d.
   - Final regression: 13 test files ALL GREEN (v5-architect 16, deep-dive 27, panel-dispatch-guard 7, panel-mode 5, agent-write-register 12, dispatch-cap 7, manifest-coverage 8, installer-coverage 2, roster-lock 11, phase-0d-oob 3, panel-deadlock 5, evidence-rules 9, thin-wrapper 14).
   - ✅ **Sync live DONE (2026-06-02, user-authorized).** `node tools/prism-installer.mjs install` → backup `.prism-install-backup-2026-06-02_11-27-13` (rollback-able), 101 files + 4 dirs, 6 user agents preserved, settings merged. Verification: installer `verify` all-pass; **audit-runner 29/29** against live hooks; live file checks confirm all v5.x code present (checkDispatchMode, panel-mode lib, session-start injection, real-dispatch + seat-sourcing doctrine, AppLocker fix); installed resolver works (roleplay→roleplay, default→dispatch); **live guard probe PASS** (installed guard blocks masquerade exit 2, allows real-dispatch + roleplay exit 0). NOTE: a Claude Code session restart makes the new hooks active for the running session (install verified standalone).
   - ⏳ STILL PENDING (need user go-ahead): (a) **append Round 13** to `docs/prism/2026-06-01-v5.0-stress-test-report.md`; (b) **commit** — all work is working-tree only (fragile; a reset would wipe it).

## 8. Decisions log (history preserved)
- Real, reusable experts by default. CONFIRMED (2026-06-02).
- Role-play kept as an opt-in fast mode. CONFIRMED.
- ~~Experts own execution (chair → expert → worker). CONFIRMED.~~ **REVISED by STEP 0 (2026-06-02):** dispatched experts have NO dispatch primitive → execution model **A** (experts plan, master dispatches). CONFIRMED with user.
- ~~Project-master likely required as chair (pending spike). DIRECTIONAL.~~ **CONFIRMED by STEP 0:** the session-level project-master is the ONLY context with the Agent tool; it MUST chair.
- **Master = top-class, codebase-learning solution architect, absorbed into THIS plan.** CONFIRMED with user (2026-06-02).
- **Experts persist AND learn (per-project domain memory across sessions).** CONFIRMED with user (2026-06-02).
- **Experts also own an evolving, reusable set of domain SKILLS, authored via skill-creator and equipped to the workers the master dispatches.** CONFIRMED with user (2026-06-02). Reconciled with STEP 0: experts author/equip; the master spawns. Authoring proven (spike a289c1f4e058beb10).

## 9. Open questions / remaining spikes for the build session
- STEP 0b: dispatched-expert self-persistence vs master-brokered memory (primary vs fallback in §4.2). NOTE: cannot be tested in one session (needs two). The 0c finding (registry snapshotted at session-init, no hot-reload) makes same-session self-persistence unlikely by analogy → lean to master-brokered fallback; defer the true two-session test to build. 
- ~~STEP 0c~~ ✅ RESOLVED (`NOT_DISCOVERABLE_MID_SESSION`): same-session = master injects skill file into worker prompt; cross-session = registered skill (§4.8).
- Seat-count default + per-seat model defaults (current direction: cap 3 default / 5 max; opus master, sonnet seats).
- Where `PRISM_PANEL_MODE` is read and how tiers map to it.
- Roster schema additions for per-expert memory (file pointer + `learns` flag) — exact shape.
- Master-memory vs expert-memory boundary: what the master's MEMORY.md holds vs what lives in each expert's domain memory (avoid duplication).

## 10. Evidence pointers
- Panel transcript proving role-play: `C:\Users\ServosY\.claude\projects\Y--Documents-utilities-projects-Prism-ultimate\cdf40de8-7977-40ee-bded-192f47e1acec\subagents\agent-a168f7095456bfffc.jsonl`
- Round 12 findings: `docs/prism/2026-06-01-v5.0-stress-test-report.md` (Round 12 entry to be appended) + the three memory files in "Related memory".
- STEP 0 nesting spike (2026-06-02, this session): spike A general-purpose = `NO_DISPATCH_TOOL`; spike B master-orchestrator (declares Agent) had Agent stripped, toolset reduced to Read/Write/Bash/Grep/Glob, ToolSearch disabled. Conclusion: zero nesting, dispatch is main-loop-only.
- Current project-master template: `tools/prism-deep-dive.mjs` `renderMasterAgent()` (~line 183) — today framed as "dispatcher/evaluator/handoff-producer" (the identity §4.1 rewrites). Global wrapper: `agents/master-orchestrator.md`.
