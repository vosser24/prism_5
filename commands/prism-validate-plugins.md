---
name: prism-validate-plugins
description: Audit installed Claude Code plugins for broken hooks, missing manifests, and skill-name conflicts. Report-only in v3.11.0; --fix deferred to v3.12.0.
---

# /prism-validate-plugins — v3.11.0 Phase C

Locked design: `docs/prism/adjudications/D004-v4-product-vision.md` Phase C.
Helper: `tools/prism-validate-plugins.mjs`.

**Purpose:** detect plugin-installation problems that would otherwise
silently degrade the user's Claude Code environment (e.g., a hook that
shells out to a deleted script, a skill name registered by two plugins
simultaneously, a plugin whose directory was removed without an uninstall).

**Scope:** report-only. `--fix` is deferred to v3.12.0 per D004 risk
register #5 (false-positive risk on legitimate plugins). When findings
suggest a remedy, the slash command shows the user what they can do but
does not modify settings.json automatically.

---

## Step 0 — git guard

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: STOP. The audit needs a project root to anchor temp
paths and to keep operations scoped.

## Step 1 — run the audit

Run: `node ~/.claude/tools/prism-validate-plugins.mjs audit --json`

Helper exit codes:
- `0` — clean
- `1` — error-level findings present (broken_hook or missing_manifest)
- `2` — git guard
- `7` — `claude` CLI not found (advisory; tell user to install Claude Code first)
- `8` — plugin list output not valid JSON

The `--json` flag emits structured findings:
```json
{
  "plugins_audited": 5,
  "findings": [
    {"level": "error", "type": "broken_hook", "plugin": "foo", "message": "...", "path": "..."},
    {"level": "warn",  "type": "skill_conflict", "plugin": null, "message": "...", "owners": ["a","b"]}
  ]
}
```

## Step 2 — surface findings

Group by level: `error` first, then `warn`.

For each finding, show:
- The plugin (if attributed)
- The check type (`broken_hook`, `missing_manifest`, `skill_conflict`)
- The actionable message

**Suggested remedies (manual — DO NOT auto-apply):**

| Finding type | Suggested remedy |
|---|---|
| `broken_hook` | Either restore the missing file (re-run the plugin install) or remove the hook entry from `~/.claude/settings.json`. |
| `missing_manifest` | Run `claude plugin uninstall <name>` then reinstall, OR re-clone the plugin into its expected path. |
| `skill_conflict` | Disable one of the conflicting plugins, OR check the plugin authors' docs for a namespacing override. PRISM does NOT pick a winner. |

## Step 3 — summary

If no findings: report "✅ All plugins look healthy. <N> audited."

If only warnings: report "⚠ <N> warning(s) found — no auto-fixable, review when convenient."

If errors: report "❌ <N> error(s) — your environment may be degraded. See suggested remedies above."

DO NOT call `prism-validate-plugins audit --fix`. That flag does not
exist in v3.11.0.

---

## Failure modes

| Helper exit | /prism-validate-plugins behaviour |
|---|---|
| 0 / 1 | Normal report-out (clean or findings) |
| 7 | Tell user the `claude` CLI is not on PATH; install Claude Code, or pass `PRISM_PLUGIN_LIST_FIXTURE=<file>` to test against a captured list. |
| 8 | `claude plugin list --json` returned non-JSON. Likely a CLI version mismatch — ask user to upgrade Claude Code. |
| other non-zero | Surface stderr to the user; do not retry automatically. |

## Related

- `/prism-bootstrap` — sets up the project; the new v2 `plugin-validate` phase runs a stub that future versions may delegate to this audit.
- `/prism-doctor` (legacy, hidden) — was the catch-all health check before PRISM v3.10; this command is the plugin-specific replacement.
