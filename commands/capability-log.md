---
name: capability-log
description: Show the ACL capability create/upgrade/rollback history
---

Print the Autonomous Capability Loop (ACL) event history from the local
digest (`~/.claude/.prism-acl-digest.json`). Covers all capabilities
created, upgraded, or rolled back in the current digest window.

## Usage

```
/capability-log
```

No flags. Read-only — does not modify any state.

## Output

```
ACL Capability History
======================

Created:
  + watchdog-monitor-builder
  + uptime-checker-builder

Upgraded:
  ^ greek-seo-agent (v3→v4)

Rolled back:
  < greek-seo-agent (v4→v3)
```

If there is nothing in the digest, prints `(no entries)`.

## Implementation

Invoke the thin CLI:

```bash
node ~/.claude/tools/prism-capability-cli.mjs log
```

or, from the repo root:

```bash
node tools/prism-capability-cli.mjs log
```

## Notes

- The digest accumulates entries across sessions until it is cleared by the
  `prism-acl-notify` SessionStart hook (which consumes it and shows the
  one-line notice). After that, the digest is empty until the next ACL cycle.
- To manually trigger a rollback, use `/capability-rollback <name>`.
- To inspect the roster directly, use `/prism-roster`.
