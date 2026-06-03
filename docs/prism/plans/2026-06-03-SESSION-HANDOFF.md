# SESSION HANDOFF — command-consolidation plan + session state (2026-06-03)

> **Read this first in the next session.** Self-contained: resume the consolidation work without re-reconning. Re-verify any "pending" claim against the repo before trusting it — handoff claims decay.

## TL;DR — what to do next session
1. Implement the **panel-vetted "adopted subset"** (§THE PLAN): **5 automations + 2 consolidations**. TDD, on a **fresh branch off `main`**.
2. Re-verify the full suite (54 suites / 975 tests) + `audit-runner` 29/29, then merge → push.
3. Optional/parallel: run the **30-prompt UAT** in a recreated `test_prism_5` (§ALSO PENDING).

## Branch + state (2026-06-03)
- On **`main`**, working tree **clean**. HEAD: `6d62b7df4` (prism-init removal).
- All of v5.0 + v5.1 + the UAT fixes + pure-PRISM docs + prism-init removal are **merged to `main` and pushed** (`feat/v5.0` is synced with origin; this handoff pushes the last main commit too).
- **Tests:** 975 across 54 suites green. **Audit 29/29.** Live `~/.claude` install is in sync.
- `includeCoAuthoredBy: false` is set in `~/.claude/settings.json` — no more AI co-author footers on commits.

## DONE this session (context — already committed)
- **v5.1 P2–P4**: `/prism-clean append-summary` fold, handoff-doc step, bootstrap `claude-mem` offer + Mode-A/B, default-flip doc sweep.
- **Finding #1 fixed** (dispatch-guard Read carve-out for the tier-override file) — proven live.
- **4 UAT findings fixed**: EPERM rename retry, target-aware `rm -rf`, panel/sonnet classifier calibration, token-count format. Plus the **heredoc safety over-fire** fix.
- **Pure-PRISM docs**: full README rewrite, attribution stripped, `claude` co-author footer disabled.
- **`/prism-init` removed** — its CLAUDE.md template inlined into bootstrap's identity phase; pulled from both allowlists; refs repointed.
- **Panel** evaluated the command-consolidation proposal (4 dispatched experts: feasibility, UX-minimalism, speed-adversary, quality-adversary).

---

## THE PLAN — adopted command-consolidation subset (panel-vetted, SAFE)

**Governing principle (do NOT re-litigate):** *Automate DETECTION (cheap, deterministic, nudge-only). Keep EXECUTION manual (LLM-judged / mutating / installing / blocking).* Everything below rides the **existing once-per-24h SessionStart freshness sweep** + the **KB dirty-flag** — **no new hot-path latency**.

### A. Automations → fold into `hooks/prism-freshness-sweep.mjs` (already SessionStart, 24h-throttled)
Each must be CHEAP (fs/process only, **no LLM, no network**) and emit a **NOTICE only** — never run the heavy command, never mutate. Cap any `spawnSync` at ≤8s.

1. **Hook-integrity + settings-wiring check** (`node --check` on each hook + verify settings.json hook wiring) → nudge. Replaces the routine structural part of `/prism-doctor`.
2. **Roster-orphan detection** → nudge. (Sweep already has `checkStaleAgents`; add an orphan-vs-roster check.)
3. **Audit-staleness reminder** ("last `/prism-audit` was N days ago") → nudge.
4. **Version-lag → "update available" nudge** (filesystem version compare, **NO network**; apply stays manual). Sweep may already do a C3 version-lag check — extend, don't duplicate.
5. **Index auto-rebuild on corpus-change**: gate on dirty-flag (corpus mtime vs index `built_at`), **atomic write** (`.tmp` + rename) + **lockfile**. Reuse `prism-kb-autosync` machinery. Removes `/prism-index` from the routine surface.

### B. Consolidations
6. **New `prism-fresh` command** = `/prism-deep-dive --refresh` (memory-only). **Upgrade stays SEPARATE** (`--upgrade`, diff+confirm). ❗DO NOT merge refresh+upgrade into one silent op — upgrade rewrites the *learned* master agent body and would clobber tuning.
7. **Demote** `deps` / `index` / `validate-plugins` / `audit-full` into a "Maintenance" group in `commands/prism-help.md` (visible-surface tidy — **nothing deleted**, all still callable).

### C. Explicitly NOT doing (panel killed these — they compromise speed/quality)
- ❌ audit as a **blocking pre-commit gate** (15–20s + trains `--no-verify`, which disables the safety gate that blocks `rm -rf`/force-push).
- ❌ doctor/health **full pass every session** (5+ external process spawns = 3–5s dead air).
- ❌ **auto-recommend** (LLM cost, no "done" state → nags every session).
- ❌ **unattended update-APPLY** (silently rewrites model-matrix/agent bodies, no change event, no rollback trail).
- ❌ **auto-upgrade** of the master agent body.
- ❌ **auto-install** deps (OAuth/sudo can't be automated safely).

---

## IMPLEMENTATION POINTERS
- `hooks/prism-freshness-sweep.mjs` — the sweep. 24h throttle pattern via `.prism-freshness-last.json` (`THROTTLE_SECONDS = 24*60*60`). Add checks A1–A4 here. **MANDATORY:** any new SessionStart work MUST use this throttle or it fires on every `/clear`.
- `hooks/prism-session-start.mjs` — surfaces sweep notices; the **flag-file pickup pattern** (~lines 209–354) is the template for an "update-pending"/"index-rebuilt" nudge.
- Index dirty-flag: `hooks/prism-kb-autosync.mjs` + `tools/prism-kb-knowledge-indexer.mjs` (already does atomic builds). Gate the rebuild on corpus mtime.
- `prism-fresh`: new `commands/prism-fresh.md` wrapping `deep-dive --refresh`. **Add to BOTH `manifest.json` AND `tools/install-manifest.json` `files[]`** (the manifest-coverage test enforces sync). Add a row to `commands/prism-help.md`.
- **Every new sweep check + the new command needs a test.** Sweep test = `tests/v3/state/test-prism-freshness-sweep.mjs` (27 tests). `test-manifest-coverage` + `test-installer-coverage` MUST stay green when adding `prism-fresh`.

## KEY DECISIONS / CONSTRAINTS (locked — do NOT re-open)
- **Detection-automate / execution-manual** is the governing rule.
- **24h throttle** on any new SessionStart work.
- Irreducible core ≈ **11 commands**; everyday surface ≈ **4** (`bootstrap`, `clean`, `recall`, `sync`).
- `prism-fresh` = refresh-only; upgrade is a separate diff-confirmed action.
- Sweep checks emit **notices**, never execute the heavy command or mutate state.

## VERIFICATION (keep green before merge)
```
# full suite — 54 suites, 975 tests
find tests -name 'test-*.mjs' | while read t; do node "$t"; done  # plus tests/v3/state/testbed-edge-cases.mjs
# focus: test-prism-freshness-sweep, test-manifest-coverage, test-installer-coverage, test-prism-bootstrap
node tools/prism-installer.mjs install && node tools/prism-installer.mjs verify
node tools/prism-audit-runner.mjs   # expect 29/29
```

## ALSO PENDING (separate from consolidation)
- **30-prompt UAT**: run in a FRESH session cwd'd in `test_prism_5`. That folder was **torn down** — recreate it first (coffee-ledger Django+DRF app + git history, **no** bootstrap, so prompts 1–6 test master catch-up on pre-existing code). Prompt pack: **`docs/prism/2026-06-02-uat-prompt-pack.md`**. Run-guide was given this session (paste one prompt at a time; (expect BLOCK) prompts pass when refused).

## POINTERS
- Panel evaluation (4 grounded expert agents) → its measured findings (per-hook ~523ms cold-start, ~1s/turn tax, claude-p ~20s, index 9.2s) are the basis of the NOT-doing list. See the v5.0 stress-test report Axis-1 for the numbers: `docs/prism/2026-06-01-v5.0-stress-test-report.md`.
- UAT report: `docs/prism/2026-06-02-v5-uat-report.md`.
- Memory: `feedback-commit-msg-safety-gate`, `project-v5-stress-test-deadlock`, `reference-subagent-dispatch-main-loop-only`, `feedback-handoff-backlog-reverify`.
