# Phase-1 state-file tests

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
