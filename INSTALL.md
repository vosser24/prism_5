# PRISM Installation Instructions (for Claude Code)

> **Most users should use `/plugin install prism@PRISM` instead of the manual procedure below — see [README.md](README.md#install). This document is the manual install reference for users who want full control or who are developing PRISM itself.** As of v3.5.0 PRISM ships as a Claude Code plugin (`.claude-plugin/plugin.json`); plugin install eliminates the backup → file-copy → settings-merge ceremony that this document describes.

This document is the authoritative *manual* install procedure. A user on a fresh machine can open Claude Code in any project and say:

> **"Clone https://github.com/vosser24/PRISM, read INSTALL.md, and follow it exactly."**

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
git clone https://github.com/vosser24/PRISM.git /tmp/prism-install
cd /tmp/prism-install
```

If it is already cloned, `git pull` to pick up any updates.

---

## 2. Backup the current `~/.claude/`

Never blow away existing config. Before copying anything:

```bash
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p ~/.claude/backups/pre-prism-$TS
cp -p ~/.claude/settings.json                       ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -pr ~/.claude/hooks                              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -pr ~/.claude/tools                              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
cp -p  ~/.claude/statusline-command.sh              ~/.claude/backups/pre-prism-$TS/ 2>/dev/null || true
```

Tell the user where the backup went.

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

## 2.6. Migrate + purge legacy ATLAS-named assets (PRISM 2.5.0+)

PRISM 2.4.0 completed the ATLAS → PRISM rename; 2.5.0 turns migration
into a clean purge. Installs from before 2.4.0 may have `atlas-plan/`,
`atlas-discover/`, `atlas-updater.md`, or raw `atlas-*` hook entries on
disk under `~/.claude/`. These don't break the new install (the new
code reads `prism-*` paths only), but they become dead weight that
shadows the new layout and bloats file listings.

Two-step process: (a) safe migration of user-valuable state; (b) purge
of everything atlas-named once migration succeeds. A pre-step backup to
`~/.claude/backups/atlas-purge-<ts>/` guarantees rollback.

```bash
TS=$(date +%Y%m%d-%H%M%S)
BKP=~/.claude/backups/atlas-purge-$TS
mkdir -p "$BKP"
PURGED=0

# 2.6a — Migrate skill reference state BEFORE purging.
#        Copy (not move) each file so the purge step has a clean source
#        to delete and we never lose data mid-migration.
if [ -d ~/.claude/skills/atlas-plan/references ]; then
  mkdir -p ~/.claude/skills/prism-plan/references
  for f in roster.json update-log.json skill-effectiveness.md audit-log.json prompt-effectiveness.md benchmarks.md adversarial-review.md prompt-templates.md; do
    src=~/.claude/skills/atlas-plan/references/$f
    dst=~/.claude/skills/prism-plan/references/$f
    # Only copy if destination doesn't exist or is older (user's old state wins
    # when new code hasn't touched the target yet).
    if [ -f "$src" ] && [ ! -f "$dst" ]; then
      cp -p "$src" "$dst"
    fi
  done
fi

# 2.6b — Back up EVERY atlas-* artifact to $BKP before touching anything.
for p in \
  ~/.claude/skills/atlas-plan \
  ~/.claude/skills/atlas-discover \
  ~/.claude/skills/atlas-updater \
  ~/.claude/skills/atlas-* \
  ~/.claude/agents/atlas-*.md \
  ~/.claude/commands/atlas-*.md \
  ~/.claude/hooks/atlas-*.mjs \
  ~/.claude/hooks/lib/atlas-exec.sh \
  ~/.claude/hooks/lib/atlas-*.mjs \
  ~/.claude/tools/atlas-* \
  ~/.claude/plans/atlas-*.md \
  ~/.claude/.atlas-* ; do
  # glob-expand; skip if nothing matches
  for f in $p; do
    if [ -e "$f" ]; then
      cp -pr "$f" "$BKP/" 2>/dev/null || true
    fi
  done
done

# 2.6c — PURGE the atlas-* artifacts. The backup in $BKP is the safety net.
# NOTE: PRISM's safety-gate blocks `rm -rf` (pattern `/rm\s+-rf\s/i`).
# Use `rm -r` (without -f) — the safety gate allows this, and nothing
# inside `~/.claude/` is write-protected so -f is unnecessary.
#
# v2.8.0 note: purge lists are EXPLICIT (no `atlas-*` catch-all glob).
# The old glob matched `atlas-reference-archive/` — a legitimate user
# archive that should NEVER be deleted. Every atlas-* directory/file
# below is listed by name. If you have your own `atlas-*` content that
# isn't in this list, it is preserved.
for p in \
  ~/.claude/skills/atlas-plan \
  ~/.claude/skills/atlas-discover \
  ~/.claude/skills/atlas-updater ; do
  for f in $p; do
    if [ -d "$f" ]; then rm -r "$f" && PURGED=$((PURGED+1)); fi
  done
done
for p in \
  ~/.claude/agents/atlas-*.md \
  ~/.claude/commands/atlas-*.md \
  ~/.claude/hooks/atlas-*.mjs \
  ~/.claude/hooks/lib/atlas-exec.sh \
  ~/.claude/hooks/lib/atlas-*.mjs ; do
  for f in $p; do
    if [ -f "$f" ]; then rm "$f" && PURGED=$((PURGED+1)); fi
  done
done
for p in \
  ~/.claude/tools/atlas-kb-query.mjs \
  ~/.claude/tools/atlas-kb-sync.mjs \
  ~/.claude/tools/atlas-kb-indexer.mjs \
  ~/.claude/tools/atlas-kb-rebuild.mjs \
  ~/.claude/tools/atlas-kb-classify.mjs \
  ~/.claude/tools/atlas-kb-domains.mjs \
  ~/.claude/tools/atlas-kb-promote-domain.mjs \
  ~/.claude/tools/atlas-kb-notebook-init.mjs \
  ~/.claude/tools/atlas-context-audit.mjs \
  ~/.claude/tools/atlas-recall.mjs \
  ~/.claude/tools/atlas-rollup-weekly.mjs \
  ~/.claude/tools/atlas-db.mjs \
  ~/.claude/tools/atlas-db-migrate.mjs \
  ~/.claude/tools/test-atlas-gaps.mjs \
  ~/.claude/tools/atlas-monitor \
  ~/.claude/plans/atlas-*.md ; do
  for f in $p; do
    if [ -d "$f" ]; then rm -r "$f" && PURGED=$((PURGED+1));
    elif [ -f "$f" ]; then rm "$f" && PURGED=$((PURGED+1)); fi
  done
done
# Dot-file state (legacy turn counters, tier caches under old name).
# Explicitly enumerated; catch-all `.atlas-*` glob avoided for the same
# reason as above.
for f in \
  ~/.claude/.atlas-state.json \
  ~/.claude/.atlas-global-state.json \
  ~/.claude/.atlas-kb-index.json \
  ~/.claude/.atlas-kb-meta.json \
  ~/.claude/.atlas-kb-dirty \
  ~/.claude/.atlas-sessions \
  ~/.claude/.atlas-rollups \
  ~/.claude/.atlas-routing.jsonl \
  ~/.claude/.atlas-spend.jsonl \
  ~/.claude/.atlas-lessons.jsonl \
  ~/.claude/.atlas-context-audit.json \
  ~/.claude/.atlas-context-audit.last \
  ~/.claude/.atlas-tier-cache.json ; do
  if [ -d "$f" ]; then rm -r "$f" && PURGED=$((PURGED+1));
  elif [ -f "$f" ]; then rm "$f" && PURGED=$((PURGED+1)); fi
done
# Also purge glob-matched turn-tier sentinels and memory counters that are
# per-session (clear prefix match, not a real catch-all — files follow an
# exact pattern). These are safe glob matches because the suffix is a UUID.
for f in ~/.claude/.atlas-turn-tier-*.json ~/.claude/.atlas-memory-save-counter-*.json; do
  [ -f "$f" ] && rm "$f" && PURGED=$((PURGED+1))
done

# 2.6d — Prune settings.json hook entries that reference the legacy names.
#        See §4b for the settings.json edit pattern — it already matches:
#          node ~/.claude/hooks/atlas-*.mjs
#          node %USERPROFILE%\.claude\hooks\atlas-*.mjs
#          bash ~/.claude/hooks/lib/atlas-exec.sh *
#        so no extra work here — §4b handles it.

echo "Legacy purge: $PURGED artifact(s) removed, backup at $BKP"
```

### What gets purged

| Path pattern | Action |
|---|---|
| `~/.claude/skills/atlas-plan/` | state migrated to `prism-plan/`, then directory purged |
| `~/.claude/skills/atlas-*/` (anything else) | purged |
| `~/.claude/agents/atlas-*.md` | purged (system agents are replaced by new `prism-*` in §3) |
| `~/.claude/commands/atlas-*.md` | purged (replaced by `prism-*` in §3) |
| `~/.claude/hooks/atlas-*.mjs` | purged |
| `~/.claude/hooks/lib/atlas-exec.sh`, `atlas-*.mjs` | purged |
| `~/.claude/tools/atlas-*` | purged |
| `~/.claude/plans/atlas-*.md` | purged |
| `~/.claude/.atlas-*` state dots | purged |

### What NEVER gets touched (owned by the user)

| Path | Why |
|---|---|
| `~/.claude/agents/<any non-atlas-named agent>/` | user's specialists (greek-ecommerce-seo, demand-forecasting, etc.) |
| `~/.claude/.prism-sessions/*.md` | memory — session summaries |
| `~/.claude/.prism-routing.jsonl` | event ledger |
| `~/.claude/.prism-*` state files (non-atlas) | hook state, caches |
| `~/.claude/settings.json` MCP servers, permissions, statusLine | user config (§4 merges, never overwrites) |
| `~/.claude/CLAUDE.md` global | user's global instructions |
| `~/.claude/backups/` and `~/.claude/agents-archive/` | prior backups |

### Report to the user after §2.6 runs

If `$PURGED > 0`:

> Purged N legacy ATLAS artifact(s). Backup at `~/.claude/backups/atlas-purge-<ts>/`.
> User-created specialists, session history, MCP servers, and personal
> CLAUDE.md are untouched. Roster history migrated to the new path.

If `$PURGED == 0`, skip silently — nothing to clean up.

### Rollback

If the user reports that the purge removed something they needed:

```bash
# Restore everything from the backup (most recent purge)
LATEST=$(ls -1td ~/.claude/backups/atlas-purge-* | head -1)
cp -pr "$LATEST"/* ~/.claude/
```

---

## 2.7. Tuning — environment variables for enforcement mode and thresholds

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

## 3. Copy the files listed in `manifest.json`

Read `manifest.json`. For each entry in `files`:

- Create the destination directory if it doesn't exist.
- Copy `<repo>/<src>` → expanded `<dest>` (`~` resolves to `HOME` / `USERPROFILE`).
- Only overwrite if the content differs (content-hash compare).
- If the entry has `"chmod": "+x"`, mark it executable on POSIX (`chmod +x`). On Windows this is a no-op.

Claude is free to use Python, Node, or bash+jq — whichever is cleaner on the target OS.

---

## 4. Merge `settings.fragment.json` into `~/.claude/settings.json`

**Never overwrite settings.json.** Deep-merge, OS-aware, with stale-pruning.

**Recommended recipe (v2.7.3+):** run the dedicated merger script from the
repo root. It handles §4a (Windows rewrite), §4b (stale-prune), and §4c
(deep-merge) in one pass, with correct escape handling that the inline
`node -e "..."` approach could not guarantee on Windows + Git Bash.

```bash
cd <path-to-PRISM-repo-root>
node scripts/install-merge.mjs
```

Output prints a summary you can parse for §8:
```
PRUNED_COUNT=<N>
MERGED_NEW_HOOK_ENTRIES=<N>
ENV_KEYS=<N>
STATUSLINE_PRESERVED=<bool>
TOTAL_TOP_LEVEL_KEYS=<N>
```

The script is idempotent — running it twice with no fragment changes is a
no-op. Safe to re-run if an upgrade changes `settings.fragment.json`.

### What `scripts/install-merge.mjs` does (reference, for auditors)

### 4a. OS-specific command rendering (automated by the script)

`settings.fragment.json` ships POSIX form (`bash ~/.claude/hooks/lib/prism-exec.sh <hook>.mjs`). On Windows, every such hook `command` is rewritten to use the `.cmd` wrapper:

- POSIX: fragment used as-is.
- Windows: each hook `command` string rewritten:
  - from: `bash ~/.claude/hooks/lib/prism-exec.sh <path>`
  - to:   `cmd /c "%USERPROFILE%\.claude\hooks\lib\prism-exec.cmd" <path-with-backslashes-and-%USERPROFILE%>`
  - Example: `bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-hook.mjs`
    → `cmd /c "%USERPROFILE%\.claude\hooks\lib\prism-exec.cmd" "%USERPROFILE%\.claude\hooks\prism-hook.mjs"`

The script uses `String.fromCharCode(92)` for literal backslashes
internally — this bypasses Git Bash `\\` mangling and avoids
`JSON.stringify` double-escaping, both of which bit v2.7.2 installers who
followed inline instructions.

### 4b. Prune stale pre-2.3 hook entries (automated by the script)

Older PRISM installs registered raw `node ~/.claude/hooks/*.mjs` entries alongside the wrapper. These fail on any machine where node is not on the non-interactive shell's PATH. The script walks the existing `hooks` object and removes any entry whose `command` matches one of these exact patterns:

- `node ~/.claude/hooks/prism-*.mjs`
- `node %USERPROFILE%\.claude\hooks\prism-*.mjs`
- `node ~/.claude/hooks/atlas-*.mjs`       ← PRISM 2.4.0 legacy rename
- `node %USERPROFILE%\.claude\hooks\atlas-*.mjs`  ← PRISM 2.4.0 legacy rename
- `bash ~/.claude/hooks/lib/atlas-exec.sh *`  ← PRISM 2.4.0 legacy rename

Raw `node` entries for non-PRISM hooks — user-added or plugin-added — are left alone. Only `prism-*.mjs` and `atlas-*.mjs` entries get pruned.

### 4c. Deep-merge (automated by the script)

- Starts from existing `~/.claude/settings.json` (or `{}` if absent), after 4b pruning.
- Loads `settings.fragment.json` from cwd, applies 4a OS rewrite in-memory.
- For each top-level key in the fragment:
  - `env` → shallow merge (fragment wins on key conflict).
  - `hooks` → for each event (SessionStart, PreToolUse, etc.), appends fragment entries only if no existing entry has the same `command` string.
  - `statusLine` → set only if no existing `statusLine` is configured (user's custom statusline preserved).
- Other top-level keys (`permissions`, `enabledPlugins`, `extraKnownMarketplaces`, etc.) untouched.
- Writes merged JSON back with 2-space indent.

This is **idempotent**: running step 4 twice produces the same file.

After the merge, the fragment will have registered four tier-enforcement guards under `PreToolUse`: `prism-agent-model-guard.mjs` (fires on every `Agent()` dispatch — classifies cognitive load and nudges/denies under-specified model choices), `prism-task-tier-advisor.mjs` (v2.7.0+ — fires on `TaskCreate` PreToolUse — recommends haiku/sonnet/opus for the new task), `prism-mutation-guard.mjs` (v2.7.2+ — fires on `Edit`/`Write`/`MultiEdit`/`Bash` — blocks the parent Opus context from mutating files directly, incl. file-writing Bash/PowerShell commands that would bypass the orchestrator pattern and introduce Windows UTF-8 BOM corruption), and `prism-parent-dispatch-guard.mjs` (fires on all tools — enforces tier-based dispatch, incl. NOVEL-tier `summon_panel` → `@master-orchestrator` requirement in v2.5.0+). All share the same `.prism-routing.jsonl` log and follow the `soft|hard|off` env-var convention.

### Fallback — manual merge (only if `scripts/install-merge.mjs` is unavailable)

If for some reason the script isn't present (e.g., mid-upgrade from an
older repo checkout), the merge can be done manually per §4a/§4b/§4c
above. **On Windows, use `String.fromCharCode(92)` for literal
backslashes in any inline `node -e "..."` command** — Git Bash strips
`\\` from template literals, and `JSON.stringify` double-escapes. This
is why the script exists.

---

## 5. Build the initial KB index

The PRISM hook routes prompts against `~/.claude/.prism-kb-index.json`. Fresh install has no index. Build one:

```bash
node ~/.claude/tools/prism-kb-indexer.mjs
```

Report the entry count. A healthy install produces 20+ entries (PRISM's own agents/commands/skills). If plugins are installed in `~/.claude/plugins/`, the count will be higher.

---

## 6. Verify

Run the verify script from the repo:

```bash
node scripts/verify.mjs
```

It checks that every required file exists in `~/.claude/` and that `settings.json` wires the `prism-hook.mjs` and (optionally) the `statusLine`. Non-zero exit means install failed — stop and report the missing items.

---

## 7. Optional: run the full test suite

For a thorough green-bar check:

```bash
node ~/.claude/tools/test-prism-gaps.mjs
```

Target: all tests either **pass** or **skip gracefully** (tests that depend on NotebookLM, a large index, etc., self-skip on a minimal install). The suite should never hard-fail.

---

## 8. Summary to the user

Print one compact block:

- Files installed: N
- Settings keys merged: K
- KB entries indexed: E
- Statusline: installed (path)
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
bash scripts/uninstall.sh           # DRY-RUN preview (default — safe)
bash scripts/uninstall.sh --purge   # actually remove PRISM
bash scripts/uninstall.sh --help    # all flags
```

**PowerShell-native (Windows, no Git Bash needed) — v3.4+:**
```powershell
.\scripts\uninstall.ps1             # DRY-RUN preview (default — safe)
.\scripts\uninstall.ps1 -Purge      # actually remove PRISM
.\scripts\uninstall.ps1 -Help       # all parameters
```

## One-line install (alternative to manual procedure above)

**bash:**
```bash
bash scripts/install.sh             # full install
bash scripts/install.sh --dry-run   # preview only
```

**PowerShell-native (v3.4+):**
```powershell
.\scripts\install.ps1               # full install
.\scripts\install.ps1 -DryRun       # preview only
```
