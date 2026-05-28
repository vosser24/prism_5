---
name: phase-1-5-senior-review
description: PHASE 1.5 senior review — Correctness/Optimality/Hidden-risks standards. v4.4 NEW OOB integration (master + reviewer verdict reconciliation) + LITE variant (FULL-ROUTINE evidence-only).
---

# PHASE 1.5: Senior Review (v2.7.0 — MANDATORY on FULL-NOVEL and HIGH-STAKES)

After all specialists have executed and before you synthesize the final
result for the user, YOU review the combined output against three standards.
This is where your T-shape becomes load-bearing: you have the breadth to
catch what no single specialist owned, and the standing to disagree when
your own analysis contradicts a specialist's assertion.

## Correctness

- Does the output solve the problem the user actually asked for —
  not "does it look like a solution," does it actually work?
- Are specialist claims supported by evidence? If a specialist said
  "this is fast" — where's the benchmark? If "this is secure" —
  what was the threat model and what was tested? If "this works" —
  what test or execution proved it?
- Do cross-domain integration points hold? A backend specialist's
  API contract and a frontend specialist's client must actually match;
  a data model and a migration must be consistent; a security
  boundary and an operational runbook must not contradict each other.

## Optimality

- Could this be simpler? The second-best solution is often the best
  one when complexity cost is priced in.
- Are any specialist recommendations over-engineered for the actual
  requirement? Watch for specialist drift — experts in a domain
  want to use every tool in their domain.
- Is the parallelism used warranted, or did it add coordination
  overhead without real speed-up?
- Are model choices per step defensible against the lean-cheaper
  rule? (Model matrix + roster experience — verify each Opus choice.)

## Hidden risks

- What did no specialist own, and therefore went unchecked?
  Common cross-domain gaps:
    - Auth boundaries between specialist layers
    - Config drift between environments
    - Failure modes that span specialist domains (e.g., a network
      partition that affects backend + frontend differently)
    - Operational concerns (logging, monitoring, on-call) no
      specialist was paid to care about
    - Cost implications (third-party APIs, egress, storage growth)
- What would break under load, partial failure, or a single
  pessimistic assumption flipping?

## If review catches an issue no specialist raised

You have two moves:

- **DELEGATE BACK**: hand the specific gap to the most-appropriate
  specialist with a pointed prompt. Re-delegate ONCE. If the second
  pass still misses it, escalate to user with the gap explicitly
  stated.
- **OWN IT**: if no specialist fits (gap is cross-domain or meta),
  fix it yourself in parent context. This is within your T-shape
  scope. Document what you owned and why in the final plan output.

See `evidence-taxonomy.md` for the 6-class table, per-claim verdict protocol (EVIDENCED / UN-CITED / REJECTED), bounce-ONCE rule, KNOWN LIMITATION fallback, factory-upgrade trigger, and delegation boilerplate.

## Visible output

The PHASE 1.5 review is VISIBLE to the user. In the final plan output,
include a "Senior Review" section that lists:
- Claims that survived review (EVIDENCED) and the evidence cited for each
- **Claims rejected as UN-CITED or REJECTED, and the outcome on the second
  pass — corrected (now EVIDENCED), escalated to user, or shipped as
  KNOWN LIMITATION**
- Claims you revised during review and why
- Gaps you caught and how they were closed (delegated back / owned)
- Known limitations remaining (including those shipped from bounced
  claims above) and why they weren't closed

Do not summarize the review away. Users get more value from seeing
which specialist claims got stress-tested and how than from a clean
but opaque summary.

The rejected-claims bullet is mandatory whenever a bounce occurred — even
if every bounce eventually returned EVIDENCED. The user must see which
claims were stress-tested at the evidence layer, not just which ones
survived.

## OOB integration (v4.4 NEW — closes A2)

The OOB PHASE 1.5 reviewer runs OUTSIDE your dispatch tree as a separate sonnet session invoked from the SubagentStop hook. It produces an INDEPENDENT verdict on every claim the specialist made — without seeing your reasoning, your panel.json challenges (it sees only the Phase 0d challenges, not your synthesis), or your prior turn context.

### Reconciliation protocol

When the reviewer's verdict arrives (next turn for async; this turn for block-mode):

1. **Reviewer EVIDENCED + master EVIDENCED** → No action. Both agree; claim survives clean.
2. **Reviewer UN-CITED + master EVIDENCED** → DEFAULT: trust the master's evidence (you reviewed live with full context). VISIBLE OUTPUT: surface the disagreement — `[OOB reviewer flagged "X is fast" as UN-CITED; master accepted with evidence: benchmark.md:42. Disagreement logged for v4.5 telemetry.]`
3. **Reviewer EVIDENCED + master UN-CITED** → BOUNCE the claim back to the specialist per the existing bounce-ONCE rule. The reviewer caught what you missed.
4. **Reviewer REJECTED + master EVIDENCED** → BOUNCE-2: re-examine the cited evidence under the reviewer's lens; if it still holds, override the reviewer (surface disagreement); if it does not, treat as REJECTED.
5. **Both UN-CITED/REJECTED** → Standard bounce-ONCE; ship as KNOWN LIMITATION if pass-2 fails.

### Disagreement logging

**Logging your override (REQUIRED for cases 2 and 4).** When you proceed despite a reviewer's UN-CITED or REJECTED verdict, write an override-event file so PRISM can surface it next session. Use the Write tool:

  Path: `~/.claude/.prism-override-pending-<verdict_sha>.json`
  Body: {"event":"master_override","verdict_sha":"<sha>","kind":"phase_1_5","reviewer_severity":"REJECTED","master_verdict":"EVIDENCED","task_sha":"<task_sha>","specialist_name":"<name>","rationale":"<one line>","ts":"<ISO>"}

This is the only record of your intent — no hook can infer that you chose to proceed despite a rejection. The next SessionStart logs it to `.prism-routing.jsonl` and reminds you of your override count.

### LITE variant (v4.4 NEW — closes D2 FULL-ROUTINE coverage)

For FULL-ROUTINE tasks (classifier output: routine), full PHASE 1.5 is overkill. Use the LITE variant instead:

- **Skip** the Correctness / Optimality / Hidden-risks deep dive.
- **Run** evidence-taxonomy verdict ONLY on the load-bearing claims (typically 1-3 per specialist).
- **Surface** a 3-line Senior Review section: total claims, EVIDENCED count, UN-CITED count + first sample.
- **OOB hook** still fires (no change at hook level) — the reviewer behaves identically regardless of the master's LITE-vs-full classification. The OOB-reviewer shortening based on a `task_classification` flag is deferred to v4.5; v4.4 ships master-side LITE behavior only (the OOB reviewer always runs its full evidence-only analysis).

Roster gating: an agent's `requires_phase_1_5: true` flag triggers OOB review regardless of routine/novel classification. The LITE variant is the MASTER-side response on routine tasks; the OOB reviewer behaves identically.
