---
name: phase-0d-adversarial
description: PHASE 0d adversarial-review protocol — ≥2 substantive challenges per expert before synthesis. Verdict tokens ACCEPT/REJECT/CONDITIONAL. NEW v4.4 panel.json write closes 0d→1.5 cross-link gap.
---

# PHASE 0d: Adversarial Review (MANDATORY, VISIBLE)

Before any position advances to tensions and synthesis, YOU chair an
adversarial review of each expert on the panel. This is the step where
weak positions get caught — not rubber-stamped with token skepticism.

For each expert, surface **at least two substantive challenges** against
their stated position. Two is a FLOOR, not a target; go to three or four
on positions that look glib, over-confident, or under-defended.

**A substantive challenge MUST include:**
- The specific flaw — not "have you considered..." but "this fails when X"
- The condition under which it bites — concrete and observable
- The consequence — what breaks, for whom, how badly

**Disqualified as theater:**
- Generic objection ("but there are risks", "this has tradeoffs")
- Restating another expert's position (that belongs in TENSIONS)
- Semantic nitpick with no real-world teeth
- "Playing devil's advocate" without a specific flaw attached

**Each expert responds with exactly one of:**
- ACCEPT       — challenge valid; position REVISES to incorporate it
- REJECT       — challenge doesn't apply; give specific counter-reason
- CONDITIONAL  — valid under conditions; state the mitigation

**ANTI-THEATER RULE (critical):**
If you cannot generate two substantive challenges against an expert,
that expert does not belong on the panel. Drop them or replace them —
do NOT invent weak challenges to meet the quota. Either the position
is too generic to be falsifiable, or the expert is a rubber-stamp
voice.

**Verdict per expert:**
- SURVIVES           — position intact; carries into tensions
- SURVIVES (revised) — position fundamentally updated through ACCEPTs
- DROPPED            — challenges fatal; expert removed from synthesis
                       (but the reason is itself a finding worth recording)

Only surviving / revised positions carry into tensions and synthesis.

**Visible to user:** Show all challenges, responses, and verdicts in the
plan output. Do NOT summarize the review away. The user gets more value
when they can see which positions got stress-tested and how.

**Integration with checkpoints:**
If a position collects an ACCEPT that materially revises the approach,
add a Phase 1 checkpoint immediately after execution begins so the
revision gets tested empirically before the plan commits to it.

See: ~/.claude/skills/prism-plan/references/adversarial-review.md
for the full protocol, common challenge patterns, and examples.

## Panel.json write (v4.4 NEW — closes A4/F1 0d→1.5 cross-link)

At end of PHASE 0d, BEFORE proceeding to tensions and synthesis, write the panel state to `~/.claude/.prism-task-<task-id>/panel.json` for downstream OOB PHASE 1.5 reviewer pickup. Atomic write (tempfile + rename); fail-open (if write fails, log to stderr but continue).

Schema:

```jsonc
{
  "schema_version": 1,
  "task_id": "20260526-a3f7",
  "positions": [
    {
      "position_id": "pos-1",
      "expert_name": "Claude Code product expert",
      "specialist": "@claude-master",
      "challenges": [
        {
          "id": "ch-1",
          "text": "this fails when the user has no MCP servers configured",
          "response": "ACCEPT",
          "verdict": "SURVIVES (revised)"
        }
      ]
    }
  ]
}
```

One position object per SURVIVING expert. `specialist` is the agent name that will be dispatched to fulfill the position (if not yet known, leave as `null` and OOB reviewer falls through to no-cross-link mode for that position).

Bash one-liner to write atomically:

```bash
TASK_ID=20260526-a3f7
DIR=~/.claude/.prism-task-$TASK_ID
mkdir -p "$DIR"
cat <<'EOF' > "$DIR/panel.json.tmp" && mv "$DIR/panel.json.tmp" "$DIR/panel.json"
{ ...panel state... }
EOF
```

If no panel was assembled (standalone master-orchestrator session with no 0d), do NOT write panel.json — OOB reviewer's pending file gets `phase_0d_challenges: []`.

## v4.5 — alternatives-considered logging

When writing `panel.json` at end of Phase 0d, populate `rationale.alternatives_considered` with the approaches you rejected and why. Format:

```json
{
  "rationale": {
    "alternatives_considered": [
      {"approach": "Single bundled PR for the refactor", "why_not": "would mix unrelated changes; reviewer fatigue"},
      {"approach": "Separate PRs per layer", "why_not": "chosen — better review granularity"}
    ]
  }
}
```

The OOB Phase 0d reviewer (v4.5 A1) reads this field to judge whether the master genuinely considered options. Absent field = pre-v4.5 master; reviewer treats as "alternatives not logged" without penalizing.

Schema validation: `prism-panel-guard.mjs` Path B enforces the shape — each entry must have `approach` and `why_not` strings. Invalid shape → exit 2 with `[panel-guard] each alternatives_considered entry must have approach + why_not`.
