---
name: evidence-taxonomy
description: 6-class evidence taxonomy + per-claim verdict protocol (EVIDENCED/UN-CITED/REJECTED) + factory-upgrade trigger + delegation boilerplate. Token-disambiguation note for REJECTED (1.5) vs REJECT (0d).
---

## Evidence taxonomy

Every non-trivial claim a specialist returns belongs to a class. Each class
has a fixed bar for what counts as evidence. If the bar is not met, the
claim is **un-cited** and triggers the per-claim verdict below — there is
no rhetorical wiggle room here.

| Claim class | What counts as evidence |
|---|---|
| **Performance** (`X is fast`, `scales to Y`, `cheap`) | Benchmark numbers with environment + N (runs), OR a comparison against a named baseline measurement. Adjectives alone never qualify. |
| **Security** (`X is secure`, `resists Y`, `safe by default`) | An explicit threat model statement + at least one probe/test attempted, OR a named OWASP / CWE category with the mitigation cited. |
| **Correctness** (`X works`, `handles edge cases`, `is sound`) | A passing test cited by path + test name, OR an enumerated edge-case list (≥3 items) with the disposition of each. An empty/zero/absent result is a CLAIM, not evidence — it must be PROVEN to mean absence. Before a "0 / none / not found / doesn't exist / success" is accepted: (1) OBJECT-EXISTENCE CHECK — confirm the queried object exists (right DB/schema/table/column/name); a wrong name returns zero rows for everything, which reads exactly like "it isn't there". (2) COUNTERFACTUAL CHECK — state what would have to be true for the number to be non-zero; if a zero is structurally impossible-to-be-nonzero it carries no information and must be labelled so. Only then may absence be reported as a finding. VERDICT: an absence/zero claim offered without (1)+(2) → REJECTED; bounce once. |
| **Completeness** (`covers all cases`, `no gaps`, `exhaustive`) | The enumeration above, OR an explicit "known limitations" subsection naming what is NOT covered. |
| **Compatibility** (`works on X version`, `cross-platform`) | A version-stamped test, OR a quote from the source's compatibility docs (URL or repo-relative path). |
| **External tool / library claims** | Citation of the source URL or doc path with the version pinned. |

A non-trivial claim that doesn't fit a class above defaults to the
**Correctness** row: name the test or enumerate the cases. "Trivial"
means restating a fact already established elsewhere in the panel
output, or describing what the specialist literally did (`I read the
file`) — not opinions about the result.

## Per-claim verdict

For each non-trivial claim a specialist returns, YOU issue exactly one
verdict. This mirrors PHASE 0d's `ACCEPT / REJECT / CONDITIONAL` shape
deliberately — the evidence layer is a peer protocol to the challenge
layer, not an ad-hoc afterthought.

- **EVIDENCED** — Evidence cited matches the taxonomy row for the claim's
  class. Claim survives into the final plan.
- **UN-CITED** — Claim is non-trivial but no evidence is offered. **Bounce
  back ONCE** with the specific taxonomy row that applies and the exact
  evidence the specialist must produce. If the second pass still lacks
  evidence, **ship the claim as a KNOWN LIMITATION** in the Visible output
  rather than letting it sneak into the deliverable. Do not bounce a
  third time.
- **REJECTED** — Evidence was offered but does not support the claim
  (e.g., a benchmark on a different workload, a threat model that
  ignores the relevant threat, an enumerated list missing the
  edge case the user actually asked about). Same bounce-ONCE protocol
  as UN-CITED; same KNOWN-LIMITATION fallback on the second miss.

> **Token note:** `REJECTED` here is a PHASE 1.5 orchestrator verdict on
> a claim's evidence quality. It is distinct from `REJECT` (no -ED),
> which is the PHASE 0d expert response to a challenge. The peer-protocol
> framing above is intentional; the -ED suffix is load-bearing
> disambiguation when both verdict layers appear in the same plan output.

**Aggressive rejection — this is the Phase J intent:** if a specialist's
output reads as confident and conclusion-heavy with no cited proof, do
NOT charitably interpret it. Issue UN-CITED verdicts on the load-bearing
claims and bounce. The specialist's job is to produce evidenced
deliverables; yours is to refuse to launder un-cited assertion into the
final plan.

## Factory-upgrade trigger

**Factory-upgrade trigger:** if a single PHASE 1.5 pass produces **≥3
UN-CITED verdicts on the same specialist**, set
`pending_upgrade: true` on their `roster.json` entry immediately and
surface it in the final user report. Domain confidence is suspect when
a specialist cannot cite three claims in their stated expertise — this
is the same threshold as the PHASE 2c `corrections_since_last_upgrade
≥ 3` rule, applied at the evidence layer.

This is a SEPARATE trigger from the domain-gap escalation in
`### Factory escalation from senior review` below. That section fires
on `2+ misses` of domain expertise (gaps a specialist SHOULD have
caught in their stated domain); this trigger fires on `≥3 UN-CITED
verdicts` (claims a specialist MADE without evidence). Both flip
`pending_upgrade: true`, but the diagnoses are different — a specialist
with many uncited claims has evidence-discipline issues, while one
with recurring domain gaps has knowledge-coverage issues. Either path
is sufficient on its own; neither blocks the other.

## Standard of evidence — delegation boilerplate

When you spawn a specialist via `Agent()`, include this structured block
verbatim in the prompt. The taxonomy must be visible to the specialist
at delegation time, not just at review time — otherwise the bounce-ONCE
loop just adds latency for evidence the specialist could have included
on pass #1.

> **EVIDENCE REQUIREMENTS (PHASE 1.5 enforcement, v4.0 Phase J):**
>
> Each non-trivial claim in your output MUST carry evidence per the
> taxonomy:
>
> - **performance** → benchmark numbers (with environment + N) OR
>   comparison against a named baseline
> - **security** → threat model statement + probe attempted, OR a named
>   OWASP / CWE category with mitigation cited
> - **correctness / completeness** → cited test (path + name) OR an
>   enumerated edge-case list (≥3 items) with disposition of each
> - **compatibility** → version-stamped test OR quote from compat docs
>   (URL or repo path)
> - **external tool / library** → source URL or doc path, version pinned
>
> The orchestrator will issue per-claim verdicts in senior review.
> Un-cited or unsupported claims are bounced back ONCE with the specific
> taxonomy row that applies. A second pass without evidence does NOT
> ship as a deliverable — it ships as a KNOWN LIMITATION in the user-
> facing Senior Review section, attributed to your output. Recurring
> un-cited verdicts (≥3 in one pass) trigger an upgrade recommendation
> on your roster entry.
>
> An assertion without evidence is a draft, not a deliverable.

Then in PHASE 1.5, actually follow through. The bounce-ONCE rule is a
contract with the user, not a soft suggestion: a specialist who returns
"this handles all the edge cases" with no enumerated edge cases gets
the work bounced back ONCE, and if pass #2 still lacks evidence, the
claim ships as a KNOWN LIMITATION rather than as a clean assertion. Do
not silently accept the second pass to spare the specialist or move
faster. The user gets more value from a plan that says "we couldn't
verify edge-case coverage" than from one that claims coverage without
proof.

## Factory escalation from senior review

If PHASE 1.5 surfaces a gap that a specialist SHOULD have caught but
didn't, AND the miss pattern recurs (2+ misses on the same specialist
in their stated domain):

1. Log to the specialist's `lessons/improvements.md` with specifics.
2. Set roster `pending_upgrade: true` IMMEDIATELY — do not wait for
   the 3-correction threshold for deep-domain misses.
3. In the final user report, surface:
   "Agent @{name} missed {domain gap} in their stated expertise.
    Recommending upgrade via /prism-roster before next use."

If PHASE 1.5 surfaces a gap for which NO specialist exists (hiring
flow in PHASE 0 somehow didn't cover it — usually because the gap is
cross-domain or emerged only during execution), spawn
@agent-factory in --skill-research mode with the gap as scope. Ship
the current plan with the gap explicitly flagged as a known
limitation; the factory research informs the NEXT iteration, not
this one.
