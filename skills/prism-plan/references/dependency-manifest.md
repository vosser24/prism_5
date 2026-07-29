# PRISM Dependency Manifest

Source of truth for `/prism-deps`. Lists every optional dependency PRISM can
use, the capability each unlocks, the install command per OS, and the
detection check.

**Core requirements** (blocking — `/prism-bootstrap` fails without these):
- `node` >= 18
- `python` >= 3.10
- `git` (any recent version)
- `bash` (POSIX) or `cmd.exe` (Windows)

Core requirements are checked by `scripts/verify.mjs` and not managed here.
This manifest covers **optional** dependencies only.

**Detection convention (read before running any `Check:`).** Detect every tool
by **execution**, never by a bare PATH probe. `command -v <tool>` / `where
<tool>` / `which <tool>` only prove a name resolves on PATH — under Windows
AppLocker/WDAC the PATH resolves while the `.exe` is **denied**, so a PATH-only
check FALSE-POSITIVES "installed" and the tool then fails at runtime (v5.x
finding, [[feedback-applocker-exe-detection]]). So run the tool's `--version`
(or `python -m <pkg> --version`). If the name resolves but execution fails,
record **`blocked`** (not `installed`). For pip-installed tools prefer the
`python -m <pkg>` form over the bare console-script `.exe`, which is the exact
surface AppLocker denies.

---

## Tier A — Agent research & persistence

### notebooklm-py

- **Capability:** zero-cost Tier 1 agent research + `/prism-archive`
  consolidation of agent notes into RAG-queryable sources.
- **Used by:** `@agent-factory` (primary research engine),
  `/prism-archive`, `@master-orchestrator` PHASE 0a inventory.
- **Check (by execution):** `notebooklm --version` ‖ `python -m notebooklm --version`.
  `python -m notebooklm` is the canonical invocation — the bare `notebooklm.exe`
  is AppLocker/WDAC-denied on locked-down domain boxes even when installed. PATH
  resolves but neither runs → record `blocked`.
- **Install:**
  - All platforms: `pip install notebooklm-py[browser]`
  - Also run: `notebooklm login` (one-time Google OAuth)
- **Fallback if absent:** agent-factory falls through to Tier 2 (web search
  + Opus, ~$0.30–0.50 per agent) or Tier 3 (Opus general knowledge,
  ~$0.50–1.00). Flagged as "not installed — install for $0 research".

---

## Tier D — Optional dev-time helpers

### gh (GitHub CLI)

- **Capability:** `/prism-audit` can check for leaked secrets in public
  mirrors; `@master-orchestrator` can reference PR history when scoping.
- **Check (by execution):** `gh --version`
- **Install:**
  - macOS: `brew install gh`
  - Linux: see cli.github.com
  - Windows: `winget install GitHub.cli`
- **Fallback if absent:** those checks skip silently.

### jq

- **Capability:** shell-script JSON munging inside hook tests; some
  `/prism-recommend` fit-score probes use `jq` if available.
- **Check (by execution):** `jq --version`
- **Install:**
  - macOS: `brew install jq`
  - Linux: `apt install jq` / `dnf install jq`
  - Windows: `winget install jqlang.jq`
- **Fallback if absent:** hooks fall back to Node-based JSON parsing.

---

## Scan order for `/prism-deps`

1. Core requirements (blocking — report fail, exit non-zero if missing).
2. Tier A (notebooklm-py) — always relevant.
3. Tier D (gh, jq) — informational; report status but don't push install.

## Install preference per OS

**POSIX install commands are returned as-is.** Windows install commands
are returned with `winget` preferred, manual download URL as fallback.
`/prism-deps` never installs silently — always shows the command first
and waits for user approval.

## Auth-required deps

`notebooklm-py` requires a one-time `notebooklm login` after install.
`/prism-deps` detects this by running `python -m notebooklm list` post-install
(the AppLocker-safe form) and flags if it fails — but does NOT automate the
OAuth flow (browser-based).
