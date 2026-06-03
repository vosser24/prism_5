---
name: prism-fresh
description: Refresh this project's master-<slug> agent from the current codebase — memory-only. Thin wrapper for /prism-deep-dive --refresh. Does NOT rewrite the learned agent body (that is /prism-deep-dive --upgrade).
---

# /prism-fresh — refresh the project-master's memory

`/prism-fresh` re-runs the project-master's discovery + clarifying pass and
**regenerates `MEMORY.md`** from the refreshed project profile, without
touching the agent body. Use it when the codebase has moved on (new
modules, renamed surfaces, changed stack) and the master's seeded memory
has drifted.

It is a **thin alias** for:

```
/prism-deep-dive --refresh
```

## What it does (memory-only)

Delegates to `/prism-deep-dive --refresh`, which:

1. Keeps the locked slug (no re-slugging).
2. Re-runs discovery (Step 2) + clarifying questions (Step 3).
3. Does **not** overwrite the agent `.md` body (Step 4a skipped).
4. Regenerates `MEMORY.md` from the refreshed profile (Step 4b).
5. Leaves `settings.json` `agent:` untouched (Step 4c skipped).
6. Stamps `last_refreshed_at` on the project-master phase meta.

## What it does NOT do

- ❌ **Does not rewrite the learned master agent body.** That is a
  separate, diff-confirmed action — `/prism-deep-dive --upgrade <slug>` —
  kept distinct on purpose: the agent body accumulates project-specific
  tuning that a silent refresh must never clobber.
- ❌ Does not re-create the project-master from scratch (use
  `/prism-deep-dive` or `/prism-bootstrap` for first-time creation).

## When to use which

| Goal | Command |
|---|---|
| Master's memory is stale; refresh facts only | `/prism-fresh` |
| Re-synthesize the agent body (diff + confirm) | `/prism-deep-dive --upgrade <slug>` |
| First-time project-master creation | `/prism-bootstrap` (default) or `/prism-deep-dive` |

## Protocol

Invoke the `prism-deep-dive` skill / command with the `--refresh` flag and
follow its `--refresh` mode exactly. `/prism-fresh` adds no behavior of its
own beyond pinning the refresh-only (never `--upgrade`) semantics.
