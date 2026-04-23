# Adversarial Review Protocol

**Version:** 1.1 (April 2026)
**Applies to:** PRISM, PRISM Code, PRISM.
**Invoked by:** master-orchestrator (Phase 0d), blueprint-prompt (panel stage).

The adversarial review is the step where weak expert positions get caught
before they shape the final plan. It is mandatory for every NOVEL task that
reaches the panel stage. It is visible to the user — the whole point of PRISM
is to refract the question through perspectives and show what the single
beam was hiding, including what the first draft of each perspective got wrong.

---

## When to run

Between panel assembly and tensions/synthesis in the expert panel flow.
Never before the panel is fully assembled; never after synthesis has
been written.

Run on: every expert on the panel. No exceptions.
Skip on: LIGHTWEIGHT and ROUTINE tasks — they don't run panels at all.

---

## The mechanics

For each expert on the panel, the chair surfaces at least two substantive
challenges against the expert's stated position.

### What a substantive challenge must include

1. The specific flaw. Name it concretely. "This fails when X" beats
   "have you considered Y?"
2. The condition under which it bites. When does this flaw actually show
   up in reality? Under what measurable circumstances?
3. The consequence. What breaks? For whom? How badly? Is it reversible?

### What disqualifies a challenge as theater

- Generic objection ("but there are risks", "this has tradeoffs").
- Restating another expert's position (that goes in TENSIONS, not REVIEW).
- Semantic nitpick with no real-world consequence.
- "Playing devil's advocate" as a ritual, without identifying a specific
  flaw the expert has to respond to.
- Cosmetic challenges designed to hit the two-challenge quota.

### How the expert responds

Exactly one of:

**ACCEPT** — Challenge is valid. Expert revises position to incorporate
the fix. Show the revised position in full.

**REJECT** — Challenge doesn't apply, misreads the position, or is based
on a wrong factual premise. Give the specific counter-reason. REJECT is
not refusal — it must explain why the challenge fails.

**CONDITIONAL** — Challenge is valid under certain conditions. Acknowledge
the risk, state the concrete mitigation, and name the monitoring signal
that would tell you the mitigation failed.

Reflexive acceptance of every challenge is a failure mode. A position
that collects two well-reasoned REJECTs is stronger than one that folds
to every objection.

---

## The anti-theater rule

If the chair cannot generate two substantive challenges against an expert,
that expert does not belong on the panel. Either:

- The position is too generic to be falsifiable (pad the position or drop
  the expert — pick one);
- The expert is a rubber-stamp voice who agrees with the default (recruit
  a dissenter and replace);
- The chair isn't trying hard enough (try harder — think about what a
  hostile reviewer would say, what a user would complain about a year in,
  what a regulator or a competitor or a junior employee would notice).

**Do NOT invent weak challenges to hit the quota.** Two is a floor, not a
target. Go to three or four when a position looks glib, over-confident,
or under-defended.

---

## Verdicts

After challenges and responses complete for each expert, record one verdict:

- SURVIVES — position intact. Carries into tensions stage unchanged.
- SURVIVES (revised) — position updated through one or more ACCEPTs.
  The revised position carries into tensions, not the original. Note
  what changed.
- DROPPED — challenges proved fatal. Expert is removed from synthesis,
  but the reason is recorded. A dropped expert is a finding — the
  characteristic flaw in their perspective often tells you something
  about the shape of the problem.

---

## Output format (visible to user)

```
POSITIONS + ADVERSARIAL REVIEW

[Expert 1] ([role]):
  Position: "[concrete recommendation, 2-4 sentences]"

  Challenge 1 [chair]: [specific flaw] + [condition] + [consequence]
    Response: [ACCEPT|REJECT|CONDITIONAL] — [specific response with
    revision, counter-reason, or mitigation]

  Challenge 2 [chair]: ...
    Response: ...

  [Challenge 3 if weak/glib position]

  Verdict: SURVIVES | SURVIVES (revised) | DROPPED
```

Then proceed to TENSIONS (working only with surviving positions) and
SYNTHESIS.

---

## Common review patterns

**For strategic positions:** Challenge the base rate assumption. "You're
assuming churn of 15% — the industry average is 28%. If your base rate
is wrong, the whole recommendation flips."

**For technical positions:** Challenge the operating envelope. "This
works at 10k requests/day. The user said 'scale to 10M'. What breaks
first, and at what threshold?"

**For process positions:** Challenge the hidden cost. "The 3-hour
onboarding assumes senior engineers. With mid-level engineers, it's two
days. Does the cost-benefit still work?"

**For recommendations to build:** Challenge the buy-vs-build frame.
"What existing tool already solves this? If one exists, why is building
justified? If none exists, that's information — why hasn't the market
produced one?"

**For recommendations to NOT build:** Challenge the opportunity cost.
"If we defer this, what do we lose? Is the deferral reversible?"

---

## Execution checkpoint integration (master-orchestrator only)

When the chair records an ACCEPT verdict that materially revises a
position, add a checkpoint immediately after Phase 1 begins. The
revision should be tested early — it's now a claim, not a plan.

Example: If a security expert revised their position from "store tokens
in localStorage" to "use HttpOnly cookies with SameSite=strict after
Challenge 2 raised XSS consequences," the first Phase 1 checkpoint
verifies the cookie approach before any write goes beyond the prototype
stage.

---

## Anti-patterns this protocol is designed to prevent

1. Panel theater — Three experts who agree in slightly different words,
   producing a synthesis that is just one expert's opinion with extra
   steps.
2. Confidence laundering — Wrapping a strong prior in expert voices to
   make it look deliberated when no real stress-testing occurred.
3. Balance-by-dodge — Synthesis that presents "both sides" because no
   position survived challenge and the chair didn't notice.
4. Hidden single-voice — The chair has already decided the answer and
   the panel retroactively justifies it. The adversarial review exists
   to make this visible: if every expert survives every challenge
   without revision, either the panel is rubber-stamp or the chair
   isn't trying.
