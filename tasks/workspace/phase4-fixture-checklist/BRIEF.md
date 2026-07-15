# PANEL BRIEF — Phase-4 fixture + rework-checklist operationalization

**You are a seat on an adversarial design panel.** The Master Orchestrator
(PRISM project-master) will chair ≥2 substantive challenges against your
position before synthesis. Take a real stance; defend it; expose its weaknesses
honestly. Do NOT role-play agreement.

## The decision this measurement supports (why rigor matters)

PRISM auto-fires a multi-agent "expert panel" on NOVEL architecture prompts.
That costs real money. The Phase-4 experiment decides — on a PRE-REGISTERED
decision rule — whether to KEEP or RETIRE that auto-fire default. The primary
metric is **rework-survival** on architecture-design tasks. If we operationalize
rework-survival sloppily, the whole experiment voids (it cost ~$20-30 to run).

## THE FAILURE MODE YOU MUST PREVENT (this already happened — Item 6)

The prior benchmark (Item 6) tried a "rework" quality leg. It was declared
**NOT RUNNABLE** because: (1) there were **no per-session commits** to git-blame
against, and (2) there was **no frozen, enumerated, binary checklist** defining
what "rework" meant. The quality leg also failed a manipulation check: a blind
judge guessed the arm 6/6 (p=0.016) — the arm's structural signature (length,
panel artifacts) was DETECTABLE, voiding aesthetic judging. Your design must be
immune to BOTH failure modes.

## LOCKED SCOPE — stay inside this

**IN scope (design these):**
1. **Fixture structure.** What does a "design session" actually write, and where?
   One git repo per task, or one shared repo? Does the design session produce an
   ADR-style markdown decision, a scaffolded code/schema artifact, or both? How
   does it produce a git-blame-able artifact so a later stress session's rework
   is attributable to specific lines the design wrote?
2. **Rework-checklist binary items.** The concrete, frozen, yes/no items (per
   task, or a shared template) that operationalize "did the design SURVIVE the
   stress, or did it require rework?" Survival must be a clean binary computable
   from git diff / git blame — NOT a prose rubric, NOT an aesthetic judgement.
3. **Attribution mechanics.** How we tell "the stress forced rework of a design
   decision" apart from "the stress session just added new unrelated code."

**OUT of scope (PRE-REGISTERED — do NOT re-litigate; assume fixed):**
- The 3 arms: A=panel, B=PRISM_PANEL_DISABLED (orchestrator-only), C=vanilla sonnet.
- 6 tasks × 2 stages (design + stress); n=6 per arm.
- The decision rule (A survival > B by ≥10pp at Fisher p<0.10 → keep panel).
- Machine-tagged commit format `phase4/<task_id>/<arm>/<session_id>` (a harness builds it).
- The ≥3-blind-judge manipulation check (that is the SECONDARY metric).

## REQUIRED READING (read these before forming your position)

- `docs/prism/specs/2026-06-23-PRISM-6.0.0-ACCEPTANCE-AND-PHASE4-PREREG.md`
  lines ~190-362 (the Phase-4 section: metric definition, 3 non-negotiables,
  decision rule). The rework-checklist FORMAT is sketched at lines 236-266.
- `tests/v3/bench/phase4/tasks-v1.json` — the 6 tasks. EACH has a `prompt`
  (design stage), a `stress_dimension` (stress stage — the requirement that
  attacks a specific trade-off), and an `expected_artifact` (what the design
  must write down). Your checklist items must bind to these per-task fields.

## THE CORE TENSION you must resolve

Each task's `stress_dimension` "attacks the X trade-off the design made and
forces rework IF it chose naive Y." So a STRONG design pre-empts the stress
(picks the robust option up front → 0 rework → SURVIVES); a WEAK design picks
the naive option → stress forces rework → FAILS. Is that the right
operationalization? Is "survival = no rework needed" measurable as a clean
binary? What stops a design from trivially "surviving" by being vague? What
stops the stress session from "reworking" for reasons unrelated to design
quality? Resolve these.

## DELIVERABLE (write to your seat file, also return a tight summary)

1. Your recommended fixture structure (concrete: dirs, files, what each session writes).
2. Your recommended rework-checklist schema + 2-3 SAMPLE binary items bound to
   actual tasks in tasks-v1.json (e.g. for P4-06 caching, P4-01 ledger).
3. The single biggest validity threat in your own design, stated honestly.
4. Where you DISAGREE with the obvious/naive approach and why.
