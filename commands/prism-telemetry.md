---
name: prism-telemetry
description: Local-only telemetry aggregation for PRISM. Opt-in. Aggregates ~/.claude/.prism-routing.jsonl into a structured rollup at ~/.claude/.prism-telemetry-rollup.json with cost summary, classifier accuracy, guard fire rate, tier distribution. NO network — export-to-JSON for manual sharing only.
---

# /prism-telemetry

Local-only telemetry aggregation for PRISM v3.1+. Opt-in. Aggregates `~/.claude/.prism-routing.jsonl` into a structured rollup file. **No network calls. No shipping. No telemetry-as-a-service.** Anyone can read the rollup with `jq`.

**Backing implementation:** `tools/prism-telemetry-aggregate.mjs` and
`tools/prism-bootstrap.mjs` (cited per-subcommand below). The aggregate
script also exposes flags no `/prism-telemetry` subcommand maps to —
`--agreement`, `--phase-1-5-agreement`, `--recommend-calibration` (K1-K4
calibration knobs), `--blindness-canary`, `--routing-log <path>`, `--home
<path>` — run `node tools/prism-telemetry-aggregate.mjs --help` for the
full surface.

## NO NETWORK CALLOUT

**v3.1 explicitly does NOT:**
- Make HTTP requests
- Ship telemetry to any remote endpoint
- Run telemetry-as-a-service in any form

Aggregation is purely local file I/O against `~/.claude/.prism-routing.jsonl` → `~/.claude/.prism-telemetry-rollup.json`. Sharing the rollup is a manual `--export` step. A future SaaS layer (if/when offered) will read the same rollup format — opt-in only, never on by default.

## Subcommands

Every subcommand below has a deterministic backing tool — do not improvise
the read/write logic; shell out to the cited script.

### `/prism-telemetry --opt-in`
Sets `telemetry.opt_in: true` in `~/.claude/prism-policy.json`. Creates the policy file if missing, with the minimum schema:

```json
{
  "schema_version": "3.1.0",
  "telemetry": { "opt_in": true }
}
```

Confirms the write target with the user before touching disk. Once opted-in, aggregation auto-runs at session-end.

**Backing tool:** `node tools/prism-bootstrap.mjs set-telemetry-consent on` (installed: `node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent on`). Writes `prism-policy.json` atomically. Honours `DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1` — if either is set, the tool forces `opt_in:false` regardless of the `on` arg and reports `forced_off_by_env` in its JSON output.

### `/prism-telemetry --opt-out`
Sets `telemetry.opt_in: false` in `~/.claude/prism-policy.json`. Stops auto-aggregation immediately. The existing rollup file is **preserved** (not deleted) — user can still inspect or `--export` it.

**Backing tool:** `node tools/prism-bootstrap.mjs set-telemetry-consent off`.

### `/prism-telemetry --status`
Prints:
- Opt-in state (`true` / `false` / `not configured`)
- Last aggregation timestamp (from rollup `last_event` or file mtime)
- Rollup size (bytes / KB)
- Path to rollup file

**Backing tool (opt-in state only):** `node tools/prism-bootstrap.mjs detect-telemetry-consent` returns the persisted opt-in state as JSON (plus `forced_off_by_env` / `effective_opt_in` when an opt-out env var is set). The remaining fields (last-aggregation timestamp, rollup size, rollup path) have no dedicated tool — read `~/.claude/.prism-telemetry-rollup.json` directly (`last_event` field + file stat) to compose the rest of the status line.

### `/prism-telemetry --export <path>`
Dumps current rollup to user-chosen `<path>`. Before write:
- Anonymizes any `session_id` fields → `sha256short` (first 12 chars of sha256)
- Prompt hashes are already short-hashed in the source jsonl, passed through as-is
- **NO raw prompts** ever included in export (the rollup format does not store them; this is a guarantee, not a filter)

No dedicated tool exists for `--export` — this is a read-`.prism-telemetry-rollup.json` / anonymize / write-to-`<path>` transform performed directly (low-risk: read-only source, no schema mutation).

### `/prism-telemetry --aggregate`
Manual trigger. Re-reads `~/.claude/.prism-routing.jsonl`, recomputes rollup, writes `~/.claude/.prism-telemetry-rollup.json`. Default behavior is auto-run at session-end when `telemetry.opt_in: true`; this subcommand is for ad-hoc refresh.

**Backing tool:** `node tools/prism-telemetry-aggregate.mjs` (installed: `node ~/.claude/tools/prism-telemetry-aggregate.mjs`). Refuses to run (exit 13) unless `telemetry.opt_in: true` in `prism-policy.json`, or an industry-standard opt-out env var (`DO_NOT_TRACK`/`DISABLE_TELEMETRY`) is set — in which case it also refuses. Flags: `--dry-run` (compute, don't write), `--tuning` (print guard-tuning candidates), `--force` (bypass the opt-in gate; tests only).

## Rollup Schema

What lives inside `~/.claude/.prism-telemetry-rollup.json` after aggregation:

```json
{
  "schema_version": "3.1.0",
  "first_event": "ISO",
  "last_event": "ISO",
  "events_aggregated": N,
  "tier_distribution": { "haiku": N, "sonnet": N, "opus": N },
  "classifier_sources": {
    "opus": N,
    "sonnet-fallback": N,
    "cache": N,
    "keyword-floor": N,
    "allowlist": N,
    "force-opus": N
  },
  "guard_denies": {
    "mutation": N,
    "dispatch": N,
    "model": N,
    "tier_advisor": N,
    "safety": N,
    "parallel": N,
    "panel": N,
    "skill_trigger": N
  },
  "force_opus_uses": N,
  "subagent_bypasses": {
    "parent_tool_use_id": N,
    "env": N,
    "sentinel.dispatched": N
  },
  "panel_summons": { "true": N, "false": N },
  "estimated_cost_usd": "<best-effort from cost multipliers>"
}
```

`estimated_cost_usd` is best-effort, computed from the configured cost multipliers per tier and the recorded event counts. It is an estimate, not a billing record.

## Inspection

The rollup is plain JSON. Inspect freely:

```sh
jq . ~/.claude/.prism-telemetry-rollup.json
jq '.tier_distribution' ~/.claude/.prism-telemetry-rollup.json
jq '.guard_denies | to_entries | sort_by(-.value)' ~/.claude/.prism-telemetry-rollup.json
```

A future opt-in SaaS layer will consume the same rollup format unmodified.
