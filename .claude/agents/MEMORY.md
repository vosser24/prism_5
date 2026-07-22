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

- [[D050]] Lesson-match rule-token seeding dropped for precision; kwSet multiplier is the real tension
- [[D050]] Lesson-match recall via rule-token seeding — dropped for precision; the kwSet multiplier is the real tension
- [[D051]] OOB reviewer arming — induce the panel.json write, keep Phase-1.5 tag-only, gate+measure panel-seat
- [[D052]] Bounded rule-token seed for lesson-match recall — retained as recall layer; precision claim WITHDRAWN by D053
- [[D053]] Corpus-distinctiveness DF=1 anchor gate — kills the D050 lesson-match over-fire class by construction; D023 formula/threshold untouched
- [[D054]] Panel seat-sourcing is force-injected AND provenance-instrumented at panel.json write-time; schema-shown must equal schema-enforced; ships observe-first (PRISM_PANEL_PROVENANCE) — measure before flip
- [[D054]] Panel seat-sourcing is force-injected AND provenance-enforced at panel.json write-time
- [[D053]] D053 — Corpus-distinctiveness (DF=1) anchor gate for lesson-match precision
- [[D055]] Live-agents ledger keys on per-instance agent_id, not agent type
- [[D056]] Specialist-routing guard precision: stoplist ambient name-tokens + score-2 nudge floor

## Recent lessons (last 10, pointer-only)

<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->

- [[lessons-tactical#2026-07-19]] 60-prompt UAT: #56 holding-string reproduced live; D049 dormancy confirmed 3x; /prism-health asserts config-presence not live-firing; a quiet guard is not a working guard (models self-comply first)
- [[lessons-tactical#2026-07-19]] Cross-model no-author validation caught 3 regressions green tests missed (R1 session)
- [[lessons#2026-07-20-session]] Tactical lessons — 2026-07-20 R1 implement+validate session
- [[lessons-tactical#2026-07-20]] R2/R3/D051 session — measure-before-build, kwSet-inflation over-fire, fable-e2e catches silent wiring
- [[lessons#2026-07-20-session-addendum-2]] Strategic + tactical lessons — 2026-07-20 addendum #2 (#77 panel-governance fix)
- [[lessons#2026-07-20-session-addendum]] Tactical lessons — 2026-07-20 addendum (handoff-resume: #58 recall gate + #71/#75/#76)
- [[lessons-tactical#2026-07-20]] #86 live-agents: installed-vs-repo hooks; serialize shared-file edits (concurrent edits contaminate verification)
- [[lessons-tactical#2026-07-21]] Handoff PENDING lists decay — re-verify carried tickets before acting (6 already shipped)
- [[lessons-tactical#2026-07-21]] Reconcile before building — compose-first applies to auditing existing mechanisms (D056 guard already existed)
- [[lessons-tactical#2026-07-21]] Absence-claim discipline — read the source field before claiming X has no Y (classifier bucket is not evidence)

## Session log

<!-- /prism-clean appends session-summary lines here. -->

- [2026-07-19] Ran full 60-prompt UAT baseline on v6.6.1 (parent-driven claude -p harness; ~48 PASS/4 FAIL/3 PARTIAL/5 INCONCLUSIVE); #56 reproduced LIVE (subagents cant drive nested panel sessions); D049 dormancy confirmed 3x (#16 OOB reviewers, #18 file-lease-guard, #42 health reports config-presence not live-firing); authored F1-F12 surgical fix plan via fable
- [2026-07-19] Implemented + fable-validated Release R1 (F1-A/F1-C/F3/F4/F8/F9/F11/F12, all PASS, uncommitted); dropped F5 for over-firing (D050); reconciled #24/#25/#42 as already-shipped; filed follow-ups #57/#58/#66
- [2026-07-19] Committed R1 as 8 per-fix commits on branch prism-r1-observability (79856c859..529fa0859, guards green); NOT merged/pushed/installed — next: merge to main + installer install to activate global hooks
- [2026-07-20] Merged R1+R2+R3 to main + installed; shipped follow-ups #57/#66; built D051 OOB-arming (phase-0d panel.json-write injection + gated panel-seat arming + /prism-health honesty), fable-e2e verified, on branch prism-followups-57-58-66 (unmerged); #58 2nd approach (distinctive-token) failed fable battery via kwSet inflation and was reverted (top-N next); filed #71/#75/#76
- [2026-07-20] Resumed handoff → SHIPPED #58 lesson-match recall gap as corpus-distinctiveness DF=1 anchor gate (D053) after round-1 rule-token seed (D052) FAILED independent fable validation (D050 over-fire class: 9-entry fire on a natural prompt); structural guarantee held under 18 counterexample probes; caught+fixed a 3rd-writer (knowledge-delta.mjs self-heal) drift bug. +#71/#75/#76 hygiene (test-home leak, phase_0d health-honesty marker, stale dispatcher test). Released 6.6.2 (dfaaf0b36), installed+verified, pushed origin (0/0). Workflow: fable-design→opus/sonnet-build→fable-adversarial-validate. Then ran D044 PII scan → 2 machine-local leaks found (scan caught 1, orchestrator ground-truth re-grep caught the 2nd in test-repair-open-tasks.mjs) + scrubbed (a2331b96c); PUBLISHED prism5 snapshot v6.6.2 (364eae008), tree==main verified. Nothing pending — origin + prism5 both current.
- [2026-07-20] User caught the orchestrator improvising ad-hoc general-purpose panelists instead of roster+@agent-factory assembly → diagnosed PRISM's OWN panel governance as un-validated (forensic probe: 4-layer D046/D049 gap — underspecified force-inject, schema-shown≠enforced, ≥1-dispatch proxy, silent vertical-tag skip). SHIPPED #77/D054 via fable-design→opus-build→fable-adversarial-validate: force-inject seat-sourcing discipline + deterministic roster fit-list (prism-prompt-tier-router), align shown==enforced schema, observe-first provenance detector (prism-panel-guard detectAdHocSeats, PRISM_PANEL_PROVENANCE=observe default). Round-1 FAILED independent validation (gameable "<domain> domain expert" escape) → tightened to vertical-signal classifier, re-validated PASS (narrow 2/22 residual). Released 6.6.3 (9190eaf18), installed+verified, pushed origin (0/0), D044-scanned clean + PUBLISHED prism5 v6.6.3 (d53e7d2c8), tree==main. NEXT-PHASE (future, measured): flip PRISM_PANEL_PROVENANCE observe→soft→hard after confirming ~0 false-positives on live panels.
- [2026-07-20] Shipped #86 live-agents ledger per-instance agent_id keying (v6.6.4, commit 15033bce0, branch fix/86-live-agents-per-instance-keying, push HELD); E3 live-probe confirmed agent_id present+identical at Start/Stop; D055 + full D042 suite + independent no-author validation; remaining: push + fresh-session re-probe.
- [2026-07-21] Shipped #86 v6.6.4 to origin/main + prism5 mirror (c7e1fc852); fresh-session re-probe confirmed per-instance ledger keying live; re-verified backlog — all 6 carried tickets (#24/#25/#42/#58/#71/#75/#76) already closed.
- [2026-07-21] Shipped v6.6.5/D056 specialist-routing guard precision (stoplist ambient name-tokens + score-2 nudge floor + instrumentation) to origin+prism5 after 3-seat panel, TDD, no-author review, isolated uat-60 gate; backfilled 5 roster core_domains (#98).
- [2026-07-21] Shipped claude-master core_domains (2816275f8, prism5 c3e443f4d); corrected #98 (reconcile additive-only, frontmatter is source, OOB reviewers un-matched); designed D057 absence-claim gate + surgical fix plan for a fresh session.

## Recent lessons (new pointer)

- [[lessons#2026-06-23-6.0.0-engagement-gate]] verify-what-fired; red-team-before-design; monotonic-bool > RMW counter; 1.8x orchestration floor = dont-orchestrate-routine; soft-default + measure before enforce-flip; prove wiring with E2E test.
- [[lessons#2026-07-20-addendum]] #58 DF=1 recall gate (D053) after round-1 (D052) FAILED independent fable validation; structural-guarantee > tuning; grep-ALL-writers drift catch; verify-the-handed-premise (#75); proportional rigor; 6.6.2 shipped.
- [[lessons#2026-07-20-addendum-2]] #77 panel-governance fix (D054): PRISM's OWN Team-Assembly shipped un-validated (4-layer D046/D049 gap) → force-inject discipline + align schema-shown==enforced + observe-first provenance gate; no-author validator caught a gameable boundary round-1; 6.6.3 shipped + mirrored.

## Standing rules

Imperatives drawn from the most important Locked adjudications (auto-generated —
see `tools/lib/memory-heal.mjs regenerateStandingRules`, D-recall-hardening C2/C3):

<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->
- **D056:** PRISM's specialist-routing guard must match on DOMAIN signal, not ambient agent-name tokens — stoplist repo-ambient name-segments (claude, prism, code, …) in agentTerms() and require score≥2 to nudge; do NOT promote to enforce or widen the buildScore classifier until the newly-instrumented nudge-compliance data justifies it.
- **D055:** Key the live-agents ledger on the per-instance `agent_id` via `extractAgentKey` (falling back to agent type only when absent) and age-cap `running` entries — never key ledger status on agent TYPE, which collapses concurrent same-type dispatches into one flickering slot.
- **D054:** On a panel-summoning turn PRISM MUST force-inject the roster-first then factory-fill then tag-provenance seat-sourcing discipline (never a bare general-purpose/persona fill for a vertical seat), and the panel.json provenance detector MUST infer vertical (not require the explicit tag) and run regardless of dispatch_mode; the schema shown to the model MUST equal the schema the guard enforces.
- **D053:** Admit a lesson-match fire only if the prompt shares >=1 token unique to
- **D052:** Seed the lesson-match keyword map from title+slug+ref PLUS rule tokens in
- **D051:** The phase-0d/panel OOB reviewers have NO deterministic producer — `panel.json`'s content (positions + challenges) IS the master's LLM reasoning, so a hook can only write an empty skeleton that carries nothing to review; do NOT build a fake producer. Instead INDUCE the write via the reliable injection channel (F4 clause-in-prompt, gated on `summon_panel`), mandating ONE **direct Write tool call** to the final `.prism-task-<sha>/panel.json` (a tempfile+rename or Bash/heredoc write bypasses the PostToolUse Write event and the reviewer silently never fires). Keep Phase-1.5 arming **tag-only** by default; ship panel-seat arming **gated OFF** (`PRISM_PANEL_SEAT_OOB`) and **instrumented** (`arm_reason: tagged|panel-seat`) so it can be MEASURED before any default-on flip (D028: no evidence yet it beats master-chaired review). `/prism-health` reports tagged / phase-0d / panel-seat as three DISTINCT lines and never says "armed" without a genuine non-mock recent fire.
- **D048:** The repair tool's cross-transcript fold must carry fields forward WITHIN a task's own transcript history (so a later status-only update never blanks an earlier subject) AND flag — never silently weld — cross-session id collisions; neither main's ca6854cb1 (carries fields but field-bleeds on collision) nor the 2026-07-18 branch version (no field-bleed but blanks subject) satisfies both, so the tool stays HELD BACK from install until the combined fix (task #24) lands.
- **D047:** A field that collapses "no" and "didn't check" into one value is VACUOUS — populated, well-typed, structurally valid, and evidence-free; make the third state (UNKNOWN/never-measured) representable at the producer, then classify the CONSUMER as code (enforceable) or prompt-spec (advisory-only ceiling), and never report a green whose denominator you chose yourself.
- **D046:** PRISM's memory/handoff/routing defects are omissive "silent under-reporting" (a structured path fails silently → a regex/manual fallback emits plausible output → nothing reports the miss); fix by making misses LOUD (ledger + surface-at-consumption), NEVER by permissive parsers; KEEP-AND-FIX not uninstall (uninstall is measured-safe but protects nothing — all defects are omissive); snapshot unversioned knowledge before any change.
- **D045:** In agent-teams (all teammates share one `session_id`), the dispatch guard's session-global `dispatched` flag CANNOT gate per-caller — ship it ADVISORY in teams topology (fail-safe, gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), make every borrowed-unlock VISIBLE (`borrowed_unlock` event + in-band advisory) so the silent false-allow becomes measurable, and close write-collisions via a DECLARED-identity lease; NEVER build a per-caller HARD gate on payload fields that do not carry caller identity.
- **D044:** Before pushing to any PUBLIC remote (prism_5), run an exhaustive PII scan on the actual commit-tree object; already-tracked files are leak vectors that .gitignore does NOT retroactively cover (git rm --cached to untrack); the release commit itself must pass the same PII scan — test fixtures included.
- **D042:** A guard is not proven until it has been demonstrated to FIRE on a bad input AND STAY QUIET on a good one. One path is not proof. A lesson violated twice is a missing guard, not a missing paragraph.
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
