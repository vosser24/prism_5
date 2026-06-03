# Phase F — `/prism-clean` nudge hooks Implementation Plan (v4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two off-able nudge hooks that remind the user to run `/prism-clean` before durable session signals are lost — one fires on `SessionEnd[matcher=clear]` (right before `/clear` discards conversation history), one fires on `PreCompact` (right before auto-compact at 95% does the same). Both emit `additionalContext` only — never block, never exit non-zero.

**Architecture:** ONE Node hook file at `hooks/prism-clean-nudge.mjs` handles both events via a `hook_event_name` branch on the JSON input. Registered TWICE in `settings.fragment.json` (once per event, same command). Off-switches via `PRISM_DISABLE_CLEAR_NUDGE=1` and `PRISM_DISABLE_PRECOMPACT_NUDGE=1`. Follows the same `bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/<hook>.mjs` invocation convention every existing PRISM hook uses (Windows users get auto-rewritten to `cmd /c prism-exec.cmd` by `scripts/install-merge.mjs §4a` at install time — so cross-platform comes for free without writing a separate PowerShell variant).

**Tech Stack:** Node 18+ ES module, no new deps. Reads stdin JSON, emits stdout JSON in the standard hookSpecificOutput shape (verified pattern from `hooks/prism-memory-save-nudge.mjs`). Tests = `spawnSync` against the hook script with mock JSON on stdin, asserting stdout / exit code. Lives at `tests/v3/state/test-prism-clean-nudge.mjs`.

**Locked design references:**
- `docs/prism/adjudications/D004-v4-product-vision.md` §6 (Two nudge hooks, not three; SessionEnd[clear] + PreCompact; off-switches; combined script) + risk-register #4 (PS 5.1 spawn cost) + "v4.0 ship gates" rows for SessionEnd and PreCompact.
- `hooks/prism-memory-save-nudge.mjs` — canonical `additionalContext` emission pattern (lines 97-103); off-switch env-var read at top; structured failure-mode logging to `~/.claude/.prism-routing.jsonl`.
- `hooks/prism-session-end.mjs` — existing SessionEnd hook (verifies SessionEnd JSON input shape: `session_id`, `transcript_path`, `cwd`, plus an implied `reason` field).
- `settings.fragment.json` — existing hooks registration shape; this plan adds two new top-level event arrays (`SessionEnd` does not currently exist there; `PreCompact` doesn't either).
- `hooks/lib/prism-exec.sh` + `hooks/lib/prism-exec.cmd` — node-resolution wrappers; both already installed; no changes needed.
- `scripts/install-merge.mjs` §4a — Windows path-rewrite step that auto-translates `bash prism-exec.sh` → `cmd /c prism-exec.cmd` at install time.

**Deviation from D004 §6 prose, documented:** D004 §6 says "Implemented in PowerShell with `\"shell\": \"powershell\"` on Windows; bash variant for POSIX". The actual project convention uses ONE Node hook file invoked through `prism-exec.{sh,cmd}` wrappers that auto-resolve `node` from PATH / nvm / fnm / volta / asdf / brew / Program Files. Following project convention (one .mjs, no per-OS PowerShell variant) keeps the maintenance surface at ONE file and reuses the battle-tested wrapper. The cold-start budget (~100 ms target per D004 risk-register #4) is met because the wrappers + node startup are <50 ms in measured PRISM runs and the hook body is ~30 lines of synchronous I/O. No PowerShell is needed or written.

**Deviation from D004 §6 nudge text, documented:** D004 §6 quotes the nudge text as `"captured X panel decisions + Y deviations this session. Run /prism-clean first to archive?"`. Computing X and Y precisely requires session-knowledge classification that lands in Phase H (knowledge evolution rhythms). For Phase F we emit a category-agnostic nudge that names both shapes without claiming a count: *"Session has accumulated panel decisions and deviations worth archiving. Run /prism-clean first so they're not lost on /clear (or auto-compact)."*. Phase H will replace this string with computed X / Y once `~/.claude/.prism-lessons.jsonl` has stable category tags.

**Out of scope (deferred):**
- Computing exact X panel decisions / Y deviations counts (Phase H).
- Per-quarter MEMORY.md re-synthesis (D004 §5; v4.1 manual-only in v4.0).
- The cut 70% context-budget estimator hook (D004 §6 + "Cuts" table: never; CLAUDE.md instruction covers it instead).

**File structure:**

| File | Action | Responsibility |
|---|---|---|
| `hooks/prism-clean-nudge.mjs` | **CREATE** | Single hook handler. Branches on `hook_event_name` (SessionEnd vs PreCompact). Reads off-switch env vars. Emits `additionalContext` if conditions met. Silent exit 0 otherwise. |
| `tests/v3/state/test-prism-clean-nudge.mjs` | **CREATE** | Subprocess tests: 6 scenarios (SessionEnd clear / SessionEnd non-clear / SessionEnd off / PreCompact / PreCompact off / malformed input). |
| `settings.fragment.json` | **MODIFY** | Add `SessionEnd` array with `"matcher": "clear"` and `PreCompact` array — both pointing at the same .mjs via the standard `prism-exec.sh` wrapper. |
| `hooks/lib/prism-exec.sh` + `.cmd` | **UNCHANGED** | Already installed; auto-resolves node. |

---

### Task 1: Write the failing test file (TDD red)

**Why first:** Six test scenarios pin down the hook's contract before any code is written. The two-stage review can verify the behavior matches the spec.

**Files:**
- Create: `tests/v3/state/test-prism-clean-nudge.mjs`

- [ ] **Step 1: Write the failing test file**

Create `tests/v3/state/test-prism-clean-nudge.mjs` with this exact content:

```javascript
#!/usr/bin/env node
// Tests for hooks/prism-clean-nudge.mjs (v4.0 Phase F).
// Subprocess-driven; pipes mock JSON on stdin; asserts stdout JSON / exit code.
//
// Run: node tests/v3/state/test-prism-clean-nudge.mjs

import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-clean-nudge.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function runHook(stdinJson, env = {}) {
  const fullEnv = {...process.env, ...env};
  // Strip any inherited off-switches so tests are deterministic
  if (!('PRISM_DISABLE_CLEAR_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_CLEAR_NUDGE;
  if (!('PRISM_DISABLE_PRECOMPACT_NUDGE' in env)) delete fullEnv.PRISM_DISABLE_PRECOMPACT_NUDGE;
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(stdinJson),
    encoding: 'utf8',
    env: fullEnv,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function parseStdout(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout); }
  catch (e) { throw new Error(`stdout is not JSON: ${stdout}`); }
}

test('SessionEnd reason=clear: emits nudge in hookSpecificOutput.additionalContext', () => {
  const r = runHook({hook_event_name: 'SessionEnd', reason: 'clear', session_id: 'sess-1'});
  assertEq(r.status, 0, r.stderr);
  const out = parseStdout(r.stdout);
  assert(out, 'stdout should be JSON, was empty');
  assertEq(out.hookSpecificOutput.hookEventName, 'SessionEnd');
  assert(/prism-clean/.test(out.hookSpecificOutput.additionalContext), 'nudge text must mention /prism-clean');
  assert(/archive|panel|decision|deviation/i.test(out.hookSpecificOutput.additionalContext), 'nudge text must explain WHY (panel decisions / deviations / archive)');
});

test('SessionEnd reason=clear with PRISM_DISABLE_CLEAR_NUDGE=1: silent exit, no stdout', () => {
  const r = runHook(
    {hook_event_name: 'SessionEnd', reason: 'clear', session_id: 'sess-2'},
    {PRISM_DISABLE_CLEAR_NUDGE: '1'},
  );
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'off-switch must produce no stdout');
});

test('SessionEnd reason=logout (not clear): silent exit (matcher catches this upstream, but defensive)', () => {
  const r = runHook({hook_event_name: 'SessionEnd', reason: 'logout', session_id: 'sess-3'});
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'non-clear SessionEnd reason must produce no stdout');
});

test('PreCompact: emits nudge in hookSpecificOutput.additionalContext', () => {
  const r = runHook({hook_event_name: 'PreCompact', session_id: 'sess-4'});
  assertEq(r.status, 0, r.stderr);
  const out = parseStdout(r.stdout);
  assert(out, 'stdout should be JSON, was empty');
  assertEq(out.hookSpecificOutput.hookEventName, 'PreCompact');
  assert(/prism-clean/.test(out.hookSpecificOutput.additionalContext), 'nudge text must mention /prism-clean');
});

test('PreCompact with PRISM_DISABLE_PRECOMPACT_NUDGE=1: silent exit, no stdout', () => {
  const r = runHook(
    {hook_event_name: 'PreCompact', session_id: 'sess-5'},
    {PRISM_DISABLE_PRECOMPACT_NUDGE: '1'},
  );
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), '', 'off-switch must produce no stdout');
});

test('Malformed stdin: silent exit 0 (never crash, never block)', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'this is not json',
    encoding: 'utf8',
  });
  assertEq(r.status, 0, 'must exit 0 even on bad input');
  assertEq(r.stdout.trim(), '', 'no stdout on malformed input');
});

test('Empty stdin: silent exit 0', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '',
    encoding: 'utf8',
  });
  assertEq(r.status, 0, 'must exit 0 even on empty stdin');
  assertEq(r.stdout.trim(), '', 'no stdout on empty stdin');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test — verify all 7 tests FAIL (RED phase)**

```bash
node tests/v3/state/test-prism-clean-nudge.mjs
```

Expected: every test fails with an error like `Error: Cannot find module '/path/to/hooks/prism-clean-nudge.mjs'` or `ENOENT` — because the hook file doesn't exist yet. Exit code 1.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/v3/state/test-prism-clean-nudge.mjs
git commit -m "$(cat <<'EOF'
test(prism): add Phase F clean-nudge hook tests (TDD red)

Subprocess-driven tests for the planned hooks/prism-clean-nudge.mjs:
- SessionEnd reason=clear emits nudge in hookSpecificOutput.additionalContext
- SessionEnd with PRISM_DISABLE_CLEAR_NUDGE=1 is silent
- SessionEnd with reason≠clear is silent (defensive — matcher catches upstream)
- PreCompact emits nudge
- PreCompact with PRISM_DISABLE_PRECOMPACT_NUDGE=1 is silent
- Malformed and empty stdin exit 0 with no stdout (never crash, never block)

Tests currently FAIL — hook file doesn't exist yet. Task 2 creates it.

EOF
)"
```

---

### Task 2: Implement `hooks/prism-clean-nudge.mjs` (TDD green)

**Files:**
- Create: `hooks/prism-clean-nudge.mjs`

- [ ] **Step 1: Write the hook**

Create `hooks/prism-clean-nudge.mjs` with this exact content:

```javascript
#!/usr/bin/env node
// PRISM Clean Nudge (v4.0 Phase F) — SessionEnd[matcher=clear] + PreCompact
//
// Emits additionalContext reminding the user to run /prism-clean before
// durable session signals are lost on /clear or auto-compact. NEVER blocks
// (no exit 2, no stderr policy text). One file handles both events via a
// hook_event_name branch.
//
// Tunables (env vars):
//   PRISM_DISABLE_CLEAR_NUDGE=1      — suppress SessionEnd[clear] nudge
//   PRISM_DISABLE_PRECOMPACT_NUDGE=1 — suppress PreCompact nudge
//
// Failure-mode: ANY error path exits 0 with no stdout. Hooks must never
// degrade the user experience — a missing or malformed input must not
// prevent /clear or PreCompact from proceeding.

import {readFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG = join(H, '.claude', '.prism-routing.jsonl');

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG), {recursive: true});
    appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch { /* logging must never fail loudly */ }
}

const NUDGE_TEXT =
  'Session has accumulated panel decisions and deviations worth archiving. ' +
  'Run /prism-clean first so they get captured to docs/prism/ before /clear ' +
  '(or auto-compact) loses session context.';

try {
  const raw = readFileSync(0, 'utf-8');
  if (!raw.trim()) process.exit(0);

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!input || typeof input !== 'object') process.exit(0);

  const eventName = input.hook_event_name;
  const sessionId = input.session_id || 'anon';

  if (eventName === 'SessionEnd') {
    if (process.env.PRISM_DISABLE_CLEAR_NUDGE === '1') process.exit(0);
    if (input.reason !== 'clear') process.exit(0);
  } else if (eventName === 'PreCompact') {
    if (process.env.PRISM_DISABLE_PRECOMPACT_NUDGE === '1') process.exit(0);
  } else {
    process.exit(0);
  }

  appendLog({event: 'clean_nudge', hook_event: eventName, session_id: sessionId, ts: new Date().toISOString()});

  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: NUDGE_TEXT,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  appendLog({event: 'clean_nudge', error: String(e), ts: new Date().toISOString()});
  process.exit(0);
}
```

- [ ] **Step 2: Run the tests — verify they PASS (GREEN phase)**

```bash
node tests/v3/state/test-prism-clean-nudge.mjs
```

Expected: `7 passed, 0 failed`.

If any fail, do NOT proceed — read the failure message, fix the hook, re-run.

- [ ] **Step 3: Run the full 8-suite regression**

```bash
node tests/v3/state/test-prism-state.mjs
node tests/v3/state/test-prism-bootstrap.mjs
node tests/v3/state/test-prism-deep-dive.mjs
node tests/v3/state/test-prism-sync.mjs
node tests/v3/state/test-prism-clean.mjs
node tests/v3/state/test-prism-validate-plugins.mjs
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
node tests/v3/hooks/test-agent-write-register.mjs
node tests/v3/state/test-prism-clean-nudge.mjs
```

Expected: all 9 suites green; total ~143/143 (Phase E's 136 + 7 new).

- [ ] **Step 4: Commit**

```bash
git add hooks/prism-clean-nudge.mjs
git commit -m "$(cat <<'EOF'
feat(prism): clean-nudge hook for SessionEnd[clear] + PreCompact (Phase F TDD green)

ONE Node hook handles both events via hook_event_name branch on JSON input.
- SessionEnd[matcher=clear]: emits additionalContext reminding user to run
  /prism-clean before /clear discards session context.
- PreCompact: same reminder before auto-compact at 95%.

Both off-able via env vars: PRISM_DISABLE_CLEAR_NUDGE=1 and
PRISM_DISABLE_PRECOMPACT_NUDGE=1.

Defensive: malformed/empty stdin exits 0 silently. ANY error path is silent
exit 0 — hooks must never degrade the user experience by blocking /clear or
PreCompact.

Cross-platform via existing prism-exec.{sh,cmd} wrapper (no PowerShell needed
despite D004 §6 prose — project convention since v3.5.0 uses Node hooks
through wrappers, see scripts/install-merge.mjs §4a for the Windows rewrite).

Task 1 TDD red tests now pass (7/7). All 8 prior suites still green; total
143/143 across 9 suites. Settings registration in Task 3.

EOF
)"
```

---

### Task 3: Register the hook in `settings.fragment.json`

**Files:**
- Modify: `settings.fragment.json`

- [ ] **Step 1: Read the current `settings.fragment.json` to find the right insertion point**

The file has top-level keys: `env`, `hooks`. Within `hooks` there are arrays for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, possibly `Stop` / `SubagentStop` / `SessionEnd` (the existing `prism-session-end.mjs` is registered somewhere — verify by reading the full file).

```bash
cat -n settings.fragment.json
```

If `SessionEnd` already exists as a key, add a new entry to its array with `"matcher": "clear"`. If `SessionEnd` doesn't exist, add it as a new key. Same for `PreCompact` (almost certainly doesn't exist yet).

- [ ] **Step 2: Add the SessionEnd registration**

If `SessionEnd` does NOT exist in `settings.fragment.json`: append a new key-value pair. If it exists: append to its array. Either way, the new entry is:

```json
{
  "matcher": "clear",
  "hooks": [
    {
      "type": "command",
      "command": "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-clean-nudge.mjs"
    }
  ]
}
```

- [ ] **Step 3: Add the PreCompact registration**

`PreCompact` almost certainly doesn't exist yet (grep first to confirm). Add this top-level array:

```json
"PreCompact": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-clean-nudge.mjs"
      }
    ]
  }
]
```

PreCompact has no `matcher` field — it fires once per auto-compact regardless.

- [ ] **Step 4: Verify JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('settings.fragment.json', 'utf8')); console.log('valid JSON');"
```

Expected: `valid JSON`. If it errors, the JSON is malformed — read the parser error and fix.

- [ ] **Step 5: Verify install-merge.mjs Windows-rewrite still applies cleanly**

The `bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-clean-nudge.mjs` command matches the pattern install-merge.mjs §4a rewrites for Windows. Sanity-check that the new entries follow the SAME shape as the existing UserPromptSubmit entries (same wrapper, same path style). A diff comparison should be enough.

- [ ] **Step 6: Commit**

```bash
git add settings.fragment.json
git commit -m "$(cat <<'EOF'
feat(prism): register clean-nudge hook for SessionEnd[clear] + PreCompact (Phase F)

Wires the Phase F hook into settings.fragment.json. Both events point at
hooks/prism-clean-nudge.mjs via the existing bash prism-exec.sh wrapper —
install-merge.mjs §4a auto-rewrites this to cmd /c prism-exec.cmd on
Windows at install time, so cross-platform comes for free.

SessionEnd uses "matcher": "clear" to fire only on /clear (not logout,
prompt_input_exit, or other reasons).
PreCompact has no matcher — fires on every auto-compact.

EOF
)"
```

---

### Task 4: Re-sync dev install to `~/.claude/` (controller, inline)

**Why now:** The hook + settings registration are local to this repo. For the hook to actually fire in a Claude Code session, the hook file needs to be at `~/.claude/hooks/` and the settings entry needs to be in the user's `~/.claude/settings.json`. The branch is still local-only; standard install can't ship it.

This task is the controller running cp + manual settings-merge. NOT subagent-dispatchable (touches user-level files outside the repo).

- [ ] **Step 1: Copy the hook file**

```bash
cp Y:/Documents/utilities_projects/prism_3/hooks/prism-clean-nudge.mjs "$HOME/.claude/hooks/prism-clean-nudge.mjs"
```

- [ ] **Step 2: Merge the new hook entries into the user's settings.json**

The user's `~/.claude/settings.json` is a separate file from the repo's `settings.fragment.json` (which is the installer-fragment merged in by install-merge.mjs). For dev-install, do the merge by hand:

```bash
# Inspect current ~/.claude/settings.json hooks section
node -e "const s=JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8')); console.log(JSON.stringify(s.hooks?.SessionEnd ?? '(no SessionEnd)', null, 2)); console.log(JSON.stringify(s.hooks?.PreCompact ?? '(no PreCompact)', null, 2));"
```

Then write a small Node script that loads `~/.claude/settings.json`, adds the two new entries (idempotently — skip if an entry with the same command already exists), writes atomically. The exact append:

```javascript
// ad-hoc merger; controller runs this once during Task 4
import {readFileSync, writeFileSync, renameSync} from 'node:fs';
import {join} from 'node:path';

const settingsPath = join(process.env.HOME || process.env.USERPROFILE, '.claude', 'settings.json');
const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
s.hooks = s.hooks || {};
const CMD_LINUX = 'bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/prism-clean-nudge.mjs';
const CMD_WIN = 'cmd /c "%USERPROFILE%\\.claude\\hooks\\lib\\prism-exec.cmd" "%USERPROFILE%\\.claude\\hooks\\prism-clean-nudge.mjs"';
const isWin = process.platform === 'win32';
const CMD = isWin ? CMD_WIN : CMD_LINUX;

function hasCmd(arr, cmd) {
  if (!Array.isArray(arr)) return false;
  for (const block of arr) {
    for (const h of (block.hooks || [])) if (h.command === cmd) return true;
  }
  return false;
}

s.hooks.SessionEnd = s.hooks.SessionEnd || [];
if (!hasCmd(s.hooks.SessionEnd, CMD)) {
  s.hooks.SessionEnd.push({matcher: 'clear', hooks: [{type: 'command', command: CMD}]});
}

s.hooks.PreCompact = s.hooks.PreCompact || [];
if (!hasCmd(s.hooks.PreCompact, CMD)) {
  s.hooks.PreCompact.push({hooks: [{type: 'command', command: CMD}]});
}

const tmp = settingsPath + '.tmp';
writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
renameSync(tmp, settingsPath);
console.log('merged Phase F hooks into ~/.claude/settings.json');
```

Save this as `/tmp/merge-phase-f-hooks.mjs` and run:

```bash
node /tmp/merge-phase-f-hooks.mjs
```

Expected: `merged Phase F hooks into ~/.claude/settings.json`.

- [ ] **Step 3: Verify the merge landed correctly**

```bash
node -e "const s=JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8')); console.log('SessionEnd entries:', JSON.stringify(s.hooks.SessionEnd, null, 2)); console.log('PreCompact entries:', JSON.stringify(s.hooks.PreCompact, null, 2));"
```

Expected: both arrays contain at least one entry whose command matches the wrapper path. The platform-appropriate command form (cmd /c on Windows, bash on POSIX) is present.

- [ ] **Step 4: Update the dev-install inventory doc**

Append a row to `docs/prism/lessons/2026-05-25-dev-install-inventory.md` under the "Files copied" table:

```markdown
| `hooks/prism-clean-nudge.mjs` (Phase F) | `hooks/prism-clean-nudge.mjs` |
```

And update the cleanup commands to include:

```powershell
Remove-Item -Force $env:USERPROFILE\.claude\hooks\prism-clean-nudge.mjs
```

Also add a note under a new "Settings merge" section explaining how to revert the `~/.claude/settings.json` change if needed.

- [ ] **Step 5: Commit the inventory update**

```bash
git add docs/prism/lessons/2026-05-25-dev-install-inventory.md
git commit -m "$(cat <<'EOF'
docs(prism): update dev-install inventory for Phase F clean-nudge hook

Records the additional hook + settings.json merge during Phase F:
- hooks/prism-clean-nudge.mjs (new in Phase F)
- ~/.claude/settings.json: SessionEnd[clear] + PreCompact entries added
  by ad-hoc /tmp/merge-phase-f-hooks.mjs

Cleanup commands updated to remove the hook file and a note about reverting
the settings.json merge.

EOF
)"
```

---

### Task 5: User-driven smoke verification (USER)

**Why last:** The 7-test mjs suite proves the hook BEHAVES correctly when fed mock JSON. Claude Code's hook loader actually firing the hook at the right moment is something only a real session can validate.

**This task is user-driven.** Implementer marks the plan complete and hands these steps off.

- [ ] **Step 1: SessionEnd[clear] nudge fires once per session**

From any Claude Code session (after Task 4's settings merge landed):
1. Have a brief interaction (anything — say "hello" and let Claude reply once).
2. Run `/clear`.
3. The next message in the new (cleared) session should show the additionalContext nudge at the top: *"Session has accumulated panel decisions and deviations worth archiving. Run /prism-clean first..."* — OR, depending on Claude Code's UI, it may appear inline. Look for the text `Run /prism-clean first` somewhere on screen.

Expected: nudge visible.

- [ ] **Step 2: PRISM_DISABLE_CLEAR_NUDGE=1 suppresses the nudge**

In a new shell:

```powershell
$env:PRISM_DISABLE_CLEAR_NUDGE = "1"; claude
```

Repeat the /clear flow from Step 1. Expected: NO nudge appears.

- [ ] **Step 3: PreCompact nudge fires (harder to test — needs a long enough session to hit auto-compact)**

This is the impatient test. Options:
- Wait for the session to approach 95% context naturally (might take a long session).
- Or trust that the same hook fires on PreCompact since the 7-test suite already verifies the behavior matches the SessionEnd code path.

If you want to force the test: spam-generate context until the session approaches its compact threshold. The nudge should appear in the additionalContext attached to the post-compact session.

- [ ] **Step 4: PRISM_DISABLE_PRECOMPACT_NUDGE=1 off-switch**

Same env-var pattern as Step 2 but with `PRISM_DISABLE_PRECOMPACT_NUDGE`. Trigger a compact (or take it on faith).

- [ ] **Step 5: Report back to the controller session**

If all checks green:
1. Controller commits an empty milestone marker: `test(prism): Phase F clean-nudge hooks verified end-to-end`.
2. Controller marks Phase F complete in TaskUpdate.
3. Controller offers to start Phase H (knowledge evolution rhythms) or the statusline backlog item.

If any check fails: paste exactly what happened (no nudge, wrong text, exit error, hook didn't fire) so the controller can triage.

---

## Self-review (writing-plans checklist)

**1. Spec coverage:**

| D004 / handoff requirement | Plan task |
|---|---|
| Hook 1: `SessionEnd[matcher=clear]` emits additionalContext | Task 2 (hook), Task 3 (registration) |
| Hook 2: `PreCompact` emits additionalContext | Task 2 (hook), Task 3 (registration) |
| Both emit additionalContext ONLY (no exit 2 / no blocking) | Task 2 implementation always exits 0 |
| Off-able via `PRISM_DISABLE_CLEAR_NUDGE` / `PRISM_DISABLE_PRECOMPACT_NUDGE` | Task 2 implementation reads env vars; Task 1 tests cover both off-switches |
| Combined into single hook script | Task 2 creates ONE file; Task 3 registers it twice (one per event) |
| ~100 ms cold-start target | Reused `prism-exec.{sh,cmd}` wrappers, hook body is ~30 lines synchronous — well under budget; not separately tested but the architecture choice supports it |
| v4.0 ship gate: SessionEnd[clear] nudge fires once per session; off-switch works | Task 5 Step 1 + Step 2 (user-driven) |
| v4.0 ship gate: PreCompact nudge fires once per session; off-switch works | Task 5 Step 3 + Step 4 (user-driven) |

All 8 requirements covered. ✓

**2. Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", every code block / command has exact contents. ✓

**3. Type consistency:** `hookSpecificOutput.hookEventName` + `additionalContext` shape is consistent between the hook implementation (Task 2), the test assertions (Task 1), and the existing pattern at `hooks/prism-memory-save-nudge.mjs:97-103`. Off-switch env-var names are consistent across plan / hook / tests / docs. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/prism/plans/2026-05-25-phase-f-clean-nudge-hooks.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task. Tasks 1-3 are independent enough that the two-stage review catches issues without context bleeding between tasks. Task 4 + 5 are controller-inline / user-driven.

**2. Inline Execution** — I run Tasks 1-4 directly in this session using executing-plans, with a checkpoint after Task 2 (the load-bearing hook implementation). Task 5 is always user-driven.

**Which approach?**
