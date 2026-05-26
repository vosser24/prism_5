# PRISM migration guide

This guide covers upgrading from PRISM v3.8.x or v3.10.x to v3.11.0
(foundation hardening) and then to v4.0.0 (project-master surface). It is
adapted from `docs/prism/adjudications/D004-v4-product-vision.md` §Migration
recipe (lines 165-188).

> **TL;DR**: `git pull` + re-run the installer + `/prism-bootstrap` on each
> project. The bootstrap is idempotent, detects-and-adopts v3.8.9-style
> installs, and the project-master phase is opt-in. Nothing breaks silently.

## Version map

| You are on | You want | Read |
|---|---|---|
| v3.8.x | v4.0.0 | Both sections below in sequence — v3.11.0 sub-phases run first |
| v3.10.x | v4.0.0 | Both sections below in sequence |
| v3.11.0 | v4.0.0 | Skip to [§v3.11.0 → v4.0.0](#v3110--v400-project-master) |
| pre-v3.8 | v4.0.0 | Read CHANGELOG entries for v3.8.x first, then this guide |

---

## v3.10.x → v3.11.0 (foundation)

The v3.11.0 release adds the locked-design state machine, two new daily
workflow commands, and the plugin auditor — none of which existed in v3.10.

1. **Pull the repo**

   ```bash
   git pull
   ```

2. **Re-run the installer**

   Plugin install path:

   ```text
   /plugin update prism@PRISM
   ```

   Manual install path (bash):

   ```bash
   bash scripts/install.sh
   ```

   Manual install path (PowerShell-native, Windows):

   ```powershell
   .\scripts\install.ps1
   ```

   The installer is idempotent and backs up your existing `~/.claude/` to
   `~/.claude/backups/pre-prism-<ts>/` before any write.

3. **On any existing project: run `/prism-bootstrap`**

   ```text
   /prism-bootstrap
   ```

   What happens:

   - If the project has a v3.8.9-style populated `.claude/` tree, the
     bootstrap **detects-and-adopts**: each phase whose filesystem evidence
     is present (e.g. `.claude/agents/roster.json` ⇒ roster phase) gets
     marked complete with `synthesized: true`.
   - The v2-only phases (`plugin-validate`, `project-master`) start at
     `status: null` since they have no v3.8.9 signal (D004 §4).
   - The new `plugin-validate` phase runs as a sentinel stub (~2 sec).
   - The `project-master` phase is **skipped by default**; a one-line nudge
     at the end says *"To create your project-master agent, run `/prism-deep-dive`."*

   Re-running on a fully bootstrapped project is a safe no-op modulo
   refreshed `completed_at` timestamps.

4. **Use the new daily commands**

   - **`/prism-sync`** — refresh PRISM's project index (re-runs discovery,
     roster reconcile, and health checks). Conservative drift: it always
     re-scans, since v3.11.0 ships report-only drift detection per D002 §5.

   - **`/prism-clean`** — capture durable session knowledge into
     `docs/prism/`. Applies a 5-level importance classifier (D-level
     decision → adjudication; lesson-level → MEMORY.md pointer with 25 KB
     cap enforcement; below-threshold → drop). Use this before `/clear`
     or at session end.

5. **Validate installed plugins** (optional but recommended)

   ```text
   /prism-validate-plugins
   ```

   Report-only audit. Surfaces broken hooks, missing manifests, skill-name
   conflicts. `--fix` is deferred to v3.12.0 per D004 risk #5 — for now
   the slash command shows the remedy but does not modify settings.json.

### Verifying the v3.11.0 upgrade

After the above:

- `node ~/.claude/tools/prism-bootstrap.mjs status` should report all 7
  phases. Project-master will show `null` unless `--with-deep-dive` was
  passed. The other 6 should have `completed_at` set.
- `~/.claude/hooks/agent-write-register.ps1` should exist (the new
  auto-fire hook from Phase A.3).
- `~/.claude/skills/prism-clean/`, `prism-validate-plugins/`, and
  `prism-sync` should be present.

---

## v3.11.0 → v4.0.0 (project-master)

The v4.0.0 release adds the per-project master agent, migrates the
orchestration protocol from agent file to skill, and ships the Phase J
tightened PHASE 1.5 evidence rules.

1. **Pull the repo + re-install**

   ```bash
   git pull
   ```

   Then re-run the installer per step 2 of the v3.11.0 section above.

2. **Decide which projects get a master**

   The `master-<slug>` agent is opt-in per D004 §8 — PRISM does not auto-
   generate one. Two paths to create one:

   **Path A** — at bootstrap time:

   ```text
   /prism-bootstrap --with-deep-dive
   ```

   When phase 6 (project-master) runs, the bootstrap invokes
   `/prism-deep-dive` itself to complete the agent generation.

   **Path B** — on an already-bootstrapped project, run the slash command
   directly:

   ```text
   /prism-deep-dive
   ```

   Either way, you get up to 5 clarifying questions about the project's
   stack, datasources, and primary workflow.

3. **What the deep-dive writes**

   - `<project>/.claude/agents/master-<slug>.md` — the project-local agent
     with `memory: project` + `skills: [master-orchestrator]` in the
     frontmatter. The agent's body explains what it does for *this*
     project; the orchestration protocol is in the skill.
   - `<project>/.claude/MEMORY.md` — seeded with router pointers. Hard 25
     KB cap (D004 §risk #2) is enforced on every subsequent write.
   - `<project>/.claude/settings.json` — `agent: master-<slug>` field
     written via atomic merge (preserves your other settings).

4. **First next session in that project**

   Claude Code reads `settings.json` `agent:` on session start and runs
   the main thread as `master-<slug>`. The agent auto-loads the
   `master-orchestrator` skill, which carries the PHASE 0–9 multi-step
   protocol with adversarial review and Phase 1.5 senior-review evidence
   rules.

5. **Backward compatibility**

   - `@master-orchestrator` mentions still work — the agent file is a
     thin wrapper that loads the same skill.
   - Non-project sessions (no `<project>/.claude/settings.json`) still
     use the global master-orchestrator agent.
   - All v3.11.0 commands continue to work.

### Verifying the v4.0.0 upgrade

After running `/prism-deep-dive` on a project:

- `<project>/.claude/agents/master-<slug>.md` exists with frontmatter
  containing `skills: [master-orchestrator]`.
- `<project>/.claude/MEMORY.md` exists, ≤25 KB.
- `<project>/.claude/settings.json` contains an `"agent"` key set to
  `"master-<slug>"`.
- Open a fresh session in the project; the master agent should engage
  on multi-step requests and dispatch specialists (when the task crosses
  the FULL-NOVEL classification threshold).
- For the orchestration skill itself: `~/.claude/skills/master-orchestrator/SKILL.md`
  should carry the protocol body; the agent file `~/.claude/agents/master-orchestrator.md`
  should be a thin wrapper.

---

## Known limitations carried into v4.0

| Item | State | Tracking |
|---|---|---|
| `SessionEnd[clear]` + `PreCompact` nudge hooks | Deferred | [D005](adjudications/D005-phase-f-hook-api-incompatibility.md) — retry in v4.1 with flag-file + SessionStart pickup |
| `/prism-validate-plugins --fix` | Deferred | v3.12.0 per D004 risk #5 |
| `--smart-drift` mode of `/prism-sync` | Stub (stderr warning) | v3.12.0 per D002 §5 |
| User hook customization preservation | Not yet | v4.1+ |
| Tested on macOS native | Not yet | Linux + Windows tested |

---

## Rollback

Each release ships with an uninstall path that preserves user data, per
the v3.8.4 critical hotfix.

```bash
# bash (Linux / macOS / Git Bash):
bash scripts/uninstall.sh --purge

# PowerShell-native (Windows):
.\scripts\uninstall.ps1 -Purge
```

The uninstaller copies `references/roster.json` and
`references/update-log.json` (your researched-specialist registrations and
NotebookLM notebook IDs) to `$env:TEMP\prism-uninstall-preserve-<ts>\`
BEFORE removing the prism-plan skill directory, then restores them after
PRISM removal completes.

Your most recent `~/.claude/backups/pre-prism-<ts>/` keeps the prior
state file and config. To restore manually:

```bash
# Find your most recent backup
ls -t ~/.claude/backups/pre-prism-*/

# Restore (Linux/macOS)
cp -r ~/.claude/backups/pre-prism-<ts>/* ~/.claude/
```

```powershell
# Restore (Windows PowerShell)
Copy-Item -Recurse "$env:USERPROFILE\.claude\backups\pre-prism-<ts>\*" "$env:USERPROFILE\.claude\"
```

After a manual restore, run `/prism-bootstrap` to re-validate the
state machine against the restored filesystem.

---

## Where to get help

- `/prism-doctor` — symptom-driven diagnostic that reads recent routing
  log + checks env, roster integrity, settings.json wiring, hook syntax.
  Confirms before applying any fix.
- `/prism-help` — curated v4.0 slash-command index by workflow.
- `CHANGELOG.md` — full release-by-release change history.
- `docs/prism/adjudications/D004-v4-product-vision.md` — the locked v4.0
  design (parent of this guide).
- Issues: <https://github.com/vosser24/prism_master/issues>

---

*This guide is canonical for v4.0.0 (released 2026-05-26). If you're on
an unreleased branch, cross-check against the CHANGELOG entry for your
version.*
