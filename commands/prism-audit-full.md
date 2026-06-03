---
name: prism-audit-full
description: Comprehensive end-to-end audit of every PRISM capability. Runs synthetic scenarios via tools/prism-audit-runner.mjs, optionally walks user through real-session prompts, generates structured markdown report. Different from /prism-audit (fast hygiene scan) — this is the deep multi-minute audit that exercises every hook code path and produces the timing/coverage/trigger-correlation matrix.
---

# /prism-audit-full

Deep, end-to-end audit of every PRISM v3.6+ capability. Different from
`/prism-audit` (fast hygiene/secrets scan): this command exercises every
hook code path with synthetic scenarios, optionally walks the user
through a curated 40-prompt real-session sequence, then produces a
structured markdown report covering coverage, timing, trigger correlation,
failures, anomalies, and a real-vs-synthetic correlation.

## When to run this

- Before tagging a release.
- After upgrading a hook or adding a new capability.
- When investigating a routing-log anomaly.
- As part of weekly hygiene if you're deploying PRISM in production.

If you just want a quick secrets+config hygiene pass, use `/prism-audit`
instead — it runs in seconds and is the right tool for casual checks.

## Step 1 — Pre-flight

1. Confirm you're inside a PRISM install. One of these must exist:
   - `manifest.json` at repo root (manual install), OR
   - `.claude-plugin/plugin.json` (plugin install).
2. Confirm Node ≥18 is on PATH:
   ```bash
   node --version
   ```
3. Note the install method detected (plugin vs manual) — record it for
   the final report so version drift between install paths is visible.
4. Confirm the synthetic runner is present:
   ```bash
   test -f tools/prism-audit-runner.mjs || echo "MISSING"
   ```
   If missing, abort and tell the user to update PRISM (`git pull` then
   `node tools/prism-installer.mjs install`).

## Step 2 — Synthetic audit (automated, ~30s)

Run the synthetic audit runner. It sets up a throwaway `HOME` so it
mutates nothing in the real `~/.claude/`:

```bash
node tools/prism-audit-runner.mjs --output /tmp/prism-audit-run.jsonl
```

Capture stdout. Summarize for the user:
- Total scenarios executed
- Pass / fail counts
- Total wall-clock duration
- Any FAIL lines verbatim

If the runner exits non-zero, surface the exit code + last 20 lines of
stderr and stop here. Do NOT proceed to Step 3 if synthetic failed —
real-session correlation is meaningless against a broken synthetic
baseline.

## Step 3 — Real-session prompt sequence (OPTIONAL, ~30-60min)

This step is opt-in. Ask the user:

> Want to also run the real-session sequence? It's 40 curated prompts
> you paste into a fresh Claude Code window. Takes ~30-60min and
> produces real classifier-routing log entries that the analyzer can
> cross-reference against the synthetic baseline. Skip this for a
> synthetic-only audit. [y/N]

If the user says yes:
1. Point them at `tests/v3/audit-real-prompts.md` — the curated catalog.
2. Tell them to:
   - Open a fresh Claude Code session (close any existing one to start
     with a clean classifier cache).
   - Run the cleanup block at the top of the catalog:
     ```bash
     rm -f ~/.claude/.prism-turn-tier-*.json
     ```
   - Paste each prompt in order. The classifier writes
     `~/.claude/.prism-turn-tier-<sid>.json` and appends to
     `~/.claude/.prism-routing.jsonl` automatically.
   - Note any prompt where Claude Code's behavior deviated from the
     `expected` line in the catalog.
3. When the user reports they've finished, proceed to Step 4.

If the user says no, jump straight to Step 4 — the analyzer handles a
missing routing log gracefully.

## Step 4 — Analyzer

Generate the structured markdown report. Timestamp goes in the filename
so multiple audits coexist:

```bash
TS=$(date -u +%Y%m%d_%H%M%S)
node tests/v3/analyze-audit.mjs \
  /tmp/prism-audit-run.jsonl \
  ~/.claude/.prism-routing.jsonl \
  > /tmp/prism-audit-report-$TS.md
```

Note: the second argument (routing.jsonl) is optional. If the user
skipped Step 3 OR the file doesn't exist, the analyzer skips the
real-session correlation section and continues — no error.

## Step 5 — Final report

1. Tell the user the report path: `/tmp/prism-audit-report-<ts>.md`.
2. Read the report and summarize for the user inline:
   - **Coverage**: what % of capabilities exercised, any with FAIL.
   - **Timing**: top-5 slowest hooks by p95 (from the Timing
     Distribution table). Flag any p95 > 500ms as a regression.
   - **Anomalies**: counts from the Anomalies section
     (classifier divergence, parallel_guard violations, panel
     hallucinations, force-opus events, guard denies).
   - **Failures**: scenario_id + one-liner per failure.
   - **Verdict**: PASS / PASS-WITH-WARNINGS / FAIL from the bottom of
     the report.
3. If verdict is FAIL or PASS-WITH-WARNINGS, surface the
   "Recommended next steps" from the report verbatim.

## Constraints

- READ-ONLY by default. Synthetic runs in throwaway HOME (the runner
  sets this up). No mutations to the user's `~/.claude/`.
- Real-session step is OPT-IN. Never run it without explicit user
  confirmation — it requires ~60min of attended pasting.
- Final report is plain markdown. User can share it, paste into a
  GitHub issue, attach to a release PR, etc. No PII; no raw prompts
  beyond the curated catalog.
- Do NOT modify `~/.claude/.prism-routing.jsonl`. The analyzer reads
  it; nothing here writes to it.

## Difference vs /prism-audit

| Aspect | /prism-audit | /prism-audit-full |
|---|---|---|
| Duration | seconds | 30s synthetic + ~30-60min optional real-session |
| Scope | secrets, hygiene, config integrity | every hook code path + classifier + guards + panels + parallel + skills |
| Output | inline summary + audit-log.json | structured markdown report under /tmp |
| Mutating | --fix can mutate | never mutates |
| When | casual / pre-commit | pre-release / debugging anomalies |

## Exit conditions

- All steps green, no failures: report verdict PASS, exit 0.
- Synthetic failed: report verdict FAIL, exit 1, no Step 3-4.
- Synthetic passed, anomalies present (e.g., panel hallucinations):
  verdict PASS-WITH-WARNINGS, exit 0 but surface recommended fixes.

## Files this command touches

- READS: `manifest.json`, `.claude-plugin/plugin.json`,
  `tools/prism-audit-runner.mjs`, `tests/v3/analyze-audit.mjs`,
  `tests/v3/audit-real-prompts.md`, `~/.claude/.prism-routing.jsonl`.
- WRITES: `/tmp/prism-audit-run.jsonl`,
  `/tmp/prism-audit-report-<ts>.md`.
- Never writes inside `~/.claude/` or the repo.
