# Phase E — master-orchestrator → skill migration Implementation Plan (v4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the master-orchestrator operating protocol out of the agent file body and into a new `~/.claude/skills/master-orchestrator/SKILL.md` skill, leaving the agent file as a thin "Load skill: master-orchestrator" wrapper. Then flip the Phase D `/prism-deep-dive` helper default from `--orchestrator-protocol inline` to `--orchestrator-protocol skill-ref` so newly-generated `master-<slug>` agents pick up the skill automatically.

**Architecture:** The protocol body (PHASE 0a inventory, PHASE 0d adversarial review, PHASE 1.5 senior review, STARTUP, EXECUTION, COMPLETION sections — currently lines 14-652 of `agents/master-orchestrator.md`) becomes a Claude Code Skill that any agent can load via `skills: [master-orchestrator]` frontmatter. The agent file itself shrinks from ~650 lines to ~20 lines (frontmatter + one-line body) but remains a valid Agent so `@master-orchestrator` mentions still work. A CI drift-guard test asserts the body never grows back, per D004 risk-register #6.

**Tech Stack:** Node 18+ ES modules, no new deps. Skills are Markdown files with YAML frontmatter (same shape as `skills/prism-discover/SKILL.md`). Tests use `spawnSync` against `mkdtemp` testbeds, matching the existing `tests/v3/state/test-prism-*.mjs` patterns. No package.json; runner is `bash tests/v3/run-static.sh` or `node tests/v3/state/test-<name>.mjs`.

**Locked design references:**
- `docs/prism/adjudications/D004-v4-product-vision.md` §3 ("master-orchestrator → skill (with thin agent wrapper for backward compat)"), risk-register #6 ("master-orchestrator skill vs agent file divergence → Agent file body = `Load skill: master-orchestrator` one-liner only; CI assert keeps them in sync"), Phase E row of the v4.0 phase plan table.
- `tools/prism-deep-dive.mjs` lines 152-178 — already has both `ORCH_PROTOCOL_INLINE` and `ORCH_PROTOCOL_SKILL_REF` templates; line 342 (`const protocol = named.protocol || 'inline';`) is the default-flip point.
- `tests/v3/state/test-prism-deep-dive.mjs` lines 165-182 — already tests both protocol modes explicitly via `--orchestrator-protocol` flag; we add a new test for the no-flag (default) case.
- `docs/prism/lessons/2026-05-25-v4.0-phase-d-handoff.md` Phase E section — the canonical task list for this phase.
- `docs/prism/lessons/2026-05-25-dev-install-inventory.md` — re-sync cp commands for propagating dev-branch changes to `~/.claude/`.

**Out of scope (deferred):**
- Phase F: two nudge hooks (SessionEnd[clear] + PreCompact). Separate plan.
- Phase H: knowledge evolution rhythms (per-decision MEMORY.md pointer append). Separate plan.
- Existing pre-Phase-E `master-<slug>` agents in projects that already ran `/prism-deep-dive` (only `competition_agents/.claude/agents/master-competition-agents.md` exists; that one is the testbed and can be regenerated). No migration script needed in v4.0.

**File structure:**

| File | Action | Responsibility |
|---|---|---|
| `skills/master-orchestrator/SKILL.md` | **CREATE** | Holds the protocol body. Frontmatter `name: master-orchestrator` + `description:` + body = lines 14-652 of current `agents/master-orchestrator.md` verbatim. |
| `agents/master-orchestrator.md` | **MODIFY** | Body shrinks from ~650 lines to one line (`Load skill: master-orchestrator`). Frontmatter (name, description, tools, model, maxTurns, memory) UNCHANGED so `@master-orchestrator` still resolves as an Agent. |
| `tests/v3/state/test-master-orchestrator-thin-wrapper.mjs` | **CREATE** | Reads `agents/master-orchestrator.md`, parses frontmatter / body boundary, asserts body equals the canonical thin-wrapper string. Failure = drift detected. |
| `tools/prism-deep-dive.mjs` | **MODIFY** | Line 342: `const protocol = named.protocol || 'inline';` → `'skill-ref'`. Plus 5-line comment update at lines 153-157 to reflect post-Phase-E state. |
| `tests/v3/state/test-prism-deep-dive.mjs` | **MODIFY** | Add one new test: `agent-write` with NO `--orchestrator-protocol` flag produces skill-ref body (locks the new default). |

---

### Task 1: Write the failing CI drift-guard test (TDD red phase)

**Why first:** TDD discipline. The test defines the post-migration target shape; the migration commits in Task 2 + 3 make it pass.

**Files:**
- Create: `tests/v3/state/test-master-orchestrator-thin-wrapper.mjs`

- [ ] **Step 1: Write the failing test file**

Create `tests/v3/state/test-master-orchestrator-thin-wrapper.mjs` with this exact content:

```javascript
#!/usr/bin/env node
// CI drift-guard for D004 risk-register #6:
//   "master-orchestrator skill vs agent file divergence
//    → Agent file body = `Load skill: master-orchestrator` one-liner only;
//      CI assert keeps them in sync"
//
// Reads agents/master-orchestrator.md, parses the YAML frontmatter / body
// boundary, asserts the body matches the canonical thin-wrapper string.
// Failure = someone re-inlined protocol content into the agent body.
//
// Run: node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = join(__dirname, '..', '..', '..', 'agents', 'master-orchestrator.md');

const CANONICAL_BODY = `Load skill: master-orchestrator
`;

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`expected:\n${JSON.stringify(b)}\ngot:\n${JSON.stringify(a)}${msg ? '\n— ' + msg : ''}`);
}

function parseBody(raw) {
  // Frontmatter is delimited by --- on its own line.
  const lines = raw.split('\n');
  assert(lines[0] === '---', 'agent file must start with --- frontmatter delimiter');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  assert(endIdx > 0, 'agent file must have closing --- frontmatter delimiter');
  // Body starts after the closing --- and a single blank line.
  const bodyLines = lines.slice(endIdx + 1);
  // Drop leading blank lines so the comparison is robust to one or two newlines.
  while (bodyLines.length && bodyLines[0] === '') bodyLines.shift();
  return bodyLines.join('\n');
}

test('agent file body is the canonical thin wrapper (no inlined protocol)', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  const body = parseBody(raw);
  assertEq(body, CANONICAL_BODY, 'agent body must be exactly "Load skill: master-orchestrator\\n" — see D004 §3 + risk-register #6');
});

test('agent file frontmatter preserves @-mention surface (name, description, tools)', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  assert(/^name:\s*master-orchestrator\s*$/m.test(raw), 'name: master-orchestrator required in frontmatter');
  assert(/^description:/m.test(raw), 'description: required so @master-orchestrator surfaces in completion');
  assert(/^tools:/m.test(raw), 'tools: list required so the agent is dispatchable');
});

test('no protocol-body leakage: STARTUP / PHASE 0 / PHASE 1 sections must NOT appear in agent file', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  assert(!/^## STARTUP\b/m.test(raw), 'STARTUP section leaked back into agent file');
  assert(!/^## PHASE 0\b/m.test(raw), 'PHASE 0 leaked back into agent file');
  assert(!/^## PHASE 1\b/m.test(raw), 'PHASE 1 leaked back into agent file');
  assert(!/^## PHASE 1\.5\b/m.test(raw), 'PHASE 1.5 leaked back into agent file');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails (RED phase)**

Run:

```bash
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
```

Expected: FAIL on the first test ("agent file body is the canonical thin wrapper") because the current body is the full 600+ line protocol. Other two tests may pass or fail depending on frontmatter / section markers.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
git commit -m "$(cat <<'EOF'
test(prism): add CI drift-guard for master-orchestrator thin wrapper (Phase E TDD red)

Asserts agents/master-orchestrator.md body is the canonical
"Load skill: master-orchestrator\n" string per D004 §3 + risk-register #6.
Test currently FAILS (body is still 600+ lines of inlined protocol);
Task 2 + 3 of Phase E make it pass by migrating the body to a skill.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Create `skills/master-orchestrator/SKILL.md` (the migration target)

**Why second:** The skill must exist before we strip the body from the agent — otherwise `@master-orchestrator` resolves to a wrapper pointing at a non-existent skill.

**Files:**
- Create: `skills/master-orchestrator/SKILL.md`

- [ ] **Step 1: Read the source body**

Read `agents/master-orchestrator.md` and capture lines 14 through end of file (inclusive). Line 13 is the blank line after the closing `---` of the frontmatter; lines 14+ are the protocol body starting with `You are the Master Orchestrator of the PRISM system.`

```bash
# Sanity check the line numbers before extracting:
wc -l agents/master-orchestrator.md   # expect ~652
sed -n '13,15p' agents/master-orchestrator.md   # expect blank, then "You are..."
```

- [ ] **Step 2: Write the new SKILL.md**

Create `skills/master-orchestrator/SKILL.md` with this structure:

```markdown
---
name: master-orchestrator
description: >
  PRISM orchestration protocol. Tier-routed dispatch, adversarial review (≥2
  substantive challenges before synthesis), Phase 1.5 senior review on
  high-stakes work. Loaded by `master-<slug>` project agents via
  `skills: [master-orchestrator]` frontmatter, and by the standalone
  `@master-orchestrator` agent (thin wrapper).
---

# Master Orchestrator — operating protocol

<verbatim copy of lines 14-652 of agents/master-orchestrator.md goes here>
```

Concretely:

```bash
# Extract the body (lines 14+) and prepend the new skill frontmatter.
mkdir -p skills/master-orchestrator
{
  cat <<'EOF'
---
name: master-orchestrator
description: >
  PRISM orchestration protocol. Tier-routed dispatch, adversarial review (≥2
  substantive challenges before synthesis), Phase 1.5 senior review on
  high-stakes work. Loaded by `master-<slug>` project agents via
  `skills: [master-orchestrator]` frontmatter, and by the standalone
  `@master-orchestrator` agent (thin wrapper).
---

# Master Orchestrator — operating protocol

EOF
  tail -n +14 agents/master-orchestrator.md
} > skills/master-orchestrator/SKILL.md
```

- [ ] **Step 3: Verify SKILL.md shape**

```bash
head -15 skills/master-orchestrator/SKILL.md   # expect frontmatter + body start
grep -c "Five unbreakable rules" skills/master-orchestrator/SKILL.md   # expect 1
grep -c "PHASE 1.5: SENIOR REVIEW" skills/master-orchestrator/SKILL.md   # expect 1
wc -l skills/master-orchestrator/SKILL.md   # expect ~650 (frontmatter ~10 lines + body ~640 lines)
```

If any check fails, do NOT proceed — the migration is incomplete.

- [ ] **Step 4: Commit the skill**

```bash
git add skills/master-orchestrator/SKILL.md
git commit -m "$(cat <<'EOF'
feat(prism): create master-orchestrator skill (Phase E migration target)

Verbatim copy of the operating protocol from agents/master-orchestrator.md
body (lines 14-end) into a new skill at skills/master-orchestrator/SKILL.md.
This is the migration TARGET — Task 3 strips the body from the agent file
and points it at this skill via the thin "Load skill: master-orchestrator"
wrapper.

D004 §3 lock: "single source of truth for orchestration protocol;
per-project memory stays per-project."

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite `agents/master-orchestrator.md` body as thin wrapper (TDD green phase)

**Why now:** Skill exists, drift-guard test is failing. This step makes the test pass.

**Files:**
- Modify: `agents/master-orchestrator.md` (replace body, keep frontmatter)

- [ ] **Step 1: Capture current frontmatter**

```bash
# Lines 1-12 are the frontmatter block in the current file. Verify the
# closing --- is at line 12 before continuing.
sed -n '12p' agents/master-orchestrator.md   # expect "---"
sed -n '13p' agents/master-orchestrator.md   # expect blank line
```

- [ ] **Step 2: Rewrite the file**

Replace the entire file with: frontmatter (lines 1-12) + blank line + body (`Load skill: master-orchestrator\n`):

```bash
{
  head -n 12 agents/master-orchestrator.md
  echo ""
  echo "Load skill: master-orchestrator"
} > agents/master-orchestrator.md.tmp
mv agents/master-orchestrator.md.tmp agents/master-orchestrator.md
```

Resulting file should be exactly 14 lines: 12 frontmatter + 1 blank + 1 body line.

- [ ] **Step 3: Run the drift-guard test (GREEN phase)**

```bash
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
```

Expected: ALL 3 tests pass (`3 passed, 0 failed`).

If any fail: do NOT proceed. The most likely cause is a stray trailing newline or extra blank line. Verify the file is exactly 14 lines:

```bash
wc -l agents/master-orchestrator.md   # expect 14
cat -A agents/master-orchestrator.md   # inspect line-endings; should be \n only, no \r
```

- [ ] **Step 4: Run the FULL existing test suite to confirm zero regressions**

```bash
node tests/v3/state/test-prism-state.mjs
node tests/v3/state/test-prism-bootstrap.mjs
node tests/v3/state/test-prism-deep-dive.mjs
node tests/v3/state/test-prism-sync.mjs
node tests/v3/state/test-prism-clean.mjs
node tests/v3/state/test-prism-validate-plugins.mjs
node tests/v3/hooks/test-agent-write-register.mjs
```

Expected: all suites green; the 132/132 baseline from Phase D plus 3 new from Task 1's drift-guard = 135/135.

- [ ] **Step 5: Commit**

```bash
git add agents/master-orchestrator.md
git commit -m "$(cat <<'EOF'
feat(prism): master-orchestrator body → thin skill wrapper (Phase E TDD green)

Replaces the 640-line operating-protocol body in agents/master-orchestrator.md
with the canonical one-liner "Load skill: master-orchestrator". Frontmatter
(name, description, tools, model, maxTurns, memory) UNCHANGED so
@master-orchestrator mentions continue to resolve as a valid Agent.

Drift-guard test from Task 1 now passes (3/3). All 132 prior tests still
green. Total: 135/135 across 8 suites.

D004 §3 lock implemented in full. Phase D agents that picked up the
inline-fallback body (master-competition-agents.md on testbed) will be
regenerated on next /prism-deep-dive run with the default flip in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Flip `/prism-deep-dive` default `inline` → `skill-ref` (with TDD coverage)

**Why now:** The skill now exists at `~/.claude/skills/master-orchestrator/` (after Task 5's re-sync), so it is safe to make `skill-ref` the default for newly-generated `master-<slug>` agents. The two explicit-mode tests at `test-prism-deep-dive.mjs:165-182` already cover both modes; we add ONE new test for the no-flag (default) case to lock the new default.

**Files:**
- Modify: `tests/v3/state/test-prism-deep-dive.mjs` (add 1 new test for default)
- Modify: `tools/prism-deep-dive.mjs` (line 342 + comment block at 153-157)

- [ ] **Step 1: Write the failing test for the new default**

Open `tests/v3/state/test-prism-deep-dive.mjs`. Find the test at line 175 ("agent-write --orchestrator-protocol skill-ref"). Insert a new test immediately AFTER it:

```javascript
test('agent-write default (no --orchestrator-protocol flag): skill-ref body (Phase E)', () => {
  const root = makeTestbed('agentwrite-default');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/Load skill: master-orchestrator/.test(body), 'default body must be skill-ref shape (Phase E flip)');
    assert(!/Five unbreakable rules/.test(body), 'default must NOT inline the protocol (Phase E flip)');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
```

- [ ] **Step 2: Run the new test — verify it FAILS**

```bash
node tests/v3/state/test-prism-deep-dive.mjs 2>&1 | grep -E "FAIL|default \(no"
```

Expected: `FAIL agent-write default (no --orchestrator-protocol flag): skill-ref body (Phase E)` — because the current default in `tools/prism-deep-dive.mjs:342` is still `'inline'`.

- [ ] **Step 3: Flip the default in the helper**

Open `tools/prism-deep-dive.mjs`. At **line 342**, change:

```javascript
      const protocol = named.protocol || 'inline';
```

to:

```javascript
      const protocol = named.protocol || 'skill-ref';
```

- [ ] **Step 4: Update the explanatory comment block above the templates**

Open `tools/prism-deep-dive.mjs`. The comment block at **lines 153-157** currently says:

```javascript
// D004 §3: Phase E will migrate the orchestrator body to a skill. Until then,
// agent-write defaults to --orchestrator-protocol=inline so the agent works
// standalone. Phase E will flip projects to --orchestrator-protocol=skill-ref
// once the skill exists at ~/.claude/skills/master-orchestrator/SKILL.md.
```

Replace with:

```javascript
// D004 §3: Phase E (completed) migrated the orchestrator body to a skill at
// ~/.claude/skills/master-orchestrator/SKILL.md. agent-write defaults to
// --orchestrator-protocol=skill-ref so generated master-<slug> agents pick up
// the skill automatically. The --orchestrator-protocol=inline mode remains
// available for environments where the skill isn't installed (e.g., dev
// branches before re-sync); it emits the 5-rule fallback body verbatim.
```

- [ ] **Step 5: Run the new test — verify it PASSES**

```bash
node tests/v3/state/test-prism-deep-dive.mjs
```

Expected: all tests pass (`<N> passed, 0 failed`), including the new default test. The existing explicit `--orchestrator-protocol inline` and `--orchestrator-protocol skill-ref` tests both still pass because they pass the flag explicitly.

- [ ] **Step 6: Run the full suite one more time to confirm zero regressions**

```bash
node tests/v3/state/test-prism-state.mjs
node tests/v3/state/test-prism-bootstrap.mjs
node tests/v3/state/test-prism-deep-dive.mjs
node tests/v3/state/test-prism-sync.mjs
node tests/v3/state/test-prism-clean.mjs
node tests/v3/state/test-prism-validate-plugins.mjs
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
node tests/v3/hooks/test-agent-write-register.mjs
```

Expected: all 8 suites green, 136/136 (or whatever the precise count lands at — should be 132 baseline + 3 drift-guard + 1 default = 136).

- [ ] **Step 7: Commit**

```bash
git add tools/prism-deep-dive.mjs tests/v3/state/test-prism-deep-dive.mjs
git commit -m "$(cat <<'EOF'
feat(prism): flip /prism-deep-dive default to --orchestrator-protocol=skill-ref (Phase E)

One-line default change in tools/prism-deep-dive.mjs:342 from 'inline' to
'skill-ref'. Newly-generated master-<slug> agents now point at the
master-orchestrator skill instead of inlining the 5-rule fallback body.

Comment block at lines 153-157 updated to reflect post-Phase-E reality
(skill exists at ~/.claude/skills/master-orchestrator/SKILL.md).

New test locks the default behavior so a future regression can't silently
revert. The existing explicit-mode tests for --orchestrator-protocol=inline
and --orchestrator-protocol=skill-ref continue to pass unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Re-sync dev install to `~/.claude/` (propagate Phase E to user-level)

**Why now:** The branch `claude/prism-v3-phase-1-0eVY1` is local-only. The standard `scripts/install.ps1` clones from git origin, so the standard install does NOT pick up Phase E until the branch is pushed + released. Until then, hand-sync per `docs/prism/lessons/2026-05-25-dev-install-inventory.md`.

**Files:** (copy operations; nothing in-repo changes)
- Sync: `agents/master-orchestrator.md` → `~/.claude/agents/master-orchestrator.md`
- Sync: `skills/master-orchestrator/` → `~/.claude/skills/master-orchestrator/`

- [ ] **Step 1: Copy the updated agent file**

```bash
cp Y:/Documents/utilities_projects/prism_3/agents/master-orchestrator.md "$HOME/.claude/agents/master-orchestrator.md"
```

- [ ] **Step 2: Copy the new skill**

```bash
mkdir -p "$HOME/.claude/skills/master-orchestrator"
cp Y:/Documents/utilities_projects/prism_3/skills/master-orchestrator/SKILL.md "$HOME/.claude/skills/master-orchestrator/SKILL.md"
```

- [ ] **Step 3: Verify the user-level state**

```bash
wc -l "$HOME/.claude/agents/master-orchestrator.md"   # expect 14
wc -l "$HOME/.claude/skills/master-orchestrator/SKILL.md"   # expect ~650
grep -c "Five unbreakable rules" "$HOME/.claude/skills/master-orchestrator/SKILL.md"   # expect 1
grep -c "Load skill: master-orchestrator" "$HOME/.claude/agents/master-orchestrator.md"   # expect 1
```

- [ ] **Step 4: Update the dev-install inventory doc**

Open `docs/prism/lessons/2026-05-25-dev-install-inventory.md`. Under the "Files copied" table, add a row:

```markdown
| `skills/master-orchestrator/SKILL.md` (Phase E) | `skills/master-orchestrator/SKILL.md` |
```

Under the "Cleanup commands" PowerShell block, add:

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.claude\skills\master-orchestrator
```

- [ ] **Step 5: Commit the inventory update**

```bash
git add docs/prism/lessons/2026-05-25-dev-install-inventory.md
git commit -m "$(cat <<'EOF'
docs(prism): update dev-install inventory for Phase E skill (master-orchestrator)

Adds the new skills/master-orchestrator/ subtree to the dev-install
sync list and cleanup commands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Manual @master-orchestrator dog-food verification (USER-DRIVEN)

**Why last:** Claude Code's skill loader is the only authoritative validator that `skills: [master-orchestrator]` actually resolves and the protocol body becomes available to the agent. The 8-suite test pass proves the file shapes; only a real session proves the load path.

**This task is user-driven.** Implementer marks the plan complete and hands off these steps to the user.

- [ ] **Step 1: Restart Claude Code (or open a fresh session outside `prism_3`)**

From a project that does NOT have a `master-<slug>` configured (e.g., a brand-new scratch directory), open a Claude Code session.

- [ ] **Step 2: Mention `@master-orchestrator` in the session**

Type:

```
@master-orchestrator I need a quick architecture review of a microservice design — give me your operating posture.
```

- [ ] **Step 3: Verify the expected behavior**

The session should:
1. Resolve `@master-orchestrator` to a valid Agent (not "unknown agent").
2. Announce or behave consistently with the master-orchestrator protocol — specifically the 5 unbreakable rules (NEVER execute without user approval / ALWAYS present options / ALWAYS enforce checkpoints / ALWAYS chair adversarial review / ALWAYS run PHASE 1.5 senior review).
3. Reference loading the master-orchestrator skill (either explicitly in its first turn, or via behaviors clearly drawn from the skill body — e.g., asking about stakes classification, proposing options with pros/cons before any execution).

If any of these fail, the most likely cause is the skill not being discovered. Check:

```bash
ls "$HOME/.claude/skills/master-orchestrator/SKILL.md"
head -5 "$HOME/.claude/agents/master-orchestrator.md"
```

- [ ] **Step 4: Verify in a project-master context too**

In a project that has a `master-<slug>` agent generated by `/prism-deep-dive` with `--orchestrator-protocol skill-ref` (or post-flip default — re-run `/prism-deep-dive --refresh` on `competition_agents/` if you want to test the new default), confirm that the project-master agent loads the master-orchestrator skill via its `skills: [master-orchestrator]` frontmatter.

- [ ] **Step 5: Report green back to the controller session**

If all checks pass, the controller (this Claude session) will:

1. Commit an empty milestone marker: `test(prism): Phase E master-orchestrator → skill migration verified end-to-end`.
2. Mark Phase E plan complete.
3. Offer to start Phase F (two nudge hooks) — separate plan via writing-plans.

If any check fails, report exactly what went wrong (output, error, missing file) so the controller can triage before declaring Phase E done.

---

## Self-review (writing-plans checklist)

**1. Spec coverage:**

| D004 / handoff requirement | Plan task |
|---|---|
| Create `~/.claude/skills/master-orchestrator/SKILL.md` (move body from agent) | Task 2 (repo) + Task 5 (sync to ~/.claude/) |
| Rewrite agent body as `Load skill: master-orchestrator` thin wrapper | Task 3 |
| Verify `@master-orchestrator` mentions still work | Task 6 (user verification) |
| Flip Phase D helper default `inline` → `skill-ref` | Task 4 |
| CI assert preventing agent-body drift | Task 1 (failing) + Task 3 (passing) |

All 5 handoff items have an assigned task. ✓

**2. Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", every code/command step has exact contents. ✓

**3. Type consistency:** `skills: [master-orchestrator]` frontmatter syntax matches Phase D's `tools/prism-deep-dive.mjs` rendering at line 192. The skill name `master-orchestrator` is consistent across the new SKILL.md frontmatter (Task 2), the canonical body string in the drift-guard test (Task 1), the agent file wrapper (Task 3), the helper default comment (Task 4), and the user-verification mention (Task 6). ✓

---

## Execution Handoff

**Plan complete and saved to `docs/prism/plans/2026-05-25-phase-e-master-orchestrator-skill.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks. Fits this plan well because Tasks 1-4 are independent enough that even sequential dispatch keeps each subagent's scope tight. Task 5 + 6 are tiny / user-driven and don't need a subagent.

**2. Inline Execution** — I execute Tasks 1-5 in this session using `superpowers:executing-plans`, with a checkpoint after Task 3 (the load-bearing migration step) and another after Task 4 (the default flip). Task 6 is always user-driven.

**Which approach?**
