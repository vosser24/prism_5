# Phase-1 state-file tests

## How to test by hand (5-minute review path)

A thin CLI driver lives at `tools/prism-state.mjs` (Node) and
`tools/prism-state.ps1` (PowerShell 5.1). Both refuse to run unless the
target directory has a `.git/` — pass `--no-git-guard` / `-NoGitGuard` to
override on a known-throwaway testbed.

### Linux / macOS

```sh
# 1. Set up a throwaway testbed
mkdir -p /tmp/prism-testbed-django && cd /tmp/prism-testbed-django && git init -q

# 2. Run the automated suites
node ~/PRISM/tests/v3/state/test-prism-state.mjs       # 32 unit tests
node ~/PRISM/tests/v3/state/testbed-edge-cases.mjs     # 12 e2e tests

# 3. Drive it by hand from the testbed
cd /tmp/prism-testbed-django

node ~/PRISM/tools/prism-state.mjs init testbed-django
node ~/PRISM/tools/prism-state.mjs read              # full parsed state
node ~/PRISM/tools/prism-state.mjs show              # pretty-print raw file
node ~/PRISM/tools/prism-state.mjs validate          # ok / errors / checksum

# Walk a phase machine
node ~/PRISM/tools/prism-state.mjs phase complete identity --meta '{"claude_md_lines":245}'
node ~/PRISM/tools/prism-state.mjs phase complete structure
node ~/PRISM/tools/prism-state.mjs phase fail discovery "DB unreachable"
node ~/PRISM/tools/prism-state.mjs read | grep -A2 phase_failures

# Inspect on-disk bytes (must be UTF-8 no BOM, LF, with checksum field)
xxd $(node ~/PRISM/tools/prism-state.mjs path) | head -2

# Exercise corruption detection
node ~/PRISM/tools/prism-state.mjs simulate-corrupt checksum
node ~/PRISM/tools/prism-state.mjs validate            # → checksum_mismatch, exit 1
node ~/PRISM/tools/prism-state.mjs simulate-corrupt json
node ~/PRISM/tools/prism-state.mjs validate            # → invalid_json
node ~/PRISM/tools/prism-state.mjs reset

# Detect-and-adopt (v3.8.9 migration)
echo "# project" > CLAUDE.md
mkdir -p .claude/references .claude/agents
echo '[]' > .claude/agents/roster.json
node ~/PRISM/tools/prism-state.mjs adopt
node ~/PRISM/tools/prism-state.mjs read | grep synthesized

# Done — clean up
node ~/PRISM/tools/prism-state.mjs reset
```

### Windows (PowerShell 5.1) — required for BOM verification

```powershell
mkdir C:\temp\prism-testbed
cd C:\temp\prism-testbed
git init

# Automated suites
powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\PRISM\tests\v3\state\test-prism-state.ps1

# Hand-driver (same surface as Node)
& C:\path\to\PRISM\tools\prism-state.ps1 init testbed
& C:\path\to\PRISM\tools\prism-state.ps1 read
& C:\path\to\PRISM\tools\prism-state.ps1 phase complete identity -Meta '{"claude_md_lines":245}'
& C:\path\to\PRISM\tools\prism-state.ps1 simulate-corrupt bom
& C:\path\to\PRISM\tools\prism-state.ps1 validate    # confirms reader catches BOM-prefixed JSON
& C:\path\to\PRISM\tools\prism-state.ps1 reset

# Critical PS-only check: written file has NO UTF-8 BOM
& C:\path\to\PRISM\tools\prism-state.ps1 init bomcheck
$bytes = [System.IO.File]::ReadAllBytes((& C:\path\to\PRISM\tools\prism-state.ps1 path))
"first 3 bytes: $($bytes[0..2] | ForEach-Object { '{0:X2}' -f $_ })"   # must NOT be EF BB BF
& C:\path\to\PRISM\tools\prism-state.ps1 reset
```

### What "good" looks like

- Both `node test-prism-state.mjs` and `node testbed-edge-cases.mjs` print
  `<N> passed, 0 failed` and exit 0
- `prism-state init` followed by `prism-state validate` shows
  `status: ok / schema_ok: true / checksum_ok: true`
- After any `simulate-corrupt`, `prism-state validate` reports the right
  failure mode (`checksum_mismatch`, `invalid_json`, `invalid_schema`)
- The state file's first 3 bytes are NEVER `EF BB BF` (no UTF-8 BOM)
- The state file ends with one `0A` byte (trailing LF) and contains no
  `0D` bytes (no CRLF)
- After Phase 1, the testbed contains only `.git/`, `README.md`, `src/`,
  and whatever `.claude/` artifacts you deliberately left (a fully-clean
  exit is `prism-state reset` followed by `rm -rf .claude`)

---


Tests for `tools/lib/prism-state.mjs` and `tools/lib/prism-state.ps1`
(the v3.10.0 `.prism-state.json` schema + helpers).

Locked design: `docs/prism/adjudications/D001-bootstrap-unification.md`,
`docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md`.

## What's here

| File | Purpose |
|------|---------|
| `test-prism-state.mjs` | Node unit tests — schema, checksum, validation, atomic write/read, mutators, detect-and-adopt, idempotency. No external deps. |
| `test-prism-state.ps1` | PowerShell unit tests — mirrors the Node suite for the PS module. **Critical assertion: written file MUST NOT have a UTF-8 BOM.** |
| `testbed-edge-cases.mjs` | End-to-end exercise against a real testbed dir. Simulates fresh, detect-and-adopt, corruption, partial-init, and crash-mid-write scenarios. |

## Run

```sh
# Linux / macOS
node tests/v3/state/test-prism-state.mjs
node tests/v3/state/testbed-edge-cases.mjs            # uses /tmp/prism-testbed-django
node tests/v3/state/testbed-edge-cases.mjs /custom    # or pass a path
```

```powershell
# Windows PowerShell 5.1 — REQUIRED for BOM verification
powershell -NoProfile -ExecutionPolicy Bypass -File tests\v3\state\test-prism-state.ps1
# Cross-version
pwsh       -NoProfile -ExecutionPolicy Bypass -File tests\v3\state\test-prism-state.ps1
```

## Testbed setup

Phase 1 deliverable: never run against the user's real install. Create a throwaway:

```sh
# Linux / macOS
mkdir -p /tmp/prism-testbed-django
cd /tmp/prism-testbed-django && git init
```

```powershell
# Windows
mkdir C:\temp\prism-testbed
cd C:\temp\prism-testbed; git init
```

`testbed-edge-cases.mjs` refuses to run in a directory that lacks a `.git/` —
defense-in-depth against accidentally pointing it at a real project.

## What the tests cover

- Schema validation (positive integer `schema_version`, ISO-8601 dates, all five
  required phases, `phase_failures` cap)
- Checksum: deterministic, key-order-invariant, ignores its own field, detects
  tampering
- Atomic write: temp file in same directory, fsync, rename; UTF-8 no BOM; LF
  line endings; refuses to write invalid state; cleans up temp on success
- Read failure modes: `missing` / `unreadable` / `invalid_json` /
  `invalid_schema` / `checksum_mismatch`
- Mutators: `markPhaseCompleted` (idempotent, rejects unknown phases, clears
  matching `last_command`), `markPhaseFailed` (capped at 10),
  `setSyncStamps`, `setLastCommand`
- Detect-and-adopt: `synthesizeFromFilesystem` against an empty project and a
  v3.8.9-style populated `.claude/` tree; sets `synthesized: true` on adopted phases
- Crash mid-write: stray `.tmp` files do not corrupt subsequent reads; next
  successful write proceeds normally
- Idempotency end-to-end: full bootstrap + re-run of every phase produces a
  stable, valid, checksum-correct state with no accumulated failures

## Phase-2 hand-off

The orchestrator (`/prism-bootstrap`, `/prism-sync`) consumes:

```js
import {
  readState, writeStateAtomic,
  createInitialState, synthesizeFromFilesystem,
  markPhaseCompleted, markPhaseFailed,
  setLastCommand, setSyncStamps,
  isPhaseCompleted,
  PHASES,
} from '../../tools/lib/prism-state.mjs';
```

`drift_signals` is intentionally NOT a persisted field — it is computed fresh
each `/prism-sync` invocation per D001 §State management revised in D002.
