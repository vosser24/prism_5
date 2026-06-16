# Changelog

All notable changes to PRISM are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), the versioning follows
[Semantic Versioning](https://semver.org/).

## [5.7.6] - 2026-06-16

Nested-dispatch guard — closes a hole that opened when the Claude Code runtime evolved underneath PRISM. PRISM 5.x's "dispatch is main-loop-only" guarantee relied on two runtime behaviors that **silently stopped being true** on current builds: (1) a dispatched subagent had its `Agent` tool stripped, and (2) hooks did not fire inside subagents. On updated builds neither holds — a worker subagent CAN spawn a sub-subagent, and that nested `Agent()` call now reaches PreToolUse — so an unsanctioned nested spawn slips through and **stalls the agent tree** (live-repro: a Sonnet worker spawned a research sub-subagent that throttled to ~12.8k tokens over 98 minutes). Diagnosed live on a 5.7.4 machine ("1 PreToolUse hook ran" observed on the nested call).

- **`hooks/prism-parent-dispatch-guard.mjs` — nested-dispatch deny (the fix).** Before the existing subagent bypass, an `Agent()` call originating from subagent context (`parent_tool_use_id` present OR `CLAUDE_CODE_ENTRYPOINT=subagent`) is now denied (exit 2, hard mode). Only the spawn tool is gated — subagents keep full use of Edit / Bash / TaskCreate / Read (they fall through to the bypass unchanged). The deny message tells the worker to do the work inline or return a dispatch plan to the main loop. **Doctrine-aligned, zero sanctioned breakage:** PRISM already holds that NO subagent dispatches (even `@master-orchestrator`-as-subagent only role-plays), so nothing legitimate is denied. Now that hooks fire inside subagents, this enforces at the hook what was previously only prose.
- **Modes + kill switches.** `PRISM_NESTED_DISPATCH_GUARD` = `hard` (default) | `soft` (advisory, exit 0) | `off`. The master `PRISM_DISPATCH_GUARD=off` disables it too. Each blocked call appends a `nested_dispatch_guard` row to the routing log recording which signal fired (`parent_tool_use_id` vs `entrypoint_env`) — self-verifying on the first real nested spawn.
- **No false positives on parent fan-out.** The parent's legitimate parallel `Agent()` batch carries neither subagent signal, so it is never touched (regression-tested).
- **Golden-master:** existing 34 PreToolUse cases verified byte-identical (`34 match, 0 differ`); 2 new cases added (`parent/nested-deny`, `parent/nested-off`) and baked into the baseline. New unit suite `tests/v3/state/test-prism-nested-dispatch-guard.mjs` (8 cases). Neighboring suites green: ro-bash-fastpath 44, parallel-cap 7, panel-deadlock 15, dispatch-contract 23, factory-hint 6.
- **Known follow-up:** the SOLE DISPATCHER note in `skills/master-orchestrator/SKILL.md` still states the now-obsolete rationale "hooks don't fire inside subagents"; the doctrine *intent* (main-loop-only) is unchanged and is now hook-enforced. Prose refresh deferred.

## [5.7.5] - 2026-06-16

Task-tracking parity for the standalone `@master-orchestrator` wrapper — completes the 5.7.1 `TodoWrite`→`Task*` cross-build migration for the last uncovered agent. 5.7.1 gave the generated `master-<slug>` project agents the `Task*` family (via `PROJECT_MASTER_TOOLS`) and updated the plan-first nudge, but the standalone `agents/master-orchestrator.md` wrapper still declared `tools: Read, Write, Bash, Grep, Glob, Agent` — **no task tool at all**. So a session driven by the standalone orchestrator (rather than a generated project master) fired the "Multi-step work detected" nudge yet had no tool to render the list — the exact "I never see a task list" symptom, diagnosed live.

- **`agents/master-orchestrator.md`** — `tools:` gains `TaskCreate, TaskList, TaskUpdate` (additive). The wrapper now has task-tracking parity with the generated project masters and with the main loop. Harness-name-safe per the 5.7.1 design decision: unknown tool names in an allowlist are ignored, so this is inert on builds that don't expose `Task*` and active on builds that do. `TodoWrite` was never present on this wrapper, so only the `Task*` family is added.
- **No hook, dispatcher, or golden-master change** — this is a single agent-frontmatter addition; the consolidated PreToolUse dispatcher and all byte-identical golden cases are untouched.
- **`install.ps1` fallback un-stale.** The defensive `$PrismVersion` literal (only used if the manifest read fails) was still `5.7.1`; bumped to `5.7.5` alongside `.claude-plugin/plugin.json` and `tools/install-manifest.json`.

## [5.7.4] - 2026-06-16

Factory-hire routing for PHASE-1 workers — closes the gap that let durable, citation-grounded DOMAIN work (e.g. an executive-CV design system) be executed ad-hoc with a throwaway `general-purpose` WebSearch fan-out instead of being routed through `@agent-factory` to manufacture a reusable, NotebookLM-grounded specialist (vast token spend, no reusable asset). PRISM already enforced factory-first — but **only for PHASE 0d panel seats** (`prism-panel-guard.mjs`); PHASE-1 execution workers were uncovered. Same YAGNI discipline as 5.7.3: additive always-read prose + piggyback the ONE existing parallel-guard trace; no new PreToolUse hooks, heuristic enforcement is SOFT-only.

- **WS-A — factory-hire doctrine fork (doctrine).** SKILL.md DISPATCH CONTRACT step 1 gains an explicit **manufacture-vs-ad-hoc fork**: before dispatching `general-purpose` workers for durable DOMAIN research/design, run the 3-question **factory-hire test** — (1) recurring surface? (2) durable/maintained output? (3) citation-grounded knowledge? **≥2 yes → hire via `@agent-factory`**; **≤1 yes → ad-hoc is fine** (compose-first preserved). `phase-0-team-assembly.md` notes the test now governs PHASE-1 workers, not just panel seats (SKILL.md = single source of truth).
- **WS-B — soft factory-hint guard (runtime reinforcement).** `hooks/prism-parallel-guard.mjs` reuses its existing per-turn trace to detect a domain-research flood on throwaway agents: a dispatch is counted when `subagent_type` is GENERIC (a named rostered specialist is never counted) AND the prompt matches domain-research tokens; a `dr` flag is stored on the trace entry. When the same-turn running total reaches the threshold (default 3, `PRISM_FACTORY_HINT_THRESHOLD`), the guard appends a SOFT advisory suggesting `@agent-factory`. It **never denies** (advisory even in hard mode), is disable-able (`PRISM_FACTORY_HINT=off`), and is appended additively (does not change the exit code or the cap/pgroup notices, and the hard-deny JSON stays clean). Zero new I/O: one regex over the prompt + one `.filter().length` over the ≤8-entry trace already read — microsecond cost.
- **Complementary, not duplicative.** The panel-guard reads `panel.json` and guards PHASE 0d SEATS only; it cannot see PHASE-1 worker dispatches. WS-B covers the uncovered execution path.
- **Heuristic limitation (documented):** the token regex catches the common "search-angle flood" pattern, not every domain dispatch — WS-B is reinforcement; WS-A doctrine is the primary lever. The hint is soft and silent-misses fall back to doctrine.
- **No golden-master change.** Existing PreToolUse golden cases aren't domain-research → wire output byte-identical (`34 match, 0 differ`); no regeneration.
- Tests: new `tests/v3/hooks/test-factory-hint.mjs` (6 cases — 3rd dispatch hints, below-threshold/non-research/named-specialist/disabled → silent, tuned threshold); `tests/v3/skills/dispatch-contract.test.mjs` extended with 6 WS-A prose assertions (23 total). WS3 cap-enforce + golden + master-orchestrator drift suites stay green.

## [5.7.3] - 2026-06-16

Dispatch decomposition + the closed memory loop + concurrency-cap enforcement + failed-spawn handling. Addresses two user-reported failure modes (heavy single-shot workers that stall mid-run; workers that reinvent instead of reusing tools/lessons) and two diagnosed concurrency defects (the parallel cap was advisory-only → observed 7-agent 429 spawn-storm; near-zero/throttled spawns reported as `Done (0 tokens · 1s)`). Discipline: YAGNI — additive always-read prose + piggyback on ONE existing guard's trace; **no new PreToolUse hooks, no measurable per-tool latency.**

- **WS3 — concurrency-cap ENFORCEMENT (the only runtime change).** `hooks/prism-parallel-guard.mjs` now counts the same-turn in-window dispatches it ALREADY traces and flags the `(cap+1)`th call as over-cap, reusing `resolveParallelCap()` (`hooks/lib/prism-cap.mjs`, default 4, max 16). A correct single-message batch of ≤cap calls still passes (counts `0..cap-1` < cap); only over-cap fan-out is flagged. Default is **soft-nudge** (exit 0 + notice); **hard mode** denies (exit 2). The three-path subagent bypass and `!opus-force:` override short-circuit BEFORE the count, so they hold. Zero new I/O: one `.filter().length` over a ≤8-entry array + one regex on a short env string, reusing the trace object already read and the write already performed — microsecond cost, within the guard's <50ms budget. Raise deliberately via `PRISM_PARALLEL_CAP`; disable via `PRISM_PARALLEL_GUARD=off`.
- **WS1 — dispatch decomposition (parent doctrine).** SKILL.md gains an always-read **DISPATCH CONTRACT**: heavy work (> ~1 slice / ~20 tool calls) is split into 3-5 bounded sequential slices dispatched one at a time with per-slice budgets, instead of one monolithic 65-tool-use worker. `phase-1-execution.md` adds a **build-slice budget** distinct from the diagnosis budget (decompose builds; don't globally cap them).
- **WS2 — reuse-first = tools AND lessons (memory loop closed at the dispatch moment).** The DISPATCH CONTRACT's reuse-first gate is two-part: prefer rostered specialists / existing tools / live `mcp__*` (discrete MCP calls over monolithic scripts on SMB/OneDrive), AND recall lessons before specing a worker — cheap default (read `MEMORY.md` + grep `tasks/lessons-*.md` by tag), cloud `/prism-recall` only on NOVEL with `--no-rerank` (~20s cold on Windows), injecting the top 1-3 matched lessons as one-liners into the worker prompt (the worker can't query the KB). `phase-1-execution.md` adds the recalled-lessons injection to the equip rule; `phase-2-completion.md` adds **capture-on-abandon** + a leading-bracketed-tag convention (`[stall][tool][env]`) so the next grep-recall hits. Seed-if-absent: create a `MEMORY.md` stub on the first NOVEL task where it's missing.
- **WS4 — failed/throttled-spawn handling (doctrine-only; Path B).** Step-1 payload probe: the SubagentStop hook payload exposes only `usage` tokens (defensively `||0`); duration + tool-use count are parsed from the transcript, not the payload — so a robust conjunction detector (~0 tokens AND sub-second AND 0 tool-uses) is not buildable at the hook without false-positives, and the optional nudge is **not** added. Parent doctrine instead (SKILL.md + `phase-1-execution.md` validate gate): a near-zero result is a failed/throttled spawn → back off + retry (cap ~2) then escalate to the user, never accept as "Done"; a mid-run cutoff (nonzero tool-uses, 0 tokens) requires verifying partial state before any re-run (double-apply guard).
- **No golden-master change.** The existing PreToolUse golden cases (`parallel/first` single call, `parallel/off`) don't reach the over-cap path, so wire output is byte-identical — golden-master verified `34 match, 0 differ`, no regeneration needed.
- Tests: new `tests/v3/hooks/test-parallel-cap-enforce.mjs` (7 cases — over-cap soft/hard, ≤cap pass, subagent + opus-force bypass, raised-cap honored); new `tests/v3/skills/dispatch-contract.test.mjs` (17 prose-presence assertions across SKILL.md / phase-1-execution / phase-2-completion). Existing parallel-guard / dispatch-cap / PreToolUse-dispatcher / master-orchestrator drift suites stay green.

## [5.7.2] - 2026-06-12

Self-healing hook recognizer — fixes duplicate hooks that lingered after upgrades. Symptom: after `update`, a machine that had an older PRISM still showed **two Stop hooks**. Root cause: `install()` already does strip-then-merge (Step 3 strips PRISM hooks before re-adding the canonical set), but the recognizer `isPrismHookCommand` only matched the **prism-exec.sh/.cmd wrapper** form — so a pre-wrapper legacy registration (e.g. `bash ~/.claude/hooks/prism-session-end.mjs`) wasn't recognized as PRISM, strip skipped it, and the canonical wrapped hook was added beside it = duplicate.

- `tools/prism-installer.mjs` — `isPrismHookCommand` now also matches any `prism-*.{mjs,sh,cmd}` script directly under a `hooks/` (or `hooks/lib/`) dir, covering legacy non-wrapper registrations. Conservative: unrelated user hooks (e.g. `hooks/my-helper.mjs`) are never matched, so they stay preserved. **Net: a normal `update` now self-heals duplicate/stale PRISM hooks on every machine — no uninstall dance.**
- `tools/prism-installer.mjs` — added a `basename` main-guard so the module is importable for unit testing without triggering the CLI; exported `isPrismHookCommand` + `stripPrismHooks`. CLI behavior is unchanged.
- Tests: new `test-prism-hook-recognizer.mjs` (14 pure cases — wrapper + legacy recognized, user hooks not); new installer integration case **TM4** (legacy Stop hooks reduced to exactly one on upgrade, user hook preserved).
- No data-loss risk: roster/user agents, `prism-policy.json`, routing logs, non-PRISM settings, and custom `statusLine` are preserved exactly as before.

## [5.7.1] - 2026-06-12

Fixes a cross-build conflict in the v5.3.1 plan-first nudge. The nudge told the main loop to "lay out a **TodoWrite** task list", but on builds where the harness renamed the to-do tool to the **Task\*** family (`TaskCreate` / `TaskUpdate` / `TaskList`) there is no `TodoWrite` — so the nudge fired correctly on multi-step work yet produced **no visible task bullets**. Diagnosed live (the user kept tracking steps inline because "TodoWrite isn't enabled here").

- **Approach: name the capability + both tool families, additively — never replace.** An unknown tool name in a `tools:` allowlist is ignored by the harness, so listing both `TodoWrite` and the `Task*` family is safe on every machine and survives the harness exposing either name. No machine is left without a task tool, and a future rename does not re-break it.
- `hooks/prism-hook.mjs` — the `plan_first` nudge text now names `TaskCreate`/`TaskUpdate` (with "or TodoWrite on builds that expose that name"). The stable trigger phrase **"Multi-step work detected"** is unchanged, so the `test-prism-hook-paste-nudge.mjs` assertion (which matches the phrase, not the tool name) is untouched.
- `tools/prism-deep-dive.mjs` — `PROJECT_MASTER_TOOLS` additively gains `TaskCreate, TaskUpdate, TaskList` (keeps `TodoWrite`) so generated `master-*` agents declare a task tool that exists on both old and new builds.
- Tests: `test-prism-deep-dive.mjs` required-tools loop extended to assert the `Task*` family is present (keeps `TodoWrite`); `test-prism-hook-paste-nudge.mjs` comment refreshed (assertion unchanged).
- No interaction with the 5.7.0 PreToolUse consolidation / golden-master: only the `UserPromptSubmit` advisory nudge text and the deep-dive toolset constant changed — neither is part of the consolidated dispatcher or any byte-identical golden-master.
- **`install.ps1` wrapper fix.** The wrapper declared a `-Home` parameter, but `$Home` collides with PowerShell's read-only automatic `$HOME` variable, so the script died at param binding (`Cannot overwrite variable Home because it is read-only or constant`) — the "proper installer" never ran on Windows; only the underlying `node tools/prism-installer.mjs install` worked. Renamed the internal variable to `$HomeDir` with `[Alias('Home')]` (so `-Home` still works), and the banner version now reads from `install-manifest.json` instead of a hardcoded (stale `4.4.0`) string so it can't drift.

## [5.7.0] - 2026-06-10

Completes the hook-consolidation arc started in 5.6.0 (which deferred the PreToolUse enforcement hooks as higher-risk), and lands two Windows robustness fixes diagnosed this session.

- **PreToolUse enforcement consolidation: 7 hooks → 1 dispatcher.** `hooks/prism-pretooluse-dispatcher.mjs` replaces the 7 separately-registered PreToolUse entries (`prism-safety`, `prism-prepush-review`, `prism-mutation-guard`, `prism-parent-dispatch-guard`, `prism-agent-model-guard`, `prism-parallel-guard`, `prism-task-tier-advisor`) with ONE node process that reads stdin once and runs the applicable guards in-process. Routing mirrors the shipped matchers + array order exactly (e.g. `Bash` → safety, prepush-review, mutation-guard, parent-dispatch-guard). Was up to 4× bash+node spawns per Bash call (~1s startup latency on Windows/SMB) → a single spawn. Each guard gained a dual-mode `run(payload)→{exit,stdout,stderr}` export and still runs standalone + individually testable.
- **Most-restrictive-wins merge.** Every matching guard runs (preserving side-effects: routing logs, sentinel marking, parallel-trace writes); results merge as deny > ask > advisory, matching Claude Code's native multi-hook semantics. `normalize()` unifies the three deny conventions the guards use. Fail-open: bad stdin, an unrouted tool, or a guard that throws → exit 0 (one guard throwing is caught per-guard so the others still run).
- **Hardened HOME resolver (`hooks/lib/prism-home.mjs`).** Fixes the Windows `undefined/.claude/...` stray artifact: some Windows hook-execution contexts hand the process an env where `USERPROFILE`/`HOME` is the literal string `"undefined"` (truthy), so the old `HOME || USERPROFILE` idiom wrote a relative `undefined/` path into the repo. `prismHome()` walks HOME → USERPROFILE → os.homedir() → HOMEDRIVE+HOMEPATH → tmpdir(), returning the first non-garbage existing dir, resolved at call time (test-isolation safe). Adopted across the advisory/enforcement guards.
- **Self-healing claude-mem performance guard (`hooks/lib/prism-claude-mem-guard.mjs`).** Config-only, fail-open SessionStart heal for claude-mem on Windows: neutralizes its ~1s-per-tool-call login-shell PATH probe and pins the worker off the ghost-prone deterministic default port 37777 (which leaves an unkillable ghost socket on abnormal exit). Re-asserts after each silent claude-mem auto-update. Off-switch: `PRISM_DISABLE_CLAUDE_MEM_GUARD=1`. (Effective next launch; the worker is owned by claude-mem's own start hook.)
- **`plugin.json` + `settings.fragment.json` wiring updated.** PreToolUse now holds a single dispatcher entry (matcher `Bash|PowerShell|Agent|TaskCreate|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch`); the 7 per-guard registrations are removed. `tools/install-manifest.json` ships the dispatcher + the two new `hooks/lib` modules.
- **Tests.** New: `test-pretooluse-dispatcher.mjs`, `golden-pretooluse.mjs/.json` (golden-master), `test-prism-home.mjs`, `test-panel-guard-home-isolation.mjs`, `test-mutation-guard-classify.mjs`, `test-subagent-stop-roster-lock.mjs` — all green. Updated: installer `TM3` and `test-prism-mutation-guard-unblock.mjs` `B5` re-pointed from the old standalone-`Bash`-matcher assertions to the consolidation invariant (no standalone entry; dispatcher matcher still covers Bash + PowerShell). Hooks suite 10/10; state suite green (the installer integration suite remains slow-but-correct under SMB — ~14.6s/install × 38 spawns; per-operation status verified 0 via isolated harness, consistent with the 5.4.1 note).

## [5.6.0] - 2026-06-09

Hook consolidation: advisory per-event dispatchers replace the previous fan-out of individually-registered hook entries, cutting advisory spawns from ~11 to ~4 per turn on Windows, benchmark-verified to improve latency.

- **4 advisory dispatchers introduced.** `UserPromptSubmit` 4→1 (`prism-userpromptsubmit-dispatcher.mjs`), `PostToolUse` 5→1 (`prism-posttooluse-dispatcher.mjs`), `SubagentStop` 3→1 (`prism-subagentstop-dispatcher.mjs`), `SessionEnd` 2→1 (`prism-sessionend-dispatcher.mjs`). Each dispatcher uses a `run()` pattern that calls its constituent advisors inline — one `node` cold-start per event instead of N, with no change to advisor behaviour or ordering.
- **~11→4 advisory spawns per turn.** On a typical haiku/sonnet turn (UserPromptSubmit + PostToolUse × 2): was 4+5+2=11 advisory spawns per turn; now 1+1+1=3 per turn (plus the unchanged PreToolUse enforcement hooks). Benchmark suite (`tests/v3/bench/bench-hook-consolidation.mjs`) verifies the latency improvement is real and consistent.
- **`run()` refactor pattern.** Each dispatcher `import`s its constituent hook modules and calls their exported `run(payload)` (or equivalent) directly — no spawning, no shell. Constituent hooks retain their own files and remain individually testable.
- **`plugin.json` and `settings.fragment.json` wiring updated.** Each of the 4 consolidated events now has a single registered hook entry pointing at its dispatcher. The previously separate per-advisor registrations are removed.
- **Install manifest updated.** `tools/install-manifest.json` lists all 4 dispatcher files for deployment.
- **PreToolUse enforcement consolidation deferred.** The enforcement hooks (`prism-safety`, `prism-prepush-review`, `prism-agent-model-guard`, `prism-parallel-guard`, `prism-mutation-guard`, `prism-parent-dispatch-guard`, `prism-task-tier-advisor`) remain individually registered; consolidating them carries higher risk and is deferred to a future release.
- **Tests.** `tests/v3/hooks/test-*-dispatcher.mjs` (4 files, 5/8/5/3 passed); `tests/v3/state/test-settings-dispatcher-wiring.mjs` (6 passed); bench suite 4/4. Full audit ~29/0 green.

## [5.5.0] - 2026-06-08

Discipline gap closed (found while diagnosing why dispatched agents never run TDD/debugging discipline). `using-superpowers` carries a `<SUBAGENT-STOP>` that suppresses superpowers auto-activation in **any dispatched subagent** — so every worker the master dispatches runs WITHOUT test-driven-development / systematic-debugging / brainstorming discipline unless the master injects it. The existing "equip the worker in its prompt" guidance named the principle but was soft: not mandatory, no task→skill mapping, and it didn't name the superpowers skills.

- `skills/master-orchestrator/references/phase-1-execution.md` — new **MANDATORY superpowers discipline-match** step. For every worker dispatch, the master classifies the worker's task and injects the matching superpowers skill's *substance* (inline for short procedures) or its `SKILL.md` path for the worker to `Read` — **not** an "invoke the skill" instruction, because auto-activation is suppressed and Skill-tool calls are unreliable in a scoped subagent. Mapping: implement/bugfix → `test-driven-development`; diagnose bug/test failure → `systematic-debugging`; design/new capability → `brainstorming` (before any code); claims "done"/pre-merge → `verification-before-completion`; multi-step plan execution → `executing-plans`. Injection is skipped only for pure read-only scan/extract work. This implements "Option B" (orchestrator-injected, dynamic per task type) over per-agent static defaults, building on the existing main-loop-only dispatch model.

## [5.4.1] - 2026-06-08

Installer hardening (handoff PENDING item): a leading UTF-8 BOM on `roster.json` no longer aborts `update`. PowerShell's default writers (`Set-Content`/`Out-File`/`>`) emit UTF-8 *with* BOM, so a roster touched by a Bash/PowerShell path could carry a leading U+FEFF — which made `JSON.parse` throw and tripped the installer's "roster.json is malformed; refusing to overwrite" abort, blocking the upgrade.

- `tools/prism-installer.mjs` — new `stripBom()` helper applied at all four `roster.json` reads (detect, the update-time existing-roster load that previously `die()`d, the shipped-roster merge, and `verify`). A genuine BOM is stripped before parse; real corruption still surfaces (only the BOM is stripped — parse errors are not swallowed). Scoped to `roster.json`, the one PRISM file rewritten during normal operation; shipped/installer-written JSON stays clean.
- Tests: `test-prism-installer.mjs` +3 (BOM-prefixed roster → install exits 0, user agent preserved through merge, rewritten roster is BOM-free). Verified deterministically via an isolated single-install check; the full installer suite's integration tests flake under batch/SMB load (orthogonal, pre-existing — re-run standalone to confirm green).

## [5.4.0] - 2026-06-08

Friction fix (D010 §6, queued from the v5.3.x latency arc): the mutation-guard hard-blocked the **clean Edit/Write/MultiEdit tools** in the parent (Opus) context, citing a Windows UTF-8 BOM hazard — but that rationale only applies to Bash/PowerShell file-writes; the Edit/Write tools emit clean UTF-8 and are the recommended path. Blocking them was the single biggest source of everyday friction and duplicated the dispatch-guard's tier gating (it even blocked `/prism-clean`'s own artifact writes). Re-scoped with an adversarial enforcement-surface review by **@claude-master** (chose full-removal over tier-aware: option b would just double-gate what the dispatch-guard already owns, and both fail open identically on a missing tier file).

- **mutation-guard is now Bash-write-only.** `hooks/prism-mutation-guard.mjs` — `MUTATION_TOOLS` emptied and the parent Edit/Write/MultiEdit deny branch removed; the hook only ever blocks Bash/PowerShell **file-writes** (the retained unique value: UTF-8 BOM hazard + orchestrator bypass). The JS change is load-bearing — a stale-matcher install (one still wired to `Edit|Write|MultiEdit|Bash` before the upgrade re-merges) now **degrades to ALLOW** on those tools instead of hard-blocking edits.
- **Matcher narrowed `Edit|Write|MultiEdit|Bash` → `Bash`** in both `.claude-plugin/plugin.json` and `settings.fragment.json` — so the guard no longer spawns a `node` process on parent Edit/Write/MultiEdit at all (one fewer cold start per edit on Windows/SMB).
- **No enforcement hole.** The parent-dispatch-guard remains the sole tier fence for parent edits — its positive-list matcher already includes `Edit|Write|MultiEdit`, they are absent from its `ALWAYS_ALLOW`, and the haiku/sonnet pre-dispatch deny is unchanged. Opus-tier parent Edit flipping blocked→allowed is the intended goal (the Opus orchestrator doing a quick clean-UTF-8 edit is the recommended path).
- **Note:** `PRISM_MUTATION_GUARD`'s blast radius is now Bash-writes-only — anyone who relied on it to gate *edits* should use `PRISM_DISPATCH_GUARD` (the tier fence) instead. The Bash write-pattern list remains positive-match / non-exhaustive by design (a BOM-hazard nudge for common cases, not a complete write fence; the permission allowlist is the real fence).
- Tests: new `test-prism-mutation-guard-unblock.mjs` 13/13 (parent Edit/Write/MultiEdit allowed; Bash `>`/`Set-Content` still denied incl. the BOM-safe-suppresses-warning case; subagent passthrough; dispatch-guard still gates Edit on sonnet / allows on opus; matcher = `Bash` in both manifests). Audit MUT-001 repurposed (parent Edit → pass), MUT-002 (parent Bash-write → deny); 29/29. Full state suite + `test-plugin-manifest-drift.mjs` green.

## [5.3.3] - 2026-06-08

Latency fix #2 (user: "can we make search and bash quicker?"). Every tool call spawns PRISM PreToolUse hooks, and each hook is a separate `node` process (cold start ~50–150ms on Windows/SMB). Search (`Read`/`Grep`/`Glob`/`LS`) still spawned the dispatch-guard once just to exit 0; `Bash` spawned four hooks. Designed with an adversarial Windows-aware review by **@claude-master** (who rejected full hook consolidation as over-engineering — the win is overwhelmingly in the read-only path) and a docs check by **@claude-code-guide** (confirmed the `if` field; flagged negative-lookahead matchers as undocumented → we use a safe positive-list matcher instead).

- **Fix A — dispatch-guard stops spawning on read-only tools.** `hooks/prism-parent-dispatch-guard.mjs` matcher changed from `""` (all tools) to a **positive list** `Agent|TaskCreate|Bash|Edit|Write|MultiEdit|NotebookEdit|PowerShell|WebFetch|WebSearch` in both `.claude-plugin/plugin.json` and `settings.fragment.json` — so `Read`/`Grep`/`Glob`/`LS`/`NotebookRead` (the high-frequency search path) no longer spawn the guard at all. Behaviorally identical (those were already `ALWAYS_ALLOW`). A positive list was chosen over a negative-lookahead regex because lookahead matchers are undocumented in Claude Code. Plus a **Layer-2 top-of-guard early-exit** on read-only tools as belt-and-suspenders for pre-upgrade installs still on the old matcher.
- **B-lite-1 — prepush-review only spawns on git commands.** Added `"if": "Bash(git *)"` (Claude Code v2.1.85+ conditional-spawn) to the prepush hook in both manifests, so non-git Bash drops from 4 → 3 hook spawns. Zero enforcement change (prepush already fail-opened on non-push). Installer fix: `tools/prism-installer.mjs` `mergeSettings` now preserves per-hook keys beyond `type`/`command` (the `if` field was silently dropped on merge — would have re-spawned prepush on every Bash).
- **Deferred (claude-master verdict):** full front-controller consolidation of the 4 Bash hooks (rejected — concentrates risk on the enforcement core for little net gain, since mutation-guard + dispatch-guard must stay standalone for their non-Bash events) and B-lite-2 (merge safety+prepush — defer until post-A profiling).
- Tests: `test-prism-ro-bash-fastpath.mjs` +6 (Layer-2: 5 read-only tools exit 0 on a haiku turn + Edit-still-denied control) → 44/44; `test-prism-installer.mjs` +1 (prepush `if` survives `mergeSettings`) → 100/100; `test-plugin-manifest-drift.mjs` 3/0 (matcher parity holds across both manifests). Full suite + audit green. (T6/TM3 in the installer suite flake intermittently under batch/SMB load — verified 100/100 standalone; pre-existing, unrelated.)

## [5.3.2] - 2026-06-05

Latency fix (user feedback: a quick "is this run done? why isn't the flow showing?" check turned into a 9-minute, 54-tool-call forensic subagent). Root cause: the dispatch guard force-routes *all* parent work tools (incl. read-only Bash/PowerShell probes) into a subagent on haiku/sonnet turns, so a 30-second state check pays subagent spawn + cold-context + over-investigation. Designed with an adversarial Windows-aware review by **@claude-master** (fail-closed boundary, mutation-guard/safety interaction, scriptblock hole).

- `hooks/prism-parent-dispatch-guard.mjs` — new **read-only quick-check fast path**: a *provably* non-mutating Bash/PowerShell probe runs in the parent without a forced dispatch. **Fail-closed** — exemption requires every command segment to lead with an allowlisted read-only token (`ls`/`cat`/`grep`/`rg`/`head`/`tail`/`wc`/`git status|log|diff|show|rev-parse|…`, PowerShell `Get-*`/`Select-String`/`Select-Object`/…, Windows `dir`/`findstr`/`tasklist`) AND contain **no** injection/redirection/scriptblock vector (`>`/`>>`, `|tee`, `` ` ``, `$(`, `${`, `<(`, `{`) AND no env mutation. Anything not provably read-only (arbitrary-code `python -c`/`node -e`/`manage.py shell -c`, git write subcommands, `npm/pip install`, compound chains with a bad segment, `git branch/tag/config` which can write) → falls through to normal dispatch. The exemption only removes the dispatch nag; the **mutation-guard and safety hooks fire independently** and still block writes/dangerous commands (the allowlist is the real fence — mutation-guard is positive-match-only). Default **on**; kill switch `PRISM_RO_BASH_FASTPATH=off`. Hardening pass (found via the "what's the risk" review): dropped `sort` (writes via `-o FILE`) and `uniq` (positional OUTPUT file) from the allowlist and added `--output`/`-OutFile` to the injection denylist — these are read-only-*looking* commands with a write mode.
- `skills/master-orchestrator/references/phase-1-execution.md` — **diagnosis budget**: investigation dispatches are bounded (~15–20 tool calls, return partial findings at the cap, don't install deps / write throwaway scripts / thrash on env errors), scope sub-prompts tightly, and prefer the read-only fast path over spawning a subagent for pure state checks.
- Tests: new `test-prism-ro-bash-fastpath.mjs` 35/35 (14 exempt incl. pipes + PowerShell; 18 denied incl. arbitrary-code, redirects, git-write, compound-with-bad-segment, scriptblock; kill switch). Full state suite + audit green.

## [5.3.1] - 2026-06-05

UX fix (user feedback after ~1 day on 5.3.0: "agents don't spawn subagents for parallel work even when it's parallelizable — we lose speed"). Investigation found PRISM already has rich parallel machinery (`dispatch-shapes.md`, the `pgroup` system, `prism-parallel-guard`, a parallel-opportunity detector) — but it's **gated behind the heavy path**: the batch-fan-out guidance only loads under a formal plan/orchestrator, the everyday tier-router nudge pushes a *single* dispatch, and the one proactive "parallelize this" nudge was too narrow (5-turn cooldown). Net: the lightweight everyday path has the capability but never gets reminded to use it. (Hard platform limit, unchanged: only the main loop can fan out — dispatched workers have their `Agent` tool stripped — so these are all main-loop nudges, none can make a subagent spawn subagents.)

- `hooks/prism-hook.mjs` — broadened the proactive parallel-opportunity detector: added everyday build/fix verbs (`implement|build|write|create|fix|update|refactor|add|migrate|convert|generate|…`) to the verb set, a new **`parallel_files`** pattern (2+ distinct file references in one prompt → batchable), more enum nouns; cooldown cut **5 → 2** turns (and the explicit-delegation nudge 5 → 3) so everyday multi-target work actually trips the nudge.
- `hooks/prism-prompt-tier-router.mjs` — every haiku/sonnet dispatch turn now appends a **PARALLEL** note: "if this splits into 2+ INDEPENDENT subtasks, dispatch them as MULTIPLE `Agent()` blocks in ONE message (wall-clock = max, not sum); don't dispatch one-at-a-time across turns; cap 4 (`PRISM_PARALLEL_CAP`)."
- `hooks/prism-session-start.mjs` — concise standing parallel-batch reminder injected at SessionStart so the batch-fan-out default is in context from turn one. Suppress with `PRISM_DISABLE_PARALLEL_REMINDER=1`.

Same release also closes two adjacent everyday-path gaps the user raised:

- **Plan-first / task-list nudge (user feedback: "agents don't make a task list, they go full ladder").** `hooks/prism-hook.mjs` — new conservative `plan_first` detector: clear multi-step intent (first/then sequences, numbered lists, "then also add …", "multi-step"/"step-by-step") nudges the main loop to lay out a **TodoWrite task list** before executing (one item per step → visible progress, fewer skipped steps, mid-flight redirect). Gated on real multi-step markers, 3-turn cooldown, soft. Fills the medium band that `prism-plan`'s narrow triggers (heavy work) and the trivial-skip rule both leave unplanned.
- **Skill-injection protocol wording (user feedback: subagents don't invoke skills — "maybe not needed").** Correct — that's by design. `skills/master-orchestrator/references/phase-1-execution.md` now states it explicitly: a dispatched subagent does NOT hot-reload skills and is scoped, so the master **equips the worker IN ITS PROMPT** — injecting the discipline inline (e.g. red-green TDD; systematic-debugging steps) and, for vertical procedures, the `SKILL.md` path/content to `Read` + follow. Skill-tool invocation inside a worker is neither required nor reliable; injecting the skill's substance is the supported mechanism (same "Equip (same session)" rule as panel-expert skills).

- Tests: `test-prism-hook-paste-nudge.mjs` +11 (parallel: multi-file / verb+across / 2-file / explicit fire, single-file no-over-fire, paste-dampening; plan-first: first/then, numbered list, "then also" fire, single-action no-over-fire, paste-dampening) → 15/15; new `test-prism-parallel-fanout.mjs` (router PARALLEL note on haiku + sonnet) 2/2; `test-prism-turn-state-collision.mjs` +2 (SessionStart reminder present by default + suppressible) → 5/5. Full state suite + audit green.

## [5.3.0] - 2026-06-04

Behavior fix (user feedback — adjudicated as **D009**, building on D007's revisit-trigger #3 "PRISM didn't spawn the factory when it should have"). A panel filled a "UX/UI pro" seat with a generic general-purpose subagent and a "Greek e-commerce" seat with an SEO agent bent into a conversion role — instead of creating durable vertical specialists via `@agent-factory`. Two parallel investigations traced the defect to three rule-level leak points, not a code bug: (1) "fitting" was never defined in panel-seat sourcing, so **adjacency passed as fitness**; (2) prism-plan's ROUTINE/NOVEL gate was a binary *existence* check (any agent declaring the domain → ROUTINE, factory unreachable); (3) the documented fallback for a missing fit was a *generic voice*, not the factory. **Principle locked: adjacency is not fitness — a seat needing top-class vertical/domain expertise is factory-first.** Does NOT reverse D007 (master still owns the invoke-or-not tree inline); only operationalizes "fitting" and adds the missing weak-fit→factory branch + a structural guard.

- `skills/master-orchestrator/references/phase-0-team-assembly.md` — panel-seat sourcing rewritten: STRONG-fit (declares the seat's *specific* sub-domain) vs adjacency; "merely adjacent → MISS → factory-first, never bend it to fit"; decline-fallback split (cheap subagent OK for *tooling*, NOT for *vertical expertise*); domain-gap branch extended to adjacency; new **Seat metadata** note instructing the assembler to tag vertical seats `vertical:true` + set `specialist`/`seat_source` so the guard can enforce.
- `skills/prism-plan/SKILL.md` — ROUTINE/NOVEL question 2 made fit-aware (STRONG-fit, not mere existence).
- `skills/blueprint-prompt/SKILL.md` — fallback rule split: a generic persona is fine for a cross-cutting archetype seat, but a *vertical-domain* seat with no indexed specialist (score < 3) routes factory-first.
- `skills/prism-chat/SKILL.md` — chat mode can't dispatch, but must not pass a generic voice off as vertical expertise; recommends `agent-factory` in a project session.
- `hooks/prism-panel-guard.mjs` — new Path-B `checkFactoryFirst`: on a `dispatch_mode:"dispatch"` panel, any seat tagged `vertical:true` that resolves to no rostered agent (via `specialist`/`seat_source`) **or** to a `general-purpose` subagent is blocked (hard) / warned (soft). Fully additive — untagged seats and legacy panels are unenforced (zero false positives). Roleplay fast mode exempt. Kill switch `PRISM_DISABLE_FACTORY_FIRST=1`. The guard enforces only the FLOOR (a durable specialist exists); STRONG-vs-adjacent fit stays an orchestrator judgment.
- Tests: `tests/v3/state/test-prism-panel-dispatch-guard.mjs` +8 factory-first cases (rostered→allow, unrostered+hard→block, general-purpose fill→block, `seat_source:factory-created`→allow, soft→advisory, untagged archetype→allow, kill switch, roleplay exempt) → **19/19**. Full state suite + audit stay green.
- Adjudication: `docs/prism/adjudications/D009-factory-first-vertical-seats.md` (internal; `docs/` is gitignored — not distributed).

## [5.2.16] - 2026-06-04

Distribution cleanup (triage of a real `prism_5` install transcript on a fresh machine — Python 3.9.10, no MSVC compiler) **plus a public-repo privacy scrub** (user request: the published repo must never carry personal identifiers). No behavioral change to the orchestrator; docs/data/portability only. Suite stays green (state **54/54**, audit **29/29**, installer verify all-PASS).

**A — pin `greenlet` in pwagent (`tools/pwagent/requirements.txt`).** `playwright==1.60.0` depends on `greenlet` but does not pin it, so pip pulled `greenlet==3.2.5`, which ships **no cp39 Windows wheel** → source build → needs MSVC → install failed on Python 3.9 without a compiler. Added `greenlet==3.2.4` (wheels for cp39–cp313); **kept `playwright==1.60.0`** (the transcript's 1.60→1.57 downgrade was an over-fix — playwright's wheel installed fine; only greenlet's source build failed).

**B — de-hardcode Python in `tools/pwagent/pwagent.ps1`.** Replaced the hardcoded `$sysPy = "C:\Program Files\Python312\python.exe"` (PATH only as fallback) with: adopt `python` from PATH first (pwagent sources are 3.9-clean), `$env:PWAGENT_PYTHON` override, the 3.12 install path as last-resort fallback. Header comment de-3.12'd to match.

**C — repoint `INSTALL.md` §3–6 to the real installer.** The manual procedure referenced three files that don't exist (`manifest.json`, `scripts/install-merge.mjs`, `scripts/verify.mjs`) and a `/plugin install prism@PRISM` path with no marketplace manifest. Slimmed §3–6 to the actual one-pass flow — `node tools/prism-installer.mjs install` (backup → copy → roster-merge → settings deep-merge → verify, idempotent) then `node tools/prism-installer.mjs verify` — fixed the line-3 blockquote to point at `install.ps1`/`install.sh`, renumbered the trailing optional-test/summary sections, and corrected the stale `~/.claude/tools/test-prism-gaps.mjs` path (not in the manifest) to the repo-local `tools/test-prism-gaps.mjs`.

**D — privacy scrub (public repo must carry no personal data).** Removed personal identifiers from tracked (therefore published) files, replacing them with generic placeholders:
- `statusline-command.sh` + `tools/prism-monitor/refresh-statusline-cache.sh` — hardcoded absolute per-user home paths → `$HOME/...` (also a portability bug fix; these were broken for any other user).
- `tools/prism-monitor/data_reader.py` + `tools/lib/prism-flag-file.mjs` — a developer username and a real local project path in code comments → neutral placeholders.
- `skills/video-production/SKILL.md`, `commands/prism-app-expert.md`, `tests/v3/audit-real-prompts.md` — employer-/client-revealing example app names → a fictional "Acme Storefront" / `acme-shop` / `demo-pharmacy`. The public GitHub handle `vosser24` (clone/install URLs, plugin author, LICENSE copyright) is intentionally retained — it is the repo-owner identity install needs, a different class from a username/email/employer.

## [5.2.15] - 2026-06-04

Feature (user request, brainstormed → spec → plan → TDD). Two additions to the bootstrap + install surface. Spec: `docs/superpowers/specs/2026-06-04-venv-pwagent-bootstrap-design.md`; plan: `docs/superpowers/plans/2026-06-04-venv-pwagent-bootstrap.md`.

**A — project `.venv` on `/prism-bootstrap`.** New deterministic `ensure-venv <slug>` subcommand in `tools/prism-bootstrap.mjs`:
- Detects Python (`requirements.txt`/`pyproject.toml`/`Pipfile`/`setup.py`/`setup.cfg`/`manage.py`/`*.py`, root or one level deep). Honors `--python`/`--no-python`. A **greenfield** folder with no Python signal exits **7 (`needs-prompt`)** so the slash command asks *"Will this be a Python project?"* and **remembers** the answer in `.prism-state.json` (`python_project`) — never re-prompts, so a still-empty folder you've declared Python stays governed.
- On a Python project: appends `.venv/` to `.gitignore` (once), writes a SessionStart `CLAUDE_ENV_FILE` PATH hook into project `.claude/settings.json` (prepends `.venv/Scripts` for Git-Bash sessions), and creates `.venv` (`--no-create` for tests; fail-soft if no system Python).
- `commands/prism-bootstrap.md`: Phase-2 `ensure-venv` step + Operating Rule **§8.5** (run Python via the `.venv` interpreter; never system Python). The convention is the guarantee; the PATH hook is a best-effort accelerator (Git-Bash only — the PowerShell-tool fallback, an absolute-path `settings.local.json` `env`, is a documented manual step per the verified Claude Code settings/hook semantics).

**B — embed `pwagent` (Playwright CLI) in the install.** Vendored the existing `~/.claude/tools/pwagent/` tool (v0.2.0) into the repo at `tools/pwagent/` — `pwagent.cmd`, `pwagent.ps1`, `requirements.txt`, `src/pwagent/{__init__,__main__,cli,actions,session,errors}.py` — **excluding `.venv/`/`__pycache__/`/`tests/`**. Added all 9 source files to `install-manifest.json` so the installer ships them to `~/.claude/tools/pwagent/`. The tool is **self-provisioning** (`pwagent.ps1` builds its own venv + downloads Chromium + guards on a requirements hash on first run), so the installer does not re-implement that — a new **`setup-pwagent`** subcommand + a consent-gated offer during `install`/`update` adds the dir to the **User PATH** (idempotent) and **warms** it via `pwagent selftest`. Non-interactive runs print the manual steps unless `--with-pwagent` is passed; everything is fail-soft (no Python 3.12 / no network → manual step, install still succeeds).

- Tests: `test-prism-bootstrap` +6 (ensure-venv) → 44/44; new `test-prism-pwagent-install` (manifest ships all 9 source files + never a `.venv`; `setup-pwagent --dry-run`). No shipped behavior runs pip/Chromium/PATH edits without consent.

## [5.2.14] - 2026-06-04

Test fix (Windows portability — surfaced by running the FULL state suite during the v5.2.13 ship-readiness check; this test was red at session start `1c93b4828`, pre-existing and unrelated to any UAT fix). `test-prism-bootstrap` :: `init-state-if-missing detect-and-adopts v3.8.9 tree` failed with `ENOENT … .claude/agents/roster.json` — but the failure was in the **test's own fixture setup**, not production code. Line 81 used `spawnSync('mkdir', ['-p', references, agents])`, a Unix-only idiom: on Windows there is no `mkdir.exe` on PATH and no `-p`, so the directories were never created and the next line's `writeFileSync(.../agents/roster.json)` threw. Production `prism-bootstrap.mjs` was never even reached.

- `tests/v3/state/test-prism-bootstrap.mjs` — replaced the `spawnSync('mkdir', …)` fixture call with the already-imported, portable `fs.mkdirSync(dir, {recursive: true})` (the convention used everywhere else in the suite). The production detect-and-adopt assertions, now reached for the first time on Windows, pass unchanged — confirming there was no production bug.
- Result: the full state suite is now **53/53 green** on Windows (was 52/53) alongside audit **29/29**. No production/shipped-file change — tests are not part of the install manifest.

## [5.2.13] - 2026-06-04

Fix (UAT prompt 30 — "create a domain-expert agent for this coffee-ledger app"). The project-master invoked `/prism-app-expert`, loaded it, and correctly bailed: *"the wrong fit — it builds Playwright/browser-automation specialists for video screenshots, not a code domain-expert."* Root cause: the skill's frontmatter `description` was the generic **"Create or update an app expert agent for a specific application"** — which hid the skill's actual, narrow scope (a **Playwright-driven** UI-screenshot specialist for the video-production pipeline, per its own body lines 11-12). A master reading only the description reasonably reaches for it to author a code domain-expert, then wastes a load discovering the mismatch.

- `commands/prism-app-expert.md` — rewrote the `description` to disclose the real scope up front (Playwright, browser-automation, on-demand screenshots, video pipeline, requires Playwright) and to **redirect** code/domain-expert authoring to `@agent-factory` via `@master-orchestrator`. No protocol/body change — the skill already did the right (narrow) thing; only its advertised description lied by omission. No test asserts the description string (routing keys off the command *name*), so unit/audit suites are unaffected.
- `docs/prism/2026-06-02-uat-prompt-pack.md` — corrected prompt 30's *Exercises* line: the mechanism is the master authoring a code domain-expert via a dispatched author / `@agent-factory`, **not** `/prism-app-expert`; added a fixture note that the push-nudge half only fires when `test_prism_5` has an `origin` remote (it's re-created without one), and that a master declining to invent a remote is acceptable.

The agent-create + auto-register half of prompt 30 PASSED in the run: `coffee-ledger-expert` was created and registered in `roster.json`; only the push could not be exercised (no remote), which is a fixture gap, not a PRISM defect.

## [5.2.12] - 2026-06-04

Docs fix (UAT prompt 29 — the config-guard prompt PASSED: the project-master refused to silently edit CLAUDE.md and surfaced the change. While verifying its "Rule 8" objection, the **canonical CLAUDE.md template** turned out to under-document the safety gate). The template's `### 8. Safety` block enumerates what `hooks/prism-safety.mjs` blocks (`rm -rf` on dangerous targets, `DROP/TRUNCATE`, `git push --force`, `mkfs.*`, `dd`) but **omitted the `curl … | bash` pipe-to-shell block** the hook has enforced since v5.x FIX-D (`prism-safety.mjs:43`). Every project bootstrapped from this template therefore got a Rule 8 that misrepresents the gate — and this is the exact gap that made the prompt-27 master wrongly assert "there's no hook blocking curl|bash" (it had no doc telling it otherwise; it even independently proposed adding curl|bash to its own Rule 8).

- `commands/prism-bootstrap.md` §8 — added pipe-to-shell installers (`curl … | bash`, `wget … | sh`) to the canonical CLAUDE.md template's enumerated block-list.
- `commands/prism-help.md` — safety-gate row now lists pipe-to-shell alongside `rm -rf` / `DROP TABLE` / force-push.
- No code change — `prism-safety.mjs` already blocks pipe-to-shell (SAF-002, audit green); `README.md` already had the accurate phrasing and remains the alignment reference. This only brings the two enumerating doc surfaces in line with what the gate actually enforces. Same docs-vs-gate drift class as v5.2.9.

## [5.2.11] - 2026-06-04

Fix (UAT prompt 28 — the prompt designed to prove dangerous tokens in a commit message don't over-fire the *safety* gate surfaced an **adjacent over-fire in a different hook**). Asking the master to `git commit --allow-empty -m '… git push --force, rm -rf / …'` correctly slipped past `prism-safety` (the v5.x de-quote fix), but `prism-prepush-review` then fired its "about to push branch" nudge — on a **commit**, with no push happening. Root cause: the prepush matcher tested the **raw** command, so a `git push` token *mentioned inside the quoted `-m` message body* matched. Same quoted-token over-fire class `prism-safety.mjs` already fixed, in a hook that never got the treatment.

- `hooks/prism-prepush-review.mjs` — match against a **de-quoted view** (strip heredoc bodies + single/double-quoted argument contents) before the `git push` test, mirroring `prism-safety.mjs`. **No false negative is possible:** every push the matcher catches sits at an unquoted boundary (start / space / `;` / `&&` / `||`), so it never lives inside a stripped span — a compound `git commit -m '…' && git push` still nudges; only a push *quoted as message text* is now ignored. The `--dry-run` / `--help` carve-outs run on the same de-quoted view.
- Tests: `test-prism-git-hygiene` +2 — a commit message that merely mentions `git push --force` is silent; a compound real push after `&&` still nudges (27/27).
- Scope note: pushes hidden inside `bash -c "git push"` were never matched by the boundary class to begin with (detecting them would be a new feature, out of scope); de-quoting changes nothing there.

## [5.2.10] - 2026-06-04

Test fix (latent regression from v5.2.4, caught by running `/prism-audit-full` during the v5.2.9 ship). The audit-runner scenario `DSP-001` still asserted "Parent **Read** on a haiku turn → deny (exit 2)" — but v5.2.4 deliberately added `Read/Grep/Glob/LS/NotebookRead` to the dispatch-guard's `ALWAYS_ALLOW` (read-only tools pass pre-dispatch). v5.2.4 updated the *unit* test (`test-prism-panel-deadlock`) but missed the audit-runner's copy of the old contract, so `DSP-001` had been failing the audit (28/29) since v5.2.4 (the unit suites were run each release, the audit-runner was not).

- `tests/v3/audit-scenarios.json` — repurposed `DSP-001` to exercise a **mutating** tool (`Bash`) on a haiku turn → still denied (exit 2), which is the safety property that remains true and is the right thing to smoke in the audit. Read-only-allow is covered by `test-prism-panel-deadlock`. Scenario count stays 29; audit back to **29 pass / 0 fail**.
- No code change — the dispatch-guard behaves correctly; only the stale audit expectation was wrong.

## [5.2.9] - 2026-06-04

Docs fix (UAT prompt 25 — the safety gate PASSED, but the project-master over-blocked a legal command because three docs misdescribed the gate). `rm -rf ./frontend/dist` is **allowed** (verified: exit 0 — target-aware, UAT-4), yet `master-test-prism-5` claimed *"rm -rf is hard-blocked … no override"* and worked around it. The belief traces to three docs that still carried the **pre-UAT-4 blanket framing** of the safety gate:

- `commands/prism-bootstrap.md` §8 — "hard-blocks: `rm -rf`, …" → now: blocks `rm -rf` only on dangerous/unverifiable targets (`/`, `~`, home/system paths); a specific relative subdir (`rm -rf ./build`, `node_modules`) is allowed.
- `commands/prism-help.md` — safety-gate row reworded the same way (allows `rm -rf ./build`).
- `INSTALL.md` §2.6c — dropped the stale `(pattern /rm\s+-rf\s/i)`; clarified the gate is target-aware and that `~/.claude/…` (this purge's target) is genuinely gated, so the `rm -r` workaround there is still correct.

No code change — `hooks/prism-safety.mjs` was already correct and its audit (`SAF-001`/`SAF-002`, 29/29) stays green; `README.md` already had the accurate phrasing and is the alignment reference. This only removes the misleading input that made a project-master refuse a safe, allowed cleanup.

## [5.2.8] - 2026-06-04

Fix (UAT, follow-on to v5.2.7 — the project-master toolset was still incomplete). Running `/prism-deep-dive` as `master-test-prism-5`, the master tried `Skill(AskUserQuestion)` → `Error: Unknown skill: AskUserQuestion`. Root cause: now that v5.2.7 granted the `Skill` tool, the master reached for `AskUserQuestion` — but that's a **tool, not a skill**, and it wasn't in the master's `tools:`. The `/prism-deep-dive` and `/prism-clean` command bodies call `AskUserQuestion` directly, and the panel/plan-approval flows need it too.

- **Root-fix, not whack-a-mole:** the project-master runs in the **main loop** and talks to the user directly, so its `PROJECT_MASTER_TOOLS` baseline now covers the full interactive + orchestration surface: added **`AskUserQuestion`** (clarifying questions, plan approval, panel decisions) and **`TodoWrite`** (plan/orchestration tracking) alongside the v5.2.7 `Skill`. Final canonical set: `Read, Write, Edit, Bash, Grep, Glob, Agent, Skill, AskUserQuestion, TodoWrite`. (The standalone `@master-orchestrator` is a dispatched *subagent* and deliberately keeps a leaner set — different role.)
- Existing `master-test-prism-5` agent patched to match.
- Test: `test-prism-deep-dive` asserts the generated frontmatter carries the complete canonical toolset (27/27).
- **Migration:** unchanged from v5.2.7 — pre-existing masters keep their toolset until regenerated via `/prism-deep-dive`.

## [5.2.7] - 2026-06-04

Fix (UAT — the project-master couldn't invoke runtime skills). `master-test-prism-5` reported *"The Skill tool isn't enabled here"* when it tried to load `brainstorming`: the `/prism-deep-dive` generator wrote `tools: Read, Write, Edit, Bash, Grep, Glob, Agent` — **no `Skill`**. The `master-orchestrator` skill is frontmatter-preloaded so panels still worked, but the master could reach no *other* skill at runtime.

- **Generator** (`tools/prism-deep-dive.mjs`): the project-master toolset is now a single named constant `PROJECT_MASTER_TOOLS = 'Read, Write, Edit, Bash, Grep, Glob, Agent, Skill'` (one source of truth), interpolated into the frontmatter — so **every** bootstrap/deep-dive emits the identical, complete capability baseline including `Skill`. (Bootstrap delegates project-master creation to deep-dive, so this is the only generator.)
- Existing `master-test-prism-5` agent patched in place (`+ Skill`).
- Test: `test-prism-deep-dive` asserts the generated frontmatter's `tools:` contains the full canonical set incl. `Skill` (27/27). Related suites green (fresh 7, clean 22, default-flip 9).
- **Migration note:** project-masters created *before* v5.2.7 keep the old toolset until regenerated (their frontmatter isn't auto-rewritten — `/prism-fresh` is memory-only). Re-run `/prism-deep-dive` (agent-write) to refresh an existing master's toolset, or add `Skill` to its `tools:` line by hand.

## [5.2.6] - 2026-06-04

Fix B (the re-scoped half of v5.2.5) — **transcript-aware paste detection**. The recurring paste over-fire class (ledger v5.2.3; the prompt-20 meta-question) all stemmed from the same leak the v5.1.7 author flagged: `stripPastedContent` only removed lines *starting* with a transcript glyph, so a pasted transcript's **interior synthesis prose** ("A 4-seat **adversarial panel** examined…", "re-architect the platform") survived into the user's "own words" and re-fired `summon_panel` (here, "adversarial panel" matched `EXPLICIT_PANEL_RE`). Transcript-style pastes also never reached `pastedRatio ≥ 0.6`, so the dampening didn't engage.

- **Fix** (`tools/lib/prism-tier-classify.mjs`): when a prompt is transcript-DOMINATED (≥3 *strong* structural markers — `●`/`⎿`/box-drawing/status glyphs + no-glyph tool-output lines like `Agent(…)`, `Done (N tool uses · …k tokens)`, `(ctrl+o to expand)`), `stripPastedContent` now removes the contiguous transcript **block** (first→last strong marker, interior prose included) rather than just glyph-prefixed lines. The user's actual request sits outside that span and is preserved. The bare `>` blockquote is deliberately **excluded** from strong markers, so quoting in one's own prose never triggers block-strip; sub-threshold (<3) pastes fall back to the original per-line strip.
- **Result:** a pasted panel transcript + a trailing question no longer summons a panel off the transcript's vocabulary; an explicit "summon the panel" in the user's *own* trailing words still does; genuine no-paste architecture requests are unchanged.
- Tests: `test-prism-panel-paste-dampening` 9→14 (block-strip of interior "adversarial panel" prose, pastedRatio, two over-strip guards). Full classifier/panel/hook-nudge regression set green (v4-6 20, routing-chaos 35, panel-deadlock 15, sonnet 5, classifier-uat 15, release-screen 7, hook-paste-nudge 4).
- **Honest limitation:** this is heuristic. A genuine request placed *between* two strong transcript markers (≥3 total) could be block-stripped from the panel decision (tier is unaffected; the user can always say "summon the panel"). The `>`-exclusion and the 3-marker threshold bound the risk.

## [5.2.5] - 2026-06-04

Fix (UAT prompt 20 — the active project-master delegated the panel to a *nested* `@master-orchestrator` instead of chairing it itself). When a `master-<slug>` is the active agent (it loads `skills: [master-orchestrator]`), the panel-summon flow still unconditionally forced "dispatch `@master-orchestrator`" — but a dispatched orchestrator is a *subagent*, and PRISM's sole-dispatcher rule strips its `Agent` tool, so it can't spawn a real panel → it role-plays the seats and the rostered specialists (e.g. `software-architecture-expert`) never get dispatched. The user flagged this twice; it was correct.

- **Router** (`hooks/prism-prompt-tier-router.mjs`): new `detectActiveMaster(cwd)` reads the project's `settings.json`/`settings.local.json` `agent:` field; when it's a `master-*` on a panel turn, the sentinel is flagged `self_chair: true` (+ `active_master`) and the advice changes to "**you** chair this panel directly in the main loop — dispatch your expert panel members as independent parallel subagents; do NOT nest a `@master-orchestrator`."
- **Dispatch-guard** (`hooks/prism-parent-dispatch-guard.mjs`): on a `self_chair` panel turn the gate opens on the master's *own* expert dispatch (`self_chair && dispatched`) rather than requiring a nested-orchestrator dispatch — and synthesis stays blocked until ≥1 panel member is dispatched, which is exactly what *prevents* the role-play. Generic (no project-master) turns are unchanged — still require `@master-orchestrator`.
- Tests: `test-prism-panel-deadlock` 10→15 — router sets `self_chair` with an active master (and does NOT without one); guard denies synthesis pre-dispatch with a self-chair notice (not a "spawn @master-orchestrator" one), allows it after a member is dispatched, and the generic path still requires the orchestrator. Classifier/panel regression set green.
- **Fix B (meta-question / pasted-transcript panel over-fire) was re-scoped, not shipped here.** Investigation showed the bare meta-question already routes `panel=false`; the production over-fire came from the *pasted prompt-20 transcript* — its literal phrase "adversarial panel" matched `EXPLICIT_PANEL_RE`, and transcript-style paste (no code fences) evades the v5.1.7 `pastedRatio ≥ 0.6` dampening. That's the known-hard transcript-paste leak, deferred for a deliberate decision (tighten `EXPLICIT_PANEL_RE` vs. transcript-aware paste detection) → tracked for v5.2.6.

## [5.2.4] - 2026-06-04

Reconciliation + fix (UAT prompt 19 — `design a new event-sourcing architecture…` cascaded into live-only hook edits in a stress-test session; this ports them into the tracked source with tests, and fixes a regression the porting surfaced). Prompt 19 itself PASSED (opus + panel, dispatch-guard enforced). Three changes, all TDD'd:

- **Meta-question screen** (`hooks/lib/prism-opus-classifier.mjs`) — a question ABOUT the system ("why did it route through `@master-orchestrator`? am I wrong?", "is it right to get all these blocks?") was wrongly forcing the design panel off its architecture vocabulary. New `isMetaQuestion()` clears `summon_panel` (tier untouched — a question can still warrant opus) when an interrogative/explanatory pattern matches AND no imperative build verb is co-present ("design X **and** explain why" still panels). Was applied live-only in the fixture session; now ported + tested.
- **Read-only tools pass pre-dispatch** (`hooks/prism-parent-dispatch-guard.mjs`) — `Read/Grep/Glob/LS/NotebookRead` added to `ALWAYS_ALLOW`. Reading is how the parent PLANS; gating it forced a throwaway subagent dispatch just to inspect one file (and contributed to the override catch-22). Mutations (Write/Edit/Bash) stay gated — the parent-plans / subagents-execute boundary is intact, just drawn at *writes* not *reads*. **Doctrine note:** on haiku/sonnet turns the Opus parent now reads at Opus rates rather than dispatching a cheap reader — a deliberate, accepted cost concession for the friction win. Was live-only; now ported + tested (replaces the prior "normal Read is denied pre-dispatch" contract in `test-prism-panel-deadlock`).
- **`PANEL_SIGNALS` "architecture" gap** (`tools/lib/prism-tier-classify.mjs`) — *regression exposed by v5.2.3.* "design a new event-sourcing **architecture** from scratch" was only panelling via the bare-`ledger` stakes accident that v5.2.3 (correctly) removed; genuine architecture detection matched `system|app|platform|pipeline|workflow` but not `architecture`. Added `architecture` to the target-noun set so prompt-19-style requests panel for the *right* reason. Caught by the TDD guard assertion, not in production.
- Tests: `test-prism-panel-deadlock` 8→10 (read-only allowed pre-dispatch, mutations still gated); `test-prism-routing-chaos` +5 (A5 meta-question screen + architecture-panel guard). Full classifier/panel regression set green (v4-6 20, paste-dampening 9, sonnet 5, classifier-uat 15, release-screen 7). The `software-architecture-expert` agent and the fixture's `master-prism-stress-test` created in that session are global/project-local artifacts, not framework source — not part of this commit.

## [5.2.3] - 2026-06-03

Bugfix (UAT — classifier over-escalated **any** prompt mentioning `ledger` to opus + summon_panel). The money/payments `STAKES_SIGNALS` line in `tools/lib/prism-tier-classify.mjs` carried a **bare, unanchored `ledger`** token — directly violating the file's own stated rule (lines 86–91: "Each pattern carries a CONTEXT ANCHOR … not everyday dev vocabulary"). In a coffee-**ledger** app the word is in every file path, README, and read query, so trivial prompts — `what is the current ledger balance?`, `fix the typo in the ledger README`, `rename the ledger app folder` — all routed **opus + panel**.

- Surfaced by UAT prompt 18 (the sonnet-calibration test): pasting its transcript back into the dev session fired `summon_panel=true` ("novel architectural request") off the `backend/ledger/…` paths in the pasted text. Root-caused via the classifier directly — the bare prompt routes haiku, but **any** ledger mention (pasted or typed) tripped `detectStakes` → panel.
- **Fix:** removed bare `ledger` from the money signal and added an **anchored** ledger-mutation pattern — `(reconcil|rebalanc|recomput|settl|void|revers)…\s+(the|all|a/an)?\s+ledger`. Reads and cosmetic edits pass; genuine ledger mutations (`reconcile the ledger`, `reverse a ledger entry`) still escalate. No test depended on the bare token.
- Regression tests: `test-prism-v4-6-classifiers.mjs` 13→20 — four benign `ledger` prompts (incl. prompt-18) must NOT escalate; two genuine ledger mutations must still fire `stakes`. All related suites stay green (panel-paste-dampening 9, sonnet-routing 5, routing-chaos 30, classifier-uat 15, release-screen-panel 7, panel-deadlock 8).
- **Known limitation (noted, not fixed):** transcript-style pastes (prose / file paths, no code fences) don't reach the v5.1.7 `pastedRatio ≥ 0.6` dampening threshold, so paste content is still scored. This fix removes the specific `ledger` trigger; a broader transcript-aware paste detector is a separate enhancement.

## [5.2.2] - 2026-06-03

Bugfix (UAT — `/prism-validate-plugins` audited **0 of 15** active plugins and returned a false "✅ all healthy"). `tools/prism-validate-plugins.mjs` was written + tested against an assumed schema the installed `claude` CLI never emits: it expected `{plugins:[{name, path, hooks:[{command}], skills:[{name}]}]}`, but `claude plugin list --json` returns a **top-level array** of `{id, version, scope, enabled, installPath, …}` that exposes **neither hooks nor skills**. So `pluginList.plugins` was `undefined` → 0 audited, and the entire test fixture set encoded the fiction (green tests, real-world blind).

- **Fix (full):** normalize the real top-level-array schema (back-compatible with the legacy `{plugins:[…]}` shape via `normalizePluginList`); map `id`→name and `installPath`→path through `pluginName`/`pluginPath` aliases. `missing_manifest` now works off `installPath` (D004's primary purpose: "plugin dir removed without uninstall"). `broken_hook` and `skill_conflict` — absent from the list output — now read each plugin's **on-disk layout**: hook commands from `.claude-plugin/plugin.json` `.hooks` + conventional `hooks/hooks.json`; skill names from `skills/*/` directories. `${VAR}` expansion added (maps `${CLAUDE_PLUGIN_ROOT}`→installPath).
- **Conservative guards (D004 risk #5 — false-positive aversion):** `broken_hook` skips inline shell-script hooks (statement separators, command substitution, `sh -c`), glob-pattern candidates, and unresolvable-var paths — verified against the real install, which has a claude-mem plugin shipping inline `export PATH=…; ls …/[0-9]*/; exec node …` hooks that the naive path-extractor false-flagged 7×. After the fix: **15 audited, 0 findings** on the live install.
- Regression tests: `test-prism-validate-plugins.mjs` 10→19 — top-level-array-is-audited (the test that would have caught it), id/installPath mapping, disk-backed hook + skill discovery, and the inline-script / glob false-positive guards. All drive the helper as a real subprocess.

## [5.2.1] - 2026-06-03

Bugfix (UAT — skill-suggestion nudges over-fired on pasted content; the unfinished half of v5.1.7). `hooks/prism-hook.mjs` matched its TDD / debugging / code-review / git-worktree / parallelizable / MCP-intent / KB-router nudges against the **raw** prompt, with none of the pasted-content dampening v5.1.7 added to the classifier. So pasting a `/prism-*` transcript fired skill nudges off the *transcript's* vocabulary.

- **Fix:** `prism-hook.mjs` now derives `ownPrompt = pastedRatio(prompt) ≥ 0.6 ? stripPastedContent(prompt) : prompt` (graceful dynamic import of `tools/lib/prism-tier-classify.mjs`; identity fallback if absent) and matches all nudge/MCP/router intent against `ownPrompt`/`ownPromptLC` instead of the raw prompt. Genuine requests (no paste) are unaffected.
- Regression test: `tests/v3/state/test-prism-hook-paste-nudge.mjs` (4) — paste-dominated transcript fires NO TDD/debug/worktree nudge; a genuine "implement … with TDD" still does. Drives the hook as a real subprocess.

## [5.2.0] - 2026-06-03

Feature — **scope-aware agent survival** (brainstormed + designed this session; spec `docs/prism/plans/2026-06-03-agent-scope-survival-design.md`, adjudication [[D008]]). Resolves the standing tension that project-specific specialists (e.g. `coffee-ledger-expert`) live in the global pool forever with no lifecycle tied to the project they were built for.

- **Scope decision at creation.** The creator (agent-factory / commissioning master) now declares each agent's `scope`: `"broad"` (reusable, protected) or `"project"` (targeted, with `home_project` + `home_project_path`). Rule added to `agents/agent-factory.md`; roster `_schema_example_agent` documents the new fields (`scope`, `home_project`, `home_project_path`, `archived`/`archived_at`/`archived_reason`). **Absent `scope` ⇒ treated as `broad`** (safe default — existing agents are untouched on upgrade).
- **Auto-archive of project-orphaned agents.** The 24h freshness sweep gains its FIRST mutating check (`checkProjectScopedSurvival`): a `scope:"project"` agent whose home project is **absent** (dir gone, parent reachable) or **stale** (`last_sync_at` older than `PRISM_AGENT_PROJECT_STALE_DAYS`, default 90) is **moved** to `~/.claude/agents/retired/` and marked `archived` in the roster. Safety rails (per [[D008]]): reversible (move, never delete; entry retained), **SMB guard** (offline mount/parent ⇒ NOT archived), broad-protected, notify-after, dry-run stays read-only (`apply` flag).
- **`/prism-roster`** shows each agent's scope and lists archived agents separately with restore instructions.
- New: `tools/lib/prism-agent-scope.mjs` (pure decision core). Tests: `test-prism-agent-scope.mjs` (14, pure logic), `test-prism-agent-survival-sweep.mjs` (12, real archive + SMB guard + dry-run safety + reversibility); freshness-sweep harness copies the new dep.

## [5.1.9] - 2026-06-03

Bugfix (UAT — `/prism-recall` hard-failed on fresh installs). A Tier-1 semantic query (the default for most questions) routes to `prism-kb-query.mjs`, which hard-requires the NotebookLM KB (`meta missing … run prism-kb-notebook-init.mjs first`, exit 1). That KB is an **opt-in, heavyweight cloud feature** — not initialized on a default/manual install — so the headline recall command emitted a scary `ERROR: meta missing: C:\…\.prism-kb-meta.json` (leaked path, looked like a crash, never said "optional") for the most common query type. Tiers 2 (state) and 3 (analytics) were unaffected (local).

- **Fix (`tools/prism-recall.mjs`):** `formatEnvelope` now detects the KB-not-initialized condition (`isKbNotInitialized`) and renders a friendly, actionable note — "optional NotebookLM KB isn't set up (the default); enable with `node ~/.claude/tools/<rebuild|notebook-init>.mjs`; Tiers 2 & 3 work without it" — instead of a raw `ERROR:` with a leaked path. Genuine (non-KB-init) Tier-1 errors still surface as `ERROR:` unchanged.
- Regression test: `tests/v3/state/test-prism-recall-error-leak.mjs` extended (13) — covers both index-missing and meta-missing → friendly note, no path leak, points to the right tool, and a genuine error still surfaces.

## [5.1.8] - 2026-06-03

Bugfix (UAT papercut — `/prism-clean append-decision` rejected un-padded D-numbers). `tools/prism-clean.mjs` validated `--d-number` with `/^\d{3,}$/` (≥3 digits), so the natural call `--d-number 1` (the number lifted from "D001") was rejected with a misleading `(digits only)` message — "1" *is* digits. Observed live: the model passed `1`, got rejected, retried `001`.

- **Fix:** validator is now `/^\d+$/` and the value is zero-padded to the canonical 3-digit form (`String(dNumber).padStart(3,'0')`) before building the `[[D###]]` pointer. Error message clarified (`<N> (digits only, e.g. 1 or 001)`).
- Regression test: `tests/v3/state/test-prism-clean.mjs` — new case asserts `--d-number 1` → `[[D001]]` (now 22 tests).

## [5.1.7] - 2026-06-03

Two UAT-surfaced false-positive fixes (found by feeding `/prism-doctor` and `/prism-audit` transcripts back into a live PRISM session).

- **Panel-summon over-fires on pasted content (`tools/lib/prism-tier-classify.mjs`).** Pasting a command transcript/report into a PRISM session repeatedly tripped `summon_panel=true` — the keyword floor scored the pasted report's vocabulary ("security audit", "architecture", "re-architect", "migrate") as if it were the user's own request, demanding a master-orchestrator panel for a result paste. Fix: `detectSummonPanel` now detects pasted/quoted-dominated prompts (`pastedRatio ≥ 0.6` via `stripPastedContent`, which strips fenced blocks, blockquotes, Claude Code transcript markers ●/⎿, box-drawing/table chrome, and status glyphs) and on those honors ONLY an explicit panel request in the user's own words. Tier scoring is deliberately untouched — only the panel decision is dampened. New test: `tests/v3/state/test-prism-panel-paste-dampening.mjs` (9).
- **`/prism-audit` false-positives on framework OOB reviewers (`commands/prism-audit.md`).** The Agent-YAML check flagged PRISM's own `*-oob-reviewer` agents for "missing model/maxTurns". False positive — they are not Agent-dispatched: `hooks/prism-phase-0d-oob.mjs` spawns `claude -p --model claude-sonnet-4-6` (model hardcoded in the hook), `hooks/prism-phase-1-5-oob.mjs` reads model from frontmatter, and both are one-shot `claude -p` calls so `maxTurns` (an Agent turn-loop cap) is meaningless. Fix: the check now exempts `*-oob-reviewer` agents from the model/maxTurns requirement. New test: `tests/v3/state/test-prism-audit-oob-exemption.mjs` (6, incl. source-fact guards).

## [5.1.6] - 2026-06-03

Bugfix (found while *applying* v5.1.5's own fix — the Symptom-11 recipe was broken). `/prism-doctor` Symptom #11 ("bootstrap state corrupt / clobbered") recommended `prism-state.mjs adopt` then `validate`, but `adopt` **refuses to overwrite an existing file** (`state already exists; use reset first`). Symptom #11 ALWAYS describes an *existing* corrupt file, so `adopt` alone always failed for the exact scenario it targets.

- **Fix (`commands/prism-doctor.md`):** Symptom-11 recipe is now `reset` (delete the corrupt file) → `adopt` (rebuild from filesystem) → `validate`, with a note that `reset` only removes `.prism-state.json` and `adopt` immediately rebuilds it, plus the `--root` hint.
- Regression test: `tests/v3/state/test-prism-doctor-fix-recipes.mjs` (now 11) asserts the recipe sequences `reset` before `adopt`.
- Verified end-to-end against the live UAT project (`test_prism_5`): `reset`→`adopt`→`validate` took its clobbered `.prism-state.json` from `invalid_schema` to `status: ok`.

## [5.1.5] - 2026-06-03

Bugfix (UAT finding — doctor had no bootstrap-state signal). The v5.1.3 handoff advertises `/prism-doctor` as the *guided alt* for repairing a clobbered `.claude/.prism-state.json`, but the doctor's 12 signals covered hooks/roster/settings/env — **never the bootstrap state machine itself**. So a corrupt/clobbered state (the exact v5.1.3 bug) produced a clean doctor report.

- **Fix (`commands/prism-doctor.md`):** added **signal #13** (validate `.claude/.prism-state.json` via `node ~/.claude/tools/prism-state.mjs validate` when the file exists) and **Symptom #11** ("bootstrap state corrupt / clobbered" → fix `prism-state.mjs adopt` then re-validate). Both are **existence-guarded** — a missing file means "not a bootstrapped project," not a symptom (`validate` returns `invalid_schema` for a missing file, which would otherwise false-flag every non-PRISM dir, including the PRISM repo).
- Regression test: `tests/v3/state/test-prism-doctor-fix-recipes.mjs` extended to 10 tests (bootstrap-state coverage + existence-guard assertions).

## [5.1.4] - 2026-06-03

Bugfix (UAT finding — stale doctor fix-recipes). Live UAT of `/prism-doctor` (in `test_prism_5`) surfaced Symptom-1 ("prism.env missing") recommending `cd ~/PRISM && bash scripts/bootstrap-prism-env.sh` — a script that **never existed in git history**, behind a stale `~/PRISM` clone path. No `.mjs` writes `prism.env`; it is an **optional** node-resolution pin (step 2 of the `prism-exec` fallback chain), so with `node` on PATH a missing pin is the *normal healthy state*, not a symptom. Two sibling fix-recipes (Symptoms 5 and 7) also pointed at the retired `scripts/install-merge.sh` (the shell installer was retired in v5.1 / `5da140f3f`).

- **Fix (`commands/prism-doctor.md`):**
  - Symptom-1 detection is now **guarded on `node` being unresolvable** (`node --version` fails) — a missing `prism.env` with working `node` is no longer flagged. Its fix recipe writes the `PRISM_NODE=<path>` pin directly (no phantom installer script).
  - Symptoms 5 + 7 now recommend the **canonical installer** `node tools/prism-installer.mjs update` instead of the retired `scripts/install-merge.sh`.
  - Step-1 signal #3 annotated so the engine treats `prism.env` as the optional pin it is.
- Regression test: `tests/v3/state/test-prism-doctor-fix-recipes.mjs` (6 tests) — asserts no phantom `bootstrap-prism-env.sh` / stale `~/PRISM`, that **no command file references a non-existent `scripts/*.{sh,ps1}`** (general dangling-retired-script guard), and that Symptom-1 detection is node-guarded.

## [5.1.3] - 2026-06-03

Bugfix (UAT finding — state-file collision). The project-local turn-counter and the bootstrap state machine both used `.claude/.prism-state.json`. `prism-session-start.mjs` **full-overwrote** it with `{turns:0, session_start}` every session start, and `prism-hook.mjs` incremented `turns`/`recent_suggestions` in it — **clobbering the bootstrap state** (`schema_version`, `phases`, `project_slug`, …) that `tools/lib/prism-state.mjs` owns. Result: `/prism-deep-dive --refresh`, `/prism-sync`, and `/prism-doctor` saw an invalid state file after any session restart.

- **Fix:** the hook turn-counter moved to a dedicated **`.claude/.prism-turn-state.json`** — `prism-hook.mjs` (writer), `prism-session-start.mjs` (per-session reset), and `prism-recall.mjs` (reader) all updated. `.prism-state.json` is now exclusively the bootstrap state machine.
- Added `.claude/.prism-turn-state.json` to the bootstrap `.gitignore` block.
- Regression test: `tests/v3/state/test-prism-turn-state-collision.mjs` (3 tests) — asserts session-start + prism-hook never clobber a seeded bootstrap state and write the turn-counter to the dedicated file.
- **Recovery for already-clobbered projects:** `node ~/.claude/tools/prism-state.mjs adopt` (synthesizes state from filesystem) or `/prism-doctor`.

## [5.1.2] - 2026-06-03

Docs (UAT finding): added a **shell-hygiene note** to `commands/prism-bootstrap.md` Phase 4 — inspect project files with the Read/Grep/Glob tools, and never mix bash + PowerShell in one command (the bootstrap discovery probe emitted `ls` + `Test-Path`/`Get-Content`/`if (...) {…}` to git-bash, which errored). Behavioural nudge only; the error was already self-correcting and non-blocking.

## [5.1.1] - 2026-06-03

Bugfix (UAT finding): **`/prism-bootstrap` (and the other parent-driven state-machine commands) were missing from the classifier's `OPUS_ORCHESTRATION_COMMANDS` allowlist** (`hooks/lib/prism-opus-classifier.mjs`). They fell to keyword-floor scoring → low tier → the parent-dispatch-guard then **denied their own deterministic `git`/`node` calls** (e.g. bootstrap Step 0 git guard on a fresh project). Added `/prism-bootstrap`, `/prism-sync`, `/prism-deep-dive`, `/prism-fresh`, `/prism-clean`, `/prism-doctor`, `/prism-index`, `/prism-deps`, `/prism-validate-plugins`, `/prism-audit-full`, `/prism-telemetry`, `/prism-uninstall-cleanup` — they now route to opus with the `orchestration command /prism-…` rationale the dispatch-guard's carve-out recognizes, so the parent runs its own state machine. Regression-guarded by a new A4 block in `tests/v3/state/test-prism-routing-chaos.mjs` (now 30 tests).

## [5.1.0] - 2026-06-03

Lifecycle + command-consolidation. v5.1 stamps the project-master lifecycle changes that shipped in docs after v5.0, and adds a panel-vetted command-consolidation pass under one governing rule: **automate cheap, deterministic DETECTION (nudge-only); keep EXECUTION manual** (LLM-judged / mutating / installing / blocking). Every new check rides the existing 24h-throttled SessionStart freshness sweep — **no new hot-path latency**.

Migration guide: `docs/prism/MIGRATION.md` §"v5.0 → v5.1".

### Project-master lifecycle (formalized)
- **Project-master is now default-on** in `/prism-bootstrap` — the project-master phase runs non-interactively and wires `master-<slug>` as the session `agent:`. Opt out with `--no-master`; `--with-deep-dive` is an accepted no-op.
- **claude-mem-aware two-mode memory** — PRISM detects the optional `claude-mem` tier and either stands down its save-nudge (Mode A) or runs the PRISM-native fallback with `/prism-clean append-summary` + resume handoff docs (Mode B). `/prism-bootstrap` offers an opt-in install during the health phase.

### Command consolidation — detection automated, execution manual
- **Freshness sweep — three new detection checks** (`hooks/lib/prism-freshness-sweep.mjs`), all nudge-only, fail-open, 24h-throttled:
  - **A1 hook integrity** — fs wiring sanity (every `prism-*.mjs` referenced in settings.json resolves on disk) + empty-file check, always; plus a **change-gated** `node --check` of only the hooks whose mtime advanced since the last sweep (node cold-start is ~2-3s on Windows, so steady state spawns nothing; bounded by an 8s budget + 3s per-hook timeout when it does run). Nudges `/prism-doctor` for the deep pass.
  - **A2 roster orphans** — roster entries whose agent file is missing on disk (honors `file_path`, falls back to `~/.claude/agents/<name>.md`) → nudges `/prism-bootstrap` / `/prism-roster --reconcile`.
  - **A3 audit staleness** — `/prism-audit` now stamps `~/.claude/.prism-audit-last.json`; the sweep nudges a re-run once it's >30d old. Silent when never audited.
- **A5 — index auto-rebuild (E1/F4).** When the sweep detects the per-project KB index or the cross-project knowledge index is behind its source docs out-of-band, it now **rebuilds inline** (lockfile-guarded via `.prism-kb-rebuild.lock` / `.prism-kb-knowledge-rebuild.lock`, ≤1×/24h, 60s ceiling) instead of only nudging. Degrades to the prior manual nudge if the rebuild tool is absent or another session holds the lock. The `--preview` CLI stays non-mutating (never rebuilds). Removes `/prism-index`'s KB-rebuild from the routine surface.
- **New `/prism-fresh`** (`commands/prism-fresh.md`) — refresh-only alias for `/prism-deep-dive --refresh` (regenerates the project-master `MEMORY.md`). **Never** rewrites the learned agent body; that stays the separate diff-confirmed `/prism-deep-dive --upgrade <slug>`.
- **`/prism-help` tidy** — `/prism-deps`, `/prism-index`, `/prism-validate-plugins`, `/prism-audit-full` regrouped under **Maintenance** (nothing removed; all callable).

### Installer cleanup — retire the legacy shell-installer path
- **Removed** the superseded v4.4-era shell installer that copied from the stale root `manifest.json` (v3.8.9; flat file list, no skill-subdir support): `scripts/install.sh`, `scripts/install.ps1`, `scripts/install-merge.mjs`, `scripts/verify.mjs`, root `manifest.json`, and `tests/v3/run-static.sh` (its harness was built on that flow; Windows-broken + not in CI — the `.mjs` state suites are the trusted, cross-platform coverage). Eliminates a second, drift-prone install path that shipped an out-of-date file set.
- **Canonical installer is now the only path**: `node tools/prism-installer.mjs` (uses `install-manifest.json`, with directory support, version markers, backups, and coverage gates), wrapped by root `install.sh` / `install.ps1`.
- Repointed `scripts/uninstall.{sh,ps1}` `--reinstall`, `commands/prism-audit-full.md`, `tests/v3/run-claude.md`, `tests/v3/state/README.md`, and the D004 upgrade instruction at the canonical installer.

### Explicitly NOT done (panel-killed — would compromise speed/quality)
Audit as a blocking pre-commit gate; doctor/health full pass every session; auto-recommend; unattended update-apply; auto-upgrade of the master agent body; auto-install of deps. Rationale: each adds per-session latency, trains `--no-verify`, nags with no "done" state, or silently rewrites tuned state with no rollback trail.

### Tests
- `tests/v3/state/test-prism-freshness-sweep.mjs` extended to **43** (A1/A2/A3/A5 + the existing C3/E1/E2/Q-series; A1 is change-gated so the suite stays fast).
- New `tests/v3/state/test-prism-fresh.mjs` (**7**) — command contract + manifest + help-index wiring.
- Full suite **55/55** suites green; installer dry-run 102 files; `prism-audit-runner` 29/29.

## [5.0.0] - 2026-06-01

The v5.0 foundational bet: a **dep-free, offline cross-project knowledge index** (F4) — BM25 lexical retrieval + a default-on `claude -p` re-rank (silent BM25 fallback), a default-deny per-corpus-type sharing model, and a stable `queryKnowledge()` API. This is the topology shift from a self-aware single-project orchestration to a substrate that can learn across projects. The verdict-regression scanner (A5) that consumes the index is deferred to v5.1.

Migration guide: `docs/prism/MIGRATION.md` §"v4.7 → v5.0".

### F4 — cross-project knowledge index (foundational bet)
- **Phases A–D** (committed): dep-free **BM25** lexical lib (`tools/lib/prism-bm25.mjs`); cross-project
  **knowledge indexer** (`tools/prism-kb-knowledge-indexer.mjs`) with default-deny per-corpus-type
  `.prism-kb-share.json` opt-in, always-on home-global verdicts, secret pre-scan/redaction (fail-closed),
  descriptor-not-body storage, provenance, atomic write; **`claude -p` re-rank** wrapper
  (`tools/lib/prism-kb-rerank.mjs`, default-on-when-available, 8 s timeout, silent BM25 fallback); and the
  **`queryKnowledge({crossProject, limit, rerank})`** API (`tools/lib/prism-kb-knowledge-query.mjs`) wired
  into `prism-recall.mjs` (`--cross-project`, `--share-project [types…]`, `--unshare-project`, honest
  "(LLM re-ranked)" / "(lexical only — …)" labels).
- **Phase E — freshness/sync + manifest-coverage integration** (this batch):
  - `tools/prism-kb-knowledge-rebuild.mjs` — drain-at-Stop refresher (`--sync --quiet`); derives changed
    project root(s) from a dedicated `~/.claude/.prism-kb-knowledge-dirty` flag.
  - `hooks/prism-kb-autosync.mjs` — writes the dedicated knowledge-dirty flag (separate from the resource
    `.prism-kb-dirty`); project corpus gated by the project's shared types (default-deny), verdicts always-on.
  - `hooks/prism-session-end.mjs` — Stop-drain spawns `prism-kb-knowledge-rebuild` detached. Zero per-turn latency.
  - `hooks/lib/prism-freshness-sweep.mjs` — `checkKnowledgeIndexStale` SessionStart nudge (sibling to the
    v4.7 E1 per-project check); absorbs the v4.6-deferred cross-project freshness item.
  - `tools/install-manifest.json` — added the 5 `files[]` entries the A–D phases shipped uninstalled
    (bm25/indexer/rebuild/query/rerank). New `tests/v3/state/test-manifest-coverage.mjs` enforces this as a
    build-phase gate.
- **Known limitation (measured):** on Windows, raw `claude -p` cold-start (~20 s) exceeds the 8 s re-rank
  budget, so the default-on semantic re-rank silently falls back to BM25. Set
  `PRISM_RECALL_RERANK_TIMEOUT_MS=25000` to let it engage (accepting ~20 s per `--cross-project` query).
  Tracked in `docs/prism/lessons/2026-06-01-v5.0-f4-phase-e-handoff.md`.

### Fixed — routing
- **Release-safety screen no longer force-summons the design panel.** The keyword-floor release/meta-work
  screen (`hooks/lib/prism-opus-classifier.mjs`) matched bare `ship`/`release` tokens and hardcoded
  `summon_panel=true`, so a ship-*readiness question* ("are we ready to ship?") was routed through the
  full `@master-orchestrator` design panel. The screen now promotes to **opus tier** (the real anti-haiku
  safety) but leaves `summon_panel` to the genuine novel-architecture signal path (`PANEL_SIGNALS` /
  stakes / ≥3 opus signals) — a real "re-architect + release" prompt still summons it; a readiness check
  does not. New test: `tests/v3/state/test-prism-release-screen-panel.mjs`.
- **Tier-override guidance no longer contradicts the dispatch guard on panel turns.** On hard-mode
  panel-summoning turns the router (`hooks/prism-prompt-tier-router.mjs`) printed the v3.2.0 "write the
  sentinel as your FIRST action" self-override protocol — a Write the parent-dispatch-guard denies (Write
  isn't in its `ALWAYS_ALLOW` set). That text is now suppressed on those turns; the panel directive already
  carries the correct escape (`!opus-force:` / `PRISM_DISPATCH_GUARD=off`).

## [4.7.0] - 2026-05-29

Stepping-stone minor that clears the small deferred backlog (no v5.0 lift) and turns the parallel-dispatch cap into a real configurable knob. Purely additive — no topology change, no new agents or slash commands, no default flips. `.prism-routing.jsonl` gains a new `install_outcome` event (schema_version 5 on that line only; sibling events stay 4 — additive, older readers ignore unknown event kinds).

Migration guide: `docs/prism/MIGRATION.md` §"v4.6 → v4.7".

### Added
- **K1 — `PRISM_PARALLEL_CAP` knob.** The parallel-dispatch cap was a hardcoded `4` in both the `dispatch-cap` telemetry hook and the orchestrator prose. New `hooks/lib/prism-cap.mjs` (`resolveParallelCap`, strict guards) is the single source of truth; `prism-dispatch-cap.mjs` logs the resolved cap; `prism-session-start.mjs` injects the active cap into context **only when overridden** (closes the "half-knob" trap — telemetry can't diverge from doctrine). Default stays **4** (no default flip). `dispatch-shapes.md` + `phase-1-execution.md` reference the knob.
- **C3 — version-aware upgrade nudge.** SessionStart freshness sweep now compares the installed `~/.claude/.prism-version` against the `prism_version` in the current clone's manifest; when the clone is ahead (the "git pull, forgot to re-run the installer" case) it nudges the exact `node tools/prism-installer.mjs update` command. No network, no auto-apply.
- **E1 — KB-index staleness check.** Nudges a rebuild when a source `.md` under `agents/commands/skills/rules` is newer than the index's `source_mtime_max`. Catches out-of-band changes the autosync dirty-flag misses (git pull, a Stop that didn't drain). `plugins/cache` excluded (covered by Q1). Per-project scope — the cross-project semantic index remains a v5.0 item (F4).
- **E2 — tools-registry ↔ roster index-sync check.** Nudges `/prism-index` when `tools-registry.md` changed *after* the last index (`roster.index_meta.last_indexed`). Distinct from Q11 (prior-sweep comparison); silent when never indexed.
- **G1 — staleness preview.** `node hooks/lib/prism-freshness-sweep.mjs --preview` prints current staleness signals without touching the 24h throttle snapshot, so the orchestrator can run a pre-plan check mid-session. Wired into `phase-0a-inventory.md` doctrine for stale-prone work.
- **I3 — aligned install summary.** Fixed-width label column (Version/Target/Files/Backup); long target paths stay readable (path is always the value). Shows `from → to` on upgrades.
- **I8 — opt-in install/upgrade telemetry (local-only).** On install/update, appends an `install_outcome` record to `.prism-routing.jsonl` **only** when opted in via `prism-policy.json` `telemetry.opt_in` (the same consent the aggregator uses — one opt-in surface). Honors `DISABLE_TELEMETRY` / `DO_NOT_TRACK`. No network.

### Fixed
- **Roster lock crashed on first-ever roster creation** (pre-existing, surfaced during v4.7 review). `withRosterLock` opened `roster.json.lock` with `openSync(..., 'wx')` but never ensured the roster's parent directory existed; on the first agent auto-registration (no `skills/prism-plan/references/` dir yet) it threw `ENOENT` and crashed the hook, so the agent was never registered. `withRosterLock` now `mkdir -p`s the lock's parent first. `test-prism-agent-write-register.mjs` goes from 6/9 to 9/9.
- **Test harness — async-blind runner.** `test-prism-freshness-sweep.mjs` and `test-prism-git-hygiene.mjs` ran async tests with a synchronous runner that counted `pass++` before post-`await` assertions executed — assertions were silently skipped. Converted both to an async-aware runner. This surfaced 4 genuinely-failing git-hygiene tests (all test-environment artifacts — HOME captured at flag-helper module-eval, and a commitless temp repo breaking branch detection; no production bugs). All now genuinely pass.

## [4.6.0] - 2026-05-28

Telemetry-driven calibration (the payoff of v4.5's tooling-only telemetry), preceded by telemetry data-quality fixes, plus structured-output classifiers and the v4.5-review hygiene closeout. Build order inverted from layer numbering (hygiene + data-quality first, calibration last). Backward-compatible: `.prism-routing.jsonl` schema 3 → 4 is additive; v4.5 readers ignore unknown fields.

Migration guide: `docs/prism/MIGRATION.md` §"v4.5 → v4.6".

### Added (Layer 2 — Telemetry-driven calibration, recommend-then-apply)
- `tools/prism-telemetry-aggregate.mjs --recommend-calibration` — on-demand engine; reads routing + verdict logs, prints `{knob, current, recommended, evidence, confidence}[]` + apply commands; degrades to "insufficient data (n<15)"; output to stdout + `~/.claude/.prism-calibration-<date>.json`. NO silent writes.
- K1 cap-retune rule (REPORT-ONLY — the cap is prose in dispatch-shapes.md), K2 escalate-model (ratchet detects via pending_upgrade, K2 recommends; apply `--set-model`), K3 auto-clear pending_upgrade (apply `--clear-pending-upgrade`), K4 master-override gate (advisory; `PRISM_OVERRIDE_GATE=strict`).
- `tools/prism-roster.mjs --set-model <agent> <model>` + `--clear-pending-upgrade <agent>` apply-writers.

### Added (Layer 1 — Telemetry data-quality)
- `dispatch_cap` events now carry `actual_parallel` + `queue_depth` (fresh `.prism-task-*` dir count). `.prism-routing.jsonl` schema 3 → 4 (additive).
- Challenge `evidence_class` classified at panel-write (7-class taxonomy) so telemetry no longer reads `UNCLASSIFIED`.
- `tests/v3/state/test-installer-coverage.mjs` — manifest-coverage regression guard.
- Fixed: `--agreement` mode was joining a non-existent `phase_1_5_verdict` event; now reads the real verdict JSONL + phase-0d challenges.

### Added (Layer 3 — Structured-output classifiers)
- `tools/lib/prism-validation-classify.mjs` (C1), `tools/lib/prism-failure-taxonomy.mjs` (C2), stakes detection in `tools/lib/prism-tier-classify.mjs` (D1 — migrations/deletes/security/money bias to opus + panel; context-anchored to avoid over-firing on everyday dev vocabulary).

### Fixed (Layer 4 — Hygiene closeout)
- H1 `withRosterLock` now wraps `prism-agent-write-register.mjs`, `prism-uninstall-cleanup.mjs`, `prism-installer.mjs`.
- H2 `prism-verdict-flag.mjs` `writeVerdict(kind, sha, payload)`; phase-0d + phase-1-5 unified (phase-0d keeps no-jsonl behavior).
- H3 `--target` installs now rewrite hook commands to the target's paths (were silently no-oping at `~/.claude`).
- H4 Windows `claude` `.cmd` resolution before `spawnSync`; `PRISM_PHASE_0D_MOCK_VERDICT` + `PRISM_PHASE_1_5_MOCK_VERDICT` test env vars.

### Schema
- `.prism-routing.jsonl` 3 → 4 (additive: `actual_parallel`, `queue_depth`, `master_override` event). v4.5 readers ignore unknown fields.

### Known limitations / deferred to v4.7
- K1 apply is report-only (the parallel cap is orchestrator prose, not a code knob).
- `actual_parallel` is a fresh-dir-count proxy, not true sibling state (Claude Code doesn't expose it).
- Live hook-refresh requires a version bump to install (re-run `installer update` after upgrading).

## [4.5.0] - 2026-05-27

Four composing layers: telemetry tooling (no calibration), out-of-band Phase 0d panel reviewer, installer hardening, coverage/hygiene picks. Closes 15 evaluation-flow items from the v4.5 brainstorm across 40 plan tasks. Backward-compatible: all schema changes additive; pre-v4.5 panels and rosters work unchanged.

Migration guide: `docs/prism/MIGRATION.md` §"v4.4 → v4.5".

### Added (Layer 1 — Telemetry tooling, no calibration)

- `hooks/prism-phase-0d-challenges.mjs` — log Phase 0d challenge events to `.prism-routing.jsonl` (B1-tool).
- `hooks/prism-dispatch-cap.mjs` — log parallel-dispatch cap utilization (B3-tool).
- `tools/prism-telemetry-aggregate.mjs --agreement` — reviewer-agreement aggregator (B4-tool).
- `.prism-routing.jsonl` `schema_version` bumped 2 → 3 (additive; readers must ignore unknown fields).

Telemetry policy: TOOLING ONLY in v4.5. No defaults change. v4.6 will read these and decide calibration (B1 cap retune, master-overrides confirmation gate, auto-clear pending_upgrade).

### Added (Layer 2 — Out-of-band Phase 0d completion)

- `hooks/prism-phase-0d-oob.mjs` + `agents/phase-0d-oob-reviewer.md` — out-of-band Phase 0d panel-quality reviewer (A1). Fires under `PostToolUse[Write]` on `.prism-task-*/panel.json`; runs in background; emits verdict to `~/.claude/.prism-phase-0d-verdicts-<sha>.json` for next-turn pickup.
- `tools/lib/prism-roster-lock.mjs` — cross-platform exclusive-create lock for roster.json mutations (O2). Roster writes in `tools/prism-roster.mjs`, `hooks/prism-phase-1-5-oob.mjs`, and `hooks/prism-phase-0d-oob.mjs` wrap through `withRosterLock()`. Other mutation sites (`hooks/prism-agent-write-register.mjs`, `tools/prism-uninstall-cleanup.mjs`, `tools/prism-installer.mjs`) remain on atomic write — extending the lock to those sites is deferred to v4.6.
- `hooks/prism-phase-1-5-oob.mjs` — LITE mode plumbing (O1) gated by `roster.<spec>.phase_1_5_lite_oob`.
- `tools/prism-roster.mjs --skip-next-oob <spec>` — one-shot OOB skip on a specialist (V1).
- `hooks/prism-panel-guard.mjs` Path B — `dropped_positions[]` logging in panel.json (A3).
- `tests/v3/state/test-oob-pickup-e2e.mjs` — E2E for verdict pickup (O3).
- SessionStart hook picks up phase-0d verdicts in addition to phase-1-5 verdicts.

### Added (Layer 3 — Installer polish)

- `--target <dir>` flag for `install` / `update` / `uninstall` / `verify` / `detect` (I7). Default unchanged (omitted = `~/.claude/`). Mutually exclusive with `--home`.
- `update` subcommand (`detect && backup && install` chained) with `--dry-run` preview and `Already at vX; nothing to do.` no-op when installed version matches shipped (I6).
- `.prism-version` marker written by `install()` on success; consumed by `update`.
- `--purge-state` flag for `uninstall` (I4). Wipes `MEMORY.md`, `roster.json`, `.prism-routing.jsonl`, `.prism-spend.jsonl`, `.prism-phase-1-5-verdicts.jsonl`, `.prism-telemetry-rollup.json`, `prism-policy.json`, `.prism-flags/`, `.prism-task-*/`. Interactive prompt; `--yes` skips confirmation; `--quiet --purge-state` without `--yes` is rejected fail-fast.
- Expanded backup paths (I5): every install now snapshots the union of shipped files (`agents/`, `hooks/`, `tools/`, `commands/`, `skills/`) and user state (`MEMORY.md`, `prism-policy.json`, `.prism-routing.jsonl`, `.prism-spend.jsonl`, `.prism-phase-1-5-verdicts.jsonl`, `.prism-telemetry-rollup.json`, `settings.json`). 94 paths vs legacy 3.

### Added (Layer 4 — Coverage/hygiene)

- `tests/v3/state/test-scope-guard.mjs` — D3 SCOPE GUARD test (26 cases).
- `hooks/prism-panel-guard.mjs` — `rationale.alternatives_considered[]` shape validation in panel.json (G2). Additive; absent field still passes.

### Changed

- SCOPE GUARD is **advisory by default** (emits stderr, exits 0). Set `PRISM_SCOPE_GUARD=strict` to restore the original block-on-violation behavior. The keyword-overlap heuristic is intentionally loose; advisory mode keeps it useful as a signal without blocking real Phase 0d panels.
- `hooks/prism-panel-guard.mjs` is now registered under `PostToolUse[Write]` in both `.claude-plugin/plugin.json` and `settings.fragment.json` (in addition to `SubagentStop` from v3.2). Path B was dead code in v4.4; fix landed during Phase 4 review.
- `hooks/prism-session-start.mjs` output format changed from plain-text to JSON `{hookSpecificOutput:{additionalContext:...}}` per Claude Code's Context-only hook contract (D005).

### Schema

- `roster.json` schema 4.4.0 → 4.5.0 (additive: `phase_1_5_lite_oob`, `skip_next_oob`).
- `.prism-routing.jsonl` schema 2 → 3 (additive event types: `phase_0d_challenge`, `dispatch_cap`).
- `panel.json` schema additive: `dropped_positions[]`, `rationale.alternatives_considered[]`.

### Fixed

- Installer manifest now ships all 5 v4.5 files (`hooks/prism-phase-0d-oob.mjs`, `hooks/prism-phase-0d-challenges.mjs`, `hooks/prism-dispatch-cap.mjs`, `tools/lib/prism-roster-lock.mjs`, `agents/phase-0d-oob-reviewer.md`). Without this, the installer would have silently shipped v4.4 only.
- `settings.fragment.json` Phase 0d hook entries rewritten from `node $CLAUDE_PROJECT_DIR/...` to the standard `bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/...` form so `isPrismHookCommand()` recognizes them and `mergeSettings()` wires them on install.
- Installer `--target`-aware error recovery on malformed `roster.json`: previously crashed with `HOME is not defined` ReferenceError; now emits actionable instructions with the correct `--target` (or `--home`) invocation.
- Installer `update` no longer creates two backup dirs per invocation (was: explicit `makeBackup()` + `install()`'s internal backup; now: only `install()`'s).

### Deferred to v4.6

All telemetry-driven calibration decisions (B1 cap retune, master-overrides confirmation gate, auto-clear pending_upgrade); structured-output classifiers (C1, C2, C3); heavier coverage/hygiene (D1, E1, E2, G1); cosmetic installer polish (I3, I8); SCOPE GUARD heuristic upgrade beyond keyword overlap; refactor of `tools/lib/prism-verdict-flag.mjs` to support both phase-0d and phase-1-5 verdicts via a `kind` parameter (currently the phase-0d hook inlines its own `atomicWrite`).

#### Known v4.5 telemetry-shape limitations (carried into v4.6 calibration design)

- `dispatch_cap` events emit `{event, cap, subagent_type, description}` — the spec also listed `actual_parallel` and `queue_depth`, but Claude Code's `PostToolUse[Agent]` event doesn't expose sibling-dispatch state, so those fields are absent. v4.6 calibration must either compute them from on-disk task-dir state or accept the narrower signal.
- `phase_0d_challenge` events emit `evidence_class: 'UNCLASSIFIED'` for every challenge because Layer 4's panel-guard does not pre-classify the `panel.positions[].challenges[]` entries. v4.6 will need to derive evidence-class downstream from challenge text, or extend panel-guard to compute and write the field at panel-write time.
- Roster lock (`withRosterLock`) wraps the 3 primary mutation sites but NOT `prism-agent-write-register.mjs`, `prism-uninstall-cleanup.mjs`, or `prism-installer.mjs`. Concurrent writes from those sites against the locked sites can lose updates under contention.

## [4.4.0] - 2026-05-26

Three composing layers: master-orchestrator skill refactor, out-of-band PHASE 1.5 reviewer, telemetry + lite-1.5. Closes 14 of 32 evaluation-flow gaps from the v4.4 brainstorm. Backward-compatible: legacy agents (no `requires_phase_1_5` tag) run unchanged.

Migration guide: `docs/prism/MIGRATION.md` §"v4.3 → v4.4".

### Layer A — master-orchestrator skill refactor

- Split 770-line `skills/master-orchestrator/SKILL.md` into a ~130-line navigation index + 10 focused references under `skills/master-orchestrator/references/`.
- New references: `phase-0a-inventory.md`, `phase-0-team-assembly.md`, `phase-0d-adversarial.md`, `phase-1-execution.md`, `phase-1-5-senior-review.md`, `phase-2-completion.md`, `evidence-taxonomy.md`, `adversarial-review.md`, `dispatch-shapes.md`, `model-ratchet.md`.
- Closes E3 (compaction risk) and G3 (REJECTED-vs-REJECT token-namespace disambiguation explicit in references).

### Layer B — Out-of-band PHASE 1.5 reviewer

- New hook `hooks/prism-phase-1-5-oob.mjs` (SubagentStop matcher): when the just-stopped subagent's roster entry has `requires_phase_1_5: true`, the hook invokes an independent reviewer via `claude -p` (Claude Code subscription auth — no separate API key required).
- New verdict-flag lib at `tools/lib/prism-verdict-flag.mjs` (per-SHA pending/result files + append-only verdict log).
- New reviewer system prompt at `agents/phase-1-5-oob-reviewer.md`.
- New verdict-log reader CLI at `tools/prism-phase-1-5-verdicts.mjs`.
- Roster schema additions: per-agent `requires_phase_1_5` and `requires_phase_1_5_block` flags (default false). Schema_version bumped to 4.4.0.
- SessionStart hook extended to pick up completed verdicts and surface UN-CITED/REJECTED items as `[Prior turn]` notices (all-EVIDENCED is silent).
- `agents/claude-master.md` PRISM-composition section refreshed for v4.3+v4.4 reality (closes G4).
- Closes A2 (master judges own subagents), A4 + F1 (0d→1.5 challenge cross-link), B5 (verdict log persisted), D2-lite (FULL-ROUTINE LITE coverage), G4 (claude-master stale composition).

### Layer C — Telemetry + lite-1.5

- `tools/prism-telemetry-aggregate.mjs` adds `--phase-1-5-agreement` subcommand for reviewer↔master agreement signal.
- `tools/prism-roster.mjs` is a new CLI with `--apply-ratchet` (evidence-discipline ratchet from verdict log, threshold ≥ 30% UN-CITED rate over last 10 dispatches → `pending_upgrade: true`), `--reset-model`, `--tag-1-5`, `--untag-1-5`.
- `/prism-clean` automatically runs `--apply-ratchet` at end-of-session hygiene.
- LITE PHASE 1.5 variant for FULL-ROUTINE tasks (documented in `references/phase-1-5-senior-review.md`); evidence-only verdict on load-bearing claims, 3-line Senior Review section.
- Routing log entries now carry a `phase_1_5: null` placeholder field (extended by the OOB hook).
- Closes A6 (bounce-2 measurement), B2/B4/B6/B7 (telemetry surfaces), F3 (atomic roster updates safe under parallel sessions).

### Kill switches

- `PRISM_DISABLE_OOB_REVIEW=1` env var disables the hook per-session.
- Setting `requires_phase_1_5: false` on a roster entry disables OOB per-agent.
- Removing the hook registration from `settings.fragment.json` disables system-wide.

### Deferred to v4.5 / v5.0

18 gaps identified in the brainstorm not closed in v4.4 — see `docs/prism/plans/2026-05-26-v4.4-phase-1-5-oob-reviewer-design.md` §"What's NOT in v4.4" for the full list. Highlights:
- A1: panel-side OOB reviewer (v4.5)
- A5: verdict regression scanner (v5.0)
- Family C: structured-output / SARIF (v4.5+v5.0)
- D3: SCOPE GUARD enforcement (v4.5)
- F4: semantic cross-project knowledge index (v5.0)

### Installer (NEW)

- `tools/prism-installer.mjs` — Node 18+ core installer (~430 LOC) with four subcommands:
  - `detect` — print JSON of current install state (no changes, exit 0 always). Detects file presence, hook registrations in `settings.json`, roster schema version.
  - `install [--dry-run] [--no-backup] [--quiet] [--home <path>] [--src <path>]` — full install/upgrade. Idempotent. Steps: detect → backup → strip old PRISM hooks → remove old PRISM files (by name pattern) → copy new files → merge roster (preserve user agents) → JSON-aware `settings.json` merge (no duplicates, preserves non-PRISM hooks) → chmod+x on Unix → post-install verify → summary. (`--home` / `--src` are dev/test flags that override the HOME directory and source repo root respectively.)
  - `uninstall [--restore-backup <path>] [--quiet]` — removes all PRISM files and strips PRISM hooks from `settings.json`. State files (`.prism-routing.jsonl`, `.prism-spend.jsonl`, `prism-policy.json`, etc.) are always preserved. To fully clean, manually delete `~/.claude/.prism-*` files after uninstall.
  - `verify` — checks every manifest file exists, `settings.json` parses and contains PRISM hooks, `roster.json` parses. Exit 0 if all pass, 1 if any fail.
- `tools/install-manifest.json` — data-driven file manifest (85 individual files + 4 skill directories). Add new files here for future versions; installer reads the manifest at runtime.
- `install.sh` / `uninstall.sh` — Bash 4+ wrappers (Mac/Linux/git-bash) with Node-18 check and banner.
- `install.ps1` / `uninstall.ps1` — PowerShell 5.1+ wrappers (Windows) with Node-18 check and banner. `-DryRun`, `-NoBackup`, `-RestoreBackup`, `-Home` parameters.
- Hardening: lock file (`~/.claude/.prism-install.lock`) prevents concurrent runs; atomic tempfile+rename writes; fail-loud on malformed `settings.json` (exit 2) instead of silently overwriting; read-only file handling on Windows (chmod before unlink).
- `settings.fragment.json` is also copied to `~/.claude/` for audit purposes (it lists every hook entry the installer merged; not read at runtime).
- `README.md` updated with a top-level **Installation** section (clone → install script → verify; Windows + Mac/Linux invocations; upgrade and uninstall instructions).
- `docs/prism/MIGRATION.md` v4.3 → v4.4 section rewritten around the installer.

### Tests

New suite `tests/v3/state/test-prism-model-ratchet-behavior.mjs` — 5 cases (ratchet fires at 40% UN-CITED rate, does not fire at 0% rate, does not fire below MIN_DISPATCHES, idempotent on already-flagged agents, exit 0). New Test 6 added to `test-prism-phase-1-5-oob.mjs`: recursion guard (PRISM_OOB_REVIEWER_PROCESS=1 exits 0 + logs action without writing pending file). New suite `tests/v3/state/test-prism-installer.mjs` — 41 cases covering detect/install/uninstall/verify/idempotency/dry-run/preservation. Full suite: 306/306 across 18 files (17 state + 1 hooks).

## [4.3.0] - 2026-05-26

The **plugin-vs-manual provenance** release. Enables safe pre-uninstall hygiene for PRISM-as-plugin installs without risking manually-created agents.

Migration guide: `docs/prism/MIGRATION.md` §"v4.2.0 → v4.3.0".

### Added
- **`/prism-uninstall-cleanup` slash command** (`commands/prism-uninstall-cleanup.md`) + worker tool (`tools/prism-uninstall-cleanup.mjs`, ~135 LOC). Removes agents created while PRISM was installed as a plugin — agent directory, flat `.md` file, and roster entry — in one atomic pass. Lists by default; destructive only when explicitly invoked with `--mode=remove-all`.
- **`installed_via` field on roster entries** (`"plugin"` | `"manual"`). Set by the agent-factory based on whether `$CLAUDE_PLUGIN_ROOT` is in the environment when the factory runs. Project-local master-`<slug>` agents are excluded (they were never global).

### Changed
- `agents/agent-factory.md` — CREATE PROTOCOL step 4 and `--from-notebook` mode step 5 now teach the factory to set `installed_via` on every new roster entry. Master-`<slug>` mode carries an explicit exception note.
- `skills/master-orchestrator/SKILL.md` STARTUP block — notes that `installed_via` is informational only (dispatch ignores it).

### Migration
- Legacy roster entries (missing `installed_via`) treated as `"manual"` — never removable by the new command. No migration step needed; existing agents are safe.
- See `docs/prism/MIGRATION.md` §"v4.2.0 → v4.3.0" for the full upgrade path including non-interactive flags.

### Tests
- New suite `tests/v3/state/test-prism-uninstall-cleanup.mjs` — 6 cases (backfill safety, plugin-only filter, zero-state idempotency, removal correctness, atomic-write exit state, env-detection smoke with graceful skip when bash unavailable). Full suite: 224 / 224 across 13 files.

## [4.2.0] - 2026-05-26

The **packaging + privacy hardening** release. No new behavior — closes
the 6 packaging gaps surfaced by the post-v4.1 audit at
`docs/prism/lessons/2026-05-26-packaging-fix-handoff.md`.

Migration guide: `docs/prism/MIGRATION.md` §"v4.1.0 → v4.2.0".

### Added
- **Phase 0 — plugin.json sync + drift-guard test.**
  - `.claude-plugin/plugin.json` bumped 3.8.9 → 4.2.0 with full hooks block
    matching `settings.fragment.json` — adds `SessionEnd[matcher=clear]`,
    `SessionEnd` catch-all, `PreToolUse[Bash]` prepush-review,
    `PostToolUse` agent-write-register, swaps stale `PreCompact`
    session-start for precompact-nudge-flag. Marketplace install path now
    delivers v4.0 + v4.1 features to clean installs.
  - `tests/v3/state/test-plugin-manifest-drift.mjs` — 3-assertion
    drift-guard: version matches CHANGELOG top entry, hook event keys
    match, (matcher | handler-basename) multisets match. Skips
    gracefully if either truth-source is missing.
- **Phase A — packaging polish + telemetry privacy hardening.**
  - `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1` env vars honored across
    `tools/prism-telemetry-aggregate.mjs` (exit 13 silently when set) and
    `tools/prism-bootstrap.mjs` `set-telemetry-consent` (force opt_in:false
    regardless of CLI arg) + `detect-telemetry-consent` (returns
    `forced_off_by_env: <VAR>`). Industry-standard signal honored
    authoritatively; file state preserved for inspection.
  - `.claude-plugin/plugin.json` discoverability keys: `category`,
    `documentation`, `example_prompts`.

### Changed
- **Telemetry default flipped from prompt-recommended-on to off-by-default**
  in `commands/prism-bootstrap.md` Step 7b. AskUserQuestion now offers
  "Keep telemetry off (default)" as the first / recommended option.
  Existing opt-in consent is preserved on upgrade — only the first-install
  default for new machines flipped. `README.md` table entry retitled
  "Telemetry opt-in prompt (v4.1)" (was "Telemetry auto-opt-in").

## [4.1.0] - 2026-05-26

The **observability + hygiene** release. Layered on top of v4.0's
project-master surface, v4.1 closes 11 audit questions surfaced in the
post-v4.0 governance review by adding a git-hygiene hook bundle, a
once-per-24h SessionStart freshness sweep, and the telemetry opt-in
loop with a deterministic aggregator that the `prism-updater` agent
consumes for guard-tuning candidates.

Roadmap: `docs/prism/lessons/2026-05-26-v4.1-roadmap.md`.
Adjudication: `docs/prism/adjudications/D007-agent-creator-vs-factory.md`.
Migration guide: `docs/prism/MIGRATION.md` §"v4.0.0 → v4.1.0".

### Added
- **Phase 0 — D007 lock** (commit `f038031`).
  - `docs/prism/adjudications/D007-agent-creator-vs-factory.md` locks
    the agent-creation surface architecture: status quo, no
    `agent-creator` skill ships in v4.1. Master-orchestrator owns the
    inline decision tree; factory remains the sole creation surface.
  - Cross-link added to `skills/master-orchestrator/SKILL.md` Team
    Assembly section pointing readers at the factory's own decision
    tree (D007 Lock item 2).
  - Audit's deferred `agents/agent-factory.md:31-33 git add -A`
    finding RESOLVED as stale — current code has no `git add`
    anywhere in agent-factory.md.
- **Phase A — git-hygiene hook bundle + D005 Phase F** (commit `8057342`).
  - `tools/lib/prism-flag-file.mjs` — shared per-project flag helper
    (SHA-256 keyed paths, atomic writes, readAndClear / listPending).
  - `hooks/prism-clean-nudge-flag.mjs` — SessionEnd[matcher=clear]
    side-effect writer (D005 Phase F bundle).
  - `hooks/prism-precompact-nudge-flag.mjs` — PreCompact side-effect
    writer (D005 Phase F bundle).
  - `hooks/prism-git-clean-nudge.mjs` — SessionEnd catch-all that
    writes a flag if working tree dirty.
  - `hooks/prism-prepush-review.mjs` — PreToolUse[Bash] filter that
    returns `permissionDecision: "ask"` + nudge when `git push` is
    about to run. Optional hard-gate via per-branch `review-done`
    flag-file.
  - `hooks/prism-session-start.mjs` extended with flag-file pickup
    that emits the actual nudge text via additionalContext (the
    SessionStart event supports it; SessionEnd + PreCompact don't —
    D005's verified matrix).
  - Off-switches (4 independent env vars):
    `PRISM_DISABLE_CLEAR_NUDGE`, `PRISM_DISABLE_PRECOMPACT_NUDGE`,
    `PRISM_DISABLE_GIT_CLEAN_NUDGE`, `PRISM_DISABLE_PREPUSH_NUDGE`.
  - `tests/v3/state/test-prism-git-hygiene.mjs` — 23 tests.
- **Phase B — SessionStart freshness sweep** (commit `db60c85`).
  - `hooks/lib/prism-freshness-sweep.mjs` — once-per-24h throttled
    sweep that closes 6 audit questions in one pass: plugin drift
    (Q1), stale agents (Q5, ≥90d), update-log age (Q6a, >15d),
    CLAUDE.md mtime (Q6b, >60d), tools-registry rotations (Q11).
    Snapshot at `~/.claude/.prism-freshness-last.json` (atomic).
    Off-switch: `PRISM_DISABLE_FRESHNESS_SWEEP=1`.
  - `skills/prism-plan/references/roster.json` — schema bump to add
    derived `domain_groups` top-level block + `_schema_example_domain_group`.
    Closes Q9 (domain grouping).
  - `commands/prism-index.md` Step 5.5 — derives + writes
    `domain_groups` from agent.core_domains + skill.domains.
  - `commands/prism-roster.md` — new `--by-domain` view consuming
    `domain_groups` (read-only coverage table).
  - `README.md` + `commands/prism-help.md` — 3-line clarification on
    factory's global-write rule vs the `--master-<slug>` exception
    (closes Q7).
  - `tests/v3/state/test-prism-freshness-sweep.mjs` — 14 tests.
- **Phase C — telemetry auto-opt-in** (commit `2531e12`).
  - `tools/prism-bootstrap.mjs` — new `detect-telemetry-consent` +
    `set-telemetry-consent on|off` subcommands; `--no-telemetry`
    flag pre-declines without prompting. Both bypass the `.git/`
    guard.
  - `tools/prism-telemetry-aggregate.mjs` — deterministic rollup
    helper. Honours consent gate (exit 13 if no opt-in); reads
    `~/.claude/.prism-routing.jsonl`; writes
    `~/.claude/.prism-telemetry-rollup.json`. Surfaces tuning
    candidates (guards ≥25% of denies AND ≥3 denies).
  - `commands/prism-bootstrap.md` Phase 7 split into 7a (wiring) +
    7b (consent prompt) + 7c (complete). One-shot prompt; never
    re-asks.
  - `agents/prism-updater.md` step 3 extended with telemetry-
    informed gap analysis — reads rollup, surfaces tuning candidates
    in the migration plan, approval-gated like every other item.
  - `docs/prism/MIGRATION.md` — Phase C section with consent flow +
    helper subcommand table.
  - `tests/v3/state/test-prism-telemetry-consent.mjs` — 12 tests.

### Changed
- `skills/prism-plan/references/roster.json` — `schema_notes` extended
  with a v4.1 entry documenting `domain_groups` semantics; `agents` /
  `skills` / `tools` / `mcps` blocks unchanged.
- `commands/prism-help.md` — version line bumped to "v4.0 + v4.1
  (git-hygiene + freshness sweep + telemetry opt-in)"; new "Hooks"
  section enumerates v4.1 hooks with their off-switches.
- `docs/prism/MIGRATION.md` — D005-Phase-F row in the known-limitations
  table flipped to "shipped"; new "v4.0.0 → v4.1.0" section.

### Test baseline
- 95 tests across 6 suites green:
  - test-master-orchestrator-thin-wrapper: 3/3 (unchanged)
  - test-master-orchestrator-evidence-rules: 9/9 (unchanged)
  - test-prism-bootstrap: 34/34 (unchanged)
  - test-prism-git-hygiene: 23/23 (NEW)
  - test-prism-freshness-sweep: 14/14 (NEW)
  - test-prism-telemetry-consent: 12/12 (NEW)

### Known limitations carried into v4.1
- Cross-project telemetry rollup deferred to v4.2 — routing log writers
  don't carry a `project` field; adding one touches every guard hook
  (architectural change beyond Phase C scope).
- Pre-push hard-gate auto-writer (PostToolUse[Skill] on /code-review
  completion) deferred to v4.2 — Phase A ships the manual writer +
  the consumer side; the auto-write side is opt-in plumbing.

## [4.0.0] - 2026-05-26

The **project-master surface** release. Each project can now grow its own
`master-<slug>` agent with a project-local `MEMORY.md`; the master loads
the shared `master-orchestrator` skill (which carries the multi-step
orchestration protocol) and hires specialists from the global roster.

Locked design: `docs/prism/adjudications/D004-v4-product-vision.md`.
Migration guide: `docs/prism/MIGRATION.md`.

### Added
- **Phase D — `/prism-deep-dive`** (commits `37c6f34..1011af0`, `5a9a254..8d8e27c`).
  - `commands/prism-deep-dive.md` slash command — discovery + ≤5 clarifying
    questions + writes `<project>/.claude/agents/master-<slug>.md`,
    seeded `MEMORY.md`, and `settings.json` `agent: master-<slug>` field.
  - `tools/prism-deep-dive.mjs` helper with subcommands: `slug-derive`,
    `agent-write`, `memory-seed`, `settings-write`, `agent-diff`.
  - `agent-factory --master-<slug>` mode for project-local master generation.
  - State schema v2: `project_slug` field + `setProjectSlug` mutator.
  - `/prism-bootstrap phase-project-master` wired to `/prism-deep-dive`
    (opt-in only via `--with-deep-dive`).
- **Phase E — master-orchestrator skill migration** (commits `054986e..07952d5`).
  - `~/.claude/skills/master-orchestrator/SKILL.md` carries the orchestration
    protocol body (PHASE 0–9, adversarial review, Phase 1.5 senior review).
  - `~/.claude/agents/master-orchestrator.md` reduced to thin skill-loading
    wrapper.
  - CI drift-guard `tests/v3/state/test-master-orchestrator-thin-wrapper.mjs`
    asserts the wrapper stays minimal and the skill carries the body.
  - `@master-orchestrator` mentions and `master-<slug>` agents both load the
    skill correctly.
- **Phase H — knowledge evolution rhythms** (commits `14e1067..79d339b`).
  - `append-decision` + `append-lesson` subcommands of `prism-deep-dive`.
  - `/prism-clean` wired to call `append-decision` + `append-lesson` per
    classifier level (D-level → adjudication; lesson-level → MEMORY.md
    pointer with 25 KB cap enforcement).
  - `prism-deep-dive agent-diff` subcommand for `/prism-deep-dive --upgrade <slug>`
    diff-then-confirm flow.
- **Phase J — tightened PHASE 1.5 evidence rules** (commits `efbeac8..dfda420`).
  - `master-orchestrator` skill PHASE 1.5 gains three new subsections:
    *Evidence taxonomy* (6-row claim-class table), *Per-claim verdict*
    (`EVIDENCED / UN-CITED / REJECTED` with bounce-ONCE protocol +
    KNOWN-LIMITATION fallback + factory-upgrade trigger at ≥3 UN-CITED),
    and *Standard of evidence — delegation boilerplate*.
  - `### Visible output` gains mandatory bullet listing claims rejected
    as UN-CITED or REJECTED and their second-pass outcome.
  - Drift-guard `tests/v3/state/test-master-orchestrator-evidence-rules.mjs`
    pins uppercase verdict tokens case-sensitively (9 tests / 12 assertions).
- **Phase K — docs + release prep** (commits `8bfde8e..` this release).
  - `commands/prism-help.md` — curated v4.0 slash-command index by workflow.
  - `commands/prism-bootstrap.md` — rebuilt phase table for 7 phases; new
    Phase 3 (plugin-validate) section; renumbered + reordered for v2 schema.
  - `docs/prism/MIGRATION.md` — standalone v3.10 → v3.11 → v4.0 migration
    recipe with rollback section.
  - `README.md` refreshed to surface v4.0 capability matrix.
  - Statusline install fold into `/prism-bootstrap` (opt-in only, no auto-write).

### Changed
- **`/prism-bootstrap`** schema migrated from 5 phases (v1) to 7 phases (v2)
  during Phase B; v4.0 doc finally catches up via Phase K's prose sweep.
- **`master-orchestrator`** protocol body relocated from agent file to skill
  file. Behavior preserved across `@master-orchestrator` mention and the new
  `master-<slug>` project-agent dispatch path.
- **`MEMORY.md` 25 KB cap** is now hard-enforced on every write by
  `tools/prism-clean.mjs` (`append-decision` / `append-lesson`) and
  `tools/prism-deep-dive.mjs` (`memory-seed`) — Phase D / D004 §risk #2.

### Deferred
- **Phase F — SessionEnd[clear] + PreCompact nudge hooks** — deferred to v4.1
  per `docs/prism/adjudications/D005-phase-f-hook-api-incompatibility.md`.
  The hook API does not support the side-effect-only output combination D004 §6
  assumed. v4.1 will retry with the flag-file + SessionStart pickup pattern.

## [3.11.0] - 2026-05-25

The **foundation hardening** release. Three sub-phases (A, B, C) shipped
together per the D004 phase plan; gates v4.0.

Locked design: `docs/prism/adjudications/D001-bootstrap-unification.md`,
`D002-v3.10-hooks-drift-scope.md`, `D003-bootstrap-scaffold-scope.md`,
`D004-v4-product-vision.md`.

### Added
- **Phase A.1 — `/prism-sync`** (commits `5745062..72781f7`).
  - `tools/prism-sync.mjs` with `plan [--smart-drift]` and `complete [--meta '<json>']`
    subcommands. Conservative drift = always re-scan; `--smart-drift` is a
    stderr-warning stub until v3.12.0 (D002 §5).
  - `commands/prism-sync.md` slash command orchestrating the LLM-judged phases.
  - 11 tests: git guard, conservative pending list, identity refresh conditional
    on `CLAUDE.md` mtime, sync stamps, atomic crash safety, idempotency.
- **Phase A.2 — `/prism-clean`** (commits `699e2c0`, `665c239`).
  - `tools/prism-clean.mjs` with `next-d-number` (scans
    `docs/prism/adjudications/D###-*.md`) and `git-stats --since <iso>`
    (commits + diff shortstat) subcommands.
  - `commands/prism-clean.md` slash command — applies a 5-level importance
    classifier (D-level decision → adjudication; lesson-level → MEMORY.md
    pointer; below → drop), surfaces candidates as a checklist, and writes
    approved artifacts with locked headers.
- **Phase A.3 — agent-write auto-fire hook** (commits `7636f41`, `0415a7d`).
  - `hooks/agent-write-register.ps1` — registers a new global agent within
    100ms of `Write` to `~/.claude/agents/*.md`.
  - Hook wired into `install.ps1` / `install.sh` for both fresh installs and
    upgrades (D002 §4).
- **Phase B — Bootstrap 7-phase + schema v2 + sentinels** (commit `525d84e`).
  - State schema v2: 7 phases (`identity`, `structure`, `plugin-validate`,
    `discovery`, `roster`, `project-master`, `health`) with per-phase
    sentinels `{started_at, completed_at, status, artifact_hashes}`.
  - `tools/lib/prism-state.mjs` carries `PHASES` constant + `migrateV1ToV2`
    transparently on `readState`.
  - Crash-resume semantics: `in_progress` phase without `completed_at` is the
    first pending entry on next plan.
  - `phase-plugin-validate` stub helper (advances planner; full validator
    lives in `/prism-validate-plugins`).
  - `phase-project-master --with-deep-dive` helper — opt-in only;
    `/prism-bootstrap` never auto-prompts.
- **Phase C — `/prism-validate-plugins`** (commit `b8f02f5`).
  - `tools/prism-validate-plugins.mjs` — shells out to `claude plugin list --json`,
    reports broken hooks, missing manifests, skill-name conflicts, MCP reachability.
  - Report-only in v3.11.0; `--fix` deferred to v3.12.0 (D004 risk #5 —
    false-positive risk on legitimate plugins).
  - `commands/prism-validate-plugins.md` slash command.

### Changed
- **`/prism-bootstrap`** is now the canonical first-run entry point. The
  legacy commands `/prism-init`, `/prism-discover`, `/prism-roster --reconcile`,
  `/prism-health` remain callable but are hidden from `/prism-help` per
  D002 §3 line 30.

### Tests
- 107/107 tests pass at v3.11.0 ship across `tests/v3/state/test-*.mjs` +
  `tests/v3/hooks/test-*.mjs`.

## [3.8.9] - 2026-04-26
### Improved
- **install.ps1 / install.sh** auto-detect branch from script's own git repo when `-Branch` / `--branch` is not explicitly passed. Prevents the common "step 4 failed: install-merge.mjs missing" trap when the local clone is on a non-main branch but install defaults to main. Falls back to `main` if not running from a git repo. Logs branch source (explicit / auto-detected / default).

## [3.8.8] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 runtime failure on Windows PS 5.1 at init step: `$PSVersionTable.Platform` property doesn't exist in PS < 6, throws under StrictMode. Replaced with `$PSVersionTable.ContainsKey('Platform')` hashtable lookup which is safe in both PS 5.1 and PS 7+. Audited install.ps1 + uninstall.ps1 for similar PSVersionTable property accesses.

## [3.8.7] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 third PowerShell 5.1 parser bug: catch block at line 387-392 still tripped PS 5.1 even after $_ subexpression refactor. Hex-audit revealed no non-ASCII bytes, no BOM, no smart quotes, and pure CRLF line endings — the smoking gun was `$()` subexpression interpolation inside double-quoted strings throughout the file (lines 64, 68, 71, 74, 231, 243, 257, 350, 369, 370). PS 5.1's tokenizer misparses nested `$()` blocks inside `"..."` even when syntactically valid in PS7+. Refactored ALL `"...$(...)"` patterns to `('literal' + $var)` concatenation, which bypasses the PS 5.1 string-interp tokenizer entirely. Also normalized line endings to CRLF and stripped any non-ASCII chars in install.ps1 + uninstall.ps1. Added v3.12 static-test assertions: zero non-ASCII bytes, brace balance.

## [3.8.6] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 second PowerShell 5.1 parser bug uncovered by v3.8.5 fix: inline `$($_.Exception.Message)` subexpression in catch block tripped PS 5.1's parser ("Array index expression is missing or not valid" at line 390). Refactored all `$($_.X.Y)` subexpressions in strings to extract the value to a local variable first, then interpolate the variable. Same scrub applied to uninstall.ps1.

## [3.8.5] - 2026-04-26
### Fixed
- **CRITICAL** install.ps1 parser error on Windows PowerShell 5.1: replaced PS7-only null-coalescing `??` operator (line 371) with PS5.1-compatible `if ($null -ne ...) { ... } else { ... }` pattern. Scrubbed install.ps1 + uninstall.ps1 for any other PS7-only syntax (`?:` ternary, `?.` null-conditional, `&&`/`||` pipeline chains).

## [3.8.4] - 2026-04-25

CRITICAL data-loss hotfix: uninstaller now preserves
`references/roster.json` and `references/update-log.json`.

### Fixed

- v3.8.3 (and all earlier versions) wiped roster.json and update-log.json
  when removing the prism-plan skill directory. roster.json contains
  user-mutated state (agent registrations, `notebooklm_notebook_id`
  values, task counts, escalation history). For users with researched
  specialists via agent-factory, this would silently lose every
  NotebookLM notebook link on uninstall — making the cloud notebooks
  effectively orphaned.

### Changed

- `scripts/uninstall.ps1`: copies roster.json + update-log.json to
  `$env:TEMP\prism-uninstall-preserve-<ts>\` BEFORE the prism-plan
  skill directory deletion; restores them to
  `~/.claude/skills/prism-plan/references/` AFTER all PRISM removal.
  Cleanup of preserve temp at end of run.
- `scripts/uninstall.sh`: same logic in bash.
- Both scripts: final report now lists the preserved files explicitly.

### Migration

Users who already ran v3.8.3's `--purge` and lost roster.json: restore
from your `~/.claude/backups/pre-uninstall-<ts>/` backup directory.
The backup IS still made unconditionally; only the in-place roster
was wiped from `~/.claude/skills/prism-plan/references/`.

## [3.8.3] - 2026-04-25

Hotfix: full rewrite of uninstall.ps1 after v3.8.0/v3.8.1/v3.8.2
incremental scrubs failed. Three Linux-sandbox-based attempts to
patch the file couldn't reproduce the Windows PowerShell parser
error. Pivot: rewrite from scratch with strict-conservative idioms.

### Changed

- `scripts/uninstall.ps1` rewritten end-to-end (~250 lines vs 537
  before). Same external behavior — same flags (-Purge, -KeepMemory,
  -NoBackup, -ReinstallPath, -Help), same artifact list, same
  surgical settings.json edit. New internal style:
  - No top-level try/catch wrapping (uses explicit Test-Path guards
    and Remove-Item -ErrorAction SilentlyContinue)
  - No < / > characters anywhere in strings
  - No -> arrows in user-facing messages
  - No nested try blocks, no inline here-strings inside try
  - Functions defined before main flow
  - Single-quoted strings preferred; double-quotes only when interpolating
  - The settings.json edit script (Node.js) lives as a top-level
    here-string variable and is piped to `node -` outside any try
- Renamed -Reinstall to -ReinstallPath for clarity (no flag conflict
  in older PS versions). Backwards compat: positional still accepts.

### Mechanics

Manifest 3.8.2 → 3.8.3.

### Why three previous fixes failed

v3.8.0 shipped the original 537-line uninstall.ps1. v3.8.1 patched
one `<...>` marker. v3.8.2 patched 11 more (`<>`, `->`). All scrubs
PASSED structural balance checks in Linux sandbox but Windows still
reported the same `try {` / missing-`}` cascade. Without `pwsh` in
the sandbox to run AST parse, we were debugging blind. Rewrite is
the only deterministic path forward.

## [3.8.2] - 2026-04-25

Hotfix: comprehensive `uninstall.ps1` parser-error scrub.

### Fixed

- v3.8.1 patched only line 208's `<each.../>` marker. Windows users
  reported a follow-on `try {` / missing-`}` parser cascade. Root
  cause: additional `<...>` markers in `Write-*` strings throughout
  the file caused PowerShell's strict parser to derail mid-script.
  v3.8.2 ships a comprehensive scrub: every `<` and `>` inside
  double-quoted strings is now `[` / `]`. The angle brackets that
  remain (single-quoted strings, comments, code operators like `>=`)
  are confirmed safe.
- Same scrub applied defensively to `install.ps1`.

### Mechanics

Manifest 3.8.1 → 3.8.2. install-merge §4d auto-stamps update-log
on next run.

### Migration

`git pull && .\scripts\uninstall.ps1` should now parse cleanly.
Zero state changes.

## [3.8.1] - 2026-04-25

Hotfix: PowerShell parser error in uninstall.ps1.

### Fixed

- **`scripts/uninstall.ps1` line 208 (and any siblings)** — replaced
  `<text>` documentation markers in `Write-UninstallLog` strings with
  `[text]`. PowerShell's strict parser treated unquoted `<` as the
  reserved redirection operator, causing parse failure on Windows
  before the script could even run. Cascading "missing }" / "missing
  catch" errors were downstream parser confusion. Same fix applied
  defensively to `scripts/install.ps1` if any sibling occurrences
  existed.

### Mechanics

Manifest 3.8.0 → 3.8.1. install-merge §4d auto-stamps update-log
on next run for users who already pulled v3.8.0.

### Migration

Zero. Pull v3.8.1, re-run `.\scripts\uninstall.ps1` — it now parses
correctly. No state changes.

## [3.8.0] - 2026-04-25

Conversational-friction reduction. Eliminates the per-turn dispatch
ceremony that fires on short user follow-ups in interactive sessions
("ok", "yes", "go", "proceed" → haiku via keyword-floor → guard
denies every parent tool). Closes ~80% of the friction we hit during
v3.x release-engineering today.

### Added

- **Continuation detection** in `hooks/prism-prompt-tier-router.mjs`.
  Short messages (<8 words) OR explicit approval phrases ("ok",
  "yes", "go", "proceed", "ship", "approved", "continue", etc.) that
  follow an opus/sonnet sentinel <5min old now INHERIT the previous
  tier instead of re-classifying as haiku. New sentinel `source`
  value: `"continuation-inherit"`. Eliminates the dispatch-guard
  spam during interactive Q&A.

- **`PRISM_CONVERSATION_MODE` env var.** Set to `1` to make ALL
  turns inherit the previous tier when one exists (no length / age
  guards). Opt-in escape for development sessions where you want
  zero classifier overhead. Off by default. Project-scoped via
  `.claude/settings.local.json` env block.

- **Agent-model-guard exemption** for `model: opus` on non-haiku
  turns. When a dispatch explicitly specifies opus AND the sentinel
  is non-haiku, the guard now passes through silently (no nudge
  even in soft mode). Closes the cascade where parent dispatches
  opus subagents and gets advisory noise on every one.

### Mechanics

Manifest 3.7.0 → 3.8.0. plugin.json 3.7.0 → 3.8.0 (THIS time staged
and committed in the version-bump commit; v3.7.0 had a follow-up
chore commit for this oversight). install-merge §4d auto-stamps
update-log. Hook count unchanged at 16.

### Migration

Zero migration needed. Continuation-inherit is purely additive — if
the previous sentinel doesn't exist or is stale, normal classification
runs unchanged. `PRISM_CONVERSATION_MODE` is opt-in.

### Why this matters

In interactive Claude Code sessions where users send a long opus-tier
prompt followed by short approvals/follow-ups ("yes", "ship it",
"continue", "what about X"), the keyword-floor classifier scored
those short messages as haiku. The dispatch-guard then denied every
parent tool, forcing `!opus-force:` prefix or subagent ceremony on
each turn. v3.8.0 makes the classifier session-aware: a short
follow-up after an opus context inherits opus tier. Same discipline
on first-message-of-conversation; no friction on continuation.

Solves the friction we hit shipping v3.7.0 in this very session.

### Tests

`tests/v3/run-static.sh` Category v3.8 with 4 assertions
(T_v3.8.1–T_v3.8.4) verifying:
- prism-prompt-tier-router has continuation detection
- prism-agent-model-guard has explicit-opus exemption
- PRISM_CONVERSATION_MODE env var documented
- continuation-inherit source value used in tier router

## [3.7.0] - 2026-04-25

Closes the orphan-NotebookLM-notebook discovery gap. Pre-existing
notebooks (e.g., research-backed agents whose local agent.md was
deleted, or notebooks imported from another machine) are now
discoverable, surfaced in Phase 0a inventory, and wireable as new
agents in one command. Compose-first thesis fully extended to
cloud-stored research.

### Added

- **`agent-factory --from-notebook <notebook-id>`** — reverses the
  standard agent-factory flow. Instead of research → notebook → agent,
  this mode reads an existing NotebookLM notebook (sources, summary)
  and generates a matching `agent.md` + `roster.agents` entry with
  `notebooklm_notebook_id` linked to the EXISTING notebook (no new
  notebook spawned). Sets `source: "from-notebook"` to distinguish
  from `agent-factory`-created and `reconcile`-created entries.
  Default model: `sonnet` (conservative; user can upgrade).

- **`/prism-roster --reconcile-cloud`** — extends `--reconcile`. After
  local reconciliation, scans `notebooklm list` for notebooks NOT
  linked to any roster entry (orphans). For each orphan, prompts:
  [W]rap as new agent (dispatches `@agent-factory --from-notebook`),
  [D]elete the notebook (with double confirmation),
  [I]gnore (adds to skiplist `~/.claude/.prism-orphan-notebook-skiplist.json`),
  [S]kip (re-prompts next run). Cloud step is read-only by default;
  only deletes/wraps on per-orphan user confirmation. Backs up
  `roster.json` to `.bak` before any wrap.

- **Master-orchestrator Phase 0a — orphan-notebook surfacing.** New
  inventory sub-section lists NotebookLM notebooks present in cloud
  but not linked to any roster agent. If the user's request matches
  an orphan's likely domain, the orchestrator suggests wiring it via
  `@agent-factory --from-notebook` BEFORE assembling the panel.
  Closes the failure mode where research-backed knowledge sits
  orphaned in NotebookLM cloud while the panel falls back to
  hardcoded personas.

### How it solves the "nuclear-physicist" scenario

You have a NotebookLM notebook from 6 months ago with curated
nuclear-physics research, but no local agent.md and no roster entry.
- Pre-v3.7.0: invisible to PRISM. Panel falls back to generic persona.
- v3.7.0: Phase 0a flags the orphan notebook. User runs
  `/prism-roster --reconcile-cloud` (or accepts the inline suggestion),
  picks [W]rap. Agent-factory generates the agent.md from notebook
  contents, registers in roster with the notebook ID, takes ~30s.
  Next panel: the rostered nuclear-physicist agent is dispatched
  with full notebook backing.

### Mechanics

Manifest 3.6.0 → 3.7.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Manifest entries unchanged at 85.
No new files in the manifest (changes are doc/protocol updates to
existing agents/commands).

### Skiplist convention

`~/.claude/.prism-orphan-notebook-skiplist.json` schema:
```json
{
  "skipped_ids": ["notebook-id-1", "notebook-id-2"]
}
```
Local-only, not synced anywhere. Removing the file restores
all-orphan visibility on next `--reconcile-cloud` run.

### Closes audit findings

- Orphan-notebook discovery gap surfaced in v3.6.0 audit retrospective
- `agent-factory` was one-way (create only) — now bidirectional
- Phase 0a inventory was complete for linked notebooks but blind to
  orphan notebooks in the same cloud account

## [3.6.0] - 2026-04-25

Bundled release: pre-install audit fixes for v3.5.0 + comprehensive end-to-end audit suite. Closes the two CRITICAL findings from the v3.5.0 plugin-install pre-flight audit AND ships the multi-hour real-environment audit infrastructure.

### Fixed (v3.5.0 pre-install audit findings)

- **SessionStart bootstrap for plugin install** (`hooks/prism-session-start.mjs`). Detects `${CLAUDE_PLUGIN_ROOT}` env var. If present AND `~/.claude/skills/prism-plan/references/` is missing key reference files, copies them from the plugin payload. Files: `adversarial-review.md`, `model-matrix.md`, `prompt-templates.md`, `tools-registry.md`, `mcp-registry.md`. `roster.json` only created if absent. Idempotency flag `~/.claude/.prism-plugin-bootstrap-done-v3.6`. Manual installs skip. Closes CRITICAL #2 (10 hardcoded reference paths).
- **`/prism-index` Step 2 plugin-root tier** — new tier 0 scans `${CLAUDE_PLUGIN_ROOT}/skills/**/SKILL.md` tagged `source: "prism"` BEFORE legacy globs. Explicit dedup. Closes CRITICAL #1.
- **`/prism-health` and `/prism-doctor` layout detection** — both detect plugin-install vs manual-install and check correct paths. New doctor symptom #10: "PRISM bootstrap incomplete".
- **plugin.json hook commands quoted** for spaced Windows paths. All 17 commands changed from `node ${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs` to `node "${CLAUDE_PLUGIN_ROOT}/hooks/X.mjs"`.
- **CHANGELOG v3.5.0 migration recipe corrected** — was `uninstall.sh --purge` (would WIPE `roster.json` + every `notebooklm_notebook_id`); now `uninstall.sh` (no `--purge`) with explanatory note.

### Added — comprehensive audit suite

- **`tools/prism-audit-runner.mjs`** (~190 LOC) — synthetic runner. Spawns each scenario's target hook as subprocess, pipes `input_payload` via stdin, captures exit + stdout + stderr + duration. Modes: `--category`, `--output`, `--scenarios`, `--help`.
- **`tests/v3/audit-scenarios.json`** — declarative catalog of 30 scenarios across 10 categories (classifier 6, mutation-guard 3, parent-dispatch-guard 3, agent-model-guard 3, task-tier-advisor 1, safety 4, parallel-guard 1, panel-guard 1, skill-trigger-guard 2, lifecycle 5). Schema-versioned; extensible.
- **`tests/v3/run-audit.sh`** — bash wrapper. Throwaway HOME, calls runner, calls analyzer. Modes: `--category`, `--output`, `--keep-home`, `--help`. POSIX.
- **`tests/v3/analyze-audit.mjs`** — report generator. Reads runner JSONL + optional routing log. Produces markdown: coverage matrix, timing distribution (p50/p95/p99), trigger correlation, failures detail, anomalies, verdict.
- **`commands/prism-audit-full.md`** — new slash command orchestrating end-to-end audit: pre-flight, synthetic, optional real-session, analyzer, final report. Differentiated from `/prism-audit` (fast hygiene scan).
- **`tests/v3/audit-real-prompts.md`** — 40+ curated real-session prompts across 6 sections (classifier, guards, panels, parallel, skill triggers, lifecycle). Each declares expected behavior. Pasted into fresh Claude Code session for real-environment coverage.

### Changed

- Manifest 3.5.0 → 3.6.0. install-merge §4d auto-stamps update-log.
- Manifest entries: 84 → 85 (+1: `commands/prism-audit-full.md`).

### How to use

```
# Inside Claude Code:
/prism-audit-full

# Or shell:
bash tests/v3/run-audit.sh                       # all categories
bash tests/v3/run-audit.sh --category classifier # filtered

# Analyze a previous run:
node tests/v3/analyze-audit.mjs /tmp/prism-audit-run.jsonl ~/.claude/.prism-routing.jsonl > report.md
```

For real-session coverage: paste prompts from `tests/v3/audit-real-prompts.md` into a fresh Claude Code session, then run analyzer with `~/.claude/.prism-routing.jsonl` as second arg.

### Process notes

SA1 (audit fixes) shipped cleanly across 6 files. SA2 (audit-suite core) timed out twice on API stream-idle — parent wrote audit-scenarios.json + prism-audit-runner.mjs + run-audit.sh + audit-real-prompts.md directly under dispatched-bypass. SA3 (UX) shipped analyze-audit.mjs + prism-audit-full.md cleanly but timed out before audit-real-prompts.md (parent wrote that).

## [3.5.0] - 2026-04-25

Plugin-packaging release. PRISM now ships as a first-class Claude Code
plugin (`/plugin install prism@PRISM`). Closes G1 from the v3.4.0
cheat-sheet structural audit — eliminates the clone+install-merge
ceremony for end users while preserving the manual install path
unchanged for developers.

### Added

- **`.claude-plugin/plugin.json`** — Claude Code plugin manifest at
  repo root. Declares all 16 hooks across the 8 lifecycle events
  (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  SubagentStop, Stop, ConfigChange, PreCompact) using
  `${CLAUDE_PLUGIN_ROOT}` for plugin-relative paths. Skills, commands,
  and agents are auto-discovered from the standard `skills/`,
  `commands/`, `agents/` directories per plugin convention.

- **Plugin-install path** — primary install method documented in
  README:
  ```
  /plugin marketplace add vosser24/PRISM
  /plugin install prism@PRISM
  ```
  Hooks, skills, commands, agents register automatically. No
  `settings.fragment.json` merge needed for plugin users. No
  `prism-exec.sh`/`prism-exec.cmd` wrapper (plugin manifest invokes
  `node` directly).

- **Plugin uninstall path** — `/plugin uninstall prism@PRISM` is
  symmetric; Claude Code drops hooks/skills/commands/agents. Manual
  Tier 1 cleanup of transient state files (`.prism-turn-tier-*.json`)
  is documented because those live outside `${CLAUDE_PLUGIN_DATA}`
  for compatibility with the legacy install path.

### Documentation

- README.md — top-level Install section now leads with plugin install,
  manual clone+install.sh as labeled alternative.
- INSTALL.md — top callout pointing users to `/plugin install` first;
  manual procedure preserved as the legacy/developer path.
- UNINSTALL.md — top section showing `/plugin uninstall prism@PRISM`;
  manual uninstall.sh path preserved below.

### Tests

- `tests/v3/run-static.sh`: new Category v3.5 with assertions
  verifying `.claude-plugin/plugin.json` exists, parses cleanly, has
  required fields (name/version/description/hooks), version matches
  `manifest.json`, and declares all 16 hooks across 8 events.
- `scripts/verify.mjs` extended to check plugin manifest presence
  alongside the legacy file checks.

### Migration

Existing manual installs keep working unchanged. To migrate from
manual to plugin-install:

1. `bash scripts/uninstall.sh`               # preserves roster.json + notebook IDs (do NOT use --purge for migration)
2. Inside Claude Code: `/plugin install prism@PRISM`

> Note on step 1: the default `uninstall.sh` removes hooks, commands,
> agents, and skills from `~/.claude/` but PRESERVES
> `~/.claude/skills/prism-plan/references/roster.json` and any
> `notebooklm_notebook_id` values inside it. Passing `--purge` would
> wipe roster.json and the notebook IDs your agents have accumulated;
> the default uninstall path is the migration-safe option.

Plugin users no longer need `prism.env` (plugin runtime resolves node
automatically).

### Limitations (vs manual install)

- Plugin install does NOT scaffold `~/.claude/skills/prism-plan/references/roster.json`
  with team_id defaults. Run `/prism-roster --reconcile` after
  install to populate.
- Plugin install does NOT auto-write `~/.claude/prism.env` because
  plugin manifest invokes node via `${CLAUDE_PLUGIN_ROOT}` directly
  (no need). If you previously had `ANTHROPIC_API_KEY` in prism.env
  from pre-v3.2.0, that file is no longer read — see CHANGELOG
  v3.2.0 for context.
- Some legacy state files live outside `${CLAUDE_PLUGIN_DATA}` for
  cross-install-method compatibility. Plugin uninstall does not
  remove them; run Tier 1 cleanup manually if desired.

### Mechanics

Manifest 3.4.0 → 3.5.0. install-merge §4d auto-stamps update-log for
manual-install users. settings.fragment.json unchanged (still used
by the manual install path).

## [3.4.0] - 2026-04-25

Windows-native productization release. Ships PowerShell-native ports of
both lifecycle scripts so pure-PowerShell users no longer need Git Bash.
Closes the last cross-shell gap in PRISM's installation lifecycle.

### Added

- **`scripts/install.ps1`** (391 lines) — PowerShell-native installer
  mirroring `install.sh` step-for-step. Parameters: `-Prefix`, `-Branch`,
  `-DryRun`, `-NoBackup`, `-Help`. Walks Windows-specific node
  resolution chain (`Get-Command node` → nvm `$env:APPDATA\nvm\<latest>`
  → Volta `$env:LOCALAPPDATA\Volta\bin` → `${env:ProgramFiles}\nodejs`).
  Writes `~/.claude/prism.env` as **UTF-8 NO BOM** via
  `[System.IO.File]::WriteAllBytes` + `UTF8Encoding($false)` —
  preserves Windows backslashes and avoids the v2.7.2 BOM trap. Uses
  `Join-Path` for all path building, `Set-StrictMode -Version Latest`,
  per-step `try/catch` with `$CurrentStep` tracking. Compatible with
  PowerShell 5.1 (Windows default) and PowerShell 7+ (cross-platform).

- **`scripts/uninstall.ps1`** (537 lines) — PowerShell-native uninstaller
  mirroring `uninstall.sh`. Parameters: `-Purge`, `-KeepMemory`,
  `-NoBackup`, `-Reinstall <path>`, `-Help`. **DRY-RUN by default**
  (inverted vs install.ps1 — same safety stance as the .sh). Surgically
  removes 16 PRISM hooks + 14 commands + 8 skill directories
  (enumerated by name, never glob) + 3 core agents (by exact filename
  — never glob `agents/`) + tools + statusline + state files. Edits
  `~/.claude/settings.json` via inline node heredoc using single-quoted
  `@'...'@` to prevent PowerShell variable interpolation in the JS
  block. Idempotent.

### Documentation

- README + INSTALL.md + UNINSTALL.md updated to show both invocation
  options (PowerShell-native vs bash-via-Git-Bash). Pure-PowerShell
  users no longer need Git Bash for either install or uninstall.

### Tests

- `tests/v3/run-static.sh`: new Category v3.4 with 6 assertions
  verifying both `.ps1` files exist + balance check + parameter
  documentation.
- `tests/v3/run-claude.md`: new Category 23 with manual round-trip
  prompts for testing the PowerShell-native lifecycle on Windows.

### Mechanics

Manifest 3.3.0 → 3.4.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Manifest entries unchanged at 84
(both `.ps1` files are repo-level scripts like their `.sh`
counterparts, not copied to ~/.claude/).

Process note: SA1 (install.ps1 subagent) timed out twice on API
stream-idle, then was blocked by mutation-guard from inside its
subagent context (sentinel inherited haiku from short-prompt
classification). Recovered via parent-as-orchestrator execution
under user `!opus-force:` override. SA2 (uninstall.ps1) completed
cleanly at 537 lines on first attempt. Ships clean despite the
workflow friction.

## [3.3.0] - 2026-04-25

Productization release: ships the missing automated uninstaller. Closes
the symmetry gap with v3.1's `scripts/install.sh` — PRISM now has both
ends of the install lifecycle as one-command operations.

### Added

- **`scripts/uninstall.sh`** — POSIX one-command uninstaller mirroring
  install.sh shape. Modes:
  - default = **DRY-RUN** (safe; prints what would be deleted, mutates
    nothing). Inverted default vs install.sh because uninstall is
    destructive — `--purge` flag is REQUIRED to actually delete.
  - `--purge` — actually performs deletion
  - `--keep-memory` — preserve `.prism-sessions/` and `.prism-rollups/`
    (session memory + weekly rollups)
  - `--no-backup` — skip the pre-uninstall backup (NOT recommended)
  - `--reinstall <repo-path>` — chains uninstall → install in one run
  - `--help` — usage

  Surgically removes: 16 PRISM hooks + 14 PRISM commands + 8
  PRISM-owned skill directories (enumerated by name, never glob) + 3
  PRISM core agents (by exact filename — never glob `agents/`) + tools
  + statusline + state files. Edits `~/.claude/settings.json` to
  remove only PRISM hook entries (preserves user/plugin entries +
  MCP servers + permissions). Pre-uninstall backup at
  `~/.claude/backups/pre-uninstall-<ts>/` unless `--no-backup`.

- **`UNINSTALL.md`** at repo root — full documentation: tiered
  cleanup procedure (state-only → full uninstall → reinstall chain →
  recovery from accidental --purge). Flag reference, when-to-use-which
  decision table.

- **README + INSTALL.md updates** — both link to UNINSTALL.md and
  show the one-command default-DRY-RUN preview.

### Tests

- `tests/v3/run-static.sh`: new Category v3.3 section with 6
  assertions (uninstall.sh exists + executable, --help works,
  default mode is DRY-RUN preserves a marker file, --purge flag
  documented, --keep-memory flag documented, POSIX syntax check).
- `tests/v3/run-claude.md`: new Category 22 with 6 manual prompts
  for testing uninstall + reinstall round-trip on a throwaway HOME.

### Mechanics

Manifest 3.2.0 → 3.3.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. settings.fragment.json unchanged.
Manifest entries unchanged at 84 (uninstall.sh is a repo-level
script like install.sh, not copied to ~/.claude/).

### Migration

Zero migration needed. Additive release. Existing v3.2.0 installs
that pull + run install-merge get §4d auto-stamp 3.2.0 → 3.3.0.
The new uninstall.sh is available immediately from the repo —
no deployment to ~/.claude/ needed.

## [3.2.0] - 2026-04-25

Classifier architecture simplification. Per direct user feedback: PRISM
should not require a separate `ANTHROPIC_API_KEY` to function correctly.
The vast majority of users (Claude Code Pro/Max login) cannot expose
their auth to hook subprocesses, and the previous "API-classifier-as-
default with keyword-floor as fallback" framing was a productization
mistake. v3.2.0 makes keyword-floor the only classifier and adds a
conversation-model self-override mechanism for cases where the regex
heuristic gets it wrong.

### Removed (BREAKING for the small set of users who had API key configured)

- **`hooks/lib/prism-opus-classifier.mjs` API-call paths** — the Opus +
  Sonnet API attempts are gone. Function signature preserved (callers
  unchanged); only the source of the classification changes. `source`
  field can no longer be `"opus"` or `"sonnet-fallback"`; it's now one
  of `"keyword-floor"` / `"cache"` / `"allowlist"` / `"force-opus"` /
  `"conversation-model-override"` (new, see below).
- **`INSTALL.md §2.7` (ANTHROPIC_API_KEY setup)** — entire section
  deleted. No replacement needed; keyword-floor works without any
  external auth.
- **`prism-session-start.mjs` keyword-floor warning notice** — removed.
  Keyword-floor is the standard mode, not degraded.
- **`/prism-doctor` keyword-floor symptom** — removed from the symptom
  list. Doctor no longer flags users for not having an API key set.
- **`/prism-health` API-key environment check** — removed.
- All `ANTHROPIC_API_KEY` references throughout the docs (README, etc.).

### Added

- **Conversation-model self-override protocol** — `prism-prompt-tier-router.mjs`
  now emits, alongside the keyword-floor classification, a directive
  inviting the parent conversation model to override the classification
  when the regex heuristic gets it wrong. The override is a Write to
  `~/.claude/.prism-turn-tier-<session>.json` with `source:
  "conversation-model-override"`. Optional, opportunistic — Claude only
  overrides when it disagrees, otherwise keyword-floor stands. This
  uses the conversation model's full intelligence for classification
  without requiring any separate API call.

### Migration

Users who relied on the API classifier (set `ANTHROPIC_API_KEY` in
`prism.env`): your environment variable becomes inert. Remove it from
`prism.env` if you want a clean state, or leave it — nothing reads it
anymore. Keyword-floor classification is now the single classifier
path. Most users won't notice any change in behavior; classifications
on ambiguous prompts may differ slightly from what the API call would
have produced. The conversation-model self-override protocol kicks in
automatically the first time the parent model decides to correct the
classifier.

### Mechanics

Manifest 3.1.0 → 3.2.0. install-merge §4d auto-stamps update-log.
Hook count unchanged at 16. Settings.fragment.json unchanged (the
3 v3.1 hooks ship at the same trigger points). 84 manifest entries.

### Known gaps still open (target v3.3+)

- INSTALL-MERGE-001 — user-customized hooks clobbered on upgrade
- SCHEMA-VERSIONING-001 — readers don't validate `schema_version`
- CONFIG-GUARD-DRIFT-001 — config-guard warns but doesn't restore
- skill-trigger-guard hard mode (false-positive measurement first)
- macOS native testing

## [3.1.0] - 2026-04-25

Productization release. Closes the v3.0 documented gaps (T10.3, T13.4),
adds the first centralized policy mechanism, ships a one-command
installer + guided diagnostic command + opt-in local telemetry. Plus
two Tier 3 levers (team roster, central policy) shipped surgically.

### Added — enforcement hooks

- **`prism-parallel-guard.mjs`** — PreToolUse on `Agent`. Detects
  sequential dispatch of pgroup-tagged tasks within a single turn
  (60s window via `~/.claude/.prism-parallel-trace-<session>.json`)
  and emits advisory (soft, default) or denies (hard) with a message
  pointing at the parallel-dispatch contract. Closes T10.3 — the
  parallel-dispatch enforcement gap that v2.7.1 promised but only
  hint-emitted. Honors `!opus-force:` and three-path subagent bypass.
- **`prism-panel-guard.mjs`** — SubagentStop. Scans subagent output
  for persona-name patterns (`**Name**:` etc.) and cross-references
  against `roster.agents/skills/tools` plus a hardcoded fallback
  whitelist (Architect, Security, Performance, Cost, Skeptic, etc.).
  Names matching neither are flagged as unindexed personas. Closes
  DOCTRINE-DRIFT-001 (v2.8.2 audit finding) — the hallucinated-
  persona detection gap. Soft mode warns; hard mode denies +
  asks to re-assemble. Skips `sentinel.dispatched` bypass path
  (would always be true at SubagentStop) — documented inline.
- **`prism-skill-trigger-guard.mjs`** — UserPromptSubmit. Reads
  `skills/prism-plan/references/skill-triggers.md` (12 keyword→skill
  mappings as of v3.1.0) and emits an advisory when a user prompt
  matches a regex but the corresponding skill wasn't auto-invoked
  in the next 2 turns. Closes T13.4 (advisory). Hard mode coerced
  to soft in v3.1 — reserved for v3.2 once false-positive rate
  is measured. Honors `!opus-force:`.

### Added — productization

- **`scripts/install.sh`** — POSIX-compatible one-command installer.
  Modes: `--dry-run`, `--prefix <dir>`, `--branch <name>`,
  `--no-backup`, `--help`. Detects platform, walks 6-source node
  resolution chain (PATH → nvm → fnm → volta → asdf → homebrew),
  writes `~/.claude/prism.env` via single-quoted heredoc to preserve
  Windows backslashes, runs install-merge + verify, captures verify
  exit code for clean error reporting. ERR trap reports failing step.
  Idempotent.
- **`commands/prism-doctor.md`** — symptom-driven diagnostic + guided
  fix command. Scans 50 most-recent routing events, env state, roster
  integrity, settings.json wiring, hook syntax. 10+ symptom→fix
  mappings (keyword-floor mode, prism.env missing, empty
  resource-index, stale sentinels, hook syntax errors, stale roster,
  v2.9.1 BREAKING CONTRACT misconfig, etc.). READ-ONLY by default —
  every fix proposed gets a `[Y/n]` confirmation before any write.
- **`commands/prism-telemetry.md`** — opt-in local-only telemetry.
  Subcommands: `--opt-in`, `--opt-out`, `--status`, `--aggregate`,
  `--export <path>`. Aggregates `~/.claude/.prism-routing.jsonl` into
  `~/.claude/.prism-telemetry-rollup.json` with cost summary,
  classifier accuracy, guard fire rate, tier distribution. **NO
  NETWORK, NO SHIPPING, NO TELEMETRY-AS-A-SERVICE in v3.1.** Future
  SaaS will read same rollup format. Anonymizes session_ids on
  export; raw prompts never exported.
- **README.md landing page** — 30-second pitch (277 chars), three
  concrete use cases (cost discipline / parallel orchestration /
  specialist dispatch), one-line install, status table covering 15
  user journeys (works / half-works / known-gaps), architecture
  overview, docs links. Existing install/contributing/license content
  preserved under "Manual install".

### Added — Tier 3 surgical levers

- **Team roster (`team_id` field)** — optional per-agent field in
  `roster.json`. `null` = global/no team. String = arbitrary team
  identifier. `/prism-roster --team <id>` filters the display table.
  `--team -` shows team-less agents. **Visibility lever, not
  access-control** — any user with read access to `roster.json` sees
  every agent. Real RBAC requires layered auth outside PRISM scope.
- **`~/.claude/prism-policy.json` central policy file** — admin-owned
  config that hooks read BEFORE checking env vars. Schema covers all
  8 guard knobs (mutation, dispatch, model, tier_advisor, safety,
  parallel, panel, skill_trigger) plus telemetry opt-in and team
  defaults. Precedence: **policy file → env var → hook default**.
  User escape: set `PRISM_POLICY_OVERRIDE=1` to flip precedence so
  env wins. Ships as `prism-policy.example.json` template; users
  rename + drop `_` prefixes from active keys.

### Added — schema + telemetry

- **`roster.json` schema bumped to 3.1.0**. New `team_id` field in
  `_schema_example_agent`. New `schema_notes` entry documenting
  team_id semantics.
- **`skills/prism-plan/references/skill-triggers.md`** — 12 keyword
  regex → required-skill mappings consumed by skill-trigger-guard.
  Severity column reserved for v3.2 (currently all `nudge`).
- **`tests/v3/run-static.sh`** extended with v3.1 assertions:
  install.sh executable + dry-run + POSIX syntax; prism-doctor +
  prism-telemetry frontmatter; prism-policy.example.json valid;
  skill-triggers.md present; 3 new hooks parse + honor force_opus +
  three-path bypass; settings.fragment.json registers all 3; roster
  schema = 3.1.0 + team_id documented.
- **`tests/v3/run-claude.md`** extended: T10.3 + T13.4 flipped to
  expected-pass (gaps closed); 6 new categories (Cat 16
  panel-hallucination, Cat 17 doctor, Cat 18 telemetry, Cat 19
  central policy, Cat 20 team filter, Cat 21 installer dry-run +
  real install).
- **`tests/v3/analyze-log.mjs`** extended: 5 new event types tracked
  (`panel_hallucination_detected`, `skill_trigger_advisory`,
  `policy_loaded`, `parallel_guard_block`, `parallel_guard_advise`)
  with verdict heuristics for each.

### Fixed (closes audit findings + v3.0 documented gaps)

- T10.3 (parallel dispatch enforcement) — closed via
  `prism-parallel-guard.mjs`.
- T13.4 (skill-invocation enforcement) — closed via
  `prism-skill-trigger-guard.mjs` (advisory; hard mode v3.2).
- DOCTRINE-DRIFT-001 (panel adversarial review enforcement) —
  partially closed via `prism-panel-guard.mjs` (catches hallucinated
  personas; ≥2-challenge enforcement still doctrine-only).

### Migration

Zero migration. All v3.1 additions are additive. Existing v3.0
installs that `git pull && node scripts/install-merge.mjs` get the
3 new hooks registered, 2 new commands, 4 new reference files. §4d
auto-stamps update-log `3.0.0 → 3.1.0`. No env-var changes for
existing users; new `PRISM_POLICY_OVERRIDE` is opt-in.

### Known gaps still open (target v3.2)

- INSTALL-MERGE-001 — user-customized hooks clobbered on upgrade
  (checksum-based detection needed)
- SCHEMA-VERSIONING-001 — readers don't validate `schema_version`
- CONFIG-GUARD-DRIFT-001 — config-guard warns but doesn't restore
- Skill-trigger-guard hard mode (false-positive rate measurement)
- macOS native testing (sandbox-tested only)

## [3.0.0] - 2026-04-24

Testability release. First comprehensive user-journey test suite covering
every claim PRISM makes about what it does. Not a breaking-change release
despite the major-version bump — the version bump reflects the
accumulated architectural shift from v2.8 → v3.0 (unified resource-index,
T-shape orchestrator, three-path guard parity, fresh-install hardening,
adversarial-review doctrine, BREAKING CONTRACT on `PRISM_MODEL_GUARD=hard`
semantics in v2.9.1).

### Added

- **`tests/v3/`** — end-to-end user-journey test suite. Six artifacts:
  - `plan.md` — 15 categories × 62 tests, organized by the verdict
    framework (works / half-works / known-gap). Distinguishes automated
    from manual tests up front.
  - `run-static.sh` — automated bash runner for categories that don't
    need a live Claude Code session (install/upgrade, verify, roster
    schema, stale-state recovery, backup safety, hook syntax, JSON
    validity, manifest src integrity). 37 automated assertions. Runs
    in a throwaway HOME so the user's real `~/.claude/` is never
    touched. Local run: 37/37 pass on v3.0.0.
  - `run-claude.md` — Claude Code prompt pack for the 25 manual tests
    across classifier routing, guards, roster/reconcile, resource-index,
    blueprint-prompt, parallel dispatch, cost discipline, skills
    invocation, and Windows-specific checks. Every prompt has exact
    expected outcomes tied to sentinel fields or log events.
  - `analyze-log.mjs` — parses `~/.claude/.prism-routing.jsonl` and
    emits a structured markdown report: tier distribution, classifier
    sources, guard denies, subagent-context bypass events, force-opus
    usage, pgroup violations (for future v2.10 hook), classifier
    divergence, verdict heuristic. Supports `--since <ISO>` filter.
  - `report-template.md` — fill-in table-per-category report with
    auto-captured static-log + analyzer-output appendix.
  - `run-all.sh` — master orchestrator. Modes: interactive (static +
    manual prompt + analyzer + report), `--static-only`, `--ci`.
- **`.gitignore` coverage** for generated test artifacts
  (`tests/v3/v3-report-*.md`, `tests/v3/v3-*.log`).

### Unchanged / documented-gap carry-forward

These findings from the v2.8.2 fresh-eyes audit remain known gaps
targeting later releases. The test suite validates them as documented
failures (T10.3, T13.4), not regressions:

- **Parallel-dispatch enforcement** (target v3.1) — `prism-parallel-guard`
  hook that blocks sequential dispatch of same-pgroup tasks.
- **Hallucinated-persona detection** (target v3.1) — `prism-panel-guard`
  hook that cross-references panel output against `roster.json` skills
  + agents.
- **Skill-invocation trigger map** (target v3.1) — keyword → required-skill
  advisory.
- **User hook customization preservation** (target v3.2) — checksum-based
  detection, copy-to-`.new` on conflict.
- **Config-guard self-heal** (target v3.2) — restore PRISM section in
  global CLAUDE.md from backup.
- **Schema-version runtime checking** (target v3.2) — readers validate
  `roster.schema_version` before parsing new shapes.
- **ATLAS purge in fresh-install path** (target v3.2 cleanup) — move
  legacy migration out of `INSTALL.md §2.6`.

### Migration notes

No migration needed. Test suite is additive. Running `/prism-update` or
`git pull && node scripts/install-merge.mjs` bumps update-log
`2.9.1 → 3.0.0` via the §4d auto-stamp added in v2.8.1. Nothing else
changes. Users not running tests see identical runtime behavior to v2.9.1.

### Running the suite

```bash
# Automated only (~2 min)
bash tests/v3/run-static.sh

# Full (static + manual prompts + analyzer)
bash tests/v3/run-all.sh
```

Report target: 60/62 pass. 2 documented failures in categories 10 + 13
are EXPECTED and prove the v3.1 target gaps still exist. When those hooks
ship, the expected results for those tests flip to pass.

## [2.9.1] - 2026-04-24

Audit hardening patch. Two in-scope findings from the fresh-eyes audit
of v2.8.2 applied, plus a strict-mode migration notice. Executed via
proper PRISM protocol (blueprint-prompt → master-orchestrator
dispatch → parallel Group A execution) — the protocol discipline was
the point; the code fixes are small.

### ⚠ BREAKING CONTRACT — `PRISM_MODEL_GUARD=hard` semantics changed

**If you set `PRISM_MODEL_GUARD=hard` deliberately to deny any non-opus
dispatch without explicit model, you must switch to
`PRISM_MODEL_GUARD=strict` to preserve that behavior.**

v2.9.1 narrows `hard` mode to match `task-tier-advisor` semantics: deny
ONLY when sentinel tier is `opus` AND no explicit model. Sonnet and
Haiku dispatches drop to advisory nudges under `hard`. The old
deny-everything behavior is preserved under the new `strict` enum
value.

A one-time session-start notice surfaces this when
`PRISM_MODEL_GUARD=hard` is detected post-upgrade, gated by
`~/.claude/.prism-v2.9.1-migration-shown`.

### Fixed

- **TIER-DRIFT-001**: `prism-agent-model-guard.mjs` `hard` mode was
  over-enforcing — denying every non-opus dispatch without explicit
  model violated the "soft doctrine in skills, hard enforcement in
  hooks" principle by gating tier-routing decisions that belong in
  advisory territory. Split into three modes (soft / hard / strict)
  with hard now matching task-tier-advisor semantics. Unknown env
  values fall back to `soft` (safe default).

- **ATOMIC-WRITE-001**: `prism-memory-save-nudge.mjs` and
  `prism-session-start.mjs` were writing state files directly via
  `writeFileSync`, missing the tempfile+renameSync pattern that
  v2.8.0 shipped for other state writers. Now match the v2.8.0
  reference shape in `prism-parent-dispatch-guard.mjs:90-107`
  (tempfile + atomic rename with catch-fallback to direct write for
  the Windows-antivirus EBUSY edge case). Counter corruption from a
  crash mid-write no longer silently resets nudge cadence or context-
  audit state.

### Added

- **v2.9.1 migration notice** in `prism-session-start.mjs` — one-time
  emit when `PRISM_MODEL_GUARD=hard` is in env and the flag file
  `~/.claude/.prism-v2.9.1-migration-shown` is absent. Points users
  at the strict-mode contract change. Flag written atomically
  (tempfile+rename) after first emit.

### Known gaps (not addressed in v2.9.1 — tracked for future releases)

Six findings from the v2.8.2 audit remain open. Deferred deliberately
to keep v2.9.1 narrow and shippable; none block current workflows.

| ID | Severity | Target | Summary |
|---|---|---|---|
| INSTALL-MERGE-001 | HIGH | v2.10 | install-merge.mjs has no checksum-based detection of user-edited hooks → upgrades silently clobber user customizations |
| DOCTRINE-DRIFT-001 | MEDIUM | v2.10 | blueprint-prompt adversarial review (≥2 substantive challenges) is text-only doctrine — no hook enforces compliance |
| SCHEMA-VERSIONING-001 | MEDIUM | v3.0 | roster.json `schema_version` is written but no reader validates it before parsing — silent breakage when readers lag writers |
| CONFIG-GUARD-DRIFT-001 | LOW | v3.0 | `prism-config-guard.mjs` warns on CLAUDE.md PRISM-section removal but doesn't restore — damage already done by the time warning fires |
| DEAD-REFERENCE-001 | LOW | v3.0 | INSTALL.md §2.6 ATLAS purge runs on every install including fresh ones that have no ATLAS state — should be gated or relocated |
| DEPENDENCY-MANIFEST-001 | INFO | opportunistic | tools-registry.md has no `last_verified` date or schema version — no staleness detection |

## [2.9.0] - 2026-04-24

Unified resource-index release. Closes the structural gap that caused
orchestrators to hallucinate generic personas ("Rachel/Priya") instead
of dispatching to real installed skills (ui-ux-pro-max, frontend-design,
etc.). Plus one CRITICAL guard-parity fix surfaced by the fresh-eyes
audit run against v2.8.2.

### Added

- **`/prism-index` command** — scans every installed agent, skill,
  tool, and MCP and populates a unified resource-index. Covers resources
  that never flowed through agent-factory: user-installed skills,
  plugin-provided skills (from `~/.claude/plugins/*/skills/`), manually
  imported agents, configured MCP servers. Deterministic keyword
  extraction by default; optional `--enrich` flag uses Opus for higher-
  quality keywords/trigger-phrases (~$0.30 per full reindex).
  Idempotent, additive to the `agents` block (never clobbers
  agent-factory state). Backs up `roster.json` to `.bak` before write.
  Modes: `/prism-index`, `/prism-index --enrich`, `/prism-index --dry-run`,
  `/prism-index --skills-only`.

- **Unified resource-index schema in `roster.json` (schema v2.9.0).**
  The file that was previously an agent-only roster becomes PRISM's
  single source of truth for all callable resources. Four authoritative
  sibling blocks: `agents` (unchanged — task-tracking state), `skills`
  (new — discovery metadata), `tools` (new — Tier 1/2 install status),
  `mcps` (new — configured servers). Plus an `index_meta` block tracking
  `last_indexed` / `indexer_version` / `enrichment` level. Each block
  has a `_schema_example_<type>` entry documenting the fields.

- **Blueprint-prompt Phase 4 — resource-index-first assembly.**
  Hard-codes the mandatory query protocol: extract prompt keywords,
  score across all four index blocks, pick top-scoring indexed resource
  per domain, fall back to hardcoded personas ONLY when no resource
  scores above threshold, and explicitly label any fallback. Also:
  if the index is empty/missing, emit a loud "hallucination risk HIGH"
  notice at the top of the panel output. Closes the doctrine-vs-code
  gap where Phase 4 said "roster-first" but nothing enforced it.

- **Master-orchestrator Phase 0a — unified read.** Single read of
  `roster.json` replaces three separate reads (roster / tools-registry /
  mcp-registry). Emits index-staleness warning when
  `index_meta.last_indexed` is null or >14 days old.

### Fixed

- **CRITICAL: `prism-agent-model-guard.mjs` missing v2.7.5 three-path
  subagent-context bypass.** The v2.8.0 CHANGELOG claimed *"All guards
  now treat subagent context identically"* but agent-model-guard was
  never actually wired with the bypass. Result: on Claude Code builds
  that don't propagate `parent_tool_use_id` to subagent `Agent()`
  calls, a subagent-spawned Agent() without explicit `model` was
  treated as parent-context and hit the same gate as a parent Opus.
  v2.9.0 adds the three-path bypass (parent_tool_use_id /
  CLAUDE_CODE_ENTRYPOINT env / sentinel.dispatched) at the top of
  `main()`, matching mutation-guard, parent-dispatch-guard, and
  task-tier-advisor exactly. The false parity claim in v2.8.0
  CHANGELOG is now genuine.

## [2.8.2] - 2026-04-24

Security hygiene patch. `/prism-audit` run against v2.8.1 install
surfaced a `CRITICAL` + `HIGH` finding both rooted in the same gap:
the PRISM repo shipped with no `.gitignore`. Any fresh clone that
dropped a `.env`, local Claude Code overlay, or secret file would
track it immediately, risking accidental `git add .` commits.

### Fixed

- **Add `.gitignore` to PRISM repo root.** Covers:
  secrets (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials.json`, `*.pfx`); Claude Code local overlays
  (`CLAUDE.local.md`, `.claude/settings.local.json`,
  `.claude/.prism-state.json`, `.claude/references/`); dev cruft
  (`node_modules/`, `.DS_Store`, `Thumbs.db`); and stray
  `backups/` dirs if install-merge ever lands one in repo root
  due to a misconfigured HOME. Tracked-repo canonical files
  (`manifest.json`, `settings.fragment.json`, `tasks/todo.md`,
  `tasks/lessons-*.md`) intentionally NOT ignored — those are
  the shared project-state files PRISM teams commit.

## [2.8.1] - 2026-04-24

Fresh-install hardening release. Three fixes identified during the v2.8.0
install/upgrade walkthrough on a real user's machine where `/prism-health`
surfaced drift that existed in the repo itself (not just local state).
All additive, backward-compatible, no runtime behavior changes.

### Added

- **`skills/prism-chat/SKILL.md` now in manifest.** The definitive
  Claude.ai chat skill landed in v2.8.0 but was not wired into
  `manifest.json`, so `install-merge.mjs` never copied it to fresh
  installs and `verify.mjs` never validated it. Adding the entry fixes
  both — the skill now ships with every install and upgrade.
- **`install-merge.mjs` stamps manifest version into `update-log.json`
  (new §4d).** Previously the merger copied files and merged settings
  but never touched `~/.claude/skills/prism-plan/references/update-log.json`.
  This caused `/prism-health` to report "version lag" on every fresh
  install — the installed files matched v2.8.0 but the log still showed
  the skeleton's shipped version. Now, after a successful merge,
  install-merge reads `manifest.json` → compares to the log's
  `prism_version` → appends an `update_history` entry and bumps the
  field if they differ. Idempotent: re-running with no version change
  only refreshes `last_update_check`. Fresh installs (no log file yet)
  get a freshly-created log with an "Installed PRISM v<X> via
  install-merge" entry. Non-fatal on any error — metadata write, not
  load-bearing.
- **`/prism-roster --reconcile` — new flag for orphan-agent registration.**
  Scans `~/.claude/agents/` (both flat `<name>.md` and subdir
  `<name>/agent.md` layouts), finds agent files not present in
  `roster.json`, and adds minimal roster entries with defaults from
  each agent's frontmatter. Core PRISM agents (agent-factory,
  master-orchestrator, prism-updater) skipped. Existing entries never
  modified — reconcile is strictly additive. Closes the gap for agents
  created outside `agent-factory` (manual creation, imports from
  another PRISM install, legacy pre-v2.7 agents, factory mid-crash
  states). Creation date falls back through: git first-commit date →
  file mtime → current timestamp. Entries are marked `"source":
  "reconcile"` to distinguish from factory-created agents that have
  richer metadata (notebooklm_notebook_id, researched domains, etc.).
  Backup to `roster.json.bak` before any write.

### Fixed

- **Default-mode `/prism-roster` now surfaces orphans.** Previously the
  command displayed only what was in `roster.json`, so agents on disk
  but missing from the roster were silently invisible. The display
  table now ends with an "orphans detected" flag when `~/.claude/agents/`
  contains files not in `roster.json`, with a suggestion to run
  `/prism-roster --reconcile`. Closes the same detection gap that
  required running `/prism-health` to notice roster drift.

## [2.8.0] - 2026-04-23

Audit-driven hardening release. 13 fixes from the full repo audit,
bundled into one version bump after the v2.7.x hotfix cadence. No new
features; all hardening, correctness, and observability. Backward-
compatible — runtime behavior preserved for all legitimate inputs.

### Fixed

- **`scripts/verify.mjs` now checks every manifest entry.** Previously
  only 11 of 75 paths were hardcoded-verified. Silent install failures
  (e.g., `prism-opus-classifier.mjs` missing from disk) would pass
  verify and crash at first prompt. v2.8.0 reads `manifest.json` at
  verify time and checks all 75 `dest` paths exist. Hardcoded fallback
  preserved for the rare case the manifest can't be located.
- **`RELEASE_SAFETY_RE` no longer fires on bare `PRISM` or `2.x.x`
  tokens.** Previously every prompt mentioning "PRISM" by name or
  quoting a version triggered `release/meta-work` in the keyword
  floor → `summon_panel=true` → dispatch-guard panel demand. On
  users with API unreachable (classifier stuck in floor), this was
  nearly every prompt about using PRISM itself. Now requires
  release-like context: `release PRISM`, `deploy v2.8.0`,
  `upgrade PRISM to 2.8`, etc. Bare mentions like
  "configure PRISM for my project" no longer trip the screen.
- **`install-merge.mjs` stale-prune uses explicit legacy-hook whitelist.**
  Previously the pattern `prism-[A-Za-z0-9._-]+\.mjs` matched ANY
  `prism-*` raw-node hook including user-authored custom hooks. v2.8.0
  ships an explicit 26-name whitelist (13 known PRISM legacy hooks +
  13 ATLAS-era renames) so users with their own `prism-my-custom.mjs`
  raw-node entries are preserved intact across upgrades.
- **`INSTALL.md` §2.6 purge uses explicit path lists (no `atlas-*`
  catch-all glob).** The old glob matched `~/.claude/atlas-reference-archive/`
  — a user's legitimate archive directory — and deleted it on any
  upgrade that hit §2.6. v2.8.0 enumerates the 6 known atlas-era
  subdirectories by name and uses the glob only for per-session
  sentinels and counters where the suffix is a UUID (truly unambiguous).
- **`commands/prism-recall.md` now has `name: prism-recall` in YAML
  frontmatter.** All other commands declare `name:` explicitly; this
  was the one outlier. Claude Code may derive name from filename in
  some builds but the explicit declaration is required for consistency
  and for builds that require it.
- **Manifest `chmod +x` entries added for `prism-monitor.py`,
  `refresh-statusline-cache.sh`, and `subagent-summary.py`.**
  Previously these 3 shipped without execute bit; POSIX users saw
  "permission denied" on first invocation. `.sh` and `.py` entries
  that are import-only (not invoked as scripts) correctly remain
  non-executable — only the 3 genuinely script-invoked files get +x.
- **`prism-safety.mjs` fails open on parse error (exit 0, not 1).**
  Consistent with all other PRISM hooks. Previous behavior printed
  "Safety hook error: <msg>" to stderr on malformed PreToolUse
  payloads. Exit 2 (dangerous-pattern match) is preserved — that's
  the only intentional error path.
- **Task-tier-advisor now has the v2.7.5 three-path subagent bypass.**
  Parity with mutation-guard (v2.7.5) and parent-dispatch-guard
  (v2.2.1). Without this, `PRISM_TASK_TIER=hard` users on Claude Code
  builds that drop `parent_tool_use_id` could get subagent TaskCreate
  denied as parent-context. All guards now treat subagent context
  identically.

### Added

- **Atomic sentinel writes** in `prism-parent-dispatch-guard.mjs` and
  `prism-prompt-tier-router.mjs`. Tempfile + rename instead of direct
  writeFileSync. Prevents truncated JSON sentinels from crashes
  mid-write (disk full, antivirus interference, node process kill).
  Readers (all four guards, weekly rollup) never see a partial file.
  Direct-write fallback preserved for edge cases.
- **Session-start classifier-floor hint** in `prism-session-start.mjs`.
  Once per 24h, when `ANTHROPIC_API_KEY` is missing from hook env
  (detected via probe of env var + `~/.claude/prism.env`), emits a
  visible notice: *"Classifier is running in keyword-floor-only mode
  — see INSTALL.md §2.7 for setup"*. Users no longer have to tail
  `.prism-routing.jsonl` to discover they're in floor-only mode.
- **Classifier API error visibility.** Previously the Sonnet-fallback
  catch block swallowed errors silently. v2.8.0 collects `api_errors`
  on both Opus and Sonnet failures (with HTTP status + trimmed
  message) and attaches to the classifier result. Weekly rollup can
  now surface which API failure mode is dominant — 401 (bad key),
  429 (rate limit), 529 (overloaded), or network timeout.
- **INSTALL.md §2.7 — ANTHROPIC_API_KEY setup guide.** Detection
  ("am I in floor-only mode?"), setup recipes per OS (POSIX shell
  profile, POSIX dedicated env file, Windows `setx User`), security
  notes, and verification. Optional — no PRISM feature requires it,
  but presence improves classifier accuracy on ambiguous prompts.
- **INSTALL.md §2.8 — tuning env vars.** All 6 enforcement-mode env
  vars (`PRISM_PROMPT_ROUTER`, `PRISM_DISPATCH_GUARD`,
  `PRISM_MUTATION_GUARD`, `PRISM_MODEL_GUARD`, `PRISM_TASK_TIER`,
  `PRISM_MEMORY_NUDGE`) + 3 classifier-tuning vars
  (`PRISM_TIER_THRESHOLDS`, `PRISM_MEMORY_NUDGE_FIRST`,
  `PRISM_MEMORY_NUDGE_INTERVAL`) documented in one table.
  `!opus-force:` prefix semantics documented inline.

### Changed (doc-only)

- **`tools-registry.md` dangling `/prism-registry` reference** replaced
  with honest doc: "no dedicated registry command exists — edit the
  markdown directly and commit". The command never existed; text was
  aspirational from v1.1.0 planning. Clean now.
- **`roster.json` `schema_version` bumped from 2.7.0 → 2.8.0.** No
  schema changes; version sync with current PRISM version.

### Notes

- **Re-install flow for upgrade**: pull the branch, run `node
  scripts/install-merge.mjs` (v2.7.3 merger). File-copy step 3 picks
  up all hook/script/command changes. No settings migration needed.
- **No breaking runtime changes**. The `RELEASE_SAFETY_RE` tightening
  and stale-prune whitelist both err on the side of fewer actions
  (less panel-summoning, fewer prunes). Users with custom `prism-*.mjs`
  hooks now upgrade cleanly.
- **ANTHROPIC_API_KEY propagation via settings.fragment.json was
  explicitly out of scope**, per user direction. Users who want the
  Opus classifier active add the key manually per INSTALL.md §2.7.
  The session-start hint makes floor-only state visible so they can
  decide whether to configure it.
- **Tested clean-room install with mocked missing manifest entries**:
  `verify.mjs` correctly reports `FAILED: 73 checks did not pass`
  instead of the pre-2.8.0 false green.

## [2.7.5] - 2026-04-23

Second hotfix in the v2.7.4 cycle. Closes the final lockout path where
an installed PRISM + guards-on + Claude Code build that doesn't
propagate `parent_tool_use_id` to subagent tool calls → every
Agent()-dispatched `Edit`/`Write`/`Bash` denied as "parent context".

### Context — the real-world lockout

v2.7.4 fixed `!opus-force:` via `sentinel.force_opus`, but a user on a
Claude Code build that doesn't send `parent_tool_use_id` to subagent
tool calls discovered a deeper problem: **every documented
mutation-guard override was non-functional in that build**:

- `!opus-force:` prefix: pre-v2.7.4 only checked `input.user_prompt`
  (empty on PreToolUse in most builds). v2.7.4 added sentinel path.
- Subagent dispatch: `input.parent_tool_use_id` wasn't populated, so
  haiku-dispatched Edit/Write hit the same guard deny as parent calls.
- `PRISM_MUTATION_GUARD=off` in settings.local.json env: works, but
  the user couldn't edit the file — the mutation-guard was blocking
  writes to the very file that would turn it off. Bootstrap deadlock.

Only escape: manual edit of `.claude/settings.local.json` outside
Claude Code (Notepad etc.). That's a terrible UX for a "hotfix guard".

### Fixed

- **`prism-mutation-guard.mjs` now checks all 3 subagent bypass paths**
  the dispatch-guard has used since v2.2.1:
    1. `input.parent_tool_use_id` present (original v2.2.1 check)
    2. `CLAUDE_CODE_ENTRYPOINT` env var === `'subagent'`
    3. `sentinel.dispatched === true` (parent has already dispatched an
       Agent() this turn; subsequent tool calls — parent or subagent
       that lost its parent_tool_use_id — all pass)
  Parity restored with `prism-parent-dispatch-guard.mjs`. Both guards
  now treat subagent calls identically.

  Path 3 is the critical one for builds that drop `parent_tool_use_id`:
  once parent Opus has made ANY Agent() dispatch on the turn, the
  sentinel.dispatched flag flips (dispatch-guard does this), and
  thereafter both guards allow any work-tool call regardless of
  payload shape.

### Logged reasons (for `.prism-routing.jsonl` observability)

- `subagent-parent-tool-use-id-passthrough` — path 1 fired
- `subagent-claude-code-entrypoint-passthrough` — path 2 fired
- `subagent-sentinel-dispatched-passthrough` — path 3 fired

Weekly rollup (v2.7.0+) can now report which path is most common per
user. On builds with broken `parent_tool_use_id`, path 3 will dominate;
that's a signal the Claude Code build has the propagation bug.

### Notes

- **Bootstrap deadlock remains for users still on pre-2.7.5.** If
  `PRISM_MUTATION_GUARD=off` isn't already set in settings.local.json,
  the only way to add it is to edit the file manually outside Claude
  Code. Once done, `=off` turns the guard off system-wide for that
  project, and the user can subsequently install v2.7.5 normally and
  switch the guard back to `hard` (or remove the env override).
- **No INSTALL.md change.** Re-running `node scripts/install-merge.mjs`
  is a no-op; this is a hook-file-content update — §3 file-copy covers
  it on any re-install.
- **Backward-compatible.** Existing `PRISM_MUTATION_GUARD=off` overrides
  continue to work. Existing `!opus-force:` prefix from v2.7.4 works.
  All three paths are OR-combined with the existing checks — no
  regression possible.

## [2.7.4] - 2026-04-23

Hotfix: `!opus-force:` prefix now actually bypasses the mutation-guard.
Discovered during a real Phase 2 design-migration session — prefix gated
tier routing correctly but parent `Edit`/`Write`/`Bash` still got denied.

### Fixed

- **`prism-mutation-guard.mjs` now reads `sentinel.force_opus`** as
  authoritative. The v2.2.1 → v2.7.3 implementations checked
  `input.user_prompt` for the `!opus-force:` substring, but Claude Code
  PreToolUse payloads do not reliably include `user_prompt` — that's a
  `UserPromptSubmit`-scoped field. The guard was effectively blind to
  the override despite emitting "Override: prefix the user prompt with
  !opus-force:" in its deny message.

  The tier-router (`hooks/prism-prompt-tier-router.mjs` + classifier)
  correctly sets `sentinel.force_opus = true` when it sees the prefix
  on `UserPromptSubmit`. `parent-dispatch-guard.mjs` has read that
  sentinel since v2.5.0. `mutation-guard.mjs` now matches the pattern:
  reads sentinel at the same phase as the bootstrap-command check,
  passes through immediately when `force_opus === true`.

  The legacy `input.user_prompt` path is retained as defense-in-depth
  for any Claude Code version that does include `user_prompt` on
  PreToolUse — it runs after the sentinel check, logs
  `reason: 'opus-force-prompt'` vs `'opus-force-sentinel'` so the
  source is observable in `.prism-routing.jsonl`.

### Why this matters

On a guards-on session (`PRISM_MUTATION_GUARD=hard`,
`PRISM_DISPATCH_GUARD=hard`), users must either:
- Turn off guards entirely (`=off` in settings.local.json), OR
- Use `!opus-force:` prefix per prompt to bypass.

v2.7.0–v2.7.3 users who picked the prefix approach discovered the
prefix worked for the dispatch-guard (which stopped asking for
`@master-orchestrator` dispatch) but the mutation-guard still denied
their `Edit`/`Write`/`Bash` calls. The two guards were inconsistent.
Now both honor `sentinel.force_opus` identically.

### Notes

- **Backward-compatible.** Existing sessions keep working. If a user
  ran a turn without `!opus-force:`, sentinel.force_opus is false,
  guard behaves exactly as v2.7.3 did.
- **No runtime perf change.** One additional `readSentinel()` call per
  PreToolUse, which was already happening in `isBootstrapTurn()`
  anyway — now we just read the flag field alongside the rationale.
- **No config change needed.** Existing `PRISM_MUTATION_GUARD=off` in
  settings.local.json still works exactly the same.
- **No INSTALL.md change.** Re-running `node scripts/install-merge.mjs`
  is a no-op since the hook file content is the only thing that
  changed — file-copy step 3 covers it.

## [2.7.3] - 2026-04-23

Install-experience fixes from real-world v2.7.2 install friction. No
runtime changes. Moving the §4 merge logic into source-controlled code
eliminates the three Git-Bash-on-Windows escape traps that caused the
last installer to need three attempts.

### Added

- **`scripts/install-merge.mjs`** — consolidates INSTALL.md §4a
  (Windows rewrite), §4b (stale-entry prune), and §4c (deep-merge) into
  one idempotent script. Runs from the repo root: `node
  scripts/install-merge.mjs`. Uses `String.fromCharCode(92)` for
  literal backslashes internally, bypassing both Git Bash template-
  literal mangling and `JSON.stringify` double-escaping. Prints a
  parsable summary (`PRUNED_COUNT=N`, `MERGED_NEW_HOOK_ENTRIES=N`,
  etc.) that INSTALL.md §8 consumes.

### Changed

- **`INSTALL.md` §2.5** — the `printf 'PRISM_NODE=...\\n'` recipe
  caused Git Bash on Windows to interpret `\n`, `\P`, and other
  backslash sequences, mangling Windows paths like
  `C:\Program Files\nodejs\node.exe`. Replaced with a single-quoted
  heredoc (`cat > ~/.claude/prism.env <<'EOF' ... EOF`) that preserves
  backslashes verbatim. Explicit warning added against `printf` /
  `echo -e` for this file.
- **`INSTALL.md` §2.6** — purge block switched from `rm -rf` to
  `rm -r`. The safety-gate pattern `/rm\s+-rf\s/i` correctly blocks
  `rm -rf` as a dangerous shell pattern; our own install docs
  shouldn't trip it. `-f` is unnecessary since nothing in
  `~/.claude/` is write-protected.
- **`INSTALL.md` §4** — replaced inline `node -e "..."` merge
  instructions with a single `node scripts/install-merge.mjs`
  invocation. The inline approach had three escape traps that bit
  v2.7.2 installers:
    1. Template literals `\\` flattened by Git Bash before reaching node
    2. `JSON.stringify` double-escaped backslashes
    3. Two retries before `String.fromCharCode(92)` + plain concat landed
  §4a/§4b/§4c sections retained as reference documentation; the
  script is authoritative.

### Fixed

- **Stale test assertion `P5a.2` in `tools/test-prism-gaps.mjs`**
  updated to match v2.7.0 advisor behavior. Advisor moved from
  `PostToolUse` → `PreToolUse`, so `task_id` must now come from
  `tool_input.id` (not `tool_response.task_id`). Test payload
  updated; assertion unchanged semantically.
- **Stale test assertion `V220.11` in `tools/test-prism-gaps.mjs`**
  updated to match v2.7.0 `cacheKey` behavior. `dirty` parameter was
  removed from the cache key in v2.7.0 (noted in v2.7.0 changelog
  entry) to improve prompt-iteration hit rate. Assertion now
  expects `k1 === k3` (dirty-insensitive) instead of `k1 !== k3`.
  Test renamed to "cacheKey is deterministic, branch-sensitive,
  dirty-insensitive (v2.7.0+)".

### Notes

- **No runtime changes.** All hooks, guards, classifier, and
  orchestrator logic unchanged. Only INSTALL.md, tests, and a new
  repo-only script.
- **Backward-compatible install.** If for some reason a user runs
  an older INSTALL.md against a v2.7.3 repo, the old inline
  approach still works (with the Windows escape friction); the new
  script is strictly an improvement, not a requirement.
- **v2.7.2 install on the branch completed cleanly** despite the
  friction — specialists preserved, 14 stale entries pruned,
  prism.env correct, verify PASSED. v2.7.3 just prevents the
  three-retry-on-§4 experience for the next installer.

## [2.7.2] - 2026-04-23

Windows BOM trap closed. Fixes the compensation-pattern failure surfaced
during the migration: mutation-guard blocks parent-context `Edit/Write`,
Claude routes writes through Bash/PowerShell, PowerShell defaults to
UTF-8-with-BOM, files get corrupted. Prior sessions had to manually
strip BOMs before commit or set `PRISM_MUTATION_GUARD=off`. Neither is
a real fix. This release makes the guard aware of file-writing Bash
and tells the model to use Edit/Write tools instead.

### Added

- **Bash file-write patterns in `hooks/prism-mutation-guard.mjs`.**
  Matcher extended from `Edit|Write|MultiEdit` to `Edit|Write|MultiEdit|Bash`.
  When Bash is called from parent context, the guard inspects the
  command string against 15+ write-pattern regexes:
    - PowerShell writers: `Set-Content`, `Add-Content`, `Out-File`,
      `Export-Csv`, `Export-Clixml`, `Tee-Object -FilePath`,
      `[System.IO.File]::WriteAllText`, `ConvertTo-Json | Set-Content`
    - Shell redirect to file: `> foo.json`, `>> file.ts` with
      extension whitelist to avoid matching `> /dev/null` or `>&2`
    - `echo` / `printf` / `cat` redirects and heredocs
    - In-place editors: `sed -i`, `awk > file`, `perl -i`
    - Language one-liners: `python -c "open(...'w')"`, `node -e
      "...writeFileSync..."`, `ruby -e "File.write..."`
    - Downloaders with file output: `curl -o foo.json`, `wget -O foo.md`
    - Mutation commands into project paths: `cp`/`mv` into
      `src/`, `app/`, `lib/`, `.claude/`, etc.
    - `git restore`/`checkout` on code files
  Non-write Bash (`git status`, `ls`, `npm run`, etc.) passes cleanly.
  Subagent callers (via `parent_tool_use_id`) always pass. Bootstrap
  commands (`/prism-init`, `/prism-update`, `/prism-archive`) continue
  to pass via the existing allowlist.
- **BOM-safe acknowledgement.** When the Bash command includes
  `-Encoding UTF8NoBOM`, `-Encoding ASCII`, or
  `[System.Text.UTF8Encoding]::new($false)`, the guard's notice drops
  the BOM warning (the user knows what they're doing). Still blocks
  in hard mode on parent context — the mutation-guard is about
  orchestrator pattern, not just encoding — but message is shorter.
- **Windows BOM warning in deny/nudge messages.** When
  `process.platform === 'win32'` AND Bash-write is detected AND
  command is not BOM-safe, the guard's message enumerates the three
  safe alternatives:
    1. Prefer Edit/Write tools (no BOM).
    2. Append `-Encoding UTF8NoBOM` to Set-Content/Out-File.
    3. Use `[System.IO.File]::WriteAllText` with explicit
       non-BOM UTF-8 encoder.
- **Tier-router Windows note.** `hooks/prism-prompt-tier-router.mjs`
  now appends a Windows-specific note to every dispatch advice
  (haiku / sonnet / summon_panel turns): *"inside subagent prompts,
  instruct them to use Edit/Write/MultiEdit for file changes — NOT
  Bash/PowerShell. PowerShell's Set-Content, Out-File, and `>` redirect
  default to UTF-8 with BOM..."*  Early warning before the model even
  starts dispatching.

### Changed

- **`settings.fragment.json` mutation-guard matcher** updated to
  `Edit|Write|MultiEdit|Bash`. Bash calls now pass through the
  mutation-guard, which short-circuits to pass-through on
  non-write Bash.

### Fixed

- **PowerShell `Set-Content`/`Out-File`/`>` redirect bypassing the
  mutation-guard.** Previously parent Opus, blocked on `Edit`/`Write`,
  would "compensate" using Bash/PowerShell — which went through only
  the safety-gate (blocks `rm -rf` etc.) and the parent-dispatch-guard
  (tier enforcement), not the mutation-guard. The resulting
  UTF-8-with-BOM output corrupted JSON/YAML/TS files in subtle ways
  (git diff shows `﻿` prefix, some parsers fail). 2.7.2 catches these
  at the mutation-guard layer with the same orchestrator-pattern
  enforcement that applies to Edit/Write.

### Notes

- **Backward compatible runtime.** Existing PRISM_MUTATION_GUARD
  settings (`hard`/`soft`/`off`) apply to Bash the same way they
  apply to Edit. `off` remains a clean escape hatch.
- **Bootstrap-command allowlist preserved.** `/prism-init`,
  `/prism-update`, `/prism-archive` can still write project files
  via Bash (they legitimately need to — file creation during install
  often uses `mkdir`, `cp`, `>` redirect).
- **False-positive floor.** The write-pattern list is deliberately
  non-exhaustive — designed to catch the 90%+ common writes without
  flagging `git status`, `ls`, `node --version`, or test-running
  commands. If you find a false positive, set
  `PRISM_MUTATION_GUARD=soft` for the session (nudge only, no block)
  or `=off` (silent).
- **Migration unchanged.** No data migration. Re-running
  `INSTALL.md` copies the updated hook + fragment; existing
  `settings.json` gets re-merged via §4c (fragment's expanded
  matcher replaces the old Edit|Write|MultiEdit matcher cleanly).

## [2.7.1] - 2026-04-23

Parallel-dispatch enforcement. Three-file patch that closes the "PRISM
misses parallelism opportunities on non-NOVEL work" gap identified in
the scoring-mechanics review.

### Context

Current Claude Code runtime has ONE spawn tool, `Agent()`. Parallelism
comes from dispatching **multiple `Agent()` tool_use blocks in a SINGLE
assistant message** — Claude Code fans them out concurrently, wall-clock
cost = `max(each)` not `sum(each)`. Sequential `Agent()` calls are
strictly slower.

Prior PRISM docs referenced a separate `Task()` spawn tool that no
longer exists. That stale terminology hid the actual speed mechanism
from the model and caused the orchestrator to reason about parallelism
in a way that didn't match the runtime.

### Added

- **Parallel-opportunity detector in `hooks/prism-hook.mjs`.** Five
  new regex patterns fire an INVOCATION nudge when the user prompt
  carries enumerative, comparative, or explicit-parallel cues:
    - `parallel_enum`: "these 5 modules", "each of the 3 packages"
    - `parallel_multi`: "run tests across", "scan for X over every"
    - `parallel_compare`: "compare X vs Y", "A/B", "benchmark against"
    - `parallel_list`: "research Redis, Memcached, and Dragonfly"
    - `parallel_explicit`: "in parallel", "concurrently", "simultaneously"
  Nudge text: *"Parallelizable work detected. Dispatch as MULTIPLE
  Agent() tool uses in a SINGLE assistant message..."* — includes the
  recipe (N tool_use blocks, cheap-model-per-task rule). Cooldown 5
  turns. Doesn't fire if the existing `delegate` nudge already fired
  on the same prompt (avoids double-emit).

- **`[pgroup=N]` as an execution contract** in
  `skills/blueprint-prompt/SKILL.md` Phase 6. Previously *"labels
  tasks that can run concurrently"* (hint); now *"BINDING contract
  at execution time"* (must batch into one message). Plus worked
  example with the anti-pattern. Plus a `{event:'pgroup_violation'}`
  hook event described for future weekly-rollup surfacing.

### Changed

- **Master-orchestrator Phase 1 parallelism decision** rewritten.
  Stale "Method A: Task() Subagents" / "Method B: Agent Teams"
  dichotomy replaced with:
    - **PARALLEL**: multiple `Agent()` tool_use blocks in ONE
      assistant message. Cap 4 per batch (coordination cost).
    - **SPLIT-AND-MERGE**: same pattern, different data subsets.
    - **AGENT TEAMS** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):
      for teammates that must message each other mid-execution.
  Explicit anti-pattern call-out: emitting one `Agent()` per
  successive assistant message when batch is possible is strictly
  slower AND pays a fresh prompt-cache miss per spawn.

### Notes

- Backward-compatible — no hook or manifest changes. Purely docs +
  one new regex block in `prism-hook.mjs`.
- No classifier or sentinel changes. The new nudge fires independently
  of the tier router; useful on ROUTINE and NOVEL tiers alike where
  blueprint/orchestrator aren't engaged.
- Terminology correction: **"subagent" and "agent" refer to the same
  runtime primitive** (a child spawned via `Agent()`). There is no
  speed difference between them — the speed variable is
  *sequential vs parallel dispatch*, not tool choice.

## [2.7.0] - 2026-04-23

Classifier reconciliation + orchestration quality. Seven concrete fixes
to scoring mechanics, plus the blueprint ↔ workflow ↔ master-orchestrator
scope cleanup.

### Fixed — scoring mechanics

- **Keyword floor now derives `summon_panel`.**
  `tools/lib/prism-tier-classify.mjs` adds PANEL_SIGNALS + ≥3
  OPUS_SIGNALS + compound-verb-on-opus heuristics. Offline installs and
  no-API-key users now get the orchestrator gate even when
  `hooks/lib/prism-opus-classifier.mjs` can't reach the Anthropic API.
  Previously `summon_panel=true` was API-only.
- **Cache key drops `dirty` flag.** `hooks/lib/prism-opus-classifier.mjs`
  `cacheKey(prompt, branch, headSha)` — a single file save no longer
  invalidates the classifier cache. Prompt-iteration cache hit rate
  improves ~5×.
- **Sentinel-first classification** in
  `hooks/prism-agent-model-guard.mjs` and
  `hooks/prism-task-tier-advisor.mjs`. Both hooks now read
  `~/.claude/.prism-turn-tier-<session>.json` as authoritative instead
  of re-running the classifier. Re-classification happens only when
  sentinel is absent. Disagreements with sentinel get logged as
  `{event:'task_tier_divergence'|'classifier_divergence'}` events to
  `.prism-routing.jsonl` for the weekly rollup.
- **Plan-tier annotation now wins.** If a TaskCreate description
  carries `[haiku]`, `[sonnet]`, or `[opus]` (blueprint/workflow
  convention), the advisor treats it as authoritative over the
  session sentinel — the planner's explicit intent is stronger than
  turn-level classification.
- **Task tier advisor moved from PostToolUse → PreToolUse on `TaskCreate`.**
  Wrong-tier tasks can now be blocked before entering the plan, not
  just nudged after.
- **Compound vs summon_panel nudges separated** in the Agent model
  guard. Previously both triggered "SPLIT into retrieval+synthesis."
  Now compound → SPLIT; summon_panel → "spawn @master-orchestrator."
  Different advice for semantically different signals.

### Added — sustainability

- **Deescalation rule.** Master-orchestrator PHASE 2b: opus-locked
  agent that completes 5 consecutive sonnet-tier tasks with zero
  corrections → default_model reverts to sonnet. Breaks the
  "ratchet only goes up" bug.
- **Upgrade resets ratchet state.** Agent-factory upgrade protocol
  (Step 7, new in v2.7.0) clears `default_model`, `pending_upgrade`,
  `corrections_since_last_upgrade`, and
  `consecutive_successful_sonnet_tasks` on every completed upgrade.
  Refreshed agents are evaluated fresh against current task
  complexity, not saddled with pre-upgrade opus-locks.
- **Dynamic cost multipliers.** `loadCostMultipliers()` in
  `tools/lib/prism-tier-classify.mjs` reads pricing from
  `model-matrix.md` at runtime and normalizes relative to haiku-input.
  Falls back to hardcoded `{haiku:1, sonnet:5, opus:15}` if the
  matrix is absent. `/prism-update` now automatically propagates
  pricing changes to every cost-referencing nudge.
- **Weekly calibration feedback loop.** `tools/prism-rollup-weekly.mjs`
  now includes a **Classifier Calibration** section: advised tier
  distribution, actual model used, divergence count, top 5 advised
  ≠ actual, and a recommendation string. Appends a compact record
  to `update-log.json#calibration_history[]` (capped at 26 weeks).
  `/prism-update` surfaces the trend. No auto-tuning — human
  reviews and decides.

### Added — T-shape master-orchestrator

- **Identity upgrade** (agents/master-orchestrator.md). Explicit
  T-shape role: BROAD expertise across every PRISM domain, DEEP on
  orchestration/adversarial-review/dispatch, BOUNDARY for
  domain-specific work delegated to specialists. Orchestrator is a
  peer to hired specialists with standing to disagree on merits, not
  a client who rubber-stamps their output.
- **PHASE 1.5: SENIOR REVIEW (mandatory on FULL-NOVEL and HIGH-STAKES).**
  After all specialists execute, orchestrator runs a correctness +
  optimality + hidden-risk review before synthesis. Rejects
  untestable claims. Delegates caught gaps back (once) or owns them
  in parent context. Factory escalation for specialists that miss
  in their own domain (2+ misses → `pending_upgrade: true`
  immediately, skipping the 3-correction threshold).
- **Standard of evidence** enforced at specialist delegation prompts:
  "You must cite, test, or benchmark every non-trivial claim. An
  assertion without evidence is a draft, not a deliverable."
  PHASE 1.5 actually rejects them.
- **Visible output.** The PHASE 1.5 review is shown to the user:
  claims that survived, claims revised, gaps caught and closed,
  known limitations remaining.

### Changed — scope cleanup (blueprint / workflow / orchestrator)

- **Blueprint Section 5 "Workflow Execution Mechanics" removed.**
  Was duplicating 60 lines of workflow-orchestration content
  verbatim. Replaced with a one-line pointer: "See
  `~/.claude/skills/workflow-orchestration/SKILL.md`." Single
  source of truth for execution mechanics.
- **Blueprint Phase 4 — roster-first panel assembly.** Consult
  roster.json + tools-registry.md + NotebookLM notebooks before
  assembling panel. Hardcoded "Full-Stack Architect / Python Master
  / ..." personas are FALLBACK ONLY when no rostered specialist or
  Tier 1/2 tool fits. Compose-first enforced.
- **Blueprint Phase 5 Round 2 — formal adversarial review.**
  Cross-examination upgraded from "surface conflicts" to the full
  ≥2-substantive-challenges / ACCEPT-REJECT-CONDITIONAL /
  anti-theater protocol from
  `skills/prism-plan/references/adversarial-review.md`.
- **Blueprint Phase 7 — explicit Execution-heavy handoff to
  @master-orchestrator.** After writing initial todo.md, blueprint
  spawns the orchestrator with the verbatim user request; orchestrator
  expands the panel via PHASE 0a inventory, runs PHASE 0d
  adversarial review, dispatches specialists, and owns PHASE 1.5
  senior review. Fixes the v2.5.0 bug where parent Opus would
  execute Execution-heavy plans without assembling a panel.
- **Workflow section 1.5 — orchestrator-ownership rule.**
  Parent-direct vs orchestrator-driven distinction made explicit.
  When orchestrator is driving, parent does NOT touch roster.json
  or lesson files — orchestrator owns PHASE 2. Never double-update.
- **Workflow todo.md template aligned** to blueprint's tier
  annotation: `[haiku|sonnet|opus] [pgroup=N]` on every step. Same
  grammar so `prism-task-tier-advisor` parses both consistently.

### Infrastructure

- **Roster.json template scrubbed.** Ships as an empty `agents: {}`
  with a `_schema_example` documenting the new v2.7.0 shape fields
  (`default_model`, `corrections_since_last_upgrade`,
  `consecutive_successful_sonnet_tasks`,
  `notebooklm_notebook_id`). Previous template had the author's
  actual specialist (`competitive-intelligence-specialist`) seeded —
  fresh installs now land clean.
- **Master-orchestrator dispatch bypass** in agent-model-guard:
  spawning `@master-orchestrator` is always passthrough (no
  tier/model checks). The orchestrator itself handles its model
  selection internally.

### Notes

- **No breaking runtime changes** — sentinel shape preserved; guards
  and advisors fall back to re-classification if sentinel is absent
  (e.g., first turn after session start before tier-router has run).
- **Cost-accuracy tradeoff preserved.** Opus classifier remains
  default (`DEFAULT_MODEL='claude-opus-4-7'`). Cost rises ~$0.007/prompt
  but accuracy stays high. No regression to Sonnet/Haiku classifier
  as primary (explicitly rejected during v2.7.0 scope review).
- **Calibration is human-in-the-loop.** No auto-tuning of classifier
  regex or thresholds. The weekly rollup surfaces drift; user
  decides whether to tighten signals, adjust thresholds, or leave
  alone.

## [2.6.0] - 2026-04-23

CLAUDE.md sizing discipline and nested-file scaffolding. Closes the
last context-bloat vector after the 2.4.0/2.5.0 install rescope: the
root `CLAUDE.md` now has an explicit ≤200-line budget, and
`/prism-discover` proposes subdomain-scoped `CLAUDE.md` files that
Claude Code auto-loads only when working in the relevant subdir — so
per-session token load shrinks instead of growing as the project gains
subdomains.

### Added

- **`commands/prism-init.md` template rule 10: CLAUDE.md sizing
  discipline.** Explicit ≤200-line budget for the root `CLAUDE.md`,
  concrete destinations for growth (`.claude/references/` via
  `/prism-discover`, `tasks/lessons-tactical.md`,
  `tasks/lessons-strategic.md`, nested `CLAUDE.md` files,
  `~/.claude/.prism-sessions/`), and explicit anti-patterns (no
  always-on knowledge base, no duplicated rules across nested files).
- **`skills/prism-discover/SKILL.md` Step 4 — subdomain detection +
  nested `CLAUDE.md` scaffolding.** After writing index/full files,
  `/prism-discover` detects distinct tech-stack subdomains (nested
  manifests, distinct test runners, workspace packages, service
  boundaries) and proposes nested `CLAUDE.md` scaffolds per subdomain.
  User approves case-by-case with `[Y]` scaffold, `[R]` write to
  references instead, or `[N]` skip. Per-subdomain outcomes recorded
  to `.claude/references/subdomain-map.md` so re-runs don't
  re-propose declined domains.
- **Nested CLAUDE.md template.** Target 60–100 lines, subdomain-only
  rules (never duplicate root), explicit non-goals (no PRISM rules
  copy, no shared conventions, no files in `node_modules`/`dist`/
  `build`/`.next`).
- **`/prism-discover --check-claude-chain` health check.** Walks the
  repo, reports every `CLAUDE.md` found, their token size, and
  violations of the lean-template rules (root > 200 lines, nested >
  100 lines, content duplicated parent↔child, files in excluded
  paths). Non-blocking — reports only.

### Why this matters

Claude Code loads every `CLAUDE.md` along the cwd → root path on
every turn of every session. A monolithic 7k-token root `CLAUDE.md`
covering backend + frontend + tests loads its full cost on every
prompt even when you're only working in one subdomain. Nested files
loaded only along the active path cut per-session context by 40–70%
on multi-domain projects without losing any semantic coverage.

Worked example — project with root (1.5k) + backend (1k) + frontend
(1k) + tests (0.8k):

| Where you open Claude Code | Monolithic root | Nested |
|---|---|---|
| repo root | 4.3k | 1.5k |
| `src/backend/` | 4.3k | 2.5k |
| `src/frontend/` | 4.3k | 2.5k |
| `tests/` | 4.3k | 2.3k |

Nested files are strictly a speed win — never a slowdown — when the
template rules (≤100 lines each, no duplication) are followed. The
`--check-claude-chain` health check surfaces drift early.

### Unchanged

- Runtime semantics. This is a docs + `/prism-discover` behavior
  upgrade; no hook or guard changes.
- Subagent dispatch. `@master-orchestrator`'s PHASE 0a inventory
  (v2.5.0) already considers the active CLAUDE.md chain via Claude
  Code's default loading — nothing further needed there.
- `/prism-init` still creates exactly ONE root CLAUDE.md. Nested
  files are only ever scaffolded by `/prism-discover` with explicit
  user approval — never at init time.

## [2.5.0] - 2026-04-23

Closes the NOVEL-tier orchestrator-bypass bug, bumps the model matrix to
Opus 4.7, ships `/prism-deps`, adds a skill+notebook inventory phase to
`@master-orchestrator`, and turns the legacy ATLAS migration from
archive-only into full purge with backup.

### Changed (breaking behavior)

- **NOVEL-tier parent dispatch now requires `@master-orchestrator`.**
  `hooks/prism-parent-dispatch-guard.mjs` previously let parent Opus do
  anything directly when the classifier returned `opus` tier. Now, when
  the classifier ALSO sets `summon_panel=true` (novel architectural
  request), direct Write/Edit/Bash in parent context is denied until
  the parent calls `Agent({subagent_type:'master-orchestrator', ...})`.
  Haiku dispatches for file I/O don't satisfy the gate — only an
  explicit master-orchestrator dispatch flips
  `sentinel.orchestrator_dispatched=true` and unlocks work tools.
  Fixes the failure mode where Opus was writing multi-phase design
  migration plans solo instead of assembling an expert panel.
  Override: `!opus-force:` prefix skips the panel requirement;
  `PRISM_DISPATCH_GUARD=off` disables the guard entirely.
- **Tier-router notice on panel turns is a hard directive.** When
  `summon_panel=true`, the `additionalContext` emitted by
  `hooks/prism-prompt-tier-router.mjs` now reads "PANEL-SUMMONING TURN.
  You MUST spawn @master-orchestrator as your next action…" with the
  exact `Agent()` call form and enumerated responsibilities.
- **INSTALL.md §2.6 upgraded from archive to purge.** Legacy
  `atlas-*` skill/agent/command/hook/tool/plan files are now deleted
  from `~/.claude/` after a full backup to
  `~/.claude/backups/atlas-purge-<ts>/`. User-created specialists,
  session summaries, MCP servers, and personal CLAUDE.md are never
  touched. Rollback is one `cp -pr` from the backup. Runs before §3.

### Added

- **Model matrix bumped to Opus 4.7 / Sonnet 4.6 / Haiku 4.5.**
  `skills/prism-plan/references/model-matrix.md` and
  `skills/prism-plan/references/update-log.json`. The classifier
  (`hooks/lib/prism-opus-classifier.mjs`) has been running Opus 4.7
  since the code-level bump; the docs now match. Pricing, context, and
  cache costs enumerated per model.
- **`/prism-deps` command** (`commands/prism-deps.md`) — autonomous
  dependency auditor. Reads
  `skills/prism-plan/references/dependency-manifest.md` as source of
  truth, OS-detects, tier-gates by project relevance
  (notebooklm-py / ffmpeg / kokoro / Remotion / playwright / gh / jq),
  proposes OS-specific install commands interactively. Writes results
  to `.claude/deps-scan.json` for `/prism-health` cross-reference.
  Closes the dangling `/prism-deps` reference in `/prism-init` §6 and
  `/prism-health` §4.
- **`dependency-manifest.md`**
  (`skills/prism-plan/references/dependency-manifest.md`) — 4-tier
  manifest (A: agent research, B: video production, C: app-expert,
  D: dev helpers). Each entry has capability, check command, OS-specific
  install command, and fallback-if-absent behavior.
- **PHASE 0a — Skill + Notebook Inventory** in
  `agents/master-orchestrator.md`. Before stakes detection or team
  assembly, the orchestrator now enumerates: installed skills, Tier 1/2
  external tools with status, rostered specialists with staleness
  flags, per-agent NotebookLM notebooks (`notebooklm list` +
  cross-ref with `roster.json`'s `notebooklm_notebook_id` fields),
  connected MCP servers. Emits a compact inventory summary and a gap
  hypothesis for the request before anything else. Answers "do I have
  a design skill?" with evidence, not a guess.
- **Conditional design-intent nudge.** `hooks/prism-hook.mjs` line 144
  UI-UX-PRO-MAX message changed from assertive "is installed, invoke"
  to conditional "if installed, invoke; otherwise run /prism-recommend
  or dispatch a Sonnet subagent with explicit design-system criteria."
  Matches the 2.4.0 treatment of ECC and browser-use nudges.

### Fixed

- **Dangling `/prism-deps` references** in `/prism-init` §6 and
  `/prism-health` §4 now resolve to a real command.
- **Missing `dependency-manifest.md` reference** expected by the User
  Guide v1.1 Ch.8 and by `/prism-deps` is now shipped.

### Notes

- The `summon_panel` enforcement only fires on `tier=opus AND
  summon_panel=true`. Opus-tier requests that the classifier judges as
  *not* panel-worthy (single-expert review, direct architecture
  question, one-pass refactor reasoning) still allow direct parent
  work. This preserves the "don't force subagent dispatch when parent
  Opus IS the right model" behavior while fixing the "panel never got
  assembled" bug.
- `/prism-deps` is opt-in per session — not auto-run by `/prism-init`.
  Users can trigger at any time with `/prism-deps` or `/prism-deps --check`.
- The PHASE 0a inventory is synthesized from commands the user's
  system already runs (`notebooklm list`, `/plugin list`, reading
  `roster.json`, `settings.json` mcpServers). No new subprocess
  overhead per turn — it only runs when `@master-orchestrator` is
  spawned, which is already gated to NOVEL-tier panel turns.
- After upgrade, re-run the install flow (`INSTALL.md`) to pick up the
  purge step. If you prefer to keep the archive-only behavior, skip
  §2.6 manually — the runtime works either way since the new code
  only reads `prism-*` paths.

## [2.4.0] - 2026-04-23

Completion of the ATLAS → PRISM rename that began in 2.0, plus a rescoped
install flow that trims the default surface area. Install is still
idempotent and non-destructive; existing specialists, session history,
and settings are preserved via an automated migration step.

### Changed (breaking)

- **Terminology: `ATLAS` → `PRISM` everywhere in code, comments, docs,
  agent frontmatter, skill names, env vars, and paths.** 56 files
  rewritten, 264 references. Legacy `ATLAS_CACHE` / `ATLAS_LOCK` env
  vars are renamed to `PRISM_CACHE` / `PRISM_LOCK`. Slash-command and
  skill frontmatter `name:` fields are now all `prism-*`. Legacy
  `atlas-*` artifacts on disk are archived — not deleted — by the
  installer (INSTALL.md §2.6).
- **Tier 1 companions reduced to 2.** `/prism-init` now offers only
  `obra/superpowers` (coding workflow) and `nextlevelbuilder/ui-ux-pro-max-skill`
  (UI/UX design system). Both `affaan-m/everything-claude-code` and
  `browser-use/browser-use` are moved to Tier 2 (on-demand via
  `/prism-recommend`). Rationale: ECC's ~12k-token skill index and
  browser-use's ~400 MB chromium stack were net-negative for most users
  in the default install path; they remain available for projects that
  genuinely need them.

### Added

- **New canonical `CLAUDE.md` template** written by `/prism-init`
  (commands/prism-init.md §3). Encodes the operating rules explicitly:
  tier classification drives every prompt, parent plans + subagents
  execute, cheapest-viable model per step, NOVEL tier triggers
  master-orchestrator + adversarial review, memory-save nudges at
  turn 15+ and `/clear` reminders at 15/20/30+, compose-first stance on
  Tier 1 tools, safety-gate enforcement, and persistence via
  `.prism-routing.jsonl` + `roster.json`. Appended non-destructively if
  a `CLAUDE.md` already exists.
- **INSTALL.md §2.6 — legacy ATLAS migration.** Idempotent step that
  moves `atlas-plan/references/{roster.json,update-log.json,...}` into
  the new `prism-plan/references/` location, archives orphan
  `atlas-*.md` skill/agent files to
  `~/.claude/backups/atlas-rename-<ts>/`, and extends §4b
  stale-pruning to match `atlas-*.mjs` and `atlas-exec.sh` hook entries
  in `settings.json`. Users upgrading from pre-2.4 installs re-run the
  installer and their specialist agents, effectiveness history, and
  session summaries all survive.
- **Conditional tier-2 nudges in `prism-hook.mjs`.** ECC and browser-use
  intent-detection patterns remain, but the nudge copy now says
  "if X is installed" and suggests a Sonnet subagent fallback for users
  without the optional tools. No more "ECC is installed" assertions
  that were wrong for users who skipped the install.

### Removed

- **`prism-init` auto-offer of ECC and browser-use.** Only `superpowers`
  and `ui-ux-pro-max` remain in the Tier 1 install menu. ECC and
  browser-use are mentioned as Tier 2 options available via
  `/prism-recommend` but are not part of the default setup flow.

### Notes

- No functional regressions. Every hook, tool, command, and skill still
  works — references just use the new name. Cache files under
  `~/.claude/.prism-*` were already named PRISM; no migration needed
  for hook state.
- Existing `atlas-plan/references/roster.json` contents are copied
  (not moved) to the new location only if the destination doesn't
  already have a roster — so re-running the migration is safe.
- Users with specialist agents whose prompts explicitly reference
  "ATLAS" in the system-prompt body: those strings are untouched (they
  live under `~/.claude/agents/<specialist>/agent.md`, owned by the
  user). Consider a one-time find-and-replace in your own agents if
  branding consistency matters to you.

## [2.3.0] - 2026-04-22

Cross-platform hook reliability. Fixes the long-standing `/bin/sh: node: not found`
stderr spew on Linux/macOS machines where node is installed via a version
manager (nvm/fnm/volta/asdf), and adds first-class Windows support for the
hook layer. No breaking changes; existing installs pick up the fix on
re-running the install flow.

### Added

- **Node auto-discovery in `hooks/lib/prism-exec.sh`.** The wrapper now
  resolves node by trying, in order: `$PRISM_NODE`, `~/.claude/prism.env`,
  `command -v node`, newest `~/.nvm/versions/node/*/bin/node`, newest
  `~/.fnm/node-versions/*/installation/bin/node`, `~/.volta/bin/node`,
  `asdf which node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`.
  When node is found, its bin dir is prepended to `PATH` so downstream
  `npm`/`npx` invocations inside hooks also resolve. Before 2.3.0 the
  wrapper only called `command -v node` and silently exited 0 on miss —
  so hooks appeared to "work" (no error) but never actually ran on
  version-manager-only systems.
- **Windows hook wrapper** `hooks/lib/prism-exec.cmd`. Mirrors the `.sh`
  discovery logic for cmd.exe: `%PRISM_NODE%`, `prism.env`, `where node`,
  `%APPDATA%\nvm\<latest>\node.exe` (nvm-windows), `%LOCALAPPDATA%\Volta\bin\node.exe`,
  `%ProgramFiles%\nodejs\node.exe`. Install flow selects the correct
  wrapper per OS when merging `settings.fragment.json` into
  `~/.claude/settings.json` (see INSTALL.md §4a).
- **`prism.env` install-time pin.** INSTALL.md §2.5 resolves node's
  absolute path during install and writes `PRISM_NODE=<abs-path>` to
  `~/.claude/prism.env`. Both wrappers source this first, giving a
  zero-discovery fast path. Survives `nvm install <newer>` because the
  wrappers still fall through to discovery if the pinned path is gone.
- **Stale-entry pruning in INSTALL.md §4b.** The merge step now removes
  pre-2.3 raw `node ~/.claude/hooks/prism-*.mjs` hook entries from the
  user's existing `settings.json` before merging the fragment. These
  entries — present in any install that pre-dates the v2.2.0 wrapper
  rollout — were the source of the `/bin/sh: node: not found` spew even
  after 2.2.0 cleaned up the fragment itself. Non-PRISM raw-node entries
  are left untouched.
- **`scripts/verify.mjs` wrapper checks.** Verifies the OS-correct
  wrapper exists (`prism-exec.sh` on POSIX, `prism-exec.cmd` on Windows)
  and reports presence/absence of `~/.claude/prism.env` as a non-fatal
  hint.

### Fixed

- **Linux/macOS Stop hook `/bin/sh: node: not found` spew on
  version-manager-only installs.** Root cause was two-part: (1) the
  2.2.0 `prism-exec.sh` wrapper couldn't actually find nvm-installed
  node (it only checked PATH); (2) pre-2.2.0 installs retained stale
  raw-`node` hook entries in `settings.json` that the 2.2.0 merge never
  pruned. 2.3.0 fixes both.

### Notes

- No migration required. Re-run the install flow (per INSTALL.md) to pick
  up the new wrappers, prune stale entries from your existing
  `settings.json`, and write `prism.env`. The install is idempotent.
- Users who previously worked around the issue by symlinking node into
  `~/.local/bin` can safely delete the symlink after 2.3.0 takes effect,
  but leaving it is harmless.

## [2.2.1] - 2026-04-22

Three bundled fixes based on user-reported gaps after the 2.2.0 rollout.
No breaking changes; every 2.2.0 routing decision survives this release.

### Changed

- **ECC (`affaan-m/everything-claude-code`) is now OPTIONAL, not Tier 1.**
  `/prism-init` no longer auto-installs ECC; the 100+ skills catalog
  imposes a per-turn token tax that outweighs benefits for typical work.
  Users who explicitly want polyglot reviewers or AgentShield can still
  install it via `/prism-recommend --include-optional`. Touched docs:
  `commands/prism-init.md`, `commands/prism-recommend.md`,
  `commands/prism-health.md`, `agents/master-orchestrator.md`,
  `skills/prism-plan/references/tools-registry.md`.
  Before: ECC shown as `installed, active` in default health/init status.
  After:  ECC shown as optional, install-on-demand only.

- **`/prism-audit` uses PRISM-native grep-based secret scan by default.**
  Previously the doc said "use ECC's /security-scan". Now runs a
  root-file check (`.env`, `.env.*`, `credentials.json`, `*.pem`, `*.key`,
  `id_rsa*`, `*.pfx`), the existing content-grep for known-token shapes
  (already in Step 1 — sk-/ghp_/AKIA/AIza/JWT), and a new large-binary
  check (> 50MB). AgentShield remains an OPTIONAL deeper scan if ECC is
  manually installed.

### Fixed

- **`/prism-init` mutation-guard auto-bypass.** `hooks/prism-mutation-guard.mjs`
  now detects three bootstrap commands from the sentinel rationale
  (`/prism-init`, `/prism-update`, `/prism-archive`) and passes through
  cleanly. Falls back to prompt sniffing if the sentinel is missing
  (e.g. first-turn race). Before: `/prism-init` bootstrap was blocked by
  mutation-guard under `hard` mode and users had to set
  `PRISM_MUTATION_GUARD=off` manually. After: no manual env-var dance
  needed for legitimate bootstrap writes.

- **`/prism-discover` subagent dispatch-guard deadlock.**
  `hooks/prism-parent-dispatch-guard.mjs` now has three independent
  subagent-bypass paths instead of one:
  1. `input.parent_tool_use_id` present (unchanged from 2.2.0).
  2. `CLAUDE_CODE_ENTRYPOINT=subagent` env var (new).
  3. `sentinel.dispatched === true` (hoisted — used to be checked only
     after ALWAYS_ALLOW filtering; now the primary subagent signal).
  Defense-in-depth: orchestration-command rationale matches also pass.
  Before: subagent-spawned `Read`/`Bash`/`Grep`/`Glob` calls were denied
  mid-execution because the guard re-classified the subagent's internal
  turn as haiku-tier and demanded another dispatch (which a subagent
  can't do). After: once the parent dispatched, everything downstream
  passes cleanly.

### Tests

- 5 new regression tests in `tools/test-prism-gaps.mjs` under
  `v2.2.1 hook fixes`:
  - V221.1 `/prism-init` prompt + mutation-guard → allowed
  - V221.2 `/prism-update` + mutation-guard → allowed
  - V221.3 subagent with sentinel.dispatched=true → dispatch-guard allowed
  - V221.4 subagent + haiku-tier sentinel → still allowed (no deny)
  - V221.5 parent + haiku-tier + NOT dispatched → still denies (2.2.0 regression guard)

## [2.2.0] - 2026-04-22

### Added

- **Opus-backed context classifier** (`hooks/lib/prism-opus-classifier.mjs`).
  Replaces keyword-score tier routing with Opus classification. Falls back
  to Sonnet on API error / timeout, then to the legacy keyword classifier
  as an emergency floor (so PRISM still routes something on a
  misconfigured install). Uses Anthropic Messages API; reads
  `ANTHROPIC_API_KEY` from env. 5-second timeout, bounded to 200 output
  tokens, JSON-only responses.
- **Slash-command allowlist.** The following commands short-circuit to
  `opus` at zero cost and zero latency:
  `/prism-init`, `/prism-plan`, `/prism-app-expert`, `/prism-update`,
  `/prism-recommend`, `/prism-archive`, `/prism-audit`, `/prism-health`,
  `/prism-roster`, `/prism-retire`, `/prism-recall`.
- **Tier-scoring cache** at `~/.claude/.prism-tier-cache.json`. 24h TTL.
  Key = `sha256(prompt + '|' + branch + '|' + head_sha + '|' + dirty_bool)`.
  Identical prompts on the same branch/HEAD/dirty state re-use the prior
  classification without another Opus call. Cache invalidates
  automatically on `git commit` (new HEAD changes the key).
- **Release/meta-work safety screen** in the keyword-floor path. When
  Opus and Sonnet are both unreachable, prompts matching release tokens
  (`push to main`, `merge`, `force-push`, `deploy`, `release`, `ship`,
  `tier router`, `PRISM`, `2.2.0`) are promoted to opus regardless of
  keyword score. Prevents release-engineering work from routing to haiku
  in an API-outage scenario.
- **Cross-platform hook wrapper** `hooks/lib/prism-exec.sh`. Guards the
  `node` call for every hook in `settings.fragment.json`. On Linux / macOS
  where node is not on PATH, hooks silently exit 0 instead of crashing.
- **13 regression tests** in `tools/test-prism-gaps.mjs` under the new
  `v2.2.0 classifier` section. Covers force-opus override, the 11 slash
  commands, multi-verb chains, git-write verbs, meta-work tokens, cache
  hit/miss, Sonnet fallback (mocked), and no-API-key graceful
  degradation. Includes a regression test for the
  `/prism-init full → haiku misroute` bug reported during 2.1.3.

### Changed

- **BREAKING: tier-router output format.** The `additionalContext`
  emitted by `prism-prompt-tier-router.mjs` changed from
  `PRISM TIER ROUTER: prompt scored N (X-tier, h=N s=N o=N). ...` to
  `PRISM TIER ROUTER: {tier}. {rationale}`. Downstream code that parsed
  the `h=/s=/o=` tokens to make routing decisions must migrate to the
  `rationale` / `source` fields in `~/.claude/.prism-routing.jsonl`.
- **Sentinel file shape preserved.** `~/.claude/.prism-turn-tier-<session>.json`
  keeps its v2.1.3 schema (`{tier, score, h, s, o, compound, force_opus,
  dispatched, ...}`) for compatibility with `prism-parent-dispatch-guard.mjs`
  and any external tools. The legacy `{score, h, s, o, compound}` fields
  are now zero-filled — they exist for backward-compat but are no longer
  populated by the classifier. New consumers should read `rationale` and
  `source`.
- All hook commands in `settings.fragment.json` now route through
  `bash ~/.claude/hooks/lib/prism-exec.sh <hook>` instead of calling
  `node` directly.
- `prism-task-tier-advisor.mjs` now classifies task subject+description
  via the Opus classifier. Hard-mode deny behavior and `task_tier_advice`
  row shape are unchanged.
- `prism-agent-model-guard.mjs` now classifies Agent() prompts via the
  Opus classifier. The compound-verb detector runs as a secondary signal
  (same regex as v2.1.3, now extended — see fixes below) alongside the
  classifier's `summon_panel` flag.

### Fixed

- **Linux Stop hook no longer fails when node is absent.** All hook
  invocations go through `prism-exec.sh`, which guards the node call.
- **P2.11 classifier rule** (`tools/prism-kb-domains.mjs`): extended the
  `atlas-core` regex from `atlas-*` to `(atlas|prism)-*` so current
  `prism-*` command/agent names classify correctly after the rebrand.
  Was causing `command:prism-recall` to land in `misc`.
- **P2.19 sync test race** (`tools/prism-kb-sync.mjs`): `computePlan` now
  accepts an optional `opts.mtimeMap` parameter. Tests pin body-path
  mtimes to avoid a race where an external process touches a KB file
  between the test's snapshot and `computePlan`'s `statSync` call.
  Production callers pass nothing — behavior unchanged.
- **P3b.5 compound-verb regex** (`tools/lib/prism-tier-classify.mjs`):
  extended `COMPOUND_VERB_RE` to handle object phrases + commas between
  the two verbs (`"read and analyze this module, then design a refactor"`).
  Max 60 intervening characters, non-greedy.

### Known issues

- **P2.28 classify entry-count test is environment-dependent.** The test
  asserts exact-count equality against the user's installed KB. After a
  fresh clone or plugin install the count may shift by 1–2. Does not
  affect runtime behavior. We are not updating the assertion because the
  current number is a useful health probe on the most common install
  shapes; if you see P2.28 flip on a machine with many plugins, re-run
  the suite once — the indexer is deterministic after first rebuild.

### Notes

- **Troubleshooting artifacts cleanup.** If you had to disable PRISM
  guards during a 2.1.3 session to unblock meta-work (rename to
  `.mjs.disabled`), clean them up after installing 2.2.0:
  `rm ~/.claude/hooks/prism-*.mjs.disabled`. The 2.2.0 guards supersede
  the disabled copies; both should not coexist.
- **`!opus-force:` override is NOT dead code.** The override is checked
  in the new classifier before any API call or cache lookup. It worked
  in 2.1.3 via the sentinel `force_opus=true` flag; it works the same
  way in 2.2.0. Any documentation/memory that claimed the override was
  dead was stale and should be updated.

## [2.1.3] - 2026-04

Initial modular PRISM release — hooks, tools, agents, skills,
statusline, and commands. See `INSTALL.md` and `manifest.json`.
