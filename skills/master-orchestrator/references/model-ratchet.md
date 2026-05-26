---
name: model-ratchet
description: Model ratchet — escalate-up (sonnet→opus after 3 corrections), deescalate-down (opus→sonnet after 5 successful sonnet tasks zero corrections), reset on factory upgrade. Companion to phase-2-completion.md.
---

# Model Ratchet (v2.7.0 — escalation / deescalation with reset)

Track model actually used and whether the task completed without correction (`consecutive_successful_sonnet_tasks` counter in roster).

## Escalate up (existing behavior)

- If sonnet-tier task required Opus-level correction → increment
  `corrections_since_last_upgrade`
- If `corrections_since_last_upgrade ≥ 3` → set `default_model: "opus"`,
  log reason to `agents/{name}/lessons/improvements.md`

## Deescalate down (NEW v2.7.0)

- If opus-locked agent completes 5 consecutive sonnet-tier tasks with
  zero corrections → reset `default_model: "sonnet"`, zero the
  `consecutive_successful_sonnet_tasks` counter, log to
  `agents/{name}/lessons/improvements.md`: "Deescalated default model
   to sonnet after 5 successful tasks with zero corrections."
- Manual override available via `node ~/.claude/tools/prism-roster.mjs --reset-model @<name>`.

## Reset on factory upgrade (NEW v2.7.0)

- When `@agent-factory` completes an upgrade (quick refresh or full
  rebuild), clear ALL of:
    - `default_model: null`   (next hire re-evaluates from scratch)
    - `pending_upgrade: false`
    - `corrections_since_last_upgrade: 0`
    - `consecutive_successful_sonnet_tasks: 0`
- Log to `agents/{name}/lessons/improvements.md`: "Upgrade complete.
   Default model reset; next hire re-evaluates based on current task
   complexity."
- Rationale: an opus-lock accumulated before refresh shouldn't
  persist past the refresh — the refreshed agent deserves a fresh
  evaluation against its new knowledge.

## Verdict-log ratchet (v4.4 NEW)

Separate from the in-process ratchet above. Runs via `node ~/.claude/tools/prism-roster.mjs --apply-ratchet`, invoked by `/prism-clean` at end-of-session hygiene.

Reads `~/.claude/.prism-phase-1-5-verdicts.jsonl` (append-only log of OOB reviewer outcomes). For each specialist with ≥N=10 dispatches in the log:

- UN-CITED rate ≥ 0.30 → set `pending_upgrade: true`, status: `"upgrade_needed"`, log to `agents/{name}/lessons/improvements.md`: "Evidence-discipline ratchet: UN-CITED rate {rate} over last {N} dispatches."
- UN-CITED rate < 0.10 AND `pending_upgrade: true` AND no other ratchet flagged → no clear (manual review only — auto-clear deferred to v4.5).

Atomic write: tempfile + rename on roster.json. Parallel-session safety: not implemented in v4.4; concurrent `--apply-ratchet` calls can race on roster.json (last-writer-wins). Deferred to v4.5 (flock or lock-file pattern).
