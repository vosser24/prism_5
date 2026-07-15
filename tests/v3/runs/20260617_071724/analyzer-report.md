# PRISM v3.6.0 Audit Report -- 2026-06-17T07:23:50.901Z

Run: 29 scenarios across 10 categories. Total wall-time: 29.2s.

- Audit-run JSONL: `tests/v3/runs/20260617_071724/synthetic.jsonl`
- Routing log: `~/.claude/.prism-routing.jsonl`
- Pass: **29** | Fail: **0**

## Coverage matrix (capability -> exercised?)

| Capability | Scenarios | Pass | Fail | Coverage |
|---|---|---|---|---|
| agent-model-guard | 3 | 3 | 0 | PASS |
| classifier | 6 | 6 | 0 | PASS |
| lifecycle | 5 | 5 | 0 | PASS |
| mutation-guard | 3 | 3 | 0 | PASS |
| panel-guard | 1 | 1 | 0 | PASS |
| parallel-guard | 1 | 1 | 0 | PASS |
| parent-dispatch-guard | 3 | 3 | 0 | PASS |
| safety | 4 | 4 | 0 | PASS |
| skill-trigger-guard | 2 | 2 | 0 | PASS |
| task-tier-advisor | 1 | 1 | 0 | PASS |

## Timing distribution

No hook timing samples in audit-run JSONL.

## Trigger correlation (which hooks fire on which scenarios)

- **CLF-001** (classifier): (none)
- **CLF-002** (classifier): (none)
- **CLF-003** (classifier): (none)
- **CLF-004** (classifier): (none)
- **CLF-005** (classifier): (none)
- **CLF-006** (classifier): (none)
- **MUT-001** (mutation-guard): (none)
- **MUT-002** (mutation-guard): (none)
- **MUT-003** (mutation-guard): (none)
- **DSP-001** (parent-dispatch-guard): (none)
- **DSP-002** (parent-dispatch-guard): (none)
- **DSP-003** (parent-dispatch-guard): (none)
- **AMG-001** (agent-model-guard): (none)
- **AMG-002** (agent-model-guard): (none)
- **AMG-003** (agent-model-guard): (none)
- **TTA-001** (task-tier-advisor): (none)
- **SAF-001** (safety): (none)
- **SAF-002** (safety): (none)
- **SAF-003** (safety): (none)
- **SAF-004** (safety): (none)
- **PAR-001** (parallel-guard): (none)
- **PNL-001** (panel-guard): (none)
- **STG-001** (skill-trigger-guard): (none)
- **STG-002** (skill-trigger-guard): (none)
- **LIF-001** (lifecycle): (none)
- **LIF-002** (lifecycle): (none)
- **LIF-003** (lifecycle): (none)
- **LIF-004** (lifecycle): (none)
- **LIF-005** (lifecycle): (none)

## Failures

None. All scenarios passed.

## Anomalies

- 0 classifier divergences detected
- 0 parallel_guard violations
- 0 panel hallucinations caught
- 0 force-opus events
- 0 guard-deny actions
- 0 skill-trigger advisories

## Real-session correlation

- Routing-log events: **7557**
- Synthetic scenarios with matchable (tier, source): **0**
- Matched in real session: **0** (n/a%)

Interpretation: a high match rate indicates real-world classifier behavior aligns with synthetic expectations. Low rates suggest either (a) the user has not exercised those code paths recently, or (b) the classifier is drifting.

## Verdict

**PASS**

10 capabilities exercised across 29 scenarios. 0 failures. No anomalies that block release.

Recommended next steps:
- Ship it. All capabilities exercised cleanly.

