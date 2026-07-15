# MEMORY.md — master-prism-3 router

<!-- Auto-injected at subagent start (first 200 lines or 25 KB per
     https://code.claude.com/docs/en/sub-agents § Enable persistent memory).
     This file is a ROUTER. Knowledge lives in linked files, not here.
     Seeded by /prism-deep-dive on 2026-06-19. -->

## Project profile

- **Stack**: Node.js (ESM, dep-free deterministic hooks + CLI under tools/ and hooks/); Python >=3.12 pwagent; PowerShell + Bash install scripts. Local-first, no network.
- **Datasources**: none indexed (0 tables, 0 endpoints; orchestration tool)
- **Active workstreams**:
  - Agent dispatch quality + specialist-routing guards (v5.12.x)
  - Anti-zombie dispatch guards: bash hang-guard + dispatch dedup (v5.11.0)
  - Task API adoption + tier-router ambiguity floor (v5.10.0)
  - Mutation-guard edge cases: scratch/temp-dir redirects, heredocs (v5.10.1)

## Recent decisions (last 10, pointer-only)

<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->

- 2026-06-25 — 6.0.0 PUBLISHED to prism5 (7ac5895ec, PII-clean); WS2.x panel-feeding recall CLOSED → D035 (recall stays master-scoped). origin PRIVATE, fast-forwarded to d529c0a2f.
- [[D029]] Master Economics: Value Is Conditional on Task Class; Engagement-Gate Redesign
- [[D030]] Step 2 routine cost gate MEASURED → FAIL (11.75x vs 2.0x); single-pass not cost-reducing (ON/OFF 1.42x); enforce-mode stays off; cost lever is model+context, not turn-collapse.
- [[D031]] Phase-4 rework-survival operationalization — chaired panel synthesis
- [[D032]] Phase-4 scorer R1 invariant: fire only on robust→naive flip (pre-reg amendment)
- [[D033]] Phase-4 panel verdict: no rework-survival advantage; retire panel auto-fire to opt-in
- [[D034]] Replace lexical panel auto-fire with stakes-gated recommendation (recommend → confirm)
- [[D035]] WS2.x re-scoped: panel-feeding recall closed, redirected to master stakes-recall
- [[D036]] Platform subagent-nesting (v2.1.172) doesn't change PRISM main-loop-only doctrine (design constraint, D014 hook)
- [[D037]] Always-on capability catalog at session start
- [[D039]] Nested-dispatch depth hardening — mechanical injection + CLI-spawn guard

## Recent lessons (last 10, pointer-only)

<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->

- [[lessons-tactical#2026-06-23]] Item 6 full run: H1 amortization REJECTED; heartbeat-babysit, fresh-dir rebuild over rogue agents, judge-provisioning-by-mtime, gate re-score-not-rerun
- [[lessons-tactical#2026-06-23]] Quality-leg close-out: blind judge guessed arm 6/6 (p=0.016) so S4 VOID though scores tied; S3 rework dead (no per-session commits + no frozen checklist); forensic check proved the panel never fired (summon_panel=false 0/15) — Item 6 measures Opus-parent+orchestrator+hooks, not the panel; verify what actually fired before attributing cost
- [[lessons-tactical#2026-06-23]] Cost attribution by model + billed!=public + subagent over-delegation + verify-what-fired
- [[lessons-tactical#2026-06-24]] Phase-4 a+b+c build: headless-CLI phantom flags, dry-run!=launch-validator, regex-negation, adversarial-calibration, n=6 power
- [[lessons-tactical#2026-06-24]] SMB corrupts git-blame → migrate benchmark to local C:; 8 harness plumbing fixes; probe-before-spend; one-way-ratchet instrument amendment
- [[lessons-tactical#2026-06-25]] SMB kills long workers (mtime false-negative); explicit-only panel ship; force-push hook-blocked=manual publish; git log -S over-reports history depth
- [[lessons-tactical#2026-06-25]] Test a guard empirically — an agent's analysis of guard internals is not ground truth
- [[lessons-tactical#2026-06-26]] Version-of-record must be deterministic (not update-log); verify artifacts not prose; parallelize edits, serialize commit tail
- [[lessons-tactical#2026-07-06]] Subagents don't auto-activate skills — equip discipline in the prompt
- [[lessons-tactical#2026-07-10]] Nested-dispatch guard signal absent on current builds — use injection + CLI guard

## Session log

<!-- /prism-clean appends session-summary lines here. -->

- [2026-06-24] Phase-4 preconditions a+b+c BUILT+committed (f7019ce5): chaired 3-seat panel froze rework-survival operationalization (D031, behavioral-primary+COMMITMENT-gate+deterministic-scorer+Non-Neg#4 fixed-vanilla-stress-K3); calibration 6/6 (negation-guarded); claude-master caught 3 launch-blocking CLI defects (--max-turns/--temperature not real flags, stale opus pin). Pending: d=6.0.0->main, smoke, run.
- [2026-06-24] 6.0.0 LANDED on main (ff to 0d136f4f2): preconditions a+b+c+d all done, preflight gate all_pass=YES, RUN unblocked. Caught+fixed a real version-sync bug (plugin.json un-bumped) amid worker-contention chaos (contradictory green/red suite runs = partial-bump race; quiescent re-run found the truth). Next fresh session: smoke ($0.10) then the 72-session paid run.
- [2026-06-24] Phase-4 run repair: found+fixed 8 harness plumbing bugs + SMB git-blame corruption (root cause) by migrating repo to local C:; cheap probe exposed 67% scorer over-exclusion; landed one-way-ratchet arm-neutral scorer amendment (D032, validated free: 0% exclusion, B unchanged, no ceiling); launched full 72-session run on C: (in flight). Fixes live on C: copy only — port back to Y:/ after run.
- [2026-06-24] Phase-4 full run COMPLETE (18 sessions on local C:): panel (Arm A) 40% survival vs no-panel (Arm B) 60% vs vanilla (C) 25%; Fisher p=1.0, A-B=-20pp (wrong direction) -> pre-reg rule FAILS -> RETIRE panel auto-fire to opt-in (D033 Locked); keep PRISM orchestration (both arms > vanilla). Exclusion 22% (legit). D032 scorer amendment promoted Locked. NEXT: port C: harness/scorer fixes back to Y:/.
- [2026-06-25] Shipped explicit-only panel (D034 Locked, merged 0df0228f7, installed 6.0.0, reviewed/green). Built+verified PII-clean prism5 6.0.0 snapshot 7ac5895ec (manual force-push pending). Scrubbed dev-tree employer info (080b82ae0); installable already agnostic. Lesson: heavy work on local C: not SMB Y:.
- [2026-06-25] NEXT-SESSION ORDER (user-set): finish #33 dev-side release FIRST (decide origin public/private + any origin push); then #6 + cleanup; PUBLISH prism5 LAST (irreversible). See 2026-06-25-SESSION-HANDOFF.md.
- [2026-07-06] Diagnosed + fixed 6 PRISM behavioral regressions (sonnet-overuse, prompt-truncation wording, compose-first, brevity signs, memory-recall, skill-misfire); shipped A/F/C/D/B-prep verified in working tree; B-live/D-refresh/E + capability-catalog pending user
- [2026-07-06] Completed PRISM regression-fix session: shipped+verified A/F/C/D/G/B-prep + #1 tier-escalation(D038)/#2/#10/E(SendMessage+live-agents ledger); classifier confirmed keyword-only (LLM path killed v3.2.0, semantic rejected D017); pending user: updatedInput probe, CLAUDE.md rule-1 fix, /prism-index refresh, plugin-budget, classifier self-override hardening
- [2026-07-06] Session COMPLETE + DEPLOYED: all 13 PRISM regression findings fixed/verified/installed to ~/.claude (D038 tier-escalation, E SendMessage+live-agents ledger, G capability catalog, F dispatch-guard, memory:true normalize, brevity/compose/recall, tier-override telemetry); roster refreshed 45→0 dangling; install-manifest completed 142→146. Deferred: model-guard updatedInput rewrite (evidence-gated). Uncommitted on main.
- [2026-07-06] PRISM v6.1.0 RELEASED — 13 regression findings fixed/verified/deployed; version bumped + committed 1d49bd542 + pushed origin + local install 6.1.0; scrubbed orphan release-6.1.0-scrubbed (5b8b974d0) built + PII-clean on C: clone; ONLY pending = user's manual prism5 force-push (safety-hook-blocked for agent by design)

## Recent lessons (new pointer)

- [[lessons#2026-06-23-6.0.0-engagement-gate]] verify-what-fired; red-team-before-design; monotonic-bool > RMW counter; 1.8x orchestration floor = dont-orchestrate-routine; soft-default + measure before enforce-flip; prove wiring with E2E test.

## Standing rules

Imperatives drawn from the most important Locked adjudications (auto-generated —
see `tools/lib/memory-heal.mjs regenerateStandingRules`, D-recall-hardening C2/C3):

<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->
- **D039:** Enforce the no-nesting doctrine by MECHANICALLY appending the anti-over-delegation clause to every Agent() worker prompt (hooks/prism-anti-nesting-inject.mjs) and warning on `claude -p` spawns — do NOT rely on global running-agent state to hard-deny nested dispatch: under agent-teams the main loop dispatches background agents while others run, so running-count cannot distinguish nested from legitimate dispatch. The caller-context signal (parent_tool_use_id) stays best-effort and is build-dependent past depth 2.
- **D035:** WS2.x "panel-feeding recall" is closed — never build recall injection gated to panel auto-fire; recall fires for the MASTER orchestrator on NOVEL/high-stakes turns, independent of the (now explicit-only) panel.
- **D034:** Panel fires ONLY on explicit user request (EXPLICIT_PANEL_RE). The master MAY offer the panel in one line on high-stakes/irreversible decisions — plain chat, no mechanism, never blocks work. Legacy lexical auto-fire behind `PRISM_LEXICAL_PANEL=1`.
- **D033:** Phase-4 measured NO large rework-survival advantage from the adversarial panel (Arm A panel 40% ≤ Arm B no-panel 60%, Fisher p=1.0, n=5 valid/arm); per the pre-registered rule, RETIRE panel auto-fire to opt-in. PRISM orchestration still beat vanilla (both arms > C 25%), so keep orchestration; the panel specifically earns its cost only on opt-in.
- **D032:** When a frozen measurement instrument over-excludes, amend it ONLY via a one-way-ratchet, arm-neutral correction — validate on existing committed sessions that it reduces false exclusions, never flips a valid verdict's direction, and leaves a control arm unchanged — before spending on the full run.
- **D031:** Operationalize benchmark "survival" as behavioral stress-rework on git-blamed, ID-tagged ADR decision lines, gated by a COMMITMENT prerequisite and scored deterministically (no judge in the primary path); run the stress under a fixed arm-agnostic executor (K=3 majority) and report an n=6 FAIL as "no LARGE effect", never "no effect".
- **D030:** Routine turn-collapse (single-pass) does NOT reduce one-shot routine cost — the cost is the Opus parent doing routine work itself + the full CLAUDE.md/memory context load, not the number of turns; keep PRISM_ROUTINE_SINGLE_PASS enforce-mode OFF and treat the parent/worker MODEL on routine (not turn count) as the only remaining cost lever.
- **D028:** Do not cite Item 6 as evidence for or against the NOVEL-tier expert panel — the panel never fired (summon_panel=false on all 15 Arm-A sessions), so the benchmark measures only PRISM's Opus-parent + orchestrator + hook scaffolding vs bare Sonnet on ROUTINE tasks; keep the panel-on-NOVEL default and the custom governance hooks, and treat parent-model/classifier calibration on routine work (not the panel, not hook migration) as the only cost lever this evidence supports.
- **D027:** Run Item 6 with Option 1 CLAUDE.md fidelity (baseline A vs frozen C1), per-task caps frozen at user-approved values, Arm A pinned at commit 6cc154c, and a hybrid PowerShell/Node harness with empirically-validated runtime IO.
- **D026:** Item 6 is a decision-grade A/B frozen per pre-registration; measure per-task delta_T (ratio cancels task difficulty), gate cost claims behind median-of-3 + spread, treat subscription cost as modeled/relative-only, and keep quality ground-truth via acceptance-gating + laundered blind judging.
- **D025:** Build only the two regime-independent correctness fixes (graceful-degradation-at-cap; narrow classifier over-escalation fix scoped to prompt-length+cache); do NOT make the panel opt-in or migrate always-on hooks to native availableModels/enforceAvailableModels (false premise — those are model-picker UI filters); run the sustained 5-session real-codebase A/B before any strategic panel/hook-surface change.
- **D024:** PRISM's runtime machinery is a repeatable 3-8x cost multiplier (n=1, quote ranges) on short headless tasks with complete-but-expensive output; the proven defects are null-at-cap graceful-degradation and routine-work over-escalation. The "serial dispatch" claim was a harness measurement artifact — fix the concurrency metric (group stream-json by message.id) before asserting any parallelism defect.
<!-- prism:standing-rules:end -->

## Active specialists

- (none hired yet — call @agent-factory to add)

## Available plugin tools

<!-- /prism-validate-plugins refreshes this section. -->
- (run /prism-validate-plugins to populate)
