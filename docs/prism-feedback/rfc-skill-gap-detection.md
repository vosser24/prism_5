# RFC: PRISM should auto-detect missing domain skills, not just missing model tier

**Status:** Draft for upstream PRISM maintainer review
**Reporter:** ServosY (servosy@praktiker.gr) — PRISM user, Nexus Tasks project
**PRISM version observed:** v3.8.9 (current HEAD as of 2026-04-27)
**Date:** 2026-04-27
**Severity:** Major UX bug — silent failure mode for novel-domain prompts

## TL;DR

PRISM proactively routes the model tier for every prompt. It does not proactively check domain expertise. When a user prompt lands on a domain for which no installed skill or registered agent exists, the conversation continues silently with no warning. The fix is small: extend the existing `prism-skill-trigger-guard.mjs` hook to also detect NO-MATCH (gap) conditions, not just suggest matches.

## 1. Problem statement

When PRISM routes a prompt to the best available skill or agent, it scores candidates and returns the top match. If the best match score is below both the `threshold_weak` and `threshold_strong` fences, the orchestrator currently falls through to the base model without emitting any warning. The user has no visibility into the fact that their prompt landed in a domain gap.

This is a silent failure mode. The user gets a response, but it comes from a generalist model rather than a domain specialist. Worse, the response quality may appear plausible even when it is unreliable.

## 2. Observed behavior vs. expected behavior

| Scenario | Observed | Expected |
|---|---|---|
| Prompt matches a strong skill | Routes to specialist, no warning | Correct |
| Prompt matches a weak skill (above `threshold_weak`) | Routes to specialist with suggestion | Correct |
| Prompt matches nothing (all scores below `threshold_weak`) | Falls through silently to base model | Should emit gap warning |

## 3. Root cause analysis

The `hooks/prism-skill-trigger-guard.mjs` hook (which already exists in v3.8.x) performs candidate scoring and emits `[PRISM]` prefix messages when a match is found. However, it has no branch for the NO-MATCH case. It only emits output on positive matches, so gap conditions produce no signal.

The proposed change is an **extension** to `prism-skill-trigger-guard.mjs` to also detect NO-MATCH (gap) conditions — not a new parallel hook called `prism-skill-gap-detector.mjs`. This keeps gap detection co-located with the existing match logic and avoids duplicating the scoring pipeline.

### 3.1 Two new behaviors within the existing hook

Extend `hooks/prism-skill-trigger-guard.mjs` to also detect no-match (gap) conditions, not just positive matches. Concretely:

1. After scoring all candidates, if `best_score < threshold_weak`, emit a `[PRISM GAP]` warning to the conversation context before the model responds.
2. Append a JSONL telemetry line to `~/.claude/.prism-routing.jsonl` on every gap-detection fire (see §3.5).

No new hook file is introduced. The single `prism-skill-trigger-guard.mjs` handles both match and no-match branches.

### 3.2 Schema upgrade for `roster.json`

The `agents` array in `roster.json` currently stores plain strings (agent names). To support richer gap-detection metadata (domain tags, capability vectors, confidence floor), each entry should become an object:

```json
{
  "schema_version": "3.2.0",
  "agents": [
    {
      "name": "ui-ux-pro-max",
      "domains": ["ui", "ux", "design-systems"],
      "confidence_floor": 0.6
    }
  ],
  "skills": [...],
  "tools": [...],
  "mcps": [...]
}
```

### 3.2.1 Migration approach: parallel `agents_v2` field

To avoid breaking existing readers, the schema upgrade introduces a parallel `agents_v2` field initially:

```json
{
  "schema_version": "3.2.0",
  "agents": ["legacy-string-name", ...],     // kept for backward-compat reads
  "agents_v2": [{ ...enriched objects... }], // new readers prefer this
  "skills": [...],
  "tools": [...],
  "mcps": [...]
}
```

New readers prefer `agents_v2` if present, fall back to `agents`. Old readers see both but ignore the unknown `agents_v2` key. After one full release cycle, drop `agents` at schema 4.0.

The backfill script (`tools/prism-roster-backfill-agents.mjs`) writes both fields atomically.

### 3.3 Gap warning message format

When a gap is detected the hook should prepend the following block to the system prompt for that turn:

```
[PRISM GAP DETECTED]
No installed skill or registered agent matched your prompt.
Best candidate: ui-ux-pro-max (score: 0.4 / threshold: 1.0)
Responding with base model. Domain accuracy may be reduced.
```

### 3.4 Threshold configuration

Gap detection reuses the existing `threshold_weak` and `threshold_strong` values from `settings.json`. No new configuration keys are required for the initial implementation. The gap fires when `best_score < threshold_weak`.

### 3.5 Telemetry signal

Every gap-detection fire appends a JSONL line to `~/.claude/.prism-routing.jsonl`:

```json
{"ts":"2026-04-27T...","event":"gap_detected","tier":"opus","prompt_hash":"abc123","best_match":"ui-ux-pro-max","best_score":1,"threshold_weak":1}
```

`/prism-telemetry` aggregates this into per-week gap-fire rate and per-domain gap frequency. Without telemetry, we have no way to know if the feature actually catches real gaps or just adds noise.

### 3.6 Override prefix

Mirror the existing `!opus-force:` pattern: a user prompt prefixed with `!skip-gap-check:` bypasses the gap detector for that turn. Useful for known-exploratory prompts where the user knows no domain expert is needed.

## 4. Proposed implementation plan

1. Extend `hooks/prism-skill-trigger-guard.mjs` with a NO-MATCH branch that emits `[PRISM GAP DETECTED]` and writes the telemetry JSONL line.
2. Add `tools/prism-roster-backfill-agents.mjs` to migrate existing `roster.json` files to the `agents_v2` parallel field.
3. Update `prism-skill-trigger-guard.mjs` to read `agents_v2` when present, fall back to `agents`.
4. Add `!skip-gap-check:` prefix handling alongside existing `!opus-force:` handling.
5. Update `/prism-telemetry` aggregator to include gap-fire rate and per-domain gap frequency columns.

## 5. Backward compatibility

- The `agents` field is preserved verbatim. Old readers are unaffected.
- The `threshold_weak` and `threshold_strong` keys are reused. No `settings.json` migration is required.
- The `!skip-gap-check:` prefix is additive. Existing prompts are unaffected.
- The telemetry file is append-only. Existing JSONL lines are not modified.

## 6. Alternatives considered

**Alternative A: New `prism-skill-gap-detector.mjs` hook.** Rejected because it duplicates the scoring pipeline already in `prism-skill-trigger-guard.mjs` and would require keeping two hooks in sync.

**Alternative B: Suppress gap warnings entirely, rely on user feedback.** Rejected because silent failures are the root cause of the bug this RFC addresses.

**Alternative C: Hard-fail on gap detection (refuse to respond).** Rejected as too disruptive. A warning with graceful fallback is the right UX.

## 7. Open questions

- Should the gap warning appear in the chat UI as a visible assistant message, or only in the system prompt context?
- Should the `confidence_floor` per agent override the global `threshold_weak`, or add to it?
- At what adoption percentage should `agents` be dropped in favor of `agents_v2` only?

## 8. References

- `hooks/prism-skill-trigger-guard.mjs` — existing hook being extended
- `tools/prism-roster-backfill-agents.mjs` — proposed backfill script
- `~/.claude/.prism-routing.jsonl` — telemetry sink
- PRISM settings: `threshold_weak`, `threshold_strong`

## 9. Revision history

| Date | Author | Change |
|---|---|---|
| 2026-04-27 | ServosY | Initial draft filed against v3.8.9 |
