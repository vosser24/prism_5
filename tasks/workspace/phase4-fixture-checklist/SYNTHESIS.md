# Phase-4 fixture + rework-checklist — CHAIRED SYNTHESIS

**Chair:** master-prism-3 (orchestrator). **Date:** 2026-06-24.
**Inputs:** seat1-architecture.md, seat2-methodology.md, seat3-redteam.md.
**Protocol:** each position challenged ≥2× (anti-theater); refinements below
CHANGE the seats' proposals where challenge succeeded.

---

## Adversarial review — challenges that landed (not theater)

### Crux conflict: design-text scoring (Seat 2) vs stress-rework scoring (Seat 1/3)
- **Seat 2 proposed:** SURVIVAL scored on the DESIGN commit alone — regex-token
  ROBUSTNESS check ("does the design name CDC?"); stress is only a cross-check.
- **CHAIR CHALLENGE (rejected as PRIMARY):** scoring robustness purely off the
  design text means we NEVER run the stress — we're grading the design against
  our own pre-frozen answer key. That is circular: the panel's "advantage"
  collapses to "did it mention more of our keywords," and it inherits the full
  regex-brittleness threat Seat 2 itself flagged as its biggest weakness.
- **RESOLUTION:** PRIMARY = **behavioral stress-rework** (Seat 1/3): actually run
  the stress, measure rework by git-blame on the named decision lines. Seat 2's
  design-text regex is DEMOTED to a **cross-check**, NOT discarded — its
  COMMITMENT gate and its blame⇔robustness invariant remain load-bearing.

### Seat 1 challenges
1. **(LANDED) Commit-time "reject + retry until the vagueness lint passes" would
   erase the signal.** If the harness force-retries a vague design into
   compliance, every arm gets unlimited tries to become committal — normalizing
   away the very committal-ness difference the experiment measures (Arm C is the
   naturally-vaguer arm). → **Drop force-retry for substance.** Vagueness is
   SCORED (→ DISQUALIFIED via Seat 3 T5 / Seat 2 COMMITMENT), not retried away.
   One retry allowed ONLY for hard format errors (didn't use the template at all).
2. **(Seat 1's own, mitigated)** Stress fixes RATIONALE prose, leaves the `D*.n`
   line frozen → false SURVIVE. → invariant cross-check + STRESS.md/blame
   consistency lint + superseding-file scan (Seat 3 T3); violating sessions
   EXCLUDED, not scored. Residual risk documented, not pretended-closed.

### Seat 2 challenges
1. **(LANDED) Design-text regex as primary is circular** (above) → demoted to
   cross-check.
2. **(LANDED) Regex brittleness** is real for any regex role. → MANDATORY
   pre-freeze calibration: token sets must separate ≥3 synthetic-robust and ≥3
   synthetic-naive exemplars per task; calibration set recorded with the SHA.
   Power caveat ADOPTED verbatim into the interpretation rule (below).

### Seat 3 challenges
1. **(ADOPTED — the silent killer) T1/T8 executor-machinery confound.** Stress
   stage MUST run under a FIXED vanilla Sonnet (no PRISM hooks, no panel), SAME
   executor for all arms. Becomes **Non-Negotiable #4.**
2. **(LANDED, chair refinement) A fixed stochastic stress executor has its OWN
   run-to-run variance** — same design could rework in one run, not another, at
   n=6. → stress runs at **temperature 0 / most-deterministic**, AND
   invariant-violating sessions are excluded. Seat 3 named the executor but not
   its determinism; this closes it.
3. T3 superseding-file false-negative needs a **directory scan**, not just blame
   → adopted. T4 cosmetic-reformat false-positive → score the decision VALUE
   (RHS token), not the line position; `--no-renames` diff. T6 stress-leakage →
   design session receives `prompt` ONLY; dry-run prompt-dump human sign-off.

---

## CONVERGED DESIGN (what we build)

### Fixture (Seat 1, refined)
- One shared repo subtree `tests/v3/bench/phase4/arena/<task>/`, ONE linear
  never-reset branch `phase4-arena`, NO per-session branches.
- Design session writes ONLY `DESIGN.md`; stress session edits `DESIGN.md`
  DECISIONS lines in place + logs IDs changed to `STRESS.md`. Two tagged commits
  per (task,arm,session): `phase4/<task>/<arm>/<session>` (design) and a
  `…+stress` stress tag.
- `DESIGN.md` has a fixed `## DECISIONS` block: ONE normative claim per physical
  line, ID-tagged `D<t>.<n> <field> = <value>`, enum/numeric RHS. Prose
  (CONTEXT/RATIONALE/REJECTED) quarantined OUT of the blamed range so arm
  verbosity can't move the metric. Harness lints the one-claim-per-line SHAPE
  (format only) before the design commit.

### Survival = three-layer binary (merged Seat 2 + Seat 1/3)
1. **COMMITMENT gate (prerequisite, scored on design commit, blind to arm).**
   All K required decisions present as ID-tagged blamed lines. Missing any →
   **DISQUALIFIED** (not surviving, not counted in denominator). Kills the
   vagueness exploit (Seat 2 §3, Seat 3 T5).
2. **PRIMARY: behavioral stress-rework.** Run the fixed vanilla-sonnet stress
   (temp 0). `SURVIVED` iff the attacked decision line `D<t>.R1` still blames the
   DESIGN commit after stress (no rework forced). Deterministic blame-diff on the
   RHS value; normalize denominator to NAMED-DECISION COUNT not lines (Seat 3 T2).
3. **CROSS-CHECKS (exclude on violation, don't coerce):** blame⇔robustness
   invariant (Seat 2 §1); superseding-file directory scan (Seat 3 T3); cosmetic
   reformat guard (T4); panel-firing confirmation `summon_panel=true` per Arm-A
   session (T10); `stress_dimension` withheld from design (T6).

### Scoring
- Deterministic script over git tags + blame + frozen `rework-checklist-v1.json`.
  κ=1.0 by construction. NO judge in the primary path (the Item-6 leak is
  structurally impossible — no judge to leak to). The ≥3-blind-judge check stays
  SECONDARY and firewalled from the survival number.

### Interpretation (Seat 2 power caveat — ADOPTED, binding wording)
- n=6/arm binary is powered only for LARGE effects (~50pp+ observed separation
  for Fisher one-tailed p<0.10; a true 10pp effect is undetectable).
- A PASS is credible. A FAIL MUST be reported as **"no LARGE quality effect
  detected at n=6"** — NOT "panel proven worthless." The null adjudication uses
  that exact wording.
- ALSO log per-session per-item PASS count (0..K) as a pre-registered SECONDARY
  continuous outcome (Mann-Whitney U) for more power — does NOT touch the locked
  primary decision rule.

### New non-negotiable to add to the pre-reg
- **Non-Negotiable #4 — fixed arm-agnostic stress executor:** all stress sessions
  run vanilla Sonnet, temp 0, no PRISM hooks/panel, identical across arms.
  **USER-APPROVED REFINEMENT (2026-06-24): K=3 majority-vote** — run the fixed
  stress executor 3× per design; survival outcome = majority of the 3 runs.
  Dampens run-to-run stochasticity at n=6. Cost: 18 designs → 54 stress runs.

## USER APPROVALS (2026-06-24)
- Build preconditions (a)+(b) now; PAUSE for approval before (c) harness and
  (d) 6.0.0-merge-to-main. (#16, #17 this cycle; #18, #19 next.)
- Stress executor = fixed vanilla Sonnet temp-0, **K=3 majority-vote** (above).

---

## DELIBERATELY NOT DOING
- No scaffolded application code (YAGNI; injects arm signature; fuzzier blame).
- No per-session branches (fractures the blame chain).
- No LLM/human judge in the PRIMARY metric.
- NOT changing the locked OUT-of-scope items (arms, decision rule, judge count).
- NOT force-retrying vague designs into compliance (would erase the signal).
- NOT claiming the metric measures lifetime amortized rework — it measures design
  robustness to ONE pre-specified downstream attack (documented limitation).
