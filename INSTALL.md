# PRISM Installation Instructions (for Claude Code)

This document is the authoritative install procedure. A user on a fresh machine can open Claude Code in any project and say:

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

## 3. Copy the files listed in `manifest.json`

Read `manifest.json`. For each entry in `files`:

- Create the destination directory if it doesn't exist.
- Copy `<repo>/<src>` → expanded `<dest>` (`~` resolves to `HOME` / `USERPROFILE`).
- Only overwrite if the content differs (content-hash compare).
- If the entry has `"chmod": "+x"`, mark it executable on POSIX (`chmod +x`). On Windows this is a no-op.

Claude is free to use Python, Node, or bash+jq — whichever is cleaner on the target OS.

---

## 4. Merge `settings.fragment.json` into `~/.claude/settings.json`

**Never overwrite settings.json.** Deep-merge instead:

- Start from the existing `~/.claude/settings.json` (or `{}` if absent).
- Load `settings.fragment.json` from the repo.
- For each top-level key in the fragment:
  - `env` → shallow merge (fragment wins on key conflict).
  - `hooks` → for each event (SessionStart, PreToolUse, etc.), append fragment entries only if no existing entry has the same `command` string.
  - `statusLine` → set only if no existing `statusLine` is configured (don't overwrite the user's custom statusline).
- Write the merged JSON back with 2-space indent.

This is **idempotent**: running step 4 twice produces the same file.

After the merge, the fragment will have registered three tier-enforcement guards under `PreToolUse`: `prism-agent-model-guard.mjs` (fires on every `Agent()` dispatch — classifies cognitive load and nudges/denies under-specified model choices), `prism-task-tier-advisor.mjs` (fires on `TaskCreate` — recommends haiku/sonnet/opus for the new task), and `prism-mutation-guard.mjs` (fires on `Edit`/`Write`/`MultiEdit` — blocks the parent Opus context from mutating files directly, enforcing the orchestrator-plans/subagent-executes boundary). All three share the same `.prism-routing.jsonl` log and follow the same `soft|hard|off` env-var convention.

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
