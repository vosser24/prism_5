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

- [[D039]] Nested-dispatch depth hardening — mechanical injection + CLI-spawn guard
- [[D040]] Recall hardening: auto-heal MEMORY.md + task round-trip (v6.2.0)
- [[D041]] /prism-clean worktree-aware — proceed+capture in a worktree (state gitignored), skip only --slug appends; never blanket-STOP→bootstrap (would desync state). Doc-only fix; helpers already fail-open.
- [[D041]] /prism-clean must be git-worktree-aware, not hard-STOP on absent state
- [[D042]] A guard is not proven until it fires on bad input AND stays quiet on good input
- [[D043]] The agent-teams enforcement gap: PRISM asserts dispatch controls it does not have
- [[D044]] PII gate on the prism_5 public mirror
- [[D045]] D043 resolution — dispatch guard honestly advisory under agent-teams (per-caller hard gate infeasible)
- [[D046]] PRISM memory/handoff/routing remediation — KEEP-AND-FIX on the 9-finding defect set; misses made LOUD (ledger + surface-at-consumption), never permissive parsers
- [[D046]] PRISM memory/handoff/routing remediation — KEEP-AND-FIX verdict on the 9-finding defect set

## Recent lessons (last 10, pointer-only)

<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->

- [[lessons-tactical#2026-07-10]] Nested-dispatch guard signal absent on current builds — use injection + CLI guard
- [[lessons-tactical#2026-07-13]] v6.2.0 recall-hardening tactical lessons (shipped!=installed; updatedInput completeness; dedup test-isolation; holding-string=failed)
- [[lessons#2026-07-14-dispatch-preamble-session]] Dispatch-preamble hook: what changed + a same-key updatedInput collision gotcha
- [[lessons#2026-07-14-updatedinput-collision-structural-guard]] Structural guard for same-key updatedInput collisions on the PreToolUse dispatcher
- [[lessons#2026-07-14-session]] Tactical lessons — guard-forensics session (2026-07-14)
- [[lessons-tactical#2026-07-15]] v6.3.0 release + prism5 PII-gate near-miss + Phase 1.5 revival lessons
- [[lessons-tactical#2026-07-16]] claude-mem enabled:false fix + verify-field-location-against-real-file lesson
- [[lessons-tactical#2026-07-16]] v6.4.0 guard-hardening — phantom-test-citations; teams env-leak in test subprocesses; false-allow made visible not closed; drift round-trip capstone
- [[lessons-tactical#2026-07-16]] v6.4.0 live-verified in-session (guards fire on real calls) + SMB index.lock atomic-git + mirror publishes main's tree (untrack machine-local) + dedup threshold loose on boilerplate
- [[lessons#2026-07-17-prism-remediation-session]] Tactical lessons — PRISM memory/handoff/routing remediation session (2026-07-17)

## Session log

<!-- /prism-clean appends session-summary lines here. -->

- [2026-06-25] Shipped explicit-only panel (D034 Locked, merged 0df0228f7, installed 6.0.0, reviewed/green). Built+verified PII-clean prism5 6.0.0 snapshot 7ac5895ec (manual force-push pending). Scrubbed dev-tree employer info (080b82ae0); installable already agnostic. Lesson: heavy work on local C: not SMB Y:.
- [2026-06-25] NEXT-SESSION ORDER (user-set): finish #33 dev-side release FIRST (decide origin public/private + any origin push); then #6 + cleanup; PUBLISH prism5 LAST (irreversible). See 2026-06-25-SESSION-HANDOFF.md.
- [2026-07-06] Diagnosed + fixed 6 PRISM behavioral regressions (sonnet-overuse, prompt-truncation wording, compose-first, brevity signs, memory-recall, skill-misfire); shipped A/F/C/D/B-prep verified in working tree; B-live/D-refresh/E + capability-catalog pending user
- [2026-07-06] Completed PRISM regression-fix session: shipped+verified A/F/C/D/G/B-prep + #1 tier-escalation(D038)/#2/#10/E(SendMessage+live-agents ledger); classifier confirmed keyword-only (LLM path killed v3.2.0, semantic rejected D017); pending user: updatedInput probe, CLAUDE.md rule-1 fix, /prism-index refresh, plugin-budget, classifier self-override hardening
- [2026-07-06] Session COMPLETE + DEPLOYED: all 13 PRISM regression findings fixed/verified/installed to ~/.claude (D038 tier-escalation, E SendMessage+live-agents ledger, G capability catalog, F dispatch-guard, memory:true normalize, brevity/compose/recall, tier-override telemetry); roster refreshed 45→0 dangling; install-manifest completed 142→146. Deferred: model-guard updatedInput rewrite (evidence-gated). Uncommitted on main.
- [2026-07-06] PRISM v6.1.0 RELEASED — 13 regression findings fixed/verified/deployed; version bumped + committed 1d49bd542 + pushed origin + local install 6.1.0; scrubbed orphan release-6.1.0-scrubbed (5b8b974d0) built + PII-clean on C: clone; ONLY pending = user's manual prism5 force-push (safety-hook-blocked for agent by design)
- [2026-07-15] Shipped PRISM v6.3.0 (Phase 1.5 revival + self-blindness canary + evidence taxonomy) to origin/main b8024c0ea; published history-free prism5 orphan snapshot 5c54ba9ad after a PII gate caught real employer/user data; memory:true->project fix; consolidated on main
- [2026-07-16] Cut PRISM v6.3.1: claude-mem guard/detector respect enabled:false (silence :37790 on a disabled plugin, silent native fallback); recon field-location error caught by reading the real settings.json
- [2026-07-16] Shipped PRISM v6.4.0 (0721cd38c): resolved D043 via honest advisory-in-teams + borrowed-unlock visibility (per-caller hard gate infeasible — D045) + declared-identity lease; plus drift guard, SessionStart latency budget, SendMessage PreToolUse routing, live-work dedup, handoff resume pointer, 4-guard census instrumentation. All 13 suites green; installed+verified; drift-check 0-drift. Push to origin pending user.
- [2026-07-16] v6.4.0 live-verified in this agent-teams session (borrowed_unlock/dedup/lease/preamble/advisory all fired on real tool calls via installed hooks); pushed origin main (957fe3ba3); scaffolding committed; roster.json untracked+gitignored (machine-local abs paths leak into prism_5 mirror tree); prism_5 mirror published then clean re-mirror pending; confirmed local+installed both 6.4.0, 0 drift.
- [2026-07-17] PRISM memory/handoff/routing remediation: 4-seat panel → KEEP-AND-FIX; Fix A (task-snapshot recall, 3 loss vectors + loud-miss + repair tool) complete on branch prism-fix-a-task-snapshot (9c1cd6d4b/794c321a7/8feca2fc3, 14/14 green); karpathy standing preamble on branch prism-karpathy-preamble; install to ~/.claude PENDING (agent-teams tree contention). See D046 + docs/prism/lessons/2026-07-17-prism-remediation-session.md.

## Recent lessons (new pointer)

- [[lessons#2026-06-23-6.0.0-engagement-gate]] verify-what-fired; red-team-before-design; monotonic-bool > RMW counter; 1.8x orchestration floor = dont-orchestrate-routine; soft-default + measure before enforce-flip; prove wiring with E2E test.

## Standing rules

Imperatives drawn from the most important Locked adjudications (auto-generated —
see `tools/lib/memory-heal.mjs regenerateStandingRules`, D-recall-hardening C2/C3):

<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->
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
- **D025:** Build only the two regime-independent correctness fixes (graceful-degradation-at-cap; narrow classifier over-escalation fix scoped to prompt-length+cache); do NOT make the panel opt-in or migrate always-on hooks to native availableModels/enforceAvailableModels (false premise — those are model-picker UI filters); run the sustained 5-session real-codebase A/B before any strategic panel/hook-surface change.
- **D024:** PRISM's runtime machinery is a repeatable 3-8x cost multiplier (n=1, quote ranges) on short headless tasks with complete-but-expensive output; the proven defects are null-at-cap graceful-degradation and routine-work over-escalation. The "serial dispatch" claim was a harness measurement artifact — fix the concurrency metric (group stream-json by message.id) before asserting any parallelism defect.
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
