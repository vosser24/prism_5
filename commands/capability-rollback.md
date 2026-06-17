---
name: capability-rollback
description: Manually roll back a capability to its prior version
---

Restores a PRISM ACL-managed capability to its prior version snapshot
(`versions/<n-1>/`). Idempotent: if the capability is already at v1, or
has no prior version snapshot, the command is a safe no-op (exits 0).

## Usage

```
/capability-rollback <name>
```

| Argument | Required | Description |
|---|---|---|
| `<name>` | yes | The roster key of the capability to roll back (e.g. `watchdog-monitor-builder`) |

## What it does

1. Looks up `<name>` in the global roster.
2. If not found, or already at v1, exits cleanly (no-op).
3. Locates the prior version snapshot at
   `~/.claude/skills/<name>/versions/<n-1>/<name>.md`
   (or `agents/<name>/versions/<n-1>/` for agent-type capabilities).
4. Atomically restores the prior version to the live path.
5. Decrements the roster `version` field.
6. Appends a `rolledback` entry to the ACL digest.

## Example

```
/capability-rollback watchdog-monitor-builder
```

Output:
```
capability-rollback: 'watchdog-monitor-builder' reverted v2→v1
```

## Idempotency

Running `/capability-rollback` on a capability that is already at its
lowest version is safe:

```
capability-rollback: 'watchdog-monitor-builder' is already at v1 — no prior version to restore (no-op)
```

## Implementation

Invoke the thin CLI:

```bash
node ~/.claude/tools/prism-capability-cli.mjs rollback <name>
```

or, from the repo root:

```bash
node tools/prism-capability-cli.mjs rollback <name>
```

## Notes

- This is a manual override. The ACL rollback guard (`hooks/prism-acl-rollback-guard.mjs`)
  handles auto-rollback automatically when a correction is detected after an upgrade.
- The prior version snapshot is created by the ACL learn/upgrade pass and is
  guaranteed to exist for any ACL-upgraded capability.
- To view the rollback history, use `/capability-log`.
- To inspect the roster, use `/prism-roster`.
