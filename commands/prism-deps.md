---
name: prism-deps
description: Scan system for PRISM optional dependencies, report status, offer installs
---

Autonomous dependency audit. Reads
`~/.claude/skills/prism-plan/references/dependency-manifest.md` as the
source of truth for what to check and how.

## Modes

```
/prism-deps              → scan all tiers, report, offer installs interactively
/prism-deps --check      → scan only, no install prompts (CI-safe)
/prism-deps --list       → print the manifest (what each dep enables)
/prism-deps <dep-name>   → install a single dep (notebooklm, gh, jq)
```

## Procedure

### Step 1 — Read the manifest

Read `~/.claude/skills/prism-plan/references/dependency-manifest.md`.
Parse the tier sections (A, B, C, D). For each dep, extract: name, check
command, install command per OS, fallback-if-absent note.

### Step 2 — Detect OS

- `uname -s` → `Darwin` (macOS) / `Linux` / `MINGW*|MSYS*|CYGWIN*` (Windows-ish)
- On Windows native: `ver` returns Windows version
- Pick the right install command per OS for each dep.

### Step 3 — Detect project relevance (tier gating)

- **Tier A (notebooklm-py):** always relevant.
- **Tier D (gh, jq):** always informational, never pushed.

### Step 4 — Run checks in parallel

For each relevant dep, run its check command. Record:
- `✓ installed` (check succeeded)
- `✗ missing` (check failed)
- `? partial` (CLI present but a dependent artifact is missing, e.g. an
  auth token not yet issued)

### Step 5 — Report

Print a structured table grouped by tier:

```
═══════════════════════════════════════════════════════════
PRISM — Dependency Audit
═══════════════════════════════════════════════════════════

OS:      {macOS|Linux|Windows}
PROJECT: {name} ({stack detected})

TIER A — Agent research & persistence
  ✓ notebooklm-py              installed (auth OK)
   OR
  ✗ notebooklm-py              missing
      Enables:  $0 agent research via NotebookLM, /prism-archive
      Install:  pip install notebooklm-py[browser]
                 notebooklm login

TIER D — Optional dev helpers
  ...

═══════════════════════════════════════════════════════════
SUMMARY: N/M dependencies satisfied.
═══════════════════════════════════════════════════════════
```

### Step 6 — Offer installs (interactive mode only)

Skip in `--check` mode. Otherwise for each `✗` or `?` dep whose tier is
relevant, ask:

```
Install {dep-name}? (shows exact command)
  [Y] Yes
  [n] No
  [a] Yes to all remaining
  [s] Skip all
```

Run each approved install. Capture stdout/stderr. Report per-install
SUCCESS / FAILED. On failure, do NOT abort — continue with the next dep
and report honestly at the end.

### Step 7 — Post-install re-scan

After all approved installs, re-run the checks from Step 4 to confirm.
Print a final delta:

```
BEFORE: 2/3 installed
AFTER:  3/3 installed
```

### Step 8 — Write to `.claude/deps-scan.json` (project-local)

```json
{
  "scanned_at": "2026-04-23T...",
  "os": "linux",
  "project": "nexus-tasks",
  "results": {
    "notebooklm-py": {"status": "installed", "version": "0.3.4"},
    ...
  }
}
```

`/prism-health` cross-references this file for its dependency section.

## Rules

- Never install silently — always show the command first.
- Never install paid tiers (Browser Use Cloud, ElevenLabs, etc.).
- Respect OS — use the manifest's OS-specific command, don't assume apt on macOS.
- Never `sudo` without explicit user approval.
- If an install fails, report honestly and continue.
- Skip already-installed deps (don't reinstall).
- Don't automate OAuth flows (`notebooklm login` etc.) — run them
  interactively in the user's shell; surface the command, let the user
  run it.
- `--check` mode is CI-safe: no prompts, no installs, exits 0 if all
  relevant deps satisfied, non-zero otherwise.

## What `/prism-deps` DOES NOT do

- Does NOT manage Node or Python versions (use nvm/fnm/pyenv).
- Does NOT install MCP servers (that's `/prism-recommend`).
- Does NOT install Tier 1 or Tier 2 companion tools (that's `/prism-bootstrap`
  and `/prism-recommend` respectively).
- Does NOT touch the core requirements (`node`, `python`, `git`) — those
  are install-time blockers checked by `scripts/verify.mjs`.
