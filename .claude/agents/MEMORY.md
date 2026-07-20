# MEMORY.md — master-prism-3 router

<!-- Auto-injected at subagent start (first 200 lines or 25 KB per
     https://code.claude.com/docs/en/sub-agents § Enable persistent memory).
     This file is a ROUTER. Knowledge lives in linked files, not here.
     Seeded by /prism-deep-dive on 2026-06-19. -->

## Project profile

Stack and datasources are owned by the always-loaded root `CLAUDE.md`
"Project Identity" section — deleted here (D046 #4) rather than hand-
duplicated: a second hand-written copy rots independently of the first,
and CLAUDE.md is already injected on every turn regardless.

Active work is likewise not hand-tracked here. It is surfaced every
SessionStart by the TASK-RECALL block (`hooks/prism-session-start.mjs`
C6), generated deterministically from `.claude/.prism-open-tasks.json`
(written by SessionEnd's task snapshot, `hooks/lib/prism-task-snapshot.mjs`)
— with staleness tagging, a self-clearing integrity line, and a
"+N more — call TaskList" pointer so nothing is silently dropped. That
generator already exists and already fires automatically; a hand-written
"Active workstreams" list here would duplicate it with none of that
staleness protection — which is exactly the D046 #4 defect this section
used to be (seeded 2026-06-19, last content still describing v5.10-v5.12
work on a v6.4+ codebase). If no TASK-RECALL block appears in a given
session, that means `.claude/.prism-open-tasks.json` is absent/empty or
`PRISM_DISABLE_TASK_RECALL=1` — NOT "no active work"; run `TaskList` to
check (a missing signal is not evidence of "none" — D047).

## Recent decisions (last 10, pointer-only)

<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->

- [[D044]] PII gate on the prism_5 public mirror
- [[D045]] D043 resolution — dispatch guard honestly advisory under agent-teams (per-caller hard gate infeasible)
- [[D046]] PRISM memory/handoff/routing remediation — KEEP-AND-FIX on the 9-finding defect set; misses made LOUD (ledger + surface-at-consumption), never permissive parsers
- [[D046]] PRISM memory/handoff/routing remediation — KEEP-AND-FIX verdict on the 9-finding defect set
- [[D047]] Vacuous signals: "no" vs "didn't check"
- [[D048]] Repair-tool cross-transcript fold: field-wise-carry vs newest-wins — ship-gate held it back
- [[D049]] Skill-delivery taxonomy + dormant-mechanism disease
- [[D050]] Lesson-match rule-token seeding dropped for precision; kwSet multiplier is the real tension
- [[D050]] Lesson-match recall via rule-token seeding — dropped for precision; the kwSet multiplier is the real tension
- [[D051]] OOB reviewer arming — induce the panel.json write, keep Phase-1.5 tag-only, gate+measure panel-seat
- [[D052]] Bounded rule-token seed for lesson-match recall — retained as recall layer; precision claim WITHDRAWN by D053
- [[D053]] Corpus-distinctiveness DF=1 anchor gate — kills the D050 lesson-match over-fire class by construction; D023 formula/threshold untouched

## Recent lessons (last 10, pointer-only)

<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->

- [[lessons-tactical#2026-07-18]] 6.5.1 release + reconciliation: report-delivery-failure, phantom-attribution, green-suites-hide-regressions
- [[lessons-tactical#2026-07-19]] 6.5.2 shipped (D048 closed) + skill-delivery/dormant-mechanism investigation
- [[lessons#2026-07-19-session]] 2026-07-19 session — 6.5.2 release (D048 closed) + skill-delivery/dormant-mechanism investigation
- [[lessons-tactical#2026-07-19]] Cross-model no-author verification catches regressions green tests miss (v6.6.1 FIX-4c)
- [[lessons-tactical#2026-07-19]] claude -p headless sessions need --session-id + --no-session-persistence + env-strip to isolate
- [[lessons-tactical#2026-07-19]] file-lease-guard (FIX-2) dormant unless the model actually fans out concurrently
- [[lessons-tactical#2026-07-19]] 60-prompt UAT: #56 holding-string reproduced live; D049 dormancy confirmed 3x; /prism-health asserts config-presence not live-firing; a quiet guard is not a working guard (models self-comply first)
- [[lessons-tactical#2026-07-19]] Cross-model no-author validation caught 3 regressions green tests missed (R1 session)
- [[lessons#2026-07-20-session]] Tactical lessons — 2026-07-20 R1 implement+validate session
- [[lessons-tactical#2026-07-20]] R2/R3/D051 session — measure-before-build, kwSet-inflation over-fire, fable-e2e catches silent wiring

## Session log

<!-- /prism-clean appends session-summary lines here. -->

- [2026-07-16] Shipped PRISM v6.4.0 (0721cd38c): resolved D043 via honest advisory-in-teams + borrowed-unlock visibility (per-caller hard gate infeasible — D045) + declared-identity lease; plus drift guard, SessionStart latency budget, SendMessage PreToolUse routing, live-work dedup, handoff resume pointer, 4-guard census instrumentation. All 13 suites green; installed+verified; drift-check 0-drift. Push to origin pending user.
- [2026-07-16] v6.4.0 live-verified in this agent-teams session (borrowed_unlock/dedup/lease/preamble/advisory all fired on real tool calls via installed hooks); pushed origin main (957fe3ba3); scaffolding committed; roster.json untracked+gitignored (machine-local abs paths leak into prism_5 mirror tree); prism_5 mirror published then clean re-mirror pending; confirmed local+installed both 6.4.0, 0 drift.
- [2026-07-17] PRISM memory/handoff/routing remediation: 4-seat panel → KEEP-AND-FIX; Fix A (task-snapshot recall, 3 loss vectors + loud-miss + repair tool) complete on branch prism-fix-a-task-snapshot (9c1cd6d4b/794c321a7/8feca2fc3, 14/14 green); karpathy standing preamble on branch prism-karpathy-preamble; install to ~/.claude PENDING (agent-teams tree contention). See D046 + docs/prism/lessons/2026-07-17-prism-remediation-session.md.
- [2026-07-18] Shipped PRISM 6.5.1 (six recall-integrity fixes) onto main 6.5.0; repair tool held back, correct fold fix deferred to task #24; origin/prism5 held
- [2026-07-19] Shipped 6.5.2 (D048 repair-tool fold, pushed to origin+prism5); ran 6-agent skill-delivery/superpowers investigation -> D049 (taxonomy + dormant-mechanism disease) + v6.6.0 wiring plan
- [2026-07-19] Shipped v6.6.0 (8 guard-wiring fixes) + v6.6.1 (FIX-4c ratchet added-region two-round fix); ran 30-msg opus UAT that found the FIX-4c bypass; cross-model verification caught a char-strip regression before release; both releases mirrored to prism5.
- [2026-07-19] Ran full 60-prompt UAT baseline on v6.6.1 (parent-driven claude -p harness; ~48 PASS/4 FAIL/3 PARTIAL/5 INCONCLUSIVE); #56 reproduced LIVE (subagents cant drive nested panel sessions); D049 dormancy confirmed 3x (#16 OOB reviewers, #18 file-lease-guard, #42 health reports config-presence not live-firing); authored F1-F12 surgical fix plan via fable
- [2026-07-19] Implemented + fable-validated Release R1 (F1-A/F1-C/F3/F4/F8/F9/F11/F12, all PASS, uncommitted); dropped F5 for over-firing (D050); reconciled #24/#25/#42 as already-shipped; filed follow-ups #57/#58/#66
- [2026-07-19] Committed R1 as 8 per-fix commits on branch prism-r1-observability (79856c859..529fa0859, guards green); NOT merged/pushed/installed — next: merge to main + installer install to activate global hooks
- [2026-07-20] Merged R1+R2+R3 to main + installed; shipped follow-ups #57/#66; built D051 OOB-arming (phase-0d panel.json-write injection + gated panel-seat arming + /prism-health honesty), fable-e2e verified, on branch prism-followups-57-58-66 (unmerged); #58 2nd approach (distinctive-token) failed fable battery via kwSet inflation and was reverted (top-N next); filed #71/#75/#76
- [2026-07-20] Resumed handoff → SHIPPED #58 lesson-match recall gap as corpus-distinctiveness DF=1 anchor gate (D053) after round-1 rule-token seed (D052) FAILED independent fable validation (D050 over-fire class: 9-entry fire on a natural prompt); structural guarantee held under 18 counterexample probes; caught+fixed a 3rd-writer (knowledge-delta.mjs self-heal) drift bug. +#71/#75/#76 hygiene (test-home leak, phase_0d health-honesty marker, stale dispatcher test). Released 6.6.2 (dfaaf0b36), installed+verified, pushed origin (0/0). Workflow: fable-design→opus/sonnet-build→fable-adversarial-validate. Then ran D044 PII scan → 2 machine-local leaks found (scan caught 1, orchestrator ground-truth re-grep caught the 2nd in test-repair-open-tasks.mjs) + scrubbed (a2331b96c); PUBLISHED prism5 snapshot v6.6.2 (364eae008), tree==main verified. Nothing pending — origin + prism5 both current.

## Recent lessons (new pointer)

- [[lessons#2026-06-23-6.0.0-engagement-gate]] verify-what-fired; red-team-before-design; monotonic-bool > RMW counter; 1.8x orchestration floor = dont-orchestrate-routine; soft-default + measure before enforce-flip; prove wiring with E2E test.
- [[lessons#2026-07-20-addendum]] #58 DF=1 recall gate (D053) after round-1 (D052) FAILED independent fable validation; structural-guarantee > tuning; grep-ALL-writers drift catch; verify-the-handed-premise (#75); proportional rigor; 6.6.2 shipped.

## Standing rules

Imperatives drawn from the most important Locked adjudications (auto-generated —
see `tools/lib/memory-heal.mjs regenerateStandingRules`, D-recall-hardening C2/C3):

<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->
- **D051:** The phase-0d/panel OOB reviewers have NO deterministic producer — `panel.json`'s content (positions + challenges) IS the master's LLM reasoning, so a hook can only write an empty skeleton that carries nothing to review; do NOT build a fake producer. Instead INDUCE the write via the reliable injection channel (F4 clause-in-prompt, gated on `summon_panel`), mandating ONE **direct Write tool call** to the final `.prism-task-<sha>/panel.json` (a tempfile+rename or Bash/heredoc write bypasses the PostToolUse Write event and the reviewer silently never fires). Keep Phase-1.5 arming **tag-only** by default; ship panel-seat arming **gated OFF** (`PRISM_PANEL_SEAT_OOB`) and **instrumented** (`arm_reason: tagged|panel-seat`) so it can be MEASURED before any default-on flip (D028: no evidence yet it beats master-chaired review). `/prism-health` reports tagged / phase-0d / panel-seat as three DISTINCT lines and never says "armed" without a genuine non-mock recent fire.
- **D048:** The repair tool's cross-transcript fold must carry fields forward WITHIN a task's own transcript history (so a later status-only update never blanks an earlier subject) AND flag — never silently weld — cross-session id collisions; neither main's ca6854cb1 (carries fields but field-bleeds on collision) nor the 2026-07-18 branch version (no field-bleed but blanks subject) satisfies both, so the tool stays HELD BACK from install until the combined fix (task #24) lands.
- **D047:** A field that collapses "no" and "didn't check" into one value is VACUOUS — populated, well-typed, structurally valid, and evidence-free; make the third state (UNKNOWN/never-measured) representable at the producer, then classify the CONSUMER as code (enforceable) or prompt-spec (advisory-only ceiling), and never report a green whose denominator you chose yourself.
- **D046:** PRISM's memory/handoff/routing defects are omissive "silent under-reporting" (a structured path fails silently → a regex/manual fallback emits plausible output → nothing reports the miss); fix by making misses LOUD (ledger + surface-at-consumption), NEVER by permissive parsers; KEEP-AND-FIX not uninstall (uninstall is measured-safe but protects nothing — all defects are omissive); snapshot unversioned knowledge before any change.
- **D045:** In agent-teams (all teammates share one `session_id`), the dispatch guard's session-global `dispatched` flag CANNOT gate per-caller — ship it ADVISORY in teams topology (fail-safe, gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), make every borrowed-unlock VISIBLE (`borrowed_unlock` event + in-band advisory) so the silent false-allow becomes measurable, and close write-collisions via a DECLARED-identity lease; NEVER build a per-caller HARD gate on payload fields that do not carry caller identity.
- **D044:** Before pushing to any PUBLIC remote (prism_5), run an exhaustive PII scan on the actual commit-tree object; already-tracked files are leak vectors that .gitignore does NOT retroactively cover (git rm --cached to untrack); the release commit itself must pass the same PII scan — test fixtures included.
- **D042:** A guard is not proven until it has been demonstrated to FIRE on a bad input AND STAY QUIET on a good one. One path is not proof. A lesson violated twice is a missing guard, not a missing paragraph.
- **D041:** /prism-clean must distinguish "never bootstrapped" from "running in a git worktree where .prism-state.json is legitimately absent (gitignored, lives in the main worktree)" — detect the worktree via `git rev-parse --git-common-dir` and PROCEED with capture (git-tracked MEMORY.md + docs/prism/ + knowledge-index still work), skipping only the state-derived --slug pointer-appends; never blanket-STOP and advise /prism-bootstrap in the worktree case (that would create a second desynced state file).
- **D040:** Durable knowledge must propagate into the always-on recall surfaces (MEMORY.md pointers + Standing rules + task carryover) DETERMINISTICALLY on SessionStart — never via a manual LLM step that can silently fail.
- **D028:** Do not cite Item 6 as evidence for or against the NOVEL-tier expert panel — the panel never fired (summon_panel=false on all 15 Arm-A sessions), so the benchmark measures only PRISM's Opus-parent + orchestrator + hook scaffolding vs bare Sonnet on ROUTINE tasks; keep the panel-on-NOVEL default and the custom governance hooks, and treat parent-model/classifier calibration on routine work (not the panel, not hook migration) as the only cost lever this evidence supports.
- **D027:** Run Item 6 with Option 1 CLAUDE.md fidelity (baseline A vs frozen C1), per-task caps frozen at user-approved values, Arm A pinned at commit 6cc154c, and a hybrid PowerShell/Node harness with empirically-validated runtime IO.
- **D026:** Item 6 is a decision-grade A/B frozen per pre-registration; measure per-task delta_T (ratio cancels task difficulty), gate cost claims behind median-of-3 + spread, treat subscription cost as modeled/relative-only, and keep quality ground-truth via acceptance-gating + laundered blind judging.
<!-- prism:standing-rules:end -->

## Active specialists

- (none hired yet. Per Locked D007, `@agent-factory` is reached only
  through the orchestrator's Team Assembly decision tree
  (`skills/master-orchestrator/SKILL.md`, which master-prism-3 follows) —
  registry consultation against `tools-registry.md` first, then an
  existing-agent staleness check — never call the factory directly as a
  first step.)

## Available plugin tools

<!-- /prism-validate-plugins refreshes this section. -->
- (run /prism-validate-plugins to populate)
