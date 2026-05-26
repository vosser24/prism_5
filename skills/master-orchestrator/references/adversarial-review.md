---
name: adversarial-review
description: Master-orchestrator-scoped adversarial-review reference — challenge patterns + ANTI-THEATER RULE + checkpoint integration. Points to the long-form companion in skills/prism-plan/references/adversarial-review.md.
---

# Adversarial Review (master-orchestrator scope)

This is the master-orchestrator-scoped reference. For the full protocol, common challenge patterns, and worked examples, see `~/.claude/skills/prism-plan/references/adversarial-review.md`.

## When this fires

PHASE 0d (after panel assembly, before tensions + synthesis). See `phase-0d-adversarial.md` for the full PHASE 0d protocol.

## Substantive-challenge checklist

A substantive challenge MUST include:
- **The specific flaw** — not "have you considered..." but "this fails when X"
- **The condition under which it bites** — concrete and observable
- **The consequence** — what breaks, for whom, how badly

Disqualified as theater:
- Generic objection ("but there are risks", "this has tradeoffs")
- Restating another expert's position (that belongs in TENSIONS)
- Semantic nitpick with no real-world teeth
- "Playing devil's advocate" without a specific flaw attached

## Common challenge patterns

1. **Failure-mode probe:** "this fails when {boundary condition} because {mechanism}."
2. **Cost flip:** "the claimed cost holds when N is small; at production N this becomes {scaling problem}."
3. **Cross-domain leak:** "this works in {domain A} but the interaction with {domain B not in expert's scope} is unaccounted."
4. **Reversibility:** "this assumes the action can be rolled back; at {commit point} it can't."
5. **Trust-boundary probe:** "this assumes {actor} is trusted; the threat model needs to consider {untrusted actor scenario}."

## ANTI-THEATER RULE (critical)

If you cannot generate two substantive challenges against an expert, that expert does not belong on the panel. Drop them or replace them — do NOT invent weak challenges to meet the quota. Either the position is too generic to be falsifiable, or the expert is a rubber-stamp voice.

## Verdict tokens

- `ACCEPT` — challenge valid; position REVISES to incorporate it
- `REJECT` — challenge doesn't apply; specific counter-reason
- `CONDITIONAL` — valid under conditions; state the mitigation

> **Token note:** `REJECT` (no -ED) is the PHASE 0d expert response to a challenge. It is distinct from `REJECTED` (with -ED), which is the PHASE 1.5 orchestrator verdict on a claim's evidence quality (see `evidence-taxonomy.md`).

## Integration with PHASE 1 checkpoints

If a position collects an ACCEPT that materially revises the approach, add a Phase 1 checkpoint immediately after execution begins so the revision gets tested empirically before the plan commits to it.

## Visibility rule

Show all challenges, responses, and verdicts in the plan output. Do NOT summarize the review away. The user gets more value when they can see which positions got stress-tested and how.
