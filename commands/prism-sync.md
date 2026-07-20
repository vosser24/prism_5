---
name: prism-sync
description: Refresh PRISM's project index — re-runs discovery, roster reconcile, and health checks; stamps last_sync_at. Conservative drift detection (always re-scans).
---

# /prism-sync — v3.11.0 maintenance sync

Locked design: `docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md` §5
(conservative drift = always re-scan; `--smart-drift` opt-in EXPERIMENTAL,
not yet implemented). Phase machine lives in `tools/prism-sync.mjs`.

**Flags:**
- `--smart-drift` — opt-in EXPERIMENTAL; currently falls back to conservative
  with a stderr warning.

---

## Step 0 — git guard

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: STOP. `/prism-sync` requires a bootstrapped project — tell
the user to run `/prism-bootstrap` first.

## Step 1 — load plan

Run: `node ~/.claude/tools/prism-sync.mjs plan [--smart-drift]`

If the helper exits 3 ("no state file"): tell the user this project has not
been bootstrapped and they should run `/prism-bootstrap` first. STOP.

The output JSON has:
- `mode`: always `"conservative"` in v3.11.0
- `pending`: ordered phase list to run
- `reasons`: human-readable rationale per phase
- `last_sync_at`: previous sync time (null if first sync)
- `claude_md_changed`: whether CLAUDE.md was modified since last sync

Surface the plan to the user with a one-line summary:
`"Conservative sync — will run: structure, [identity,] discovery, roster, health"`

---

## Step 2 — execute phases

For each phase in `pending`, in order:

### `structure` — verify scaffold

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-structure`

This is idempotent (creates only missing directories/seed files). The helper
records dirs_created / files_created counts in the structure phase metadata.

If `dirs_created > 0` OR `files_created > 0`: note in the final summary that
scaffold gaps were filled (someone may have deleted PRISM directories).

### `identity` — refresh CLAUDE.md (conditional, only if planned)

If CLAUDE.md was modified since last sync (per Step 1's `claude_md_changed`):
re-verify it has a `## PRISM Operating Rules` section. If absent, append the
template per `/prism-bootstrap` Phase 1's "append, don't reorder" rule.

DO NOT regenerate the file. DO NOT prompt the user — just verify + append if needed.

### `discovery` — re-scan (LLM-judged)

Invoke the existing `/prism-discover` logic (parallelized codebase scan +
schema introspection + API surface scan). DO NOT re-implement.

Record the result counts: `{references_count, tables_indexed, endpoints_indexed}`.

### `roster` — reconcile (LLM-judged)

Invoke the existing `/prism-roster --reconcile` logic. If new orphans are
detected, surface them to the user with the same dual-form match prompt as
`/prism-bootstrap` phase 4.

If running non-interactively and orphans need user choice: log them and
proceed without auto-registering — the user can re-run with `/prism-roster
--reconcile` to handle.

Record: `{agents_registered, orphans_remaining}`.

### `health` — verify wiring (LLM-judged)

Invoke the existing `/prism-health` checks. Report status to the user.

Record: `{health_status, checks_passed, checks_failed}`. (The v2 sentinel `status` is reserved for orchestrator phase state.)

---

## Step 3 — stamp + report

Collect the phase metadata from steps above into a single JSON object keyed
by phase name. Example:

```json
{
  "structure": {"dirs_created": 0, "files_created": 0, "gitignore": "present"},
  "discovery": {"references_count": 14, "tables_indexed": 6, "endpoints_indexed": 12},
  "roster": {"agents_registered": 4, "orphans_remaining": 0},
  "health": {"health_status": "green", "checks_passed": 5, "checks_failed": 0}
}
```

(Include `identity` only if it was in `pending`.)

Run: `node ~/.claude/tools/prism-sync.mjs complete --meta '<json>'`

This stamps `last_sync_at = now` and `next_sync_recommended = now + 7d`.

**Verification artifact:** the authoritative stamp is `<project>/.claude/.prism-state.json → last_sync_at` (NOT the roster). A completed sync also appends a `{"event":"prism_sync","action":"complete"}` line to `~/.claude/.prism-routing.jsonl`; a declined sync in an unbootstrapped worktree appends `{"event":"prism_sync","action":"no-state"}`. Audit those, not the roster.

Then summarize for the user:

- ✅ Phases re-scanned: <list>
- 📊 Drift highlights: <e.g., "+2 new tables in DB", "1 new orphan agent">
- ⏰ Next sync recommended: <next_sync_recommended date>

If new orphans remain or health is yellow/red: surface as actionable items.

---

## Idempotency contract

Running `/prism-sync` twice in a row on an unchanged project must:
- Produce two valid state writes (timestamps advance, checksum recomputes).
- Produce no destructive changes.
- Report identical drift highlights (or "no changes").
- Never duplicate roster entries.

## Failure modes

| State status | /prism-sync behaviour |
|--------------|----------------------|
| `missing` | STOP, tell user to /prism-bootstrap first (helper exits 3) |
| `invalid_json` / `invalid_schema` / `checksum_mismatch` | STOP, same recovery path as /prism-bootstrap |
| Discovery/roster/health phase errors | Record via `prism-bootstrap.mjs fail-phase <name>` and continue with remaining phases (D001 §Robustness #4: failure isolation) |

## Related commands

- `/prism-bootstrap` — initial setup (sets up state file)
- `/prism-clean` — capture session lessons (separate command, ships in same v3.11.0 release)
