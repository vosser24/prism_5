# SEAT 1 (ARCHITECTURE) — Phase-4 fixture + artifact-attribution

**Stance:** YAGNI / adversarial. **No scaffolded code.** A structured-ADR-only
fixture is the lightest design that yields *cleaner* git-blame attribution than
code-scaffolding would. Survival becomes a git-computable binary over labeled
decision lines, not a prose rubric and not an aesthetic call.

---

## 0. The crux, resolved honestly

The 6 tasks' `expected_artifact` is, verbatim, "a written design decision
(ADR-style)." There is **no application code** any arm is asked to produce. So
the naive impulse — "scaffold a schema/code so the stress session can `git blame`
real lines" — is building a thing the prompt never asked for. Worse, it would
*inject* an arm signature (Arm A panels love to emit code blocks; Arm C vanilla
sonnet may not), feeding exactly the detectability that voided Item 6.

**Decision: we git-blame ADR *decision-lines*, not code.** The design artifact
is itself the blame target. We make blame meaningful by *constraining the ADR to
one normative claim per line*, each line carrying a stable machine ID. The stress
session edits that file. Whether a tagged decision-line was modified is a clean
`git blame` binary. This is lighter than code AND tighter on attribution, because
a decision-line is atomic where a code diff is fuzzy (reformat vs. rework).

---

## 1. Recommended fixture structure

**One shared repo, one subdir per task. No branches.** Branch-per-(task,arm,
session) is rejected (see §5) — it fights the pre-registered linear-tag scheme
in Non-Negotiable #1, which assumes a never-reset, never-squashed commit chain
that `git blame` walks. Branches fragment that chain and invite merge noise that
pollutes blame.

```
tests/v3/bench/phase4/
  tasks-v1.json                 # frozen (exists)
  rework-checklist-v1.json      # frozen, SHA-pinned (Seat 2 owns content)
  arena/                        # the fixture repo subtree the harness commits into
    P4-01/
      DESIGN.md                 # design stage writes ONLY this
      STRESS.md                 # stress stage appends its rework log ONLY here
    P4-02/ ... P4-06/
```

Per (arm, session) the harness creates a **clean checkout of the task subdir
from the frozen template**, runs the stage, then commits + tags
`phase4/<task_id>/<arm>/<session_id>`. Design and stress are **two commits in
the same linear history** on one branch (`phase4-arena`), design first.

**What each session physically writes:**
- **Design session** → writes `arena/<task>/DESIGN.md` only. One file. The harness
  commits it under the design tag. This is the blame baseline.
- **Stress session** → is handed the committed `DESIGN.md` plus the task's
  `stress_dimension`, and instructed: "satisfy this new requirement by editing
  the DECISIONS block in place where the existing decision no longer holds; log
  what you changed in `STRESS.md`." The harness commits under the stress tag.

Attribution = `git blame arena/<task>/DESIGN.md` after the stress commit: every
DECISIONS line still blaming the **design** commit survived; every line now
blaming the **stress** commit was reworked.

---

## 2. The artifact layout that makes blame work (DESIGN.md skeleton)

The file is a fixed template. The design session fills the slots but **must keep
the `## DECISIONS` block as one normative claim per physical line**, each prefixed
with a stable decision ID `D<task>.<n>` that maps to the task's `expected_artifact`
sub-claims and to checklist items. The harness lints this shape before committing
(reject + retry if violated) so no arm can dodge attribution by going vague or
multi-line.

### Skeleton — P4-06 (caching/consistency)

```markdown
# P4-06 — Caching & consistency design decision

## CONTEXT
Read-heavy catalog, 10M req/day, freshness <30s. (prose; NOT blamed)

## DECISIONS
<!-- one normative claim per line; ID-prefixed; this block is the blame target -->
D6.1 cache_pattern = write-through            ; checkout reads must never serve stale price
D6.2 invalidation = event-driven-CDC          ; NOT TTL-only
D6.3 topology = L1-local + L2-shared-redis
D6.4 worst_case_staleness_bound = 5s          ; explicit numeric bound
D6.5 global_flush_mechanism = pub-sub-fanout  ; bounded, not lazy-TTL

## RATIONALE
(prose; NOT blamed — free-form so arm style lives here, away from the binary)

## REJECTED
(prose)
```

Mirror for **P4-01 (ledger)**: `D1.1 storage_model = event-sourced`,
`D1.2 events_table_schema = (seq, agg_id, type, payload, ts) INDEXED on (agg_id,seq)`,
`D1.3 projection_strategy = snapshot+incremental`, `D1.4 replay_30d_target = <10s`,
`D1.5 migration = strangler-dual-write`.

**Why this shape:** the numeric/enum RHS of each `D*` line is what the stress
attacks. A strong design pre-writes the robust value (`D6.2 = event-driven-CDC`,
`D6.4 = 5s`); the stress requirement is already satisfied → **0 lines rebased to
the stress commit → SURVIVES**. A weak design wrote `D6.2 = TTL-30s` → the stress
("flush globally within 5s") forces editing that line → **blames stress → FAILS**.

Prose (CONTEXT/RATIONALE/REJECTED) is deliberately quarantined OUT of the blame
target so arm-signature verbosity cannot move the binary metric.

---

## 3. Distinguishing forced-rework from unrelated new code

Three discriminators, all git-computable, no judgement:

1. **Scope = the DECISIONS block only.** Blame is read solely over the `##
   DECISIONS … ## RATIONALE` line range (harness extracts by header markers).
   New prose the stress session adds elsewhere is invisible to the metric. So
   "stress added unrelated content" cannot register as rework by construction.
2. **Modified-vs-appended.** A *reworked* decision = an existing `D*.n` line
   whose blame flips from design-commit→stress-commit (same ID, changed RHS). A
   stress session *appending* a brand-new `D*.k` line is NOT rework of the design
   — it blames the stress commit but has no design-commit ancestor for that ID,
   so it scores as "new", not "rework". The checklist keys on **ID-stable line
   mutation**, not raw line count.
3. **Per-item binding.** Each checklist `RC-###` names a specific `D*.n` and the
   predicate "blame(D*.n) == design_sha". PASS = the design's line still stands
   after stress. This makes survival a per-decision binary, summed to the
   session's ≥80% threshold — exactly the pre-reg schema, now with a concrete
   line to point `check` at.

The harness computes, per task, per session:
`git blame -L <decisions-range> -- arena/<task>/DESIGN.md --porcelain`, maps each
`D*.n` to its introducing commit, and emits PASS/FAIL per checklist item. Zero
prose, zero human.

---

## 4. Single biggest validity threat in MY design (stated honestly)

**The stress session can game attribution by *rewriting RATIONALE prose instead
of the DECISIONS line* — fixing the flaw in words while leaving the blamed line
frozen, producing a false SURVIVE.** My blame-the-decisions-block scheme is only
valid if the stress session is *forced* to express its fix as a DECISIONS-line
mutation. If the stress agent satisfies the new requirement by adding prose
("we'd now invalidate via CDC") without touching `D6.2`, blame shows 0 reworked
lines → false positive survival → inflates EVERY arm equally but adds noise that
can swamp a true 10pp gap.

Mitigation (and it is imperfect): the stress harness prompt must mandate "encode
any changed decision by editing the corresponding `D*.n` line; STRESS.md must
list the IDs you changed," AND a cheap post-hoc consistency lint flags any task
where STRESS.md claims a changed decision but blame shows the line unmoved
(→ that session is excluded, not silently scored). This is a real residual risk,
not fully closed by structure alone. I will not pretend it is.

---

## 5. Where I DISAGREE with the naive approach

1. **Naive: scaffold real code/schema so blame has "real" lines.** Rejected.
   The prompts ask for a *written decision*, not code. Scaffolding (a) builds
   unrequested work, (b) injects arm-correlated structure (code blocks) that
   feeds the manipulation-check detectability failure, and (c) makes blame
   *fuzzier* (reformat-vs-rework ambiguity in code diffs). The decision-line is
   the smaller, cleaner, more honest blame unit. **YAGNI.**
2. **Naive: branch-per-(task,arm,session).** Rejected. It fractures the linear
   never-reset commit chain that Non-Negotiable #1's `git blame` attribution
   depends on, and adds merge-base noise. One shared repo, one linear branch,
   subdir-per-task, two commits (design→stress) per session lane is sufficient
   and matches the pre-registered tag format directly.
3. **Naive: "survival = no rework needed" judged as prose.** Rejected — that is
   the exact rubric/aesthetic trap that voided Item 6. Survival must reduce to
   `blame(D*.n) == design_sha`. If a design "survives by being vague," the harness
   lint that rejects non-atomic / value-less DECISIONS lines at design-commit
   time prevents the vague artifact from ever being committed — vagueness is a
   commit-time reject, not a survival path.
