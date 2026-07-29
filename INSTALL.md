# PRISM Installation Instructions (for Claude Code)

> **Most users should use the one-line installer (`install.ps1` on Windows, `install.sh` on macOS/Linux) instead of the manual procedure below — see [README.md](README.md#install). This document is the manual install reference for users who want full control or who are developing PRISM itself.** Both the one-line installer and the manual steps below drive the same `tools/prism-installer.mjs`, which automates the backup → file-copy → settings-merge → verify ceremony in one idempotent pass.

This document is the authoritative *manual* install procedure. A user on a fresh machine can open Claude Code in any project and say:

> **"Clone https://github.com/vosser24/prism_5, read INSTALL.md, and follow it exactly."**

Claude then performs the steps below. Each step is numbered, atomic, and verifiable.

---

## 0. Prerequisites (block install if missing)

Required on PATH:

- `node` >= 18 — `node --version`
- `python` or `python3` >= 3.10 — `python --version`
- `git` — `git --version`

Optional (some features self-skip if missing):

- `notebooklm` CLI — enables PRISM-KB cloud search
- `gh` CLI — enables in-session repo operations

If any **required** tool is missing, stop and print a platform-specific install plan. Do not proceed.

---

## 1. Clone or update this repo

If the repo isn't already cloned to a working directory:

```bash
git clone https://github.com/vosser24/prism_5.git /tmp/prism-install
cd /tmp/prism-install
```

If it is already cloned, `git pull` to pick up any updates.

---

## 2. Backup the current `~/.claude/`

The installer in §3 makes its own timestamped backup automatically (and tells
you where it went), so this manual step is optional belt-and-braces. If you
want an independent copy before touching anything:

```bash
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p ~/.claude/backups/pre-prism-$TS
cp -p ~/.claude/settings.json                       ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -pr ~/.claude/hooks                              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -pr ~/.claude/tools                              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -p  ~/.claude/statusline-command.sh              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
```

---

## 2.5. Resolve node and write `~/.claude/prism.env`

PRISM hooks run under a non-interactive shell. Node installed via a version
manager (nvm, fnm, volta, asdf) is not on that shell's PATH by default. To
guarantee hooks can find node regardless of shell state, resolve node's
absolute path now and pin it.

**POSIX (Linux / macOS):**

Try each of these until one succeeds, and record the absolute path:

1. `command -v node`
2. newest `~/.nvm/versions/node/*/bin/node` (sort -V)
3. newest `~/.fnm/node-versions/*/installation/bin/node`
4. `~/.volta/bin/node`
5. `asdf which node`
6. `/opt/homebrew/bin/node`, `/usr/local/bin/node`

**Windows:**

1. `where node`
2. newest `%APPDATA%\nvm\<version>\node.exe`
3. `%LOCALAPPDATA%\Volta\bin\node.exe`
4. `%ProgramFiles%\nodejs\node.exe`

Write the resolved path to `~/.claude/prism.env` as a single line with
the format `PRISM_NODE=<absolute-path>`.

**Recommended recipe (works cleanly on POSIX + Git Bash on Windows):**

```bash
# Create ~/.claude/ if missing
mkdir -p ~/.claude

# Write prism.env via a single-quoted heredoc — preserves backslashes
# and Windows paths verbatim (no shell escape interpretation).
cat > ~/.claude/prism.env <<'EOF'
PRISM_NODE=/absolute/path/to/node
EOF

# Verify
cat ~/.claude/prism.env
```

**Do NOT use** `printf 'PRISM_NODE=C:\\Program Files\\nodejs\\node.exe\n'`
or any `echo -e` form — Git Bash on Windows interprets `\n`, `\P`, and
other backslash sequences, mangling Windows paths. The single-quoted
heredoc is the only portable recipe.

For Windows paths specifically, the line should look exactly like:
```
PRISM_NODE=C:\Program Files\nodejs\node.exe
```
(single backslashes, no escaping). Both `prism-exec.sh` (via Git Bash)
and `prism-exec.cmd` (native Windows) source this file and handle the
path correctly.

(Create `~/.claude/` if needed; do not touch other files.) If node cannot be
found, stop here — step 0 should already have caught this; if you got past
step 0 but can't resolve an absolute path, something is wrong with the
environment.

Also: if node was found but is NOT on the non-interactive shell's PATH
(verify with `/bin/sh -c 'command -v node'` on POSIX), warn the user that
without `prism.env` the wrappers would have to fall back to discovery each
hook firing. `prism.env` makes it a fast no-lookup path.

---

## 2.6. Tuning — environment variables for enforcement mode and thresholds

PRISM exposes several env vars to tune enforcement and classifier behavior.
All are optional — defaults are sensible. Set them in
`~/.claude/prism.env`, your shell profile, or `.claude/settings.local.json`
under `env`. Project-scoped overrides in `.claude/settings.local.json` are
scoped to that one project.

**Enforcement modes:**

| Variable | Default | Values | Effect |
|---|---|---|---|
| `PRISM_PROMPT_ROUTER` | `hard` | `hard` / `soft` / `off` | Tier-router. `hard` = sentinel written + advice emitted. `soft` = advice only. `off` = no-op. |
| `PRISM_DISPATCH_GUARD` | `hard` | `hard` / `soft` / `off` | Parent-dispatch-guard. `hard` = deny work tools on wrong tier. `soft` = nudge only. `off` = pass-through. |
| `PRISM_MUTATION_GUARD` | `hard` | `hard` / `soft` / `off` | Edit/Write/MultiEdit/Bash-write guard. `hard` = deny parent-context mutations. `soft` = nudge only. `off` = pass-through. |
| `PRISM_MODEL_GUARD` | `soft` | `hard` / `soft` / `off` | Agent() model-choice guard. `hard` = deny non-opus Agent() without explicit model. `soft` = nudge only. `off` = pass-through. |
| `PRISM_TASK_TIER` | `soft` | `hard` / `soft` / `off` | Task-tier advisor on TaskCreate. `hard` = deny opus-tier tasks without `tier_ack` or `[opus]` annotation. `soft` = nudge only. `off` = pass-through. |
| `PRISM_MEMORY_NUDGE` | `on` | `on` / `off` | Turn-15+ memory-save nudge. |

**Classifier tuning:**

| Variable | Default | Format | Effect |
|---|---|---|---|
| `PRISM_TIER_THRESHOLDS` | `"2,7"` | `"haiku_max,sonnet_max"` | Keyword-floor score boundaries. Score 0–`haiku_max` = haiku; `haiku_max+1` to `sonnet_max` = sonnet; above = opus. Lower `sonnet_max` to route more prompts to opus (safer, more expensive). Raise to save. |
| `PRISM_MEMORY_NUDGE_FIRST` | `15` | integer | First memory-save nudge turn. |
| `PRISM_MEMORY_NUDGE_INTERVAL` | `5` | integer | Cadence after first nudge. |

**Per-prompt overrides:**

- **`!opus-force:` prefix** on any user prompt — bypasses all tier-routing
  and guard enforcement for that single turn. Sentinel's `force_opus=true`.
  Parent Opus can write directly. Use for mechanical edits where you don't
  want the orchestrator pattern.

**Example local override** (`<project>/.claude/settings.local.json`):

```json
{
  "env": {
    "PRISM_MUTATION_GUARD": "off",
    "PRISM_DISPATCH_GUARD": "off"
  }
}
```

Scoped to just that project — useful during design-system migrations or
other mechanical refactors where guards get in the way. Remove when the
migration lands.

---

## 3. Install

Run the installer from the repo root. A single command does the whole job —
backup, stale-hook prune, file copy, roster preserve+merge, settings.json
deep-merge, and a post-install verify — and it is idempotent: re-running it is
safe, an equal-version run is a no-op, and a newer checkout upgrades in place.

```bash
node tools/prism-installer.mjs install
```

Useful flags:

- `--dry-run` — preview every action; makes no changes.
- `--home <path>` — install into a non-default HOME (handy for testing).
- `--no-backup` — skip the pre-install backup (not recommended).

The installer reads `tools/install-manifest.json` for the file list and
`settings.fragment.json` for the hook/env/statusline config it merges — you do
**not** copy files or hand-edit `settings.json`. It prints an aligned summary
on completion (version, target, file/dir counts, backup location).

What the merge guarantees (reference, for auditors):

- **Settings are never overwritten.** The fragment is deep-merged into any
  existing `~/.claude/settings.json`: `env` keys are added, `hooks` entries
  are appended only if an identical `command` isn't already present, and a
  user's existing `statusLine` is preserved.
- **OS-aware hook commands.** POSIX hook commands ship as
  `bash ~/.claude/hooks/lib/prism-exec.sh <hook>`; on Windows they are
  rewritten to the `cmd /c "%USERPROFILE%\.claude\hooks\lib\prism-exec.cmd" …`
  form automatically.
- **Stale entries pruned.** Old raw `node ~/.claude/hooks/prism-*.mjs`
  registrations from pre-wrapper installs are removed; non-PRISM hooks are
  left untouched.
- **Roster preserved.** Your existing agents in
  `skills/prism-plan/references/roster.json` are merged forward, not wiped.

After the merge, the fragment has registered PRISM's four `PreToolUse` guards
— `prism-agent-model-guard.mjs` (classifies cognitive load on every `Agent()`
dispatch), `prism-task-tier-advisor.mjs` (recommends a tier on `TaskCreate`),
`prism-mutation-guard.mjs` (blocks the parent Opus context from mutating files
directly, incl. file-writing Bash/PowerShell that would bypass the
orchestrator pattern and risk Windows UTF-8 BOM corruption), and
`prism-parent-dispatch-guard.mjs` (enforces tier-based dispatch incl. the
NOVEL-tier `summon_panel` → `@master-orchestrator` requirement) — plus the
`SessionStart` / `UserPromptSubmit` / statusline wiring. All share the
`.prism-routing.jsonl` log and follow the `soft|hard|off` env-var convention
from §2.6.

---

## 4. Verify

The installer runs a verify pass at the end of §3 automatically; you can re-run
it any time:

```bash
node tools/prism-installer.mjs verify
```

It checks that every file in the manifest is present in `~/.claude/` and that
`settings.json` wires the PRISM hooks (and, if configured, the statusline).
Every check should print `PASS`; a non-zero exit means the install is
incomplete — re-run `node tools/prism-installer.mjs install` and report any
checks that still fail.

---

## 5. Optional: run the full test suite

For a thorough green-bar check, run from the repo root:

```bash
node tools/test-prism-gaps.mjs
```

Target: all tests either **pass** or **skip gracefully** (tests that depend on
NotebookLM, a large index, etc., self-skip on a minimal install). The suite
should never hard-fail.

---

## 6. Summary to the user

The installer already prints a completion block; relay its key lines to the
user, e.g.:

- PRISM version installed (and the `from → to` if it was an upgrade)
- Target: `~/.claude/` (or the `--home` path)
- Files / directories installed
- Backup location: `~/.claude/backups/pre-prism-<timestamp>/`
- Next step: restart any open Claude Code sessions to pick up the new hooks + statusline.

---

## Uninstall

```bash
LATEST=$(ls -td ~/.claude/backups/pre-prism-* | head -1)
cp -pr "$LATEST"/* ~/.claude/
```

---

## Notes for Claude following this document

- **Never use `rm -rf` on `~/.claude`.** If a destination file exists and you must replace it, `cp` on top — don't pre-delete.
- **Respect user edits.** If `settings.json` already has a `statusLine`, don't overwrite. Report and move on.
- **No network beyond the clone step.** Everything after `git clone` is local filesystem work.
- **Safe to re-run.** All steps are idempotent. Running this install twice is a no-op.
- **Node discovery is belt-and-braces.** Step 2.5 pins node in `prism.env` so hooks have a fast path; the `prism-exec.sh` / `prism-exec.cmd` wrappers also auto-discover nvm/fnm/volta/asdf/homebrew locations at runtime as a fallback. Users can override with `PRISM_NODE=/path/to/node` in their shell env.

---

## Uninstalling

See [UNINSTALL.md](UNINSTALL.md) for the full procedure. Quick reference:

**bash (Linux / macOS / Git Bash on Windows):**
```bash
bash uninstall.sh           # DRY-RUN preview (default — safe)
bash uninstall.sh --purge   # actually remove PRISM
bash uninstall.sh --help    # all flags
```

**PowerShell-native (Windows, no Git Bash needed) — v3.4+:**
```powershell
.\uninstall.ps1             # DRY-RUN preview (default — safe)
.\uninstall.ps1 -Purge      # actually remove PRISM
.\uninstall.ps1 -Help       # all parameters
```

## One-line install (alternative to manual procedure above)

**bash:**
```bash
bash install.sh             # full install
bash install.sh --dry-run   # preview only
```

**PowerShell-native (v3.4+):**
```powershell
.\install.ps1               # full install
.\install.ps1 -DryRun       # preview only
```
