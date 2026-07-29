# Task-API probe fixtures — provenance

Consumed by `tests/v3/state/test-prism-task-api-probe.mjs`.
Design: `docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md`.

These are **distilled excerpts of real session transcripts**, not invented
data. They are committed here deliberately: `~/.claude/projects/` is subject to
`cleanupPeriodDays` (default 30), so a test that read the live directory would
silently lose its denominator when the transcripts age out.

Distillation, stated exactly (so nobody mistakes these for whole sessions):
each `Task*`/`TodoWrite` `tool_use` block and its matching `tool_result` row
were extracted and reduced to the fields the probe actually reads
(`type`, `message.role`, `message.content[].type|id|name|tool_use_id|content|is_error`,
`toolUseResult`). Refusal rows keep their error text **verbatim**. Successful
rows had their payload replaced with `"ok"` / `{"ok":true}` — the probe only
checks `is_error`, never the success payload — and successes are capped at 4
per fixture. `input` objects were emptied (they carried project work text).
Real `tool_use_id`s are preserved so rows stay joinable.

| File | Source session | Real session totals | What it proves |
|---|---|---|---|
| `refused-taskcreate.jsonl` | `deadbeef-0000-4000-8000-000000000011` (2026-07-21) | 7 `TaskCreate` refusals + 1 `TodoWrite` refusal, 0 successes | D042 leg 1 — the probe FIRES on a genuinely broken session |
| `healthy-no-refusals.jsonl` | `deadbeef-0000-4000-8000-000000000012` (2026-07-17) | 42 Task calls, 0 refusals | D042 leg 2 — STAYS QUIET. Also carries a trailing assistant **text** block quoting the refusal string verbatim: this is the real prose false-positive trap (the source session genuinely quotes the error in prose), so a substring-only detector fails here |
| `healthy-with-taskget-refusal.jsonl` | `deadbeef-0000-4000-8000-000000000013` | 38 successes + 1 `TaskGet` refusal | Regression test for the `TaskGet` defect — `TaskGet` has **0 successes in the entire local corpus** (measured 2026-07-21: `TaskGet` 0 ok / 2 refused, `TodoWrite` 0 ok / 2 refused, vs `TaskCreate` 308 ok / 7 refused, `TaskUpdate` 592 ok / 1 refused, `TaskList` 22 ok / 0 refused). A verdict keyed on "any Task refusal" reports a healthy session as broken |
| `mixed-taskupdate-refusal.jsonl` | `deadbeef-0000-4000-8000-000000000014` (2026-07-21) | 18 successes + 1 `TaskUpdate` refusal | Genuine `mixed`. `TaskUpdate` is a scoring tool with 592 corpus successes, so this refusal is real ill-health — and it occurred **in the same session as 18 successes**, which is the counter-example that refutes any session-global cause (see plan §7) |
| `no-task-calls.jsonl` | synthetic | — | The `unknown` / `no_task_calls_in_window` third state (D047) |
