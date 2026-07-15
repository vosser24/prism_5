# PRISM Live Auto-Inject Audit — Plan

**Run:** `tests/v3/runs/20260617_071724/`
**Mode:** autonomous, full-exhaustive, create-real-then-retire
**Driver:** queue-state machine (`queue.json`) executed continuously by the
conversation model. Resumable: on interruption, re-read `queue.json`, find the
first test with `status:"pending"`/`"running"`, continue.

## Why this complements the synthetic runner

`tools/prism-audit-runner.mjs` (Step 2 of `/prism-audit-full`) already exercises
all 29 hook code-paths with curated JSON in a throwaway HOME — fast, exhaustive
on guards/classifier, timed. Baseline this run: **29/29 pass**.

What synthetic **cannot** do, and what this live loop adds:

- Real orchestrator routing (`master-orchestrator` dispatch, tier handoff).
- Real **panel composition** (adversarial review, ≥2 challenges/position).
- Real **agent creation** (`agent-factory`) + **skill creation** (`skill-creator`)
  with actual roster registration, then retirement.
- Real **multi-agent parallel dispatch** (N `Agent()` blocks in one message).
- Real end-to-end **timing + telemetry** under the live conversation model,
  read back from `~/.claude/.prism-routing.jsonl` and the telemetry aggregator.

Each live test executes the capability **for real**; the PreToolUse/UserPromptSubmit
PRISM hooks fire and append to `~/.claude/.prism-routing.jsonl`. The audit reads
those entries (everything after baseline line **7531**) to score observed-vs-expected.

## Capability coverage map (user's named targets → tests)

| User ask | Test(s) |
|---|---|
| "short replies" (fast-path) | L01 trivial, L06 conv-override-from-low-score |
| "panel usage" | L03 novel+panel, L04 REST/GraphQL adversarial |
| "create skill or agent" | L08 create-agent, L09 create-skill |
| "assign agents" | L07 parallel multi-dispatch, L10 roster-specialist routing |
| "read all telemetry and timing" | L12 aggregator+analyzer, L14 final report |
| (guards / safety, for completeness) | L05 force-opus, L11 safety-guard deny |

## Verification source of truth

- **Classification telemetry:** `~/.claude/.prism-turn-tier-*.json` sentinels +
  `.prism-routing.jsonl` lines after baseline.
- **Timing:** synthetic per-scenario ms (baseline) + `analyze-audit.mjs` p95 table.
- **Coverage/anomalies/verdict:** `tests/v3/analyze-audit.mjs` markdown report.
- **Telemetry rollup:** `tools/prism-telemetry-aggregate.mjs`.

## Cleanup contract

L13 retires the disposable `prism-audit-probe` agent (`/prism-retire`) and removes
the disposable probe skill, then verifies the roster is back to its pre-run state.
No mutation to `.prism-routing.jsonl` (append-only by hooks; never edited here).

## Exit

L14 writes `runs/20260617_071724/report.md` (synthetic + live + telemetry +
timing + verdict) and the loop terminates (no further wakeup scheduled).
