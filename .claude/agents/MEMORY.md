# MEMORY.md — master-prism-3 router

<!-- Auto-injected at subagent start (first 200 lines or 25 KB per
     https://code.claude.com/docs/en/sub-agents § Enable persistent memory).
     This file is a ROUTER. Knowledge lives in linked files, not here.
     Seeded by /prism-deep-dive on 2026-06-19. -->

## Project profile

Stack/datasources: see root `CLAUDE.md` "Project Identity" — not
duplicated here (D046 #4: a hand-copy rots independently of the source).

Active work: NOT hand-tracked here — surfaced every SessionStart by the
TASK-RECALL block (`hooks/prism-session-start.mjs` C6) from
`.claude/.prism-open-tasks.json`, with staleness tagging and a
"+N more — call TaskList" overflow pointer. No TASK-RECALL block means
the file is absent/empty or `PRISM_DISABLE_TASK_RECALL=1` — NOT "no
active work" (D047: absence of a signal isn't evidence of "none"); run
`TaskList` to check. Full rationale: `docs/prism/adjudications/D046-*.md`.

## Recent decisions (last 12, pointer-only)

<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->

NOTE: `docs/prism/` (adjudications/, lessons/, plans/, deviations/ — the D### and
lessons files these pointers resolve to) is intentionally gitignored (`.gitignore:26`,
owner-confirmed 2026-07-27) — machine-local, not shipped by a fresh clone. Root
CLAUDE.md's "consult adjudications before changing phase machinery" points at nothing there.

- [[D060]] D060 — Test-isolation protocol for guard measurement: you cannot measure a guard from inside a dispatch _(Proposed)_
- [[D082]] Mutation-guard's missing D043 teams downgrade is intentional-by-default-inaction _(Withdrawn)_
- [[D086]] Fail-open paths must be observable — fail-open is correct, fail-SILENT is not _(Proposed)_
- [[D098]] D098 — A document that DESCRIBES an operation must not be treated as PERFORMING it _(Locked)_
- [[D099]] The standing-rules block is zero-sum — tiering is a trade, never an addition _(Locked)_
- [[D101]] D101 — First owner selection of the `Tier: core` set: D063 and D065 _(Locked)_
- [[D102]] D102 — Performance gates must be relative to a same-session baseline, never an absolute wall-clock threshold _(Locked)_
- [[D105]] Force-push safety gate widened to cover -f/+refspec; corrects D044 (d)
- [[D106]] Mirror push is agent-permitted once gates are green; supersedes the human-only framing
- [[D107]] Scope a verification to the artifact, not to the instrument's output
- [[D104]] D104 — An inherited absence claim must be re-verified before it is acted on _(Locked)_
- [[D108]] The mirror PII gate accounts for findings; it does not merely report them _(Proposed)_

## Recent lessons (last 10, pointer-only)

<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->

- [2026-07-29] D098's failure mode bit the ratifier during D098's own ratification
- [2026-07-29] Historical quotations are testimony, not policy
- [2026-07-29] Verify the artifact, not the idle signal — late delivery is not lost delivery
- [2026-07-29] Full task descriptions are on disk when TaskGet is unavailable
- [2026-07-29] Two granularities of FAIL that can disagree in one suite run
- [2026-07-29] A deliberately shared temp path races across concurrent processes (AUDIT_HOME)
- [2026-07-29] TaskUpdate's owner field is a dispatch, not bookkeeping
- [2026-07-29] Piping to tail reports tail's exit code, not the tool's
- [2026-07-29] Synthetic-mirror tests break on any new cross-boundary import
- [2026-07-29] A comment citing another file's line numbers rots silently, and incidental sweeps miss most copies

## Session log

<!-- /prism-clean appends session-summary lines here. -->

- [2026-07-28] Resumed 2026-07-27 handoff: deployed+committed the stale tree (5 commits, #46 closed, deployed_uncommitted proof captured then cleared). Validated all 10 carried tasks in 4 parallel validators — #16 CLOSED as phantom (fixed 3 days pre-filing), #22/#32 premises re-measured and corrected, rest hold. Shipped D083 Phase 1 (#45): inline lessons, standing-rules cap 12->30, lesson-match logging; standing rules 12->30, D063 restored, MEMORY.md 15457->22189. Panel's acceptance criterion found SELF-SATISFYING -> D084. #43 reframed to a citable defect (clause 8 never reaches Agent path, fenced by D057). New: D084/D085/D086, F33 (#47 rename retry).
- [2026-07-28] Session 2: split the D087 umbrella three ways after investigation REFUTED the identity thesis for #43; shipped chair-only tier sentinel (D087 Locked) + clause 7 on named Agent creation (D089); promoted D043 to Locked; closed 9 tasks; re-verified all 5 open tasks, correcting #32 and refuting #51.
- [2026-07-28] Session 3: shipped d5e63c246 (70 files) — F36 dedup fixed structurally via excess-over-background (5 mechanisms measured, chair's top-ranked pick proved a no-op), F21 prismHome sweep 64 sites/55 files, F32 characterised+instrumented but deliberately unfixed (negation-blindness), D090 standing-rules cap 30->35 preventing eviction of D045-D051. 5 adjudications promoted Locked (D080/D081/D084/D085/D089), D088 §3 contradiction corrected. Suite 231 files 230 ok 1 expected red; 0 drift; pushed to origin. Captured D091/D092 + session-3 lessons with FIVE misfire classes. New findings #54-#58 filed.
- [2026-07-28] Session 4: evidence-first census REJECTED the shared guard-scoring library (D094); #58 corpus fix DELETED the no-baseline branch after measuring 578 pairs in the never-sampled 0.40-0.90 band that the interim 0.60 was silently dropping 165 of (D095); D088+D093 ratified Locked; adjudication retirement mechanism shipped; status allow-list fixed a silent exclusion that hid claude-master from this session's own capability catalog (D096); closed #50/#51/#54/#56/#58/#59, filed #60-#64; 2 commits dc313a909+40c129da6, suite 232 ok / 1 expected red.
- [2026-07-28] Session 5: resumed the session-4 handoff, all 8 carried tasks resolved (#32 characterised-no-fix, #57 platform-side + residue detector, #60 AMBIENT_ENV_TERMS, #61/#62 retirements+heading, #63 claude-master restored, #64 verification convention); found F48 D093 self-retiring, #66 live F38 instance, F49 mutation-guard blocks commit prose, F50 git-stats SHA silent 58x overcount; D097 tiering ratified implementation open as #69; D098 Proposed synthesis of the self-reference class; 5 commits 24 files, suite 233/232/1, deployed and verified
- [2026-07-29] Session 6: closed the entire session-5 handoff in 4 commits (F49 mutation-guard heredoc/-m stripping after the chair rejected round-1's newline concession; F50 git-stats SHA-as-revision; D097 Tier core shipped with a 7-rule owner-chosen core set; F38 fixture helper with explicit list plus transitive-import scan that throws). Suite 235 files / 1 expected red, 0 drift, deployed and D065-verified in installed artifacts. Release audit found NO blockers, recommends 6.7.0; prism_5 mirror is a real public remote 4 versions behind with NO PII scan gating the push (D044 §e still open). Captured D099 (standing-rules block is zero-sum: tiering evicts one-for-one). Filed #70-#74; chair made 3 measurement errors, all caught.
- [2026-07-29] Session 7: resumed session-6 handoff and shipped 6.7.0 (7506f42f1) + follow-up (82caf52c2), both deployed and D065-verified in installed artifacts; closed D044 gap-e with a shipped PII scanner after finding REAL PII (employer name, two correlated usernames, live paths) in the tracked tree bound for the PUBLIC mirror, plus two .gitignore-matched-but-tracked files -> D100 Locked; took D097's deferred owner call promoting D063+D065 to Tier core -> D101; Proposed queue 21->6 with D091 REFUSED on its false premise then ratified on merits; 5 handed premises refuted plus the chair's own 83pct perf regression retracted as contention noise (#79); push deferred by owner.
- [2026-07-29] Session 8: resumed handoff-7, closed #79 with a contention-resistant ratio perf gate after the worker REFUTED the chair's I/O-bound reproduction hypothesis by measurement (disk-only never flipped; CPU flipped 5/5); D102 Proposed generalizes perf-gates-must-be-relative; 2 commits 210f2b938+c8c3c4f0b, suite 235 files 1 expected red, tree clean, unpushed. Chair made three errors all caught: wrong load-lever inference, two wrong mechanism reconstructions for #80, and a green-gate claim on a suite that ran mid-edit. Filed #80-#85 (TaskUpdate-owner-write-is-dispatch, writeDedup atomicity DEFECT cited at prism-lesson-match.mjs:129-131, sibling PERF CLI same defect, prism-clean census ordering, MEMORY.md heading drift); net +5 tasks, 9 open.
- [2026-07-29] Session 9: closed the entire session-8 handoff (9 tasks) in 3 commits d79e023d6+d96fda569+75ab05635, all deployed and D065-verified; ratified D098/D099/D101/D102/D103 with evictions D071-D075 measured before AND after the flip, withdrew D082, killed dormant task #93; #82 writeDedup fixed via the already-existing renameWithRetry helper then found to be a hand-copied template across ~20 sites (#88); #83 PERF CLI now a with/without ratio holding 0.897x-1.208x while the old ceiling flipped 5/5 under load; D103's census-after-capture fix validated on its own first run (3 -> 4, catching D104); chair handed workers FOUR false premises (TaskGet availability, a census step that never existed, 6-vs-13 citation sites from an undisclosed grep scope, and #80's wrong lease glob that disarmed a working control all session) and every one was caught by a worker who measured; captured D104, session-9 lessons, and a ledger deviation; 23 commits unpushed.
- [2026-07-29] Session 10: closed #87/#88/#90/#91/#92 in 5 commits (76be71791, 7c681b595, 32fbf9ccd, d69ccd81c, 4ea23ccd0), all deployed and D065-verified; #92 reopened TWICE — the PII scanner's own patterns were plaintext owner PII, and the fix reintroduced the email in its explanatory comment where the scanner structurally could not match it, caught only by grepping the tracked tree independently of the tool (D107); force-push gate was bypassable by -f and +refspec, contradicting D044(d)'s 'an agent could not have pushed' claim (D105); owner reversed the human-only mirror-push policy to agent-permitted-once-gates-green, blocked on #93 (D106); D104 ratified Locked, displacing D076 from the 35-slot cap; #90's flake reproduced as a machine-global AUDIT_HOME race; six times a plausible measurement was wrong, three of them the chair's.

## Standing rules

Imperatives drawn from the most important Locked adjudications (auto-generated —
see `tools/lib/memory-heal.mjs regenerateStandingRules`, D-recall-hardening C2/C3):

<!-- prism:standing-rules:start (AUTO-GENERATED from Locked adjudication **Rule:** lines by tools/lib/memory-heal.mjs — do not hand-edit between anchors) -->
- **D023:** Inject the Rule imperative text, not a file pointer; raise match threshold to 0.15; zero-suppress Locked adjudications in the dedup window.
- **D043:** A guard whose state is session-global cannot gate per-caller — under agent-teams (all teammates share one `session_id`) PRISM's `dispatched` flag is set and wiped by ANY agent's message, producing silent false-ALLOWS as well as loud false-denies; never document a single-actor guarantee for a mechanism with multi-actor shared state, and never infer a guard is working from the absence of complaints — its permissive failures are silent by construction.
- **D045:** In agent-teams (all teammates share one `session_id`), the dispatch guard's session-global `dispatched` flag CANNOT gate per-caller — ship it ADVISORY in teams topology (fail-safe, gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), make every borrowed-unlock VISIBLE (`borrowed_unlock` event + in-band advisory) so the silent false-allow becomes measurable, and close write-collisions via a DECLARED-identity lease; NEVER build a per-caller HARD gate on payload fields that do not carry caller identity.
- **D046:** PRISM's memory/handoff/routing defects are omissive "silent under-reporting" (a structured path fails silently → a regex/manual fallback emits plausible output → nothing reports the miss); fix by making misses LOUD (ledger + surface-at-consumption), NEVER by permissive parsers; KEEP-AND-FIX not uninstall (uninstall is measured-safe but protects nothing — all defects are omissive); snapshot unversioned knowledge before any change.
- **D047:** A field that collapses "no" and "didn't check" into one value is VACUOUS — populated, well-typed, structurally valid, and evidence-free; make the third state (UNKNOWN/never-measured) representable at the producer, then classify the CONSUMER as code (enforceable) or prompt-spec (advisory-only ceiling), and never report a green whose denominator you chose yourself.
- **D057:** Before writing that something is absent, empty, missing, or unmatched, read and QUOTE the source field you are describing — a value from a classifier, inference, or default bucket is not evidence the source lacks data; before removing, collapsing, or quieting an existing mechanism, QUOTE the comment saying why it is there. This tripwire covers a MEASURED ~34–37% of organic absence phrasing (anchored on the largest family, `has/have/had no X`) — treat it as a tripwire, never as enforcement.
- **D059:** Re-measure every state-prediction in a plan authored in a prior session before executing it — a plan is evidence of intent, never evidence of state, and where its predictions conflict with a fresh measurement the measurement wins.
- **D063:** Never make `runVerifyInner()` content-aware; wire content-drift detection through the standalone `verify` CLI subcommand shelling out to `tools/prism-drift-check.mjs`, leaving the install-time verify call (`tools/prism-installer.mjs:725`) on the cheap existence-only path.
- **D065:** Never report a fix as "shipped" on the strength of a commit alone — verify the INSTALLED artifact under `~/.claude/` actually changed (byte-diff or `prism-installer.mjs verify`'s drift check), because committing to the repo does not run `tools/prism-installer.mjs install` and therefore does not deploy anything.
- **D107:** Scope a verification to the ARTIFACT you are making a claim about
- **D104:** Before ACTING on an absence claim you inherited from a task, handoff, or prior finding — especially before declining to use a control it says does not exist — RE-RUN its verification command and confirm the command itself is correct; a claim of absence is only as good as the search that produced it, and a wrong glob, path, or scope produces a confident, durable, and completely false "nothing here".
- **D103:** Any Proposed-adjudication queue count written into a session handoff or a task description (e.g. task #74's tracking) MUST be taken (or re-taken) after Step 4 of `/prism-clean` has finished writing this session's own artifacts — never carried over from a count taken earlier in the session or from a prior handoff.
- **D102:** Never gate a test on an absolute wall-clock threshold; measure a same-session baseline whose cost tracks the code under test and assert the RATIO — and when placing the ratio ceiling, state the observed range, the denominator, and explicitly that the band above the maximum observation is unmeasured.
- **D101:** Promote a standing rule to `**Tier:** core` only as an explicit owner decision and only as a TRADE — core membership is subtracted from the same 35-slot cap, so each promotion evicts one more non-core rule; measure and name the displaced rule before promoting, never after.
- **D100:** `.gitignore` never untracks a file that was already committed, so gitignore status is NOT a shipping guarantee — use `git ls-files <path>` to decide whether a file ships, and `git check-ignore -v --no-index <path>` (never bare `check-ignore`, which is silent for tracked paths) to prove a rule matches.
- **D099:** State the eviction set before adding any rule to the `**Tier:** core` set — the standing-rules block holds a fixed `cap` number of entries, so promoting N rules to core evicts the N weakest date-ranked non-core rules one-for-one; never present tiering as protecting a rule without naming which rules it displaces.
- **D098:** Scope or anchor any pattern-match so that self-reference is impossible BY CONSTRUCTION, never merely unlikely — a parser reading a document that DESCRIBES its own format (a worked example, boilerplate prose, a comment) must not treat that description as the real thing. "Narrow the regex until it stops misfiring on the fixtures at hand" does NOT satisfy this: the test is whether a document ABOUT the pattern can still trip the matcher. This is Proposed, not Locked — it synthesizes an observed pattern across three unrelated incidents in one session; it is not yet an owner ratification.
- **D097:** Add a `**Tier:** core` header field that exempts an owner-designated core set of standing rules from the date-ordered sort — date-ordering systematically evicts foundational and defect-class rules for being old while recent situational adjudications occupy the block. Do not resolve this by raising the count cap again; that repeats [[D090]]'s already-exhausted trade. Which rules belong in the core set is a SEPARATE, not-yet-taken owner decision — this file ratifies the MECHANISM only.
- **D096:** Filter roster agents against ONE explicit live-state allow-list imported from a single module ({available, active, upgrade_needed} plus absent/null), so unknown future values fail CLOSED, and log every exclusion with the offending literal instead of widening the parser silently.
- **D095:** Measure the interval a threshold divides before you place it — a cut inside a region containing zero observations is unfalsifiable, and if the region really is empty say so with the denominator, because "empty" and "never looked" are different states.
- **D094:** Before unifying several guards behind a shared scoring library, census whether they actually share a MECHANISM — and if they do not, unify their telemetry instead so every guard logs its own denominator.
- **D093:** Retire a spent adjudication by APPENDING a `**Retired:** YYYY-MM-DD — <reason>` line to its header block — never by editing its `**Status:**` line; retirement removes the rule from the always-on standing-rules block ONLY, the knowledge index must keep scanning it so it stays keyword-recallable, and only the owner may retire.
- **D092:** Label any ranked candidate list in a dispatch brief as the chair's PRIOR and require the worker to measure every candidate — including the top-ranked one — before adopting any; a brief that says "in order of preference" without that instruction invites a compliant worker to ship the chair's untested guess as a fix.
- **D091:** Scope the acceptance criterion to the blast radius — a refactor touching every file in `hooks/`+`tools/` must gate on the full suite, never on targeted tests plus `prism-installer.mjs verify`, because `verify` proves presence, wiring, drift and installed-tree import resolution but proves NOTHING about behaviour or about test-fixture integrity.
- **D090:** When the Locked-adjudication count pushes the standing-rules block to its cap, raise `regenerateStandingRules`'s `cap` default (never the `MEMORY_MD_HARD_CAP_BYTES` byte ceiling, and never `orderNewestFirst`'s tiebreak) by only as much as the measured eviction set requires, and re-verify actual post-change membership and byte size before calling it done.
- **D089:** When an `Agent()` dispatch carries `name:`, append `TEAMMATE_REPORT_REQUIRED` to the worker prompt OUTSIDE the shared `FOOTER` constant — never by adding a clause to `FOOTER` itself, which stays locked at 6 clauses / 1100 chars per D057 §2.
- **D088:** A `commands/*.md` whose PROTOCOL section writes a persistent file that other tooling later reads as machine state (e.g. `roster.json`) may not stay prose-only — it needs a backing script, or it must be documented as unverifiable/best-effort until one exists. A prose-only doc that only reports, delegates, or performs read-only transforms needs no script.
- **D087:** Only the CHAIR may write the shared turn-tier sentinel — gate the dispatch-guard's `.prism-turn-tier-*.json` exemption on `CLAUDE_CODE_CHILD_SESSION !== '1'` and suppress the tier-override directive on the same predicate, always failing OPEN (env absent, non-`'1'`, or throwing → ALLOW) and LOGGING the fail-open; never broadcast an instruction to write state you then deny.
- **D085:** Implement D083's three recall repairs as decided — inline lesson text (no pointer), raise the standing-rules cap to 30 leaving the tiebreak untouched, and log every lesson-match invocation including the no-match and index-unavailable paths — and do not re-open the four rejected alternatives.
- **D084:** Scope every acceptance check to the exact region it is asserting about — a check that greps a whole artifact whose prose discusses the identifier under test is self-satisfying and will report GREEN against an unfixed system.
- **D083:** Before building any new recall/injection channel, repair and instrument the delivery layer that already exists — a Locked adjudication with a valid `**Rule:**` line can be silently evicted from the always-on layer by an arbitrary sort key while 41% of the byte budget sits unused, and `hooks/prism-lesson-match.mjs` emits no log on any path, so no recall failure-rate can be computed to justify anything.
- **D081:** In a parallel batch, deployment is a single post-batch step owned by the orchestrator; workers may run read-only `verify` but must never run `install`.
- **D080:** A finding observed in model-improvised code must be verified against a shipped artifact — and name the specific file+line it would be fixed in — before it is promoted from observation to fix task.
- **D079:** Hooks must hand the model already-resolved absolute paths, never `~` forms.
- **D078:** A natural-path panel probe is only valid with zero mechanism coaching — the chair asking clarifying questions about the problem domain is legitimate, but coaching the chair on the exact file-write/instrumentation mechanics needed to trip the hooks invalidates the probe.
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
