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
| v3.8.x | v4.5.0 | Run v3.11.0 sub-phases, then v4.0.0, v4.1.0, v4.2.0, v4.3.0, v4.4, and v4.5 sections in sequence |
| v3.10.x | v4.5.0 | Same as above starting at v3.11.0 |
| v3.11.0 | v4.5.0 | Skip to [§v3.11.0 → v4.0.0](#v3110--v400-project-master), then v4.x sections |
| v4.5.x | v4.6.0 | This page, [§v4.5 → v4.6](#v45--v46) below |
| v4.4.x | v4.5.0 | This page, [§v4.4 → v4.5](#v44--v45) below |
| pre-v3.8 | v4.5.0 | Read CHANGELOG entries for v3.8.x first, then this guide |

---

## v4.5 → v4.6

### Upgrade — run the installer

```bash
git pull
node tools/prism-installer.mjs update
node tools/prism-installer.mjs verify
```

If the installer reports `Already at v4.6.0; nothing to do.`, you're done. (If you previously ran a v4.6-dev `--target` testbed, re-run the install to pick up the corrected hook paths — see below.)

### What changed

#### `.prism-routing.jsonl` schema (3 → 4) — additive, no action

v4.6 adds three additive fields/events: `actual_parallel` + `queue_depth` on `dispatch_cap` events, and a new `master_override` event. The bump is additive — v4.5 readers ignore unknown fields, and v4.6 readers default the new fields safely. No migration step; old logs continue to work.

#### New CLI surfaces

- `node tools/prism-telemetry-aggregate.mjs --recommend-calibration` — on-demand calibration engine. Reads your routing + verdict logs and prints threshold-change *recommendations* with the exact apply commands. It NEVER changes a default itself (recommend-then-apply). Degrades to "insufficient data" below 15 samples per knob. Output also written to `~/.claude/.prism-calibration-<date>.json`.
- `node tools/prism-roster.mjs --set-model <agent> <model>` — set an agent's `default_model` (K2 apply target).
- `node tools/prism-roster.mjs --clear-pending-upgrade <agent>` — clear a stale `pending_upgrade` flag (K3 apply target).

#### New env var

- `PRISM_OVERRIDE_GATE=strict` — escalates the SessionStart advisory wording when you overrode reviewer verdicts last session. Advisory only (SessionStart cannot hard-block).

#### `--target` installs now behaviorally live (H3)

Prior to v4.6, `installer install --target <dir>` copied files but left the registered hook commands pointing at `~/.claude` (so the target's hooks never fired). v4.6 rewrites the hook-command paths to the target dir. If you maintain a `--target` testbed, re-run the install so its hooks resolve correctly. Default (`~/.claude`) installs are unchanged.

### Rollback

State files (`MEMORY.md`, `roster.json`, `.prism-routing.jsonl`) are preserved across a downgrade. The schema-4 fields are simply ignored by v4.5. Use `node tools/prism-installer.mjs uninstall --restore-backup <v4.5-backup>` to revert.

## v4.4 → v4.5

**Additive only.** No breaking changes. Existing rosters, panels, and routing logs work unchanged.

### Upgrade — use the new `update` subcommand

The v4.5 installer ships an `update` subcommand that chains `detect → backup → install` with version-equal idempotency. Recommended over bare `install` for upgrades.

**Windows (PowerShell):**
```powershell
git pull
node tools/prism-installer.mjs update
```

**Mac / Linux / git-bash:**
```bash
git pull
node tools/prism-installer.mjs update
```

Append `--dry-run` to preview without writing. Append `--target /path/to/.claude` to upgrade an install other than `~/.claude/`.

If the installer reports `Already at v4.5.0; nothing to do.`, you're done.

### What changed

#### Roster schema (4.4.0 → 4.5.0)

Two new per-agent fields (both optional, default false):
- `phase_1_5_lite_oob` — opt agent into LITE-mode Phase 1.5 OOB review (cheaper variant). When `true`, the OOB hook loads the shorter `agents/phase-1-5-oob-reviewer-lite.md` prompt instead of the full reviewer prompt (and propagates `PRISM_OOB_USE_LITE=1` to the async worker). Falls back to the FULL prompt silently if the lite file is absent.
- `skip_next_oob` — ephemeral; auto-cleared after one SubagentStop. Set via `node tools/prism-roster.mjs --skip-next-oob <spec>` when you need to bypass OOB review for one specific dispatch.

Existing rosters work unchanged. The `update` subcommand merges the new schema without overwriting your user agents.

#### `.prism-routing.jsonl` schema (2 → 3)

Two new event types added (both additive):
- `phase_0d_challenge` — emitted by `prism-phase-0d-challenges.mjs` on PostToolUse Write to panel.json.
- `dispatch_cap` — emitted by `prism-dispatch-cap.mjs` on PostToolUse Agent (parallel-dispatch utilization).

v4.4 readers (drift-guard, telemetry-aggregate) ignore unknown fields; existing log entries with `schema_version: 2` remain valid forever.

#### `panel.json` schema

Two new optional fields:
- `dropped_positions[]` — auto-populated by `prism-panel-guard.mjs` Path B when positions have zero challenges or missing specialists.
- `rationale.alternatives_considered[]` — populated by the master at end of Phase 0d; format `[{approach, why_not}]` (both fields must be non-empty strings).

Masters running pre-v4.5 panel-guard simply don't write these fields; the A1 OOB reviewer (`prism-phase-0d-oob.mjs`) handles their absence per OQ-5 (treats absent as "alternatives not logged" without penalizing).

#### Installer flags + subcommands

- `--target <dir>` — point installer at a `.claude/` directory other than `~/.claude/`. Available on `install`, `update`, `uninstall`, `verify`, `detect`. Mutually exclusive with `--home`.
- `update` — `detect && backup && install` chained. Idempotent (`Already at vX; nothing to do.` on no-op).
- `uninstall --purge-state` — additionally wipes `MEMORY.md`, `roster.json`, `prism-policy.json`, `.prism-routing.jsonl`, `.prism-spend.jsonl`, `.prism-phase-1-5-verdicts.jsonl`, `.prism-telemetry-rollup.json`, `.prism-flags/`, `.prism-task-*/`. Interactive prompt unless `--yes`. `--quiet --purge-state` without `--yes` exits 2 (don't surprise-delete user data in scripts).
- Backup is now wider: every install creates `<target>/.prism-install-backup-<timestamp>/` capturing shipped files (`agents/`, `hooks/`, `tools/`, `commands/`, `skills/`) **plus** user state. Restore via `uninstall --restore-backup <dir>` (unchanged from v4.4).

#### SCOPE GUARD (advisory)

`hooks/prism-panel-guard.mjs` now emits a `SCOPE GUARD: position "<title>" appears outside panel scope "<scope>"` warning on stderr when a position's title shares no keywords with the panel scope phrase. Advisory by default — exits 0. Set `PRISM_SCOPE_GUARD=strict` to make it blocking (exit 2). Kill via `PRISM_DISABLE_SCOPE_GUARD=1`.

The heuristic is intentionally loose (keyword overlap on 4+ char tokens). Real adversarial panels often use vocabulary not in the scope phrase, so blocking would over-fire. v4.6 may upgrade the heuristic.

### Rollback

If you need to roll back to v4.4:

```bash
# Find the v4.4 backup created by the v4.5 update
ls ~/.claude/.prism-install-backup-*

# Uninstall v4.5 (preserves state)
node tools/prism-installer.mjs uninstall

# Restore the v4.4 backup manually OR git checkout v4.4.0 and re-run install
git checkout v4.4.0
node tools/prism-installer.mjs install
```

State files (`MEMORY.md`, `roster.json`, `.prism-routing.jsonl`) are preserved across the down-grade. The roster's new v4.5 fields (`phase_1_5_lite_oob`, `skip_next_oob`) are simply ignored by v4.4 — no migration on rollback.

---

## v4.3 → v4.4

**Backward compatible.** Legacy installs continue to work without changes.

### Upgrade — run the installer

The v4.4 installer handles backup, upgrade, and settings merge automatically.

**Windows (PowerShell):**
```powershell
git pull
pwsh .\install.ps1
```

**Mac / Linux / git-bash:**
```bash
git pull
bash install.sh
```

The installer will:
1. Back up your existing `~/.claude/settings.json` and `roster.json`
2. Remove old PRISM files by name pattern
3. Copy new v4.4 files
4. Merge `settings.json` (JSON-aware; no duplicate hook entries; your non-PRISM hooks are preserved)
5. Preserve your roster agents, `prism-policy.json`, and `.prism-*.jsonl` telemetry logs
6. Run a post-install verify pass

After install, confirm with:
```bash
node tools/prism-installer.mjs verify
```

### What changed in v4.4

- `skills/master-orchestrator/SKILL.md` shrunk from 770 lines to ~130 lines. Detailed protocols moved to `skills/master-orchestrator/references/`.
- Roster schema bumped to 4.4.0. New optional per-agent flags `requires_phase_1_5` and `requires_phase_1_5_block` (default false).
- New SubagentStop hook `hooks/prism-phase-1-5-oob.mjs` registered as 3rd entry (after spend ledger and panel guard).
- New tools: `tools/prism-roster.mjs`, `tools/prism-phase-1-5-verdicts.mjs`, `tools/lib/prism-verdict-flag.mjs`.
- New installer: `tools/prism-installer.mjs` + `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1`.

### Opting into OOB PHASE 1.5 review

OOB review is opt-in per-agent. After upgrading:

```
node ~/.claude/tools/prism-roster.mjs --tag-1-5 @claude-master
node ~/.claude/tools/prism-roster.mjs --tag-1-5 @code-reviewer
```

To enable block-mode (master pauses for verdict — for agents whose output drives irreversible actions), edit `roster.json` directly:

```json
"agents": {
  "schema-migrator": {
    "requires_phase_1_5": true,
    "requires_phase_1_5_block": true
  }
}
```

### `claude` CLI prerequisite

The OOB reviewer requires the `claude` CLI to be on PATH (your Claude Code subscription auth). The hook invokes `claude -p` via `spawnSync` — no separate `ANTHROPIC_API_KEY` is needed. If the `claude` binary is missing, the hook logs `claude-binary-missing` to `.prism-routing.jsonl` and skips the review (no block, fail-open). Each review counts against your Claude Code subscription quota (~5–15s per review, no separate billing).

### Kill switches

- Per-session: `export PRISM_DISABLE_OOB_REVIEW=1`
- Per-agent: set `requires_phase_1_5: false` in roster.json
- System-wide: remove the hook entry from `settings.fragment.json`

### Verifying the upgrade

After upgrading and tagging a pilot agent:

1. Run the installer verify: `node tools/prism-installer.mjs verify`
2. Run a real specialist dispatch (e.g., spawn `@code-reviewer` on a small task).
3. Check `~/.claude/.prism-routing.jsonl` for an `event: phase_1_5_oob` entry.
4. Wait for the next session start; if any UN-CITED/REJECTED verdict was issued, you'll see a `[Prior turn] OOB PHASE 1.5 reviewer flagged …` notice.
5. Query the verdict log: `node ~/.claude/tools/prism-phase-1-5-verdicts.mjs --agent @code-reviewer`.

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
   bash install.sh
   ```

   Manual install path (PowerShell-native, Windows):

   ```powershell
   pwsh .\install.ps1
   ```

   > v4.4+ installer supersedes the old `scripts/` path.

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
   - `<project>/.claude/agents/MEMORY.md` — seeded with router pointers.
     Hard 25 KB cap (D004 §risk #2) is enforced on every subsequent write
     by `tools/prism-clean.mjs` and `tools/prism-deep-dive.mjs`.
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
- `<project>/.claude/agents/MEMORY.md` exists, ≤25 KB.
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
| ~~`SessionEnd[clear]` + `PreCompact` nudge hooks~~ | ✅ Shipped in v4.1 Phase A | Per [D005](adjudications/D005-phase-f-hook-api-incompatibility.md) flag-file + SessionStart pickup. See "v4.0.0 → v4.1.0 (git hygiene)" below. |
| `/prism-validate-plugins --fix` | Deferred | v3.12.0 per D004 risk #5 |
| `--smart-drift` mode of `/prism-sync` | Stub (stderr warning) | v3.12.0 per D002 §5 |
| User hook customization preservation | Not yet | v4.1+ |
| Tested on macOS native | Not yet | Linux + Windows tested |

---

## v4.0.0 → v4.1.0 (git hygiene + freshness sweep + telemetry)

The v4.1 release adds three things on top of v4.0:

1. **Git-hygiene hook bundle** (Phase A): SessionEnd writes a flag if you exited via `/clear` or with a dirty working tree; PreCompact writes the same flag; the next SessionStart picks it up and nudges. PreToolUse on `Bash(git push *)` asks for confirmation + nudges to run `/code-review` + `/security-review` first.
2. **SessionStart daily freshness sweep** (Phase B): once per 24h, the SessionStart hook scans plugin cache / update-log / CLAUDE.md mtime / stale agents / tool rotations and surfaces relevant nudges. Domain-grouped roster view added.
3. **Telemetry auto-opt-in** (Phase C): `/prism-bootstrap` health phase asks whether to enable local-only telemetry. Cross-project rollup feeds the `prism-updater` agent's gap analysis.

### Steps

1. **Pull and re-run the installer.** Same commands as the v3.10→v3.11 upgrade above. The Phase A hooks are written to `~/.claude/hooks/`; the settings fragment is merged in by the installer.

2. **Verify the new hooks are wired.** After install, `grep -E 'SessionEnd|prepush-review|clean-nudge|git-clean-nudge|precompact-nudge' ~/.claude/settings.json` should return matches for all five entries. If any are missing, re-run `/prism-bootstrap` — its plugin-validate phase will detect drift and offer to repair.

3. **Test the git-hygiene nudge.** In any git project: leave an unstaged change, then `/clear`. Open a new Claude Code session in the same project. The first SessionStart should print a `PRISM NUDGE: previous session left N uncommitted changes` line.

4. **Test the pre-push nudge (optional).** Run a `git push` against a feature branch. Claude Code should prompt with the "Run /code-review and /security-review first" ask. Approve to proceed, or set `PRISM_DISABLE_PREPUSH_NUDGE=1` in env to silence.

5. **Opt-in or opt-out of telemetry.** During the next `/prism-bootstrap` run, the health phase (Step 7b) will prompt for telemetry consent. The prompt fires ONCE per machine — your choice is written to `~/.claude/prism-policy.json` under `telemetry.opt_in` and never re-asked. To skip the prompt entirely from the start, invoke bootstrap with `--no-telemetry`:

   ```text
   /prism-bootstrap --no-telemetry
   ```

   This records `opt_in: false` durably (so subsequent bootstraps don't re-prompt) without showing the prompt. The flag is honored by the slash command protocol (commands/prism-bootstrap.md Step 7b) and the deterministic helper (`tools/prism-bootstrap.mjs --no-telemetry`).

   To flip the choice later, use the existing slash commands:

   ```text
   /prism-telemetry --opt-in    # enable
   /prism-telemetry --opt-out   # disable; existing rollup preserved
   /prism-telemetry --status    # check current state
   ```

   Or directly via the helper:

   ```bash
   node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent on
   node ~/.claude/tools/prism-bootstrap.mjs set-telemetry-consent off
   ```

   The opt-in is local-only. No network calls, no shipping. Rollup lives at `~/.claude/.prism-telemetry-rollup.json` and is plain JSON.

### Off-switches for the new hooks (set in env)

| Env var | Effect |
|---|---|
| `PRISM_DISABLE_CLEAR_NUDGE=1` | SessionEnd[clear] flag-writer does nothing |
| `PRISM_DISABLE_PRECOMPACT_NUDGE=1` | PreCompact flag-writer does nothing |
| `PRISM_DISABLE_GIT_CLEAN_NUDGE=1` | SessionEnd git-dirty flag-writer does nothing |
| `PRISM_DISABLE_PREPUSH_NUDGE=1` | PreToolUse pre-push ask is suppressed |

All four are independent. The hook scripts themselves still run (the harness can't be told "skip this hook entirely without removing it") — they just exit 0 as no-ops when the off-switch is set.

Phase B also adds one more off-switch for the freshness sweep:

| Env var | Effect |
|---|---|
| `PRISM_DISABLE_FRESHNESS_SWEEP=1` | SessionStart daily freshness sweep skipped (no plugin-drift / stale-agent / update-log / CLAUDE.md / tools-registry checks; no snapshot written) |

### Telemetry consent (Phase C)

The bootstrap health phase (Step 7b) asks once whether to enable PRISM telemetry. The choice is durable in `~/.claude/prism-policy.json` under `telemetry.opt_in` and never re-asked on subsequent bootstraps. The rollup at `~/.claude/.prism-telemetry-rollup.json` is generated by `node ~/.claude/tools/prism-telemetry-aggregate.mjs` (also runnable via `/prism-telemetry --aggregate`) and consumed by the `prism-updater` agent's gap-analysis step to surface guard-tuning candidates.

Single-project today. Cross-project rollup needs each event to carry a `project` field, which requires touching every hook that writes the routing log — deferred to v4.2.

| Subcommand | Purpose | Exit codes |
|---|---|---|
| `tools/prism-bootstrap.mjs detect-telemetry-consent` | Read consent state | 0 always (prints JSON) |
| `tools/prism-bootstrap.mjs set-telemetry-consent on\|off` | Write consent state | 0 ok, 9 policy file malformed, 22 invalid arg |
| `tools/prism-telemetry-aggregate.mjs` | Refresh rollup from log | 0 ok, 13 no consent, 14 no log, 15 write failed |
| `tools/prism-telemetry-aggregate.mjs --dry-run` | Compute, print, don't write | 0 ok |
| `tools/prism-telemetry-aggregate.mjs --tuning` | Print tuning candidates only | 0 ok |

### Hard-gate mode (opt-in)

If you want pushes to PROCEED without the ask once you've already run `/code-review`, write a flag file:

```bash
# bash
mkdir -p ~/.claude/.prism-flags
cat > ~/.claude/.prism-flags/review-done__<project-key>.json <<'EOF'
{"flag":"review-done","branch":"<your-branch>"}
EOF
```

The `<project-key>` is `<dir-basename>__<12-char-sha256-of-abs-path>`; the easiest way to compute it is from the helper:

```bash
node -e "import('$HOME/.claude/tools/lib/prism-flag-file.mjs').then(h => console.log(h.projectKey('$(pwd)')))"
```

A future PostToolUse hook on `/code-review` completion will write this automatically; for v4.1 the writer is manual (this is plumbing-only — opt-in).

---

## v4.1.0 → v4.2.0 (telemetry privacy hardening + packaging polish)

The v4.2 release is a packaging-and-privacy follow-up. No new behavior; two
hardening changes to the v4.1 telemetry surface plus a manifest sync that
makes the marketplace-install path actually deliver v4.0+v4.1 features.

### What changed

1. **Telemetry default flipped from on-prompt-as-recommended to off-by-default.** The `/prism-bootstrap` Step 7b prompt now presents "Keep telemetry off (default)" as the first option. If you previously opted IN (i.e. `~/.claude/prism-policy.json` already records `telemetry.opt_in: true`), **your existing consent is preserved** — only the first-install default for new machines flipped.
2. **`DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1` env vars are now honored.** Either one set in the environment causes:
    - `prism-telemetry-aggregate` to refuse aggregation with exit 13 and a one-line stderr note naming the env var
    - `prism-bootstrap set-telemetry-consent on` to force-write `opt_in:false` regardless of the CLI arg (with a stderr explainer)
    - `prism-bootstrap detect-telemetry-consent` to return a `forced_off_by_env: <VAR>` field; Step 7b skips the prompt and persists opt-out durably
    - The env signal is **authoritative** and overrides any prior file-state opt-in (no policy mutation happens unless `set-telemetry-consent` is called)
3. **`.claude-plugin/plugin.json` synced to v4.1.** The marketplace-install path delivered a stale v3.8.9 surface through all of v4.0 and v4.1 (missing `SessionEnd`, `prepush-review`, `agent-write-register`, `precompact-nudge-flag` hooks). The manifest is now in lockstep with `settings.fragment.json` via a new drift-guard test at `tests/v3/state/test-plugin-manifest-drift.mjs`.

### Steps

1. **Pull and re-run the installer.** Same commands as the v4.0 → v4.1 upgrade above.

2. **(Optional) Set `DO_NOT_TRACK=1` globally if you want PRISM to never aggregate telemetry on this machine.** Add to your shell init:

   ```bash
   # bash / zsh — ~/.bashrc or ~/.zshrc
   export DO_NOT_TRACK=1
   ```

   ```powershell
   # PowerShell — $PROFILE
   $env:DO_NOT_TRACK = "1"
   ```

   This is independent of the per-machine `telemetry.opt_in` choice — env wins.

3. **Verify the manifest sync.** Once installed:

   ```bash
   node -e "const p=require('$(npm config get prefix 2>/dev/null || echo $HOME/.claude)/.claude-plugin/plugin.json'); console.log('plugin version:', p.version);"
   ```

   Should print `plugin version: 4.1.0`. If still `3.8.9`, the installer didn't pick up the new manifest — `/plugin update prism@PRISM` to fix.

### Off-switches added in v4.2

| Env var | Effect |
|---|---|
| `DISABLE_TELEMETRY=1` | Forces telemetry off; refuses aggregation; rewrites consent to `false` |
| `DO_NOT_TRACK=1` | Same as above (industry-standard alias, consoledonottrack.com) |

Both are independent of the PRISM-specific `telemetry.opt_in` policy. The env-var signal overrides; the file state is preserved for inspection.

---

## v4.2.0 → v4.3.0 (plugin-vs-manual provenance)

**What changed.** The agent-factory now tags each roster entry it creates with `installed_via: "plugin"` or `"manual"`, depending on whether `$CLAUDE_PLUGIN_ROOT` was set when the factory ran. This enables `/prism-uninstall-cleanup` — a new slash command that removes plugin-created agents before you `/plugin remove prism`.

**Backfill rule.** Existing roster entries (created before v4.3.0) lack the field. The cleanup tool treats missing-field entries as `"manual"` and **never removes them**. No migration step needed; your existing agents are safe.

**New slash command — `/prism-uninstall-cleanup`:**

- Lists plugin-tagged agents with creation dates.
- Offers `Remove all` / `Keep all`.
- Removes the agent directory (`~/.claude/agents/<name>/`), the flat file (`~/.claude/agents/<name>.md`), and the roster entry — atomically (tmp + rename on `roster.json`).
- Run this **before** `/plugin remove prism`. Once the plugin is removed, the slash command is also gone (unless you also have a manual install of PRISM in `~/.claude/`).

**Non-interactive flags** (for scripts and tests):

| Flag | Behavior |
|---|---|
| `--dry-run` | Lists plugin-tagged agents and exits 0. No writes. |
| `--mode=remove-all` | Non-interactive removal of every plugin-tagged agent. |
| `--mode=keep-all` | Non-interactive no-op. Exits 0. |

See `commands/prism-uninstall-cleanup.md` for the full UX flow.

**Master-`<slug>` exception.** Project-local master agents (under `<project>/.claude/agents/`) are NOT tagged with `installed_via` and are NOT touched by `/prism-uninstall-cleanup`. They were never global, so they were never part of the plugin-vs-manual question.

**No breaking changes.** Anyone upgrading from v4.2.0 keeps every agent and roster entry. The new field only appears on agents the factory creates *after* upgrading.

---

## Rollback

Each release ships with an uninstall path that preserves user data, per
the v3.8.4 critical hotfix.

```bash
# bash (Linux / macOS / Git Bash):
bash uninstall.sh

# PowerShell-native (Windows):
pwsh .\uninstall.ps1
```

> v4.4+ installer supersedes the old `scripts/` path.

The uninstaller removes all PRISM files and strips PRISM hooks from
`settings.json`. State files (`.prism-routing.jsonl`, `.prism-spend.jsonl`,
`prism-policy.json`, etc.) are always preserved. To fully clean, manually
delete `~/.claude/.prism-*` files after uninstall.

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
