# SEAT 2 — MEASUREMENT METHODOLOGY

**Lens:** experimental-methodology / causal-inference skeptic. Goal: make the
rework-survival metric unfalsifiable-proof and immune to the two Item 6 failure
modes (no frozen binary checklist; arm detectable by a judge).

---

## 0. The reframe that defeats the whole problem

The naive operationalization — **"SURVIVAL = the stress required no rework"** — is
**fatally confounded** and must be rejected as the primary signal. Two reasons:

1. **The vagueness exploit.** A design that commits to nothing reworkable
   trivially "survives." If Arm C writes *"we'll use an appropriate caching
   strategy with invalidation as needed,"* there is no line to git-blame, no
   decision to rework → 0 rework → SURVIVES. This **inverts the metric**: the
   *worst* (least committal) designs score *best*. This alone voids a
   rework-only metric.

2. **Rework is observed in the WRONG session.** "Did rework happen" is measured
   in the N+1 stress session, whose behavior depends on the stress-executor's
   diligence, not just the design's quality. A lazy stress session that adds new
   files instead of editing design lines produces a false "survive."

**Fix — survival is a TWO-FACTOR conjunction, both git-computable, the first
scored BEFORE the stress is ever applied:**

> **SURVIVAL(session) = COMMITMENT(design) AND ROBUSTNESS(under stress)**
>
> - **COMMITMENT** = the design made all K pre-enumerated falsifiable decisions
>   for this task (each present/absent, scored on the design commit ALONE,
>   blind to arm, before stress). A vague design **fails here** → NON-SURVIVING.
> - **ROBUSTNESS** = for the specific decision the stress attacks, the chosen
>   option is the stress-robust one (computable from the design artifact text +
>   git blame), so the stress forces **no edit** to the design's load-bearing
>   lines.

This turns "vagueness" from a winning exploit into an automatic fail, and makes
the primary number computable from **the design commit**, largely independent of
how the stress session behaves. The stress session becomes a **confirmation
check**, not the primary measurement surface.

---

## 1. Precise binary definition of SURVIVAL (git-computable)

Per task `t`, arm `a`, session `s`:

```
DESIGN_COMMIT  = commit tagged phase4/<t>/<a>/<s>     (design stage)
STRESS_COMMIT  = commit tagged phase4/<t>/<a>/<s>+stress (stress stage)
ARTIFACT       = the expected_artifact file the design wrote (ADR markdown)
```

For each task, the checklist enumerates **K commitment items** (`C1..CK`) and
**exactly 1 robustness item** (`R1`, the one the `stress_dimension` attacks).
Each is a flat YES/NO computable from `git blame ARTIFACT` (which line, which
commit) plus a frozen literal-token presence test against the line text.

```
COMMITMENT(s)  = AND over C1..CK   (every required decision is present & blamed to DESIGN_COMMIT)
ROBUSTNESS(s)  = R1 == YES          (the attacked decision's line names the robust option,
                                     NOT the naive option, introduced in DESIGN_COMMIT)
SURVIVED(s)    = COMMITMENT(s) AND ROBUSTNESS(s)      → strict binary
```

**Confirmation cross-check (anti-gaming, not the primary number):**
`git diff DESIGN_COMMIT..STRESS_COMMIT -- ARTIFACT` on the R1 line.

```
REWORK_OBSERVED(s) = the R1-blamed line is modified in STRESS_COMMIT
```

We assert the invariant `ROBUSTNESS==YES  ⇒  REWORK_OBSERVED==NO` and
`ROBUSTNESS==NO ⇒ REWORK_OBSERVED==YES`. Any session violating this invariant is
**flagged as instrumentation-invalid and excluded** (not silently coerced) — this
catches a lazy stress session that "reworked elsewhere." Survival itself is
decided by COMMITMENT∧ROBUSTNESS on the design commit, so it does not hinge on
the stress executor's diligence; the diff only *validates the apparatus*.

**Why scored on the design commit, blind, before stress:** this removes the
N+1-session confound and makes the metric a property of the design, which is what
the experiment actually wants to measure (did the *panel* produce a more robust
design).

---

## 2. Rework-checklist JSON schema + sample items bound to real tasks

`tests/v3/bench/phase4/rework-checklist-v1.json` (frozen, SHA recorded before run 1):

```json
{
  "version": "1",
  "committed_before_run_1": true,
  "scored_on": "design_commit",
  "blind": true,
  "tasks": {
    "P4-06": {
      "artifact_glob": "P4-06/decision.md",
      "commitment_items": [
        {
          "id": "P4-06-C1",
          "decision": "cache pattern selected",
          "check": "blame(artifact) line matching /(cache-aside|read-through|write-through)/i was introduced in DESIGN_COMMIT",
          "type": "commitment"
        },
        {
          "id": "P4-06-C2",
          "decision": "invalidation strategy selected",
          "check": "blame line matching /(TTL|time-to-live|CDC|change-data-capture|event-driven)/i introduced in DESIGN_COMMIT",
          "type": "commitment"
        },
        {
          "id": "P4-06-C3",
          "decision": "explicit worst-case staleness bound stated as a number+unit",
          "check": "blame line matching /\\b\\d+\\s*(s|sec|seconds|ms)\\b/ within 5 lines of a staleness/freshness token, introduced in DESIGN_COMMIT",
          "type": "commitment"
        }
      ],
      "robustness_item": {
        "id": "P4-06-R1",
        "decision": "invalidation mechanism must support sub-5s global flush (stress: 60s-live wrong-price rollback)",
        "attacked_by": "stress_dimension: pricing rollback must flush all caches globally within 5s",
        "robust_token_re": "/(CDC|change-data-capture|event-driven|write-through|explicit flush|active invalidation|publish.{0,20}invalidat)/i",
        "naive_token_re": "/(TTL|time-to-live|passive expir|lazy expir)/i",
        "check": "YES iff the C2 invalidation line matches robust_token_re AND NOT (naive_token_re AND no robust token present); blamed to DESIGN_COMMIT",
        "type": "robustness"
      }
    },

    "P4-01": {
      "artifact_glob": "P4-01/decision.md",
      "commitment_items": [
        {"id":"P4-01-C1","decision":"storage model selected","check":"blame line matching /(event-sourc|append-only|ES\\b|CRUD|mutable balance)/i in DESIGN_COMMIT","type":"commitment"},
        {"id":"P4-01-C2","decision":"projection strategy named","check":"blame line matching /(projection|snapshot|materializ|read model)/i in DESIGN_COMMIT","type":"commitment"},
        {"id":"P4-01-C3","decision":"migration phasing stated","check":"blame line matching /(phase|dual-write|backfill|cutover|strangler)/i in DESIGN_COMMIT","type":"commitment"}
      ],
      "robustness_item": {
        "id":"P4-01-R1",
        "decision":"projection must replay 30-day window <10s + immutable correction trail <24h",
        "attacked_by":"stress_dimension: regulatory replay-window + immutable retroactive-correction trail",
        "robust_token_re":"/(snapshot|materializ|pre-?computed projection|indexed event stream|incremental projection)/i",
        "naive_token_re":"/(rebuild from scratch|full scan|naive CRUD|un-?indexed|recompute all)/i",
        "check":"YES iff C2 projection line matches robust_token_re AND not naive-only; blamed to DESIGN_COMMIT",
        "type":"robustness"
      }
    },

    "P4-02": {
      "artifact_glob": "P4-02/decision.md",
      "commitment_items": [
        {"id":"P4-02-C1","decision":"isolation model selected","check":"blame line matching /(shared-?schema|row-level-security|RLS|schema-per-tenant)/i in DESIGN_COMMIT","type":"commitment"},
        {"id":"P4-02-C2","decision":"enforcement layer selected","check":"blame line matching /(API layer|database layer|DB layer|policy enforcement)/i in DESIGN_COMMIT","type":"commitment"},
        {"id":"P4-02-C3","decision":"claims strategy selected","check":"blame line matching /(JWT|token|claims|DB-backed|database lookup)/i in DESIGN_COMMIT","type":"commitment"}
      ],
      "robustness_item": {
        "id":"P4-02-R1",
        "decision":"mid-session demotion must take effect without waiting for JWT expiry",
        "attacked_by":"stress_dimension: tenant admin demoted mid-session, no wait for JWT TTL",
        "robust_token_re":"/(DB-backed|database lookup|short-?lived token|revocation list|denylist|introspection|session lookup|per-request check)/i",
        "naive_token_re":"/(long-?lived JWT|permissions in (the )?token|claims embedded|stateless JWT only)/i",
        "check":"YES iff C3 claims line matches robust_token_re AND not naive-only; blamed to DESIGN_COMMIT",
        "type":"robustness"
      }
    }
  }
}
```

Schema is flat YES/NO, NO prose rubric. Each item names **the specific decision**
and (for R1) **the specific stress that attacks it**. All checks are
regex-token-presence against blamed lines — deterministic.

---

## 3. The "vague design survives trivially" defense

Three layered guards, in order of strength:

1. **COMMITMENT gate (primary defense).** A design must make all K enumerated
   decisions, each present as a blamed line, BEFORE any survival credit. Vague =
   missing C-items = `COMMITMENT=NO` = NON-SURVIVING. The exploit is converted
   into a fail. This is the single most important design choice in this seat.
2. **Token discrimination on R1.** Robustness requires the *robust* token to be
   present; the presence of the *naive* token without a robust one fails R1. A
   design can't satisfy R1 by hand-waving — it must name the robust mechanism.
3. **Confirmation invariant (§1).** The blame-and-diff cross-check catches the
   residual case where a design names a robust mechanism but the stress still had
   to edit it — that session is flagged invalid, not scored as survive.

The artifact is a **single enumerated ADR file per task** with **required named
headings** (e.g. `## Decision: Cache Pattern`, `## Decision: Invalidation`,
`## Worst-case staleness bound`) so the C-items have stable blame targets. The
harness seeds the empty headed template into each arm's repo at design-stage
start; the design session fills under the headings. This makes "did it commit"
a structural, not stylistic, question — **and is arm-neutral** (all arms get the
identical template), which is essential for §4.

---

## 4. Scoring mechanism + blindness / arm-undetectability

**Scoring is a DETERMINISTIC SCRIPT, not a judge.** This is the decisive break
from Item 6. Item 6 leaked because a *human/LLM judge* could read structural
arm signatures (length, panel artifacts). A regex-over-git-blame scorer:

- reads only the K+1 blamed lines under fixed headings,
- emits YES/NO per item with zero discretion,
- is **re-runnable and reproducible** by anyone from the tagged commits + the
  frozen checklist SHA — inter-rater reliability is **κ = 1.0 by construction**
  (the script is the only rater; two runs always agree).

**How it stays arm-undetectable:** the scorer never sees prose volume, never
sees session transcripts, never sees panel artifacts — only whether a token is
present on a headed line introduced by the design commit. Length, structure, and
"panel feel" are **invisible to the metric**. The Item 6 6/6 leak is structurally
impossible here because there is no judge to leak to.

**Why no judge for the PRIMARY metric:** any human/LLM judge re-imports the Item 6
detectability problem. The ≥3-blind-judge manipulation check stays as the
SECONDARY metric (per pre-reg, out of my scope to change) — but it must never feed
the survival number. I recommend an explicit firewall: judges never see the
artifact files the scorer reads, only style-normalized excerpts, to keep the two
metrics independent.

**One discretion residue I will flag honestly:** writing the regex token sets *is*
a human judgement, made once, frozen, SHA-locked before run 1. That judgement is
auditable and identical across all arms, so it cannot bias one arm over another —
but a poorly chosen token set could make a task trivially pass/fail for *all*
arms (a sensitivity problem, see §5).

---

## 5. Honest statistical-power reality + biggest threat to MY design

### Power at n=6/arm, binary outcome — brutal, and in-scope to flag

Fisher's exact, one-tailed, 6 vs 6, is **severely underpowered**. Concrete numbers:

- To even reach the pre-registered bar (A>B by ≥10pp at p<0.10) with 6/6, the
  observed split essentially must be near-separated. A realistic detectable
  contrast is roughly **6/6 survive in A vs ≤2/6 in B** (a ~67pp *observed* gap)
  before Fisher one-tailed clears p<0.10. Example: **6/6 vs 3/6 → p ≈ 0.18**
  (FAILS). **6/6 vs 2/6 → p ≈ 0.06** (passes). **5/6 vs 1/6 → p ≈ 0.04**
  (passes).
- So the decision rule's "≥10pp" is **not the binding constraint** — the
  p<0.10 gate with n=6 demands a far larger *observed* separation (~50-67pp).
  A true 10pp effect is **undetectable** here; power against a 10pp true effect
  is in the low single-digit-percent range. We are powered only to detect
  **large** effects (≈50pp+), i.e. "panel either obviously helps or we report a
  null we cannot distinguish from low power."
- **Honest framing for the decision:** a PASS is credible (large real effect); a
  FAIL is **ambiguous** — it could be a true null OR a real-but-moderate effect
  the design is blind to. The pre-reg already routes FAIL → retire auto-fire;
  that is defensible *as a cost decision* (if the lift isn't large enough to
  surface at n=6, it isn't worth the panel's money), but it must NOT be reported
  as "panel proven to add no quality." It is "no LARGE quality effect detected at
  n=6." I recommend that exact wording in the null-result adjudication.

Mitigation within the fixed n: the binary 80%-PASS collapse throws away
information. I recommend ALSO logging the **per-item PASS count (0..K+1) per
session** as a pre-registered *secondary continuous-ish outcome* for a
Mann-Whitney U — same data, materially more power, does not touch the primary
decision rule. (Logging extra data is in-scope; it does not alter the locked rule.)

### The single biggest threat to MY OWN design

**Regex-token sensitivity / synonym brittleness.** The entire metric reduces to
"did a frozen regex match a blamed line." If a design expresses the robust
mechanism in words my token set didn't anticipate (e.g. writes *"we invalidate
proactively via the pricing topic"* and my `robust_token_re` for P4-06 missed
"topic"-style phrasing), a genuinely robust design scores FAIL. Because the
checklist is **frozen before run 1**, I cannot fix this post-hoc without voiding
the experiment. This is a **construct-validity threat** that, unlike the
detectability threat, my design does not fully eliminate — it converts a
subjective-rubric risk into a frozen-regex-coverage risk.

**Defense (must happen before run 1, while the checklist is still mutable):**
adversarially **pre-test the token sets against ≥3 synthetic robust answers and
≥3 synthetic naive answers per task** (hand-written or from a throwaway model
run), confirm the scorer separates them, and record that calibration set + its
results alongside the SHA. The frozen artifact is only trustworthy if its
discrimination was demonstrated on held-out exemplars *before* freezing. Without
this pre-test, the metric is precise but possibly **not valid** — and precision
without validity is exactly the trap Item 6 fell into from the other direction.
