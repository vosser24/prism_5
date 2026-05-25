# `/prism-sync` Implementation Plan (v3.11.0 Phase A.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/prism-sync` with conservative drift detection — a deterministic maintenance command that refreshes a project's PRISM index by re-running discovery/roster/health and stamping `last_sync_at` in `.prism-state.json`.

**Architecture:** New `tools/prism-sync.mjs` peer to `tools/prism-bootstrap.mjs` (same arg-parse + git-guard + state-via-lib pattern). Two subcommands: `plan` (returns the maintenance phase list with reasons) and `complete` (writes sync stamps + phase-meta to state). New slash command `commands/prism-sync.md` orchestrates the LLM-judged phases (discovery, roster, health) and delegates state I/O to the helper. Conservative-only in v3.11.0; `--smart-drift` is a stub that prints an EXPERIMENTAL warning and falls back to conservative.

**Tech Stack:** Node 18+ ES modules, no new dependencies. Tests = node subprocess harness (`spawnSync`) against `tmpdir()` testbeds, matching `tests/v3/state/test-prism-bootstrap.mjs`. Slash commands are markdown-driven (no code).

**Locked design references:**
- `docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md` §5 (conservative-drift default; smart-drift EXPERIMENTAL opt-in)
- `docs/prism/adjudications/D001-bootstrap-unification.md` §State management (phase contract; skip-condition for discovery)
- `docs/prism/adjudications/D004-v4-product-vision.md` Phase A row (this work fits the 3-day Phase-A foundation)

**Out of scope (deferred to v3.11.0 Phase A.2 / A.3):**
- `/prism-clean` (separate task, importance classifier)
- Agent-write auto-fire hook (separate task)
- `--smart-drift` real implementation (deferred to v3.12.0 per D002 §5)

---

## File Structure

| File | Role | Status |
|---|---|---|
| `tools/prism-sync.mjs` | New CLI helper: `plan`, `complete`, status passthrough | **Create** |
| `commands/prism-sync.md` | New slash command — orchestrates the LLM-judged maintenance pass | **Create** |
| `tests/v3/state/test-prism-sync.mjs` | New subprocess test harness for the helper | **Create** |
| `tools/lib/prism-state.mjs` | Reuses `setSyncStamps`, `markPhaseCompleted`, `readState`, `writeStateAtomic`, `isPhaseCompleted` as-is | **Read-only** |

**Helper subcommand contract (locked):**

```
prism-sync plan [--smart-drift] [--root <path>] [--no-git-guard]
  → stdout JSON: { project, mode: "conservative"|"smart", pending: [...], reasons: {...}, last_sync_at, last_run, claude_md_changed }
  → exits 0; exits 2 if no .git/ (without --no-git-guard); exits 3 if no state file

prism-sync complete [--meta '<json>'] [--root <path>] [--no-git-guard]
  → updates state: last_sync_at = now, refreshes phases.{discovery,roster,health}.completed_at with optional meta,
    sets next_sync_recommended = now + 7d
  → exits 0; exits 3 if no state; exits 5 if --meta is invalid JSON
```

**Maintenance phases (what `plan` returns under `pending`):**

| Phase | Always included? | Reason text in `reasons` |
|---|---|---|
| `structure` | Yes (idempotent) | `"verify scaffold"` |
| `identity` | Only if `mtime(CLAUDE.md) > last_sync_at \|\| initialized_at` | `"CLAUDE.md modified since last sync"` |
| `discovery` | Yes (conservative override of 24h skip) | `"conservative re-scan"` |
| `roster` | Yes | `"reconcile orphan agents"` |
| `health` | Yes | `"verify wiring"` |

---

## Task 1: Scaffold `tools/prism-sync.mjs` with arg parser, git guard, and `usage()`

**Files:**
- Create: `tools/prism-sync.mjs`
- Test: `tests/v3/state/test-prism-sync.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/v3/state/test-prism-sync.mjs
#!/usr/bin/env node
// Tests for tools/prism-sync.mjs (Phase A.1 helper).
// Drives the helper as a subprocess against ephemeral testbeds.
//
// Run: node tests/v3/state/test-prism-sync.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-sync.mjs');
const BOOTSTRAP = join(__dirname, '..', '..', '..', 'tools', 'prism-bootstrap.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-sync-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function bootstrap(cwd, ...args) {
  const r = spawnSync(process.execPath, [BOOTSTRAP, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function readStateFile(cwd) {
  return JSON.parse(readFileSync(join(cwd, '.claude', '.prism-state.json'), 'utf8'));
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-sync-nogit-'));
  try {
    const r = run(dir, 'plan');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: FAIL with `MODULE_NOT_FOUND` for `tools/prism-sync.mjs` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```javascript
// tools/prism-sync.mjs
#!/usr/bin/env node
// prism-sync — deterministic maintenance helper for /prism-sync (v3.11.0 Phase A.1).
//
// Conservative drift only in v3.11.0: every sync re-runs discovery/roster/health.
// --smart-drift is a stub that prints an EXPERIMENTAL warning and falls back to conservative.
//
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §5
//
// Subcommands:
//   prism-sync plan [--smart-drift]
//   prism-sync complete [--meta '<json>']
//
// All subcommands accept --root <path> and refuse to run without .git/ unless --no-git-guard.

import {existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {
  isPhaseCompleted,
  markPhaseCompleted,
  nowIso,
  readState,
  setSyncStamps,
  writeStateAtomic,
} from './lib/prism-state.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), smartDrift: false, noGitGuard: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--smart-drift') opts.smartDrift = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-sync <command> [args] [--root <path>] [--no-git-guard]

Commands:
  plan [--smart-drift]
  complete [--meta '<json>']
`);
  exit(code);
}

// ------------------------------ guards ------------------------------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

// ------------------------------ helpers ------------------------------

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: `1 passed, 0 failed` (the git-guard test should now pass — the helper exits non-zero with `.git/` mention because the dispatch falls through to `die(unknown command)` only when guard passes, but the guard fires first).

- [ ] **Step 5: Commit**

```
git add tools/prism-sync.mjs tests/v3/state/test-prism-sync.mjs
git commit -m "feat(prism): scaffold /prism-sync helper with git guard"
```

---

## Task 2: `plan` subcommand — conservative phase list with reasons

**Files:**
- Modify: `tools/prism-sync.mjs` (add `case 'plan'` dispatch + `planPhases()` function)
- Modify: `tests/v3/state/test-prism-sync.mjs` (append new tests)

- [ ] **Step 1: Write failing tests**

Append the following test blocks to `tests/v3/state/test-prism-sync.mjs` **before** the final `console.log` line:

```javascript
test('plan: no state file → exits 3 with helpful message', () => {
  const root = makeTestbed('plan-nostate');
  try {
    const r = run(root, 'plan');
    assertEq(r.status, 3, r.stderr);
    assert(/no state file/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan: conservative mode lists 4 phases by default (no identity refresh)', () => {
  const root = makeTestbed('plan-cons');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.mode, 'conservative');
    assertEq(out.pending, ['structure', 'discovery', 'roster', 'health']);
    assert(!out.claude_md_changed, 'no CLAUDE.md → no identity refresh');
    assertEq(out.reasons.discovery, 'conservative re-scan');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan: identity included when CLAUDE.md mtime > last_sync_at', () => {
  const root = makeTestbed('plan-claude');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    // Write CLAUDE.md AFTER state file → its mtime is newer than initialized_at
    writeFileSync(join(root, 'CLAUDE.md'), '# tb\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'CLAUDE.md'), future, future);
    const r = run(root, 'plan');
    const out = JSON.parse(r.stdout);
    assert(out.pending.includes('identity'), 'identity should be planned: ' + JSON.stringify(out));
    assert(out.claude_md_changed, 'claude_md_changed flag');
    assertEq(out.reasons.identity, 'CLAUDE.md modified since last sync');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('plan --smart-drift: prints EXPERIMENTAL warning but falls back to conservative', () => {
  const root = makeTestbed('plan-smart');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'plan', '--smart-drift');
    assertEq(r.status, 0, r.stderr);
    assert(/EXPERIMENTAL/.test(r.stderr), 'warning on stderr: ' + r.stderr);
    const out = JSON.parse(r.stdout);
    // Falls back to conservative (smart-drift is a stub in v3.11.0)
    assertEq(out.mode, 'conservative');
    assertEq(out.pending, ['structure', 'discovery', 'roster', 'health']);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: 3 FAILs in the new test blocks (no `plan` dispatch case).

- [ ] **Step 3: Implement `plan` subcommand**

Modify `tools/prism-sync.mjs`. Replace the `try { switch(cmd) { default: die(...) ...` block with:

```javascript
function loadStateOrDie() {
  const r = readState(opts.root);
  if (r.status === 'missing') {
    die('no state file. Run: /prism-bootstrap first.', 3);
  }
  if (r.status !== 'ok') {
    die(`state ${r.status}: ${r.errors.join('; ')}`, 4);
  }
  return r.state;
}

function claudeMdChangedSince(referenceIso) {
  const path = join(opts.root, 'CLAUDE.md');
  if (!existsSync(path)) return false;
  if (!referenceIso) return true;  // anything > no-baseline counts as changed
  const mtimeMs = statSync(path).mtimeMs;
  const refMs = new Date(referenceIso).getTime();
  return mtimeMs > refMs;
}

function planMaintenancePhases(state) {
  const reasons = {};
  const pending = [];

  // structure: always verified (cheap, idempotent)
  pending.push('structure');
  reasons.structure = 'verify scaffold';

  // identity: only if CLAUDE.md modified since last_sync_at (fall back to initialized_at)
  const baseline = state.last_sync_at || state.initialized_at;
  const claudeChanged = claudeMdChangedSince(baseline);
  if (claudeChanged) {
    pending.push('identity');
    reasons.identity = 'CLAUDE.md modified since last sync';
  }

  // discovery: conservative override of the 24h skip
  pending.push('discovery');
  reasons.discovery = 'conservative re-scan';

  // roster: always
  pending.push('roster');
  reasons.roster = 'reconcile orphan agents';

  // health: always (cheap, last)
  pending.push('health');
  reasons.health = 'verify wiring';

  return {pending, reasons, claude_md_changed: claudeChanged};
}

try {
  switch (cmd) {
    case 'plan': {
      if (opts.smartDrift) {
        stderr.write('WARNING: --smart-drift is EXPERIMENTAL and not yet implemented; falling back to conservative.\n');
      }
      const state = loadStateOrDie();
      const planned = planMaintenancePhases(state);
      stdout.write(JSON.stringify({
        project: state.project_name,
        mode: 'conservative',
        pending: planned.pending,
        reasons: planned.reasons,
        last_sync_at: state.last_sync_at,
        last_run: state.last_run,
        claude_md_changed: planned.claude_md_changed,
      }, null, 2) + '\n');
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add tools/prism-sync.mjs tests/v3/state/test-prism-sync.mjs
git commit -m "feat(prism): /prism-sync plan subcommand — conservative drift"
```

---

## Task 3: `complete` subcommand — write sync stamps + phase meta

**Files:**
- Modify: `tools/prism-sync.mjs` (add `case 'complete'` dispatch)
- Modify: `tests/v3/state/test-prism-sync.mjs` (append new tests)

- [ ] **Step 1: Write failing tests**

Append before the final `console.log` line:

```javascript
test('complete: stamps last_sync_at and refreshes phase timestamps', () => {
  const root = makeTestbed('complete-basic');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    assertEq(before.last_sync_at, null, 'fresh state has null last_sync_at');

    const meta = JSON.stringify({
      discovery: {references_count: 12, tables_indexed: 4},
      roster: {agents_registered: 3, orphans_remaining: 0},
      health: {status: 'green', checks_passed: 5, checks_failed: 0},
    });
    const r = run(root, 'complete', '--meta', meta);
    assertEq(r.status, 0, r.stderr);
    assert(/sync complete/.test(r.stdout), r.stdout);

    const after = readStateFile(root);
    assert(after.last_sync_at, 'last_sync_at set');
    assert(after.next_sync_recommended, 'next_sync_recommended set');
    // 7-day advisory (loose check: at least 6 days in the future)
    const gap = new Date(after.next_sync_recommended).getTime() - new Date(after.last_sync_at).getTime();
    assert(gap > 6 * 86400_000, `next_sync_recommended ~7d ahead, got ${gap}ms`);
    // Phase meta applied
    assertEq(after.phases.discovery.references_count, 12);
    assertEq(after.phases.roster.agents_registered, 3);
    assertEq(after.phases.health.status, 'green');
    // Phase timestamps refreshed
    assertEq(after.phases.discovery.completed_at, after.last_sync_at);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: --meta with invalid JSON exits 5', () => {
  const root = makeTestbed('complete-badmeta');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r = run(root, 'complete', '--meta', '{not json');
    assertEq(r.status, 5, r.stderr);
    assert(/--meta is not valid JSON/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: no --meta → still stamps sync timestamps, no phase mutations', () => {
  const root = makeTestbed('complete-nometa');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    // Pre-mark discovery so we can check it's refreshed
    bootstrap(root, 'phase-structure');
    const before = readStateFile(root);
    const r = run(root, 'complete');
    assertEq(r.status, 0, r.stderr);
    const after = readStateFile(root);
    assert(after.last_sync_at, 'last_sync_at set');
    // discovery/roster/health timestamps refreshed even without meta
    assert(after.phases.discovery.completed_at, 'discovery refreshed');
    assert(after.phases.roster.completed_at, 'roster refreshed');
    assert(after.phases.health.completed_at, 'health refreshed');
    // structure is NOT auto-refreshed by complete (it's a structural verify only)
    assertEq(after.phases.structure.dirs_created, before.phases.structure.dirs_created,
      'structure meta preserved');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('complete: no state file exits 3', () => {
  const root = makeTestbed('complete-nostate');
  try {
    const r = run(root, 'complete');
    assertEq(r.status, 3, r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: 4 new FAILs.

- [ ] **Step 3: Implement `complete` subcommand**

In `tools/prism-sync.mjs`, add a new `case 'complete':` to the dispatch switch (before `default:`):

```javascript
    case 'complete': {
      const state = loadStateOrDie();
      let meta = {};
      if (named.meta) {
        try {
          meta = JSON.parse(named.meta);
        } catch (e) {
          die(`--meta is not valid JSON: ${e.message}`, 5);
        }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          die('--meta must be a JSON object keyed by phase name', 5);
        }
      }

      const now = nowIso();
      // 7-day advisory window (D002 §5: conservative cadence, opt-out by re-running)
      const nextRecommended = new Date(Date.now() + 7 * 86400_000).toISOString();

      let next = setSyncStamps(state, {at: now, nextRecommended});
      // Refresh maintenance phases (discovery, roster, health) — these are the
      // canonical "synced" phases per D002 §5. Identity/structure are conditional
      // and the slash command is responsible for invoking them (the helper only
      // records the result via the meta payload).
      for (const phase of ['discovery', 'roster', 'health']) {
        const phaseMeta = meta[phase] && typeof meta[phase] === 'object' ? meta[phase] : {};
        next = markPhaseCompleted(next, phase, phaseMeta, {now});
      }
      // If meta carries identity/structure (slash command ran them this pass), record them too
      for (const phase of ['identity', 'structure']) {
        if (meta[phase] && typeof meta[phase] === 'object') {
          next = markPhaseCompleted(next, phase, meta[phase], {now});
        }
      }

      writeStateAtomic(opts.root, next);
      stdout.write(`sync complete: last_sync_at=${now}, next_sync_recommended=${nextRecommended}\n`);
      break;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: `8 passed, 0 failed`.

- [ ] **Step 5: Commit**

```
git add tools/prism-sync.mjs tests/v3/state/test-prism-sync.mjs
git commit -m "feat(prism): /prism-sync complete subcommand — stamps + phase meta"
```

---

## Task 4: Slash command `commands/prism-sync.md`

**Files:**
- Create: `commands/prism-sync.md`

This file has no automated test (slash commands are markdown — the helper tests cover the deterministic surface). The /prism-bootstrap.md file is the model.

- [ ] **Step 1: Write the slash command**

Create `commands/prism-sync.md` with this content (full file — copy-paste exactly):

```markdown
---
name: prism-sync
description: Refresh PRISM's project index — re-runs discovery, roster reconcile, and health checks; stamps last_sync_at. Conservative drift detection (always re-scans).
---

# /prism-sync — v3.11.0 maintenance sync

Locked design: `docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md` §5
(conservative drift = always re-scan; `--smart-drift` opt-in EXPERIMENTAL,
not yet implemented). Phase machine lives in `tools/prism-sync.mjs`.

**Flags:**
- `--smart-drift` — opt-in EXPERIMENTAL; currently falls back to conservative
  with a stderr warning.

---

## Step 0 — git guard

Run: `git rev-parse --is-inside-work-tree`

If NOT a git repo: STOP. `/prism-sync` requires a bootstrapped project — tell
the user to run `/prism-bootstrap` first.

## Step 1 — load plan

Run: `node ~/.claude/tools/prism-sync.mjs plan [--smart-drift]`

If the helper exits 3 ("no state file"): tell the user this project has not
been bootstrapped and they should run `/prism-bootstrap` first. STOP.

The output JSON has:
- `mode`: always `"conservative"` in v3.11.0
- `pending`: ordered phase list to run
- `reasons`: human-readable rationale per phase
- `last_sync_at`: previous sync time (null if first sync)
- `claude_md_changed`: whether CLAUDE.md was modified since last sync

Surface the plan to the user with a one-line summary:
`"Conservative sync — will run: structure, [identity,] discovery, roster, health"`

---

## Step 2 — execute phases

For each phase in `pending`, in order:

### `structure` — verify scaffold

Run: `node ~/.claude/tools/prism-bootstrap.mjs phase-structure`

This is idempotent (creates only missing directories/seed files). The helper
records dirs_created / files_created counts in the structure phase metadata.

If `dirs_created > 0` OR `files_created > 0`: note in the final summary that
scaffold gaps were filled (someone may have deleted PRISM directories).

### `identity` — refresh CLAUDE.md (conditional, only if planned)

If CLAUDE.md was modified since last sync (per Step 1's `claude_md_changed`):
re-verify it has a `## PRISM Operating Rules` section. If absent, append the
template per `/prism-init` Step 2's "append, don't reorder" rule.

DO NOT regenerate the file. DO NOT prompt the user — just verify + append if needed.

### `discovery` — re-scan (LLM-judged)

Invoke the existing `/prism-discover` logic (parallelized codebase scan +
schema introspection + API surface scan). DO NOT re-implement.

Record the result counts: `{references_count, tables_indexed, endpoints_indexed}`.

### `roster` — reconcile (LLM-judged)

Invoke the existing `/prism-roster --reconcile` logic. If new orphans are
detected, surface them to the user with the same dual-form match prompt as
`/prism-bootstrap` phase 4.

If running non-interactively and orphans need user choice: log them and
proceed without auto-registering — the user can re-run with `/prism-roster
--reconcile` to handle.

Record: `{agents_registered, orphans_remaining}`.

### `health` — verify wiring (LLM-judged)

Invoke the existing `/prism-health` checks. Report status to the user.

Record: `{status, checks_passed, checks_failed}`.

---

## Step 3 — stamp + report

Collect the phase metadata from steps above into a single JSON object keyed
by phase name. Example:

```json
{
  "structure": {"dirs_created": 0, "files_created": 0, "gitignore": "present"},
  "discovery": {"references_count": 14, "tables_indexed": 6, "endpoints_indexed": 12},
  "roster": {"agents_registered": 4, "orphans_remaining": 0},
  "health": {"status": "green", "checks_passed": 5, "checks_failed": 0}
}
```

(Include `identity` only if it was in `pending`.)

Run: `node ~/.claude/tools/prism-sync.mjs complete --meta '<json>'`

This stamps `last_sync_at = now` and `next_sync_recommended = now + 7d`.

Then summarize for the user:

- ✅ Phases re-scanned: <list>
- 📊 Drift highlights: <e.g., "+2 new tables in DB", "1 new orphan agent">
- ⏰ Next sync recommended: <next_sync_recommended date>

If new orphans remain or health is yellow/red: surface as actionable items.

---

## Idempotency contract

Running `/prism-sync` twice in a row on an unchanged project must:
- Produce two valid state writes (timestamps advance, checksum recomputes).
- Produce no destructive changes.
- Report identical drift highlights (or "no changes").
- Never duplicate roster entries.

## Failure modes

| State status | /prism-sync behaviour |
|--------------|----------------------|
| `missing` | STOP, tell user to /prism-bootstrap first (helper exits 3) |
| `invalid_json` / `invalid_schema` / `checksum_mismatch` | STOP, same recovery path as /prism-bootstrap |
| Discovery/roster/health phase errors | Record via `prism-bootstrap.mjs fail-phase <name>` and continue with remaining phases (D001 §Robustness #4: failure isolation) |

## Related commands

- `/prism-bootstrap` — initial setup (sets up state file)
- `/prism-clean` — capture session lessons (separate command, ships in same v3.11.0 release)
```

- [ ] **Step 2: Verify the slash command file lints (no markdown syntax errors)**

Run: `node -e "const fs = require('fs'); const body = fs.readFileSync('commands/prism-sync.md', 'utf8'); if (!body.startsWith('---\nname: prism-sync')) throw new Error('frontmatter malformed'); console.log('ok: ' + body.split('\n').length + ' lines');"`

Expected: `ok: <N> lines` with no error.

- [ ] **Step 3: Commit**

```
git add commands/prism-sync.md
git commit -m "feat(prism): /prism-sync slash command — conservative drift orchestrator"
```

---

## Task 5: Idempotency + crash-safety test

**Files:**
- Modify: `tests/v3/state/test-prism-sync.mjs` (append final test block)

- [ ] **Step 1: Write the failing test**

Append before the final `console.log` line:

```javascript
test('idempotency: two completes in a row produce valid state with advanced timestamps', () => {
  const root = makeTestbed('idem');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const r1 = run(root, 'complete');
    assertEq(r1.status, 0, r1.stderr);
    const after1 = readStateFile(root);

    // Force a measurable time gap (state uses ms-precision ISO; node nowIso has ms)
    const r2 = spawnSync('node', ['-e', 'setTimeout(() => process.exit(0), 50)'], {encoding: 'utf8'});
    assertEq(r2.status, 0);

    const r3 = run(root, 'complete');
    assertEq(r3.status, 0, r3.stderr);
    const after2 = readStateFile(root);

    assert(after2.last_sync_at > after1.last_sync_at, 'last_sync_at advanced');
    // Checksum must be valid after both writes — verify by re-running plan
    const planR = run(root, 'plan');
    assertEq(planR.status, 0, 'state valid after two completes: ' + planR.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('crash safety: complete fails atomically — state stays valid on bad --meta', () => {
  const root = makeTestbed('crash');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    const before = readStateFile(root);
    // Bad meta exits before writing
    const r = run(root, 'complete', '--meta', '{not json');
    assertEq(r.status, 5);
    const after = readStateFile(root);
    assertEq(after.last_sync_at, before.last_sync_at, 'state unchanged on meta error');
    assertEq(after.checksum, before.checksum, 'checksum unchanged');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node tests/v3/state/test-prism-sync.mjs`
Expected: `10 passed, 0 failed` (all tests including the new two).

(These tests should pass against the Task 3 implementation — they're regression coverage that the design is correct, not new behavior.)

- [ ] **Step 3: Commit**

```
git add tests/v3/state/test-prism-sync.mjs
git commit -m "test(prism): /prism-sync idempotency + atomic-write coverage"
```

---

## Task 6: Run full test suite + verify against own project state

**Files:**
- No code changes; verification only.

- [ ] **Step 1: Run all v3 state tests**

Run: `node tests/v3/state/test-prism-state.mjs && node tests/v3/state/test-prism-bootstrap.mjs && node tests/v3/state/test-prism-sync.mjs`
Expected: All three suites report `0 failed`. No regression in the prior two suites.

- [ ] **Step 2: Smoke against the prism_3 project itself (read-only path)**

Run: `node tools/prism-sync.mjs plan --no-git-guard` (run from `Y:\Documents\utilities_projects\prism_3`)

Two possible outcomes — either is acceptable, just note which:
- Exit 3 + "no state file" → prism_3 hasn't been bootstrapped against itself; expected, nothing to fix.
- Exit 0 + JSON plan → confirms the helper works end-to-end on a real project.

DO NOT run `complete` against `prism_3` — this would write state to the PRISM source repo itself, polluting it. Plan-only smoke is enough.

- [ ] **Step 3: Final commit (CHANGELOG + version bump deferred to Phase A completion)**

No commit at this step — the per-task commits already cover the work. The CHANGELOG entry for v3.11.0 is added when Phase A (all of /prism-sync + /prism-clean + agent-write hook) is complete.

---

## Self-Review

**Spec coverage (D002 §5):**
- ✅ Conservative drift = always re-scan → Task 2 `planMaintenancePhases` always plans discovery+roster+health
- ✅ `--smart-drift` opt-in EXPERIMENTAL → Task 2 emits the warning and falls back
- ✅ `last_sync_at` updated → Task 3 `setSyncStamps`
- ✅ `next_sync_recommended` updated → Task 3 (7-day window)
- ✅ Identity refresh conditional → Task 2 mtime check against `last_sync_at \|\| initialized_at`

**Spec coverage (D001 §State management):**
- ✅ Atomic write via `writeStateAtomic` → reused from lib/prism-state.mjs
- ✅ Checksum recomputed → handled by `writeStateAtomic`
- ✅ Phase failure isolation → slash command (Task 4) calls `prism-bootstrap.mjs fail-phase` per phase

**Spec coverage (D004 Phase A row):**
- ✅ `/prism-sync` ships with conservative drift (this plan)
- Out of scope (separate plans): `/prism-clean`, agent-write hook

**Placeholder scan:** None — every step has full code, exact commands, exact expected output.

**Type consistency:**
- `planMaintenancePhases()` defined in Task 2, used in Task 2 — same name.
- `loadStateOrDie()` defined in Task 2, used in Task 3 — same name.
- `setSyncStamps()` from lib (existing) takes `{at, nextRecommended}` — matches existing signature in `tools/lib/prism-state.mjs:287`.
- `markPhaseCompleted(state, phaseName, metadata, {now})` from lib (existing) — matches `tools/lib/prism-state.mjs:249`.

**No gaps found.**
