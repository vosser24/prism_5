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

## Real multi-agent dispatch (v5.x — default for NOVEL / high-stakes)

The panel is NOT single-model role-play by default. As the session-level
project-master (the sole dispatcher — STEP 0: subagent dispatch is main-loop-only)
you DISPATCH one real subagent per seat:

1. **Dispatch all seats in parallel** — one `Agent()` call per expert seat, each
   with the request + its assigned (opposed) bias + the expert's recalled domain
   memory. Separate context windows produce genuine disagreement, not self-critique.
   Record the real agentId each dispatch returns as that position's
   `dispatched_agent_id`.

   **Dispatch each seat with a plain, NAMELESS `Agent()` call — do NOT pass
   `name:`.** A named call becomes an Agent-Teams teammate whose written
   position does NOT return as your tool result — you receive only a
   payload-free `idle_notification` — so the seat's challenges are lost and
   must NEVER be chair-authored to fill the gap ([[D062]]).
2. **Cross-challenge round** — give each expert the OTHERS' positions and require
   ≥2 substantive challenges to other seats (the floor above). Because the experts
   are independent contexts, these are real challenges, not one model arguing with
   itself.
3. **Synthesize** — you adjudicate surviving/revised positions into the plan with
   explicit exclusions + reasons.

Set `dispatch_mode: "dispatch"` and a real, UNIQUE `dispatched_agent_id` on every
position. The `prism-panel-guard.mjs` hook BLOCKS (exit 2) a panel that claims
`dispatch_mode: "dispatch"` but records zero / partial / duplicate ids — i.e.
role-play masquerading as dispatch.

**Opt-in fast mode (role-play → literal token `dispatch_mode: "roleplay"`, one word, no hyphen):** when `PRISM_PANEL_MODE=roleplay` (or a low-stakes
tier / explicit user request) you MAY run the legacy in-context role-play — one
model voicing every seat. Set `dispatch_mode: "roleplay"`; no `dispatched_agent_id`
is required. This is the cost/latency escape, not the default.

**No-project-master fallback:** if you are the dispatched `@master-orchestrator`
wrapper (not a session-level project-master) you CANNOT dispatch experts (STEP 0).
Degrade to `dispatch_mode: "roleplay"` and advise the user to run `/prism-deep-dive`
so a session-level master can chair a real dispatched panel.

## Cost guardrails (v5.x — keep default real-dispatch affordable)

- **Seat cap:** default **3** seats, max **5**. More seats rarely adds independent
  signal and multiplies cost.
- **Model defaults:** **opus** chair (you); seats default **sonnet**; **haiku** for
  scout-type seats; workers sized to the task (haiku scan / sonnet implement / opus
  only for architecture).
- **Parallel dispatch:** dispatch all seats in ONE message — wall-clock = slowest
  seat, not the sum.
- **Reuse to amortize:** prefer rostered experts (and their persisted memory +
  owned skills) over creating new ones — reuse pays back creation + re-learning cost.
- **Estimate first:** before a full real-dispatch panel, offer the user a one-line
  cost estimate (≈ seats × seat-model + workers). Let them downshift to
  `PRISM_PANEL_MODE=roleplay` if the task doesn't warrant real dispatch.

## Panel.json write (v4.4 NEW — closes A4/F1 0d→1.5 cross-link)

At end of PHASE 0d, BEFORE proceeding to tensions and synthesis, write the panel state to `~/.claude/.prism-task-<task-id>/panel.json` for downstream OOB PHASE 1.5 reviewer pickup. Atomic write (tempfile + rename); fail-open (if write fails, log to stderr but continue).

**`<task-id>` must be freshly generated for THIS panel's subject** — reusing an id from an earlier different-topic panel in the same session silently aliases the wrong workspace.

**OOB activation caveat:** the tempfile+rename recipe below is for reference only — the Phase 0d/1.5 hooks fire on a PostToolUse **Write tool** event to a path ending exactly `panel.json`, so for the hooks to actually fire you must write it with a single direct Write tool call to that final path, not the Bash heredoc/rename shown here.

Schema:

```jsonc
{
  "schema_version": 1,
  "task_id": "20260526-a3f7",
  "dispatch_mode": "dispatch",          // "dispatch" (default) | "roleplay" (opt-in fast mode)
  "positions": [
    {
      "position_id": "pos-1",
      "expert_name": "Greek e-commerce conversion specialist",
      "specialist": "@greek-ecommerce-conversion-specialist",  // roster key (or null if not yet known)
      "vertical": true,                     // domain-expertise seat → provenance-enforced
      "seat_source": "rostered",            // "rostered" | "factory-created" (omit for archetype seats)
      "agent_type": "greek-ecommerce-conversion-specialist",   // the real subagent_type dispatched (NOT general-purpose)
      "dispatched_agent_id": "a168f7095456bfffc",  // real agentId from the seat's Agent() call (dispatch mode only; UNIQUE per seat)
      "challenges": [
        {
          "id": "ch-1",
          "text": "this fails when the user has no MCP servers configured",
          "evidence_class": "PRECEDENT",
          "response": "ACCEPT",
          "verdict": "SURVIVES (revised)"
        }
      ]
    }
  ]
}
```

One position object per SURVIVING expert. `specialist` is the agent name that will be dispatched to fulfill the position (if not yet known, leave as `null` and OOB reviewer falls through to no-cross-link mode for that position). `dispatch_mode` records whether the panel ran as real per-seat dispatch or the opt-in role-play fast mode; in `"dispatch"` mode every position MUST carry a real, unique `dispatched_agent_id` (the guard blocks otherwise). Omitting `dispatch_mode` is treated as a legacy (pre-v5.x) panel and left unenforced.

Tag every VERTICAL/domain-expertise seat `vertical:true` and give it a real `agent_type` + `seat_source`; leave cross-cutting archetype seats (Architect/Skeptic/Security/Performance) untagged. `hooks/prism-panel-guard.mjs` enforces provenance on tagged seats — a `general-purpose` `agent_type` or an unresolved `specialist` is flagged. This makes schema-shown == schema-enforced.

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

## Seat bookkeeping — positions[] vs dropped_positions[] (v5.x, F8)

`dropped_positions[]` is a MECHANICALLY-GENERATED annotation log — `hooks/prism-panel-guard.mjs`
appends to it on the panel.json write; `positions[]` is append-only and a seat is never removed from
it. You never write `dropped_positions[]` yourself; your job is to construct `positions[]` so a seat
doesn't end up qualifying for both records at once.

1. **A seat is `positions[]` XOR `dropped_positions[]` by construction — never both.** A seat
   auto-drops into `dropped_positions[]` (`reason:"specialist_unknown"`) when it READS as vertical (a
   vertical-sounding title, or `vertical:true`) but resolves to no rostered `specialist` — while its
   real challenges stay untouched in `positions[]`. That split record is the F8 defect
   (`panel_guard_consistency` advisory). Fix it at construction time: either back a vertical-sounding
   seat with a real `specialist` (rostered or factory-created), or title it as a pure cross-cutting
   archetype ("Skeptic — attack the premise", not "… & Measurement …") so the provenance gate does not
   infer it vertical.
2. **A failed / non-delivering seat gets an honest record, never a synthesized one.** If a dispatched
   seat returns a holding string, times out, or otherwise produces no position, say so plainly in its
   `position` field (e.g. `"INCOMPLETE - seat failed to deliver"`). Do NOT author a position on the
   seat's behalf — a seat that failed is a finding, not a gap to paper over. If you carry forward any
   material against that seat (its own prior written stance, or your own re-measurement standing in
   for it), label the challenge text itself as chair-proxied/degraded (e.g. "PARTIAL/UNVERIFIED at
   seat level, then independently re-measured by chair"). A transparently degraded record is supposed
   to score low on independent review — that's correct, not a defect to fix.
3. **Carried-forward material is not a live seat response — mark the difference.** A prior written
   position pulled forward because the seat didn't respond this round must read as distinct from a
   challenge the seat actually produced live in this dispatch — label it (e.g. "Carried forward from
   this seat's prior written position") rather than presenting it at the same weight as a fresh
   response.

Worked example (rules 2–3): RB-16, `docs/prism/plans/2026-07-23-cotest-findings-tracker.md` §"RB-16",
sub-observation (a) — a `software-architecture-expert` seat failed to deliver after 36 tool calls; the
chair recorded it per the rules above and the OOB reviewer independently scored it lowest. See D072
(`docs/prism/adjudications/D072-panel-instrumentation-off-agent-dispatch-not-model-panel-json.md`) for
why panel instrumentation keys off the deterministic Agent-dispatch event, not model prose.

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
