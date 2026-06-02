# Phase H — Knowledge evolution rhythms Implementation Plan (v4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three knowledge-evolution rhythms locked in [[D004-v4-product-vision]] §5 / §H so `master-<slug>` MEMORY.md stays current as panels conclude and sessions wind down, and users can re-synthesize their master agent on demand with a diff preview. Concretely: (1) per-decision pointer append after a D### file is written, (2) per-session lesson-pointer append driven by `/prism-clean`, (3) manual `agent-factory --upgrade master-<slug>` flow with diff-then-confirm UX.

**Architecture:** Two helper surfaces, three slash-command behaviors.

- `tools/prism-clean.mjs` gains two deterministic subcommands — `append-decision` and `append-lesson` — that mutate `<root>/.claude/agents/MEMORY.md` in place under named comment anchors that the deep-dive seed template (`tools/prism-deep-dive.mjs:255-291`) already inserts. Both trim each section to the last 10 pointer lines and mirror the 25 KB hard cap that `prism-deep-dive.mjs:298-300` already enforces at seed time. No new dependency, no new file format.
- `tools/prism-deep-dive.mjs` gains a third subcommand — `agent-diff` — that renders the agent body it WOULD write (same logic as the existing `agent-write` codepath) and prints a unified diff vs the on-disk file. No mutation. Exit code carries the diff/no-diff/missing-file signal so the slash-command wrapper can branch without re-parsing stdout.
- `commands/prism-clean.md` instruction body updated so the LLM-judged surface calls the new helpers immediately after writing a D### file or appending to `tasks/lessons-tactical.md`. `commands/prism-deep-dive.md` instruction body updated with a new `--upgrade <slug>` mode that calls `agent-diff`, presents the diff via AskUserQuestion, and on approval invokes `agent-write --slug <s> --force`.

The upgrade path intentionally re-uses the existing `agent-write --force` rather than introducing a new tool. D004 §5 specifies "manual only in v4.0" with diff preview — `agent-diff` provides the preview, the slash command provides the confirmation gate, `agent-write --force` provides the write. No new code paths, just a new orchestration.

**Tech Stack:** Node 18+ ES modules, no new deps. Same `spawnSync` + `mkdtemp` test patterns as the existing `tests/v3/state/test-prism-clean.mjs` and `test-prism-deep-dive.mjs` suites. Diff generation uses `git diff --no-index --no-color` so we don't add a diff library; git is already required (`.git/` guard in both helpers).

**Locked design references:**
- `docs/prism/adjudications/D004-v4-product-vision.md` §5 — knowledge evolution rhythms (per-decision pointer append, per-session pointer update, per-quarter manual re-synth with diff preview, 25 KB cap)
- `docs/prism/adjudications/D004-v4-product-vision.md` §H row of the v4.0 phase plan table — 0.5d budget, three deliverables enumerated
- `docs/prism/adjudications/D004-v4-product-vision.md` risk-register #2 — "MEMORY.md grows past 25 KB silently truncated → hard validator refuses to write >25 KB"
- `tools/prism-deep-dive.mjs:255-291` — `renderMemoryMd()` already inserts the section comment anchors this plan reads (`<!-- /prism-clean appends \`[[D###]]\` lines here per Phase H. -->` and the matching lesson anchor)
- `tools/prism-deep-dive.mjs:298-300` — existing 25 KB cap enforcement, mirror exactly so seed-time and append-time refuse at the same threshold
- `tools/prism-clean.mjs:70-83` — existing `nextDNumber` pattern (subcommand shape, `--root` guard, exit codes) — match for new subcommands
- `tests/v3/state/test-prism-clean.mjs` — existing test scaffolding (`makeTestbed`, `run`, `assert`, `assertEq`) — re-use verbatim

**Out of scope (deferred):**
- Per-quarter auto re-synth of MEMORY.md (D004 §5 explicitly defers to v4.1 with telemetry). v4.0 ships the `--upgrade` flow as user-initiated only.
- Hook-driven auto-invocation of `append-decision` / `append-lesson` (Phase F-style — and v4.1 reopens that surface per [[D005-phase-f-hook-api-incompatibility]] anyway). v4.0 calls the helpers explicitly from `commands/prism-clean.md`.
- Cross-project pointer sync. Each project's MEMORY.md is self-contained per D004 §5.
- Phase J (tightened evidence rules) and Phase K (release prep) — separate plans.

**File structure:**

| File | Action | Responsibility |
|---|---|---|
| `tools/prism-clean.mjs` | **MODIFY** | Add `append-decision --slug <s> --d-number <NNN> --title <t>` and `append-lesson --slug <s> --date <YYYY-MM-DD> --title <t>` subcommands. Each mutates `<root>/.claude/agents/MEMORY.md` under the matching anchor, trims to last 10 pointers, refuses on missing file / malformed section / >25 KB. |
| `tests/v3/state/test-prism-clean.mjs` | **MODIFY** | Add 8 new tests covering happy path × 2, 10-trim × 2, 25 KB refusal × 2, missing-MEMORY refusal × 2 for the two new subcommands. |
| `commands/prism-clean.md` | **MODIFY** | Instruction update: after writing a D### file, invoke `node tools/prism-clean.mjs append-decision`. After appending to `tasks/lessons-tactical.md`, invoke `append-lesson`. |
| `tools/prism-deep-dive.mjs` | **MODIFY** | Add `agent-diff --slug <s> [--orchestrator-protocol <inline\|skill-ref>]` subcommand. Renders new body, reads on-disk body, prints unified diff. Exit 0 = no diff, 1 = diff present, 6 = missing file. |
| `tests/v3/state/test-prism-deep-dive.mjs` | **MODIFY** | Add 3 new tests: agent-diff with no changes (exit 0), agent-diff with protocol-mode change (exit 1, diff content shape), agent-diff with no on-disk file (exit 6). |
| `commands/prism-deep-dive.md` | **MODIFY** | Add `--upgrade <slug>` mode: call `agent-diff`, branch on exit code, present diff via AskUserQuestion, on approval call `agent-write --slug <s> --force`, report path written. |
| `docs/prism/lessons/2026-05-25-dev-install-inventory.md` | **MODIFY** | One-line note clarifying that existing `tools/*.mjs (21 files)` and `commands/prism-*.md (20 files)` inventory rows already cover Phase H updates — no new entries, but a re-sync IS required for the changed files to land in `~/.claude/`. |

---

### Task 1: Write failing tests for `append-decision` + `append-lesson` (TDD red)

**Why first:** TDD discipline. The tests pin down the exact subcommand surface (args, exit codes, file mutations, trim behavior, cap enforcement) before any helper code is written.

**Files:**
- Modify: `tests/v3/state/test-prism-clean.mjs`

- [ ] **Step 1: Read the current test file to locate the insertion point**

```bash
wc -l tests/v3/state/test-prism-clean.mjs
grep -n "^test(" tests/v3/state/test-prism-clean.mjs | tail -5
```

The new tests go at the end of the test block, immediately before the final `process.stdout.write(\`\n${pass} passed, ${fail} failed\n\`);` summary line.

- [ ] **Step 2: Add a MEMORY.md scaffold helper near the top of the test file**

Find the existing `makeTestbed` function. Immediately after it, add:

```javascript
function seedMemoryMd(root, slug) {
  // Mirror the exact shape that tools/prism-deep-dive.mjs renderMemoryMd writes,
  // including the two Phase-H anchor comments that the new subcommands key on.
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, {recursive: true});
  const body = [
    `# MEMORY.md — master-${slug} router`,
    '',
    '## Project profile',
    '',
    '- **Stack**: test',
    '- **Datasources**: ',
    '- **Active workstreams**:',
    '  - (none captured yet)',
    '',
    '## Recent decisions (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->',
    '',
    '## Recent lessons (last 10, pointer-only)',
    '',
    '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->',
    '',
    '## Active specialists',
    '',
    '- (none hired yet)',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8');
  return join(dir, 'MEMORY.md');
}

function readMemoryMd(root) {
  return readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
}
```

- [ ] **Step 3: Add the 8 new tests at the end of the file (before the summary line)**

```javascript
// ─────────────────────────────────────────────────────────────────────────
// Phase H — append-decision
// ─────────────────────────────────────────────────────────────────────────

test('append-decision: happy path appends pointer line under the D### anchor', () => {
  const root = makeTestbed('append-dec-happy');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '042', '--title', 'Test decision');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[\[D042\]\] Test decision/.test(body), 'pointer line missing');
    // Anchor comment must still be present
    assert(/<!-- \/prism-clean appends `\[\[D###\]\]`/.test(body), 'anchor stripped');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: trims to last 10 pointers (oldest dropped)', () => {
  const root = makeTestbed('append-dec-trim');
  try {
    seedMemoryMd(root, 'foo');
    // Append 12 pointers — first 2 should be trimmed
    for (let i = 1; i <= 12; i++) {
      const r = run(root, 'append-decision', '--slug', 'foo',
                    '--d-number', String(i).padStart(3, '0'),
                    '--title', `Decision ${i}`);
      assertEq(r.status, 0, r.stderr);
    }
    const body = readMemoryMd(root);
    // First two should be gone
    assert(!/\[\[D001\]\]/.test(body), 'D001 should have been trimmed');
    assert(!/\[\[D002\]\]/.test(body), 'D002 should have been trimmed');
    // Last ten should remain
    for (let i = 3; i <= 12; i++) {
      const tag = `[[D${String(i).padStart(3, '0')}]]`;
      assert(body.includes(tag), `${tag} should remain in last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: refuses when MEMORY.md does not exist', () => {
  const root = makeTestbed('append-dec-nomem');
  try {
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '001', '--title', 'x');
    assertEq(r.status, 6, 'expected exit 6 (missing MEMORY.md)');
    assert(/MEMORY\.md/.test(r.stderr), 'stderr should mention MEMORY.md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-decision: refuses when appending would exceed 25 KB cap', () => {
  const root = makeTestbed('append-dec-cap');
  try {
    seedMemoryMd(root, 'foo');
    // Pad MEMORY.md to just under 25 KB so the next append crosses
    const path = join(root, '.claude', 'agents', 'MEMORY.md');
    const body = readFileSync(path, 'utf8');
    const padding = '<!-- pad -->\n'.repeat(2000); // ~26 KB of padding
    writeFileSync(path, body + padding, 'utf8');
    const r = run(root, 'append-decision', '--slug', 'foo', '--d-number', '001', '--title', 'x');
    assertEq(r.status, 8, 'expected exit 8 (>25 KB cap)');
    assert(/25 ?KB|25600|cap/i.test(r.stderr), 'stderr should mention the cap');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// ─────────────────────────────────────────────────────────────────────────
// Phase H — append-lesson
// ─────────────────────────────────────────────────────────────────────────

test('append-lesson: happy path appends pointer line under the lessons anchor', () => {
  const root = makeTestbed('append-les-happy');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-lesson', '--slug', 'foo',
                  '--date', '2026-05-25', '--title', 'Test lesson');
    assertEq(r.status, 0, r.stderr);
    const body = readMemoryMd(root);
    assert(/- \[\[lessons-tactical#2026-05-25\]\] Test lesson/.test(body), 'pointer line missing');
    assert(/<!-- \/prism-clean appends `\[\[lessons-tactical/.test(body), 'anchor stripped');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: trims to last 10 pointers', () => {
  const root = makeTestbed('append-les-trim');
  try {
    seedMemoryMd(root, 'foo');
    for (let i = 1; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      const r = run(root, 'append-lesson', '--slug', 'foo', '--date', date, '--title', `Lesson ${i}`);
      assertEq(r.status, 0, r.stderr);
    }
    const body = readMemoryMd(root);
    assert(!/2026-05-01/.test(body), 'first lesson should have been trimmed');
    assert(!/2026-05-02/.test(body), 'second lesson should have been trimmed');
    for (let i = 3; i <= 12; i++) {
      const date = `2026-05-${String(i).padStart(2, '0')}`;
      assert(body.includes(date), `${date} should remain in last-10 window`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: refuses when MEMORY.md does not exist', () => {
  const root = makeTestbed('append-les-nomem');
  try {
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', '2026-05-25', '--title', 'x');
    assertEq(r.status, 6, 'expected exit 6');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('append-lesson: rejects malformed --date', () => {
  const root = makeTestbed('append-les-baddate');
  try {
    seedMemoryMd(root, 'foo');
    const r = run(root, 'append-lesson', '--slug', 'foo', '--date', 'not-a-date', '--title', 'x');
    assertEq(r.status, 5, 'expected exit 5 (bad arg)');
    assert(/date/i.test(r.stderr), 'stderr should mention date');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

- [ ] **Step 4: Run the suite — verify the new tests FAIL**

```bash
node tests/v3/state/test-prism-clean.mjs
```

Expected: all 8 new tests FAIL (because the subcommands don't exist yet — the helper will exit with `unknown command: append-decision` / `append-lesson`, which is `die(...)` → exit 1, not the specific codes the tests expect). The existing `next-d-number` + `git-stats` tests still pass.

- [ ] **Step 5: Commit the failing tests**

```bash
git add tests/v3/state/test-prism-clean.mjs
git commit -m "$(cat <<'EOF'
test(prism): add Phase H tests for append-decision + append-lesson (TDD red)

Adds 8 tests for the two new tools/prism-clean.mjs subcommands locked in
D004 §H — happy path, 10-trim, 25 KB refusal, missing-MEMORY refusal,
date validation. All currently FAIL; Task 2 implements the subcommands.

EOF
)"
```

---

### Task 2: Implement `append-decision` + `append-lesson` in `tools/prism-clean.mjs` (TDD green)

**Why now:** Tests are failing. This step makes them pass without touching anything else.

**Files:**
- Modify: `tools/prism-clean.mjs`

- [ ] **Step 1: Update the header comment block to document the new subcommands**

Open `tools/prism-clean.mjs`. The header comment block currently lists `next-d-number` and `git-stats`. Insert two new entries immediately after `git-stats`:

```javascript
//   append-decision --slug <s> --d-number <NNN> --title <text>
//       Append a "- [[D###]] <title>" line to the "Recent decisions" section
//       of <root>/.claude/agents/MEMORY.md. Trims to last 10 pointers.
//       Refuses on missing MEMORY.md (exit 6) or >25 KB cap (exit 8).
//
//   append-lesson --slug <s> --date <YYYY-MM-DD> --title <text>
//       Append a "- [[lessons-tactical#<date>]] <title>" line to the
//       "Recent lessons" section of <root>/.claude/agents/MEMORY.md.
//       Same trim + cap behavior as append-decision.
```

Also update the `usage()` function to list the new commands.

- [ ] **Step 2: Add the new arg parsing branches**

In the args loop (currently `--root`, `--no-git-guard`, `--since`), add three new branches:

```javascript
    else if (a === '--slug') named.slug = args[++i];
    else if (a === '--d-number') named.d_number = args[++i];
    else if (a === '--date') named.date = args[++i];
    else if (a === '--title') named.title = args[++i];
```

- [ ] **Step 3: Add the MEMORY.md cap constant and shared helpers**

Immediately above the `nextDNumber` function, add:

```javascript
const MEMORY_MD_HARD_CAP_BYTES = 25 * 1024;

const DECISION_ANCHOR = '<!-- /prism-clean appends `[[D###]]` lines here per Phase H. -->';
const LESSON_ANCHOR = '<!-- /prism-clean appends `[[lessons-tactical#date]]` lines here per Phase H. -->';
const POINTER_KEEP = 10;

function readMemoryMd(root) {
  const path = join(root, '.claude', 'agents', 'MEMORY.md');
  if (!existsSync(path)) {
    die(`refusing: MEMORY.md not found at ${path}. Run /prism-deep-dive first to seed it.`, 6);
  }
  return {path, body: readFileSync(path, 'utf8')};
}

function writeMemoryMdAtomic(path, body) {
  if (Buffer.byteLength(body, 'utf8') > MEMORY_MD_HARD_CAP_BYTES) {
    die(`refusing: MEMORY.md would be ${Buffer.byteLength(body, 'utf8')} bytes (> 25 KB cap). ` +
        `Run /prism-deep-dive --upgrade <slug> to re-synthesize the router.`, 8);
  }
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

function appendUnderAnchor({body, anchor, newLine, pointerRe}) {
  const lines = body.split('\n');
  const anchorIdx = lines.findIndex((l) => l.trim() === anchor.trim());
  if (anchorIdx < 0) {
    die(`refusing: MEMORY.md is missing the expected anchor comment:\n  ${anchor}\n` +
        `The file may have been hand-edited. Re-seed with /prism-deep-dive --upgrade.`, 7);
  }
  // Find the end of the section: the next "## " heading after the anchor.
  let endIdx = lines.length;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { endIdx = i; break; }
  }
  // Collect existing pointer lines within the section, append the new one, trim.
  const sectionBody = lines.slice(anchorIdx + 1, endIdx);
  const nonPointer = []; // blank lines and any other content directly under anchor
  const pointers = [];
  for (const l of sectionBody) {
    if (pointerRe.test(l)) pointers.push(l);
    else if (pointers.length === 0) nonPointer.push(l); // preserve leading blanks
    // Any non-pointer line AFTER pointers begin is dropped (trailing whitespace etc).
  }
  pointers.push(newLine);
  const kept = pointers.slice(-POINTER_KEEP);
  // Ensure exactly one blank line of trailing separation before the next "## "
  const rebuilt = [...nonPointer, ...kept, ''];
  const newLines = [
    ...lines.slice(0, anchorIdx + 1),
    ...rebuilt,
    ...lines.slice(endIdx),
  ];
  return newLines.join('\n');
}

function imports() { /* needed because we now use additional fs APIs */ }
```

Then update the top-level imports to include `readFileSync`, `writeFileSync`, `renameSync`:

```javascript
import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
```

- [ ] **Step 4: Add the two subcommand functions**

After `gitStats` / `parseShortstat`, add:

```javascript
function appendDecision({root, slug, dNumber, title}) {
  if (!slug) die('append-decision requires --slug <s>', 5);
  if (!/^\d{3,}$/.test(dNumber || '')) die('append-decision requires --d-number <NNN> (digits only)', 5);
  if (!title) die('append-decision requires --title <text>', 5);
  const {path, body} = readMemoryMd(root);
  const newLine = `- [[D${dNumber}]] ${title}`;
  const updated = appendUnderAnchor({
    body,
    anchor: DECISION_ANCHOR,
    newLine,
    pointerRe: /^- \[\[D\d{3,}\]\]/,
  });
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}

function appendLesson({root, slug, date, title}) {
  if (!slug) die('append-lesson requires --slug <s>', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    die('append-lesson requires --date <YYYY-MM-DD>', 5);
  }
  if (!title) die('append-lesson requires --title <text>', 5);
  const {path, body} = readMemoryMd(root);
  const newLine = `- [[lessons-tactical#${date}]] ${title}`;
  const updated = appendUnderAnchor({
    body,
    anchor: LESSON_ANCHOR,
    newLine,
    pointerRe: /^- \[\[lessons-tactical#\d{4}-\d{2}-\d{2}\]\]/,
  });
  writeMemoryMdAtomic(path, updated);
  return {path, bytes: Buffer.byteLength(updated, 'utf8')};
}
```

- [ ] **Step 5: Wire the new commands into the dispatch switch**

In the final `switch (cmd)` block, add two new cases between `git-stats` and `default`:

```javascript
    case 'append-decision': {
      const r = appendDecision({
        root: opts.root,
        slug: named.slug,
        dNumber: named.d_number,
        title: named.title,
      });
      stdout.write(JSON.stringify({appended: true, ...r}) + '\n');
      break;
    }
    case 'append-lesson': {
      const r = appendLesson({
        root: opts.root,
        slug: named.slug,
        date: named.date,
        title: named.title,
      });
      stdout.write(JSON.stringify({appended: true, ...r}) + '\n');
      break;
    }
```

- [ ] **Step 6: Run the test suite — verify all green**

```bash
node tests/v3/state/test-prism-clean.mjs
```

Expected: all tests pass (the 2 pre-existing + 8 new = 10+ depending on prior count). Zero failures.

- [ ] **Step 7: Run the FULL test suite to confirm zero regressions**

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

Expected: all 8 suites green. Total = Phase E baseline (136) + 8 new = 144.

- [ ] **Step 8: Commit**

```bash
git add tools/prism-clean.mjs
git commit -m "$(cat <<'EOF'
feat(prism): append-decision + append-lesson subcommands (Phase H TDD green)

Adds two new subcommands to tools/prism-clean.mjs that mutate
<root>/.claude/agents/MEMORY.md in place under named anchor comments
already inserted by tools/prism-deep-dive.mjs renderMemoryMd at seed
time. Both trim to last 10 pointers per section and refuse if the
write would exceed the 25 KB hard cap from D004 risk-register #2.

Implements two of the three deliverables for D004 §H. The third
(/prism-deep-dive --upgrade <slug> with diff preview) lands in Tasks
4-5 of the same plan.

EOF
)"
```

---

### Task 3: Update `commands/prism-clean.md` to call the new helpers

**Why now:** The deterministic surface exists and is tested. Wiring the LLM-judged surface to call it makes the per-decision and per-session rhythms automatic from the user's perspective.

**Files:**
- Modify: `commands/prism-clean.md`

- [ ] **Step 1: Read the current command file to locate the right insertion points**

```bash
wc -l commands/prism-clean.md
grep -n "^##\|adjudication\|lessons-tactical" commands/prism-clean.md
```

You're looking for two sections:
- Wherever the command instructs the LLM to **write a D### adjudication file** (probably after a panel-decision capture step)
- Wherever it instructs the LLM to **append to `tasks/lessons-tactical.md`** (per-session lesson capture step)

- [ ] **Step 2: After the D### write instruction, add the append-decision call**

Immediately after the bullet/paragraph that tells the LLM to write `docs/prism/adjudications/D###-<slug>.md`, add a new step:

```markdown
**After the D### file is written**, append a pointer line to the project-master MEMORY.md so the master agent's "Recent decisions" router reflects the new adjudication:

```bash
node tools/prism-clean.mjs append-decision \
  --slug "$(cat .claude/.prism-state.json | jq -r .project_slug)" \
  --d-number <NNN> \
  --title "<short title verbatim from the D### file heading>"
```

If the helper exits with code 6 (`MEMORY.md not found`), the project hasn't been through `/prism-deep-dive` yet — note this in the session summary and skip the pointer step. If exit 8 (`>25 KB cap`), suggest `/prism-deep-dive --upgrade <slug>` to re-synthesize the router. The helper succeeding means the master agent will surface the pointer on its next subagent dispatch.
```

- [ ] **Step 3: After the lesson append instruction, add the append-lesson call**

Immediately after the bullet/paragraph that tells the LLM to append to `tasks/lessons-tactical.md`, add:

```markdown
**After the lessons-tactical entry is appended**, mirror it to the project-master MEMORY.md:

```bash
node tools/prism-clean.mjs append-lesson \
  --slug "$(cat .claude/.prism-state.json | jq -r .project_slug)" \
  --date "$(date -u +%Y-%m-%d)" \
  --title "<one-line lesson title>"
```

Same exit-code handling as `append-decision` above.
```

- [ ] **Step 4: Manually verify the rendered command file reads coherently**

```bash
cat commands/prism-clean.md | less
```

Re-read the modified sections in context. The instructions should flow naturally — first the artifact write, then the pointer append, then the next step. If the file uses a single ordered list, the new steps should slot in as sub-bullets so numbering stays sane.

- [ ] **Step 5: Commit**

```bash
git add commands/prism-clean.md
git commit -m "$(cat <<'EOF'
docs(prism): wire /prism-clean to call append-decision + append-lesson (Phase H)

Per D004 §H rhythms: every D### file write now triggers a MEMORY.md
pointer append, every lessons-tactical entry triggers a lesson pointer
append. Exit-code handling for missing MEMORY.md (project not deep-dived)
and >25 KB cap (router needs re-synth) is documented inline.

EOF
)"
```

---

### Task 4: Add `agent-diff` subcommand to `tools/prism-deep-dive.mjs` (TDD red+green in one)

**Why now:** The pointer-append rhythm is in place; the third Phase H deliverable is the manual re-synth flow. `agent-diff` is the no-mutation primitive the slash command will wrap with confirmation UX in Task 5.

**Files:**
- Modify: `tools/prism-deep-dive.mjs`
- Modify: `tests/v3/state/test-prism-deep-dive.mjs`

- [ ] **Step 1: Write the failing tests first**

Open `tests/v3/state/test-prism-deep-dive.mjs`. Find the test block that ends with the Phase E default test (added in Phase E Task 4). Insert these three new tests immediately after:

```javascript
test('agent-diff: exit 0 when generated body equals on-disk body', () => {
  const root = makeTestbed('agent-diff-same');
  try {
    const writeR = run(root, 'agent-write', '--slug', 'foo');
    assertEq(writeR.status, 0, writeR.stderr);
    const diffR = run(root, 'agent-diff', '--slug', 'foo');
    assertEq(diffR.status, 0, `expected exit 0 (no diff); stderr=${diffR.stderr}`);
    assertEq(diffR.stdout, '', 'stdout should be empty on no-diff');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-diff: exit 1 with diff content when protocol mode differs', () => {
  const root = makeTestbed('agent-diff-changed');
  try {
    // Write inline-mode body, then ask for diff vs skill-ref mode
    const writeR = run(root, 'agent-write', '--slug', 'foo', '--orchestrator-protocol', 'inline');
    assertEq(writeR.status, 0, writeR.stderr);
    const diffR = run(root, 'agent-diff', '--slug', 'foo', '--orchestrator-protocol', 'skill-ref');
    assertEq(diffR.status, 1, `expected exit 1 (diff present); stderr=${diffR.stderr}`);
    assert(/Load skill: master-orchestrator/.test(diffR.stdout), 'diff should reference skill-ref body');
    assert(/Five unbreakable rules/.test(diffR.stdout), 'diff should reference inlined body being removed');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-diff: exit 6 when on-disk agent file does not exist', () => {
  const root = makeTestbed('agent-diff-nofile');
  try {
    const r = run(root, 'agent-diff', '--slug', 'ghost');
    assertEq(r.status, 6, `expected exit 6 (missing file); stderr=${r.stderr}`);
    assert(/master-ghost\.md/.test(r.stderr), 'stderr should name the missing file');
  } finally { rmSync(root, {recursive: true, force: true}); }
});
```

- [ ] **Step 2: Run the new tests — verify FAIL**

```bash
node tests/v3/state/test-prism-deep-dive.mjs 2>&1 | grep -E "FAIL|agent-diff"
```

Expected: 3 FAILs (`agent-diff` subcommand doesn't exist yet → `die(...)` exit 1, which won't match the specific codes expected).

- [ ] **Step 3: Add the `agent-diff` subcommand to the helper**

Open `tools/prism-deep-dive.mjs`. In the args parser, the existing `--orchestrator-protocol` parse is already in place. No new flag needed.

Find the existing `writeMasterAgent` function (it renders the agent body and writes to `<root>/.claude/agents/master-<slug>.md`). Immediately above or below it, add a sibling helper:

```javascript
function diffMasterAgent({root, slug, protocol}) {
  const agentPath = join(root, '.claude', 'agents', `master-${slug}.md`);
  if (!existsSync(agentPath)) {
    die(`refusing: agent file not found at ${agentPath}. ` +
        `Run /prism-deep-dive first (no --upgrade) to seed it.`, 6);
  }
  // Render what we WOULD write, into a temp path, then diff against on-disk.
  const newBody = renderMasterAgent({slug, protocol});
  // Write to a sibling .tmp file so git diff --no-index can compare.
  const tmpPath = agentPath + '.diff-preview';
  writeFileSync(tmpPath, newBody, 'utf8');
  try {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', agentPath, tmpPath], {
      encoding: 'utf8',
    });
    // git diff --no-index: exit 0 = no diff, exit 1 = diff present
    if (r.status === 0) {
      return {hasDiff: false, diff: ''};
    } else if (r.status === 1) {
      return {hasDiff: true, diff: r.stdout || ''};
    } else {
      die(`git diff --no-index failed (status ${r.status}): ${r.stderr || '(no stderr)'}`, 9);
    }
  } finally {
    try { rmSync(tmpPath, {force: true}); } catch {}
  }
}
```

Note: this requires `spawnSync` and `rmSync` from `node:child_process` / `node:fs`. Add them to the imports at the top of the file:

```javascript
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
```

If `renderMasterAgent` is currently a private helper inside `writeMasterAgent`, refactor: extract it into a standalone module-level function that both `writeMasterAgent` and `diffMasterAgent` call. This is the minimum DRY change needed.

- [ ] **Step 4: Wire the dispatch case**

In the `switch (cmd)` block, add a new case after `agent-write`:

```javascript
    case 'agent-diff': {
      if (!named.slug) die('agent-diff requires --slug <s>', 5);
      const protocol = named.protocol || 'skill-ref';
      if (!['inline', 'skill-ref'].includes(protocol)) {
        die(`--orchestrator-protocol must be inline or skill-ref, got ${protocol}`, 5);
      }
      const r = diffMasterAgent({root: opts.root, slug: named.slug, protocol});
      if (r.hasDiff) {
        stdout.write(r.diff);
        exit(1);
      }
      // No diff: exit 0, silent.
      break;
    }
```

Also update the `usage()` text:

```javascript
  agent-diff --slug <s> [--orchestrator-protocol <inline|skill-ref>]
```

- [ ] **Step 5: Run the new tests — verify all green**

```bash
node tests/v3/state/test-prism-deep-dive.mjs
```

Expected: all tests pass, including the 3 new agent-diff tests.

- [ ] **Step 6: Run the FULL suite — confirm zero regressions**

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

Expected: 144 + 3 = 147 / 147, all 8 suites green.

- [ ] **Step 7: Commit**

```bash
git add tools/prism-deep-dive.mjs tests/v3/state/test-prism-deep-dive.mjs
git commit -m "$(cat <<'EOF'
feat(prism): agent-diff subcommand for /prism-deep-dive --upgrade (Phase H)

Adds a no-mutation diff primitive: renders what agent-write WOULD write,
runs git diff --no-index against the on-disk file, returns the unified
diff on stdout with exit 1 (diff) / exit 0 (no diff) / exit 6 (missing
file). Re-uses the existing renderMasterAgent codepath that agent-write
already uses, refactored to a module-level helper so both callers share
the same body-generation logic verbatim.

This is the no-side-effects primitive that commands/prism-deep-dive.md
--upgrade <slug> mode wraps with AskUserQuestion confirmation in Task 5.

EOF
)"
```

---

### Task 5: Add `--upgrade <slug>` mode to `commands/prism-deep-dive.md`

**Why now:** The diff primitive exists. The slash command wraps it with the manual-approval gate D004 §5 requires.

**Files:**
- Modify: `commands/prism-deep-dive.md`

- [ ] **Step 1: Read the current command file to find the argument-handling section**

```bash
wc -l commands/prism-deep-dive.md
grep -n "^##\|--refresh\|--with-deep-dive" commands/prism-deep-dive.md
```

Locate the section that documents existing modes (the default flow, `--refresh` if present, anything else). Add `--upgrade <slug>` documentation alongside.

- [ ] **Step 2: Insert the `--upgrade <slug>` section**

Add a new `## Mode: --upgrade <slug>` section. Suggested body:

```markdown
## Mode: `--upgrade <slug>`

Re-synthesizes an existing project-master agent with a diff preview and explicit user approval before any write. This is the manual re-synth rhythm locked in D004 §5 ("per-quarter: manual only in v4.0").

### Workflow

1. **Verify the agent exists.** Read `.claude/agents/master-<slug>.md`. If missing, instruct the user: *"No master-<slug> agent found. Run `/prism-deep-dive` (no --upgrade) to create one first."*

2. **Generate the diff.** Run:

   ```bash
   node tools/prism-deep-dive.mjs agent-diff --slug <slug>
   ```

   Capture stdout (the unified diff) and the exit code.

3. **Branch on exit code:**
   - **Exit 0** (no diff): report *"`master-<slug>` is already up to date — no upgrade needed."* and stop.
   - **Exit 1** (diff present): proceed to step 4.
   - **Exit 6** (missing file): same as step 1 — instruct the user to run base `/prism-deep-dive` first.
   - **Any other exit**: surface the stderr and stop.

4. **Present the diff to the user via AskUserQuestion.** Use a single-question form:

   - **Question:** "Apply this upgrade to `master-<slug>`?"
   - **Header:** "Master upgrade"
   - **Options:**
     - *Apply (Recommended)* — "Write the new body to disk via `agent-write --force`."
     - *Skip* — "Discard the proposed changes; leave the existing agent file as-is."

   Include the diff inline in the question prose (use a code fence) so the user can read it before deciding.

5. **On Apply:**

   ```bash
   node tools/prism-deep-dive.mjs agent-write --slug <slug> --force
   ```

   Report the path written and remind the user that the upgrade takes effect on the next session that opens in this project (the agent is loaded at session start).

6. **On Skip:** acknowledge and stop. Do not write anything.

### When to use

- After a `/prism-deep-dive` helper change (e.g., a new section added to `renderMasterAgent`) that the user wants their existing project-masters to pick up.
- After the user manually hand-edits the seeded master and wants to know what the freshly-generated body would look like for reference.
- Per the v4.1 telemetry roadmap, this command will eventually be auto-invoked on a per-quarter schedule. For v4.0 it remains user-initiated only.
```

- [ ] **Step 3: Cross-link from the `--with-deep-dive` / default mode**

Find the section documenting the existing default and `--with-deep-dive` modes. Add a one-line cross-reference:

```markdown
> See `--upgrade <slug>` below for the manual re-synth flow that wraps `agent-diff` + `agent-write --force` with a confirmation gate.
```

- [ ] **Step 4: Manually re-read the command file end-to-end**

```bash
cat commands/prism-deep-dive.md | less
```

Verify the new section reads as a peer to existing modes and the cross-reference doesn't dangle.

- [ ] **Step 5: Commit**

```bash
git add commands/prism-deep-dive.md
git commit -m "$(cat <<'EOF'
docs(prism): /prism-deep-dive --upgrade <slug> mode with diff-then-confirm (Phase H)

Adds the manual re-synth flow locked in D004 §5. Wraps the agent-diff
helper from Task 4 with an AskUserQuestion confirmation gate; on Apply,
calls agent-write --force. On Skip, no mutation. Exit-code branching
covers missing-file and no-diff cases without surprise writes.

This is the third and final D004 §H deliverable. Per-quarter auto-rerun
stays deferred to v4.1 per D004 §5.

EOF
)"
```

---

### Task 6: Re-sync dev install + update inventory note

**Why now:** The branch is local-only, so user-level installs at `~/.claude/` don't pick up `tools/prism-clean.mjs` / `tools/prism-deep-dive.mjs` / `commands/prism-clean.md` / `commands/prism-deep-dive.md` changes until we hand-sync. The dev-install inventory already covers `tools/*.mjs (21 files)` and `commands/prism-*.md (20 files)` as bulk entries, so no new rows are needed — but a re-sync IS required.

**Files:**
- Sync: `tools/prism-clean.mjs` → `~/.claude/tools/prism-clean.mjs`
- Sync: `tools/prism-deep-dive.mjs` → `~/.claude/tools/prism-deep-dive.mjs`
- Sync: `commands/prism-clean.md` → `~/.claude/commands/prism-clean.md`
- Sync: `commands/prism-deep-dive.md` → `~/.claude/commands/prism-deep-dive.md`
- Modify: `docs/prism/lessons/2026-05-25-dev-install-inventory.md`

- [ ] **Step 1: Copy the four updated files to `~/.claude/`**

```bash
cp Y:/Documents/utilities_projects/prism_3/tools/prism-clean.mjs "$HOME/.claude/tools/prism-clean.mjs"
cp Y:/Documents/utilities_projects/prism_3/tools/prism-deep-dive.mjs "$HOME/.claude/tools/prism-deep-dive.mjs"
cp Y:/Documents/utilities_projects/prism_3/commands/prism-clean.md "$HOME/.claude/commands/prism-clean.md"
cp Y:/Documents/utilities_projects/prism_3/commands/prism-deep-dive.md "$HOME/.claude/commands/prism-deep-dive.md"
```

- [ ] **Step 2: Verify the sync**

```bash
node "$HOME/.claude/tools/prism-clean.mjs" --help 2>&1 | grep -E "append-decision|append-lesson"
node "$HOME/.claude/tools/prism-deep-dive.mjs" --help 2>&1 | grep "agent-diff"
grep -c "append-decision\|append-lesson" "$HOME/.claude/commands/prism-clean.md"
grep -c "upgrade" "$HOME/.claude/commands/prism-deep-dive.md"
```

All four greps should return non-zero / non-empty.

- [ ] **Step 3: Append a Phase H note to the dev-install inventory**

Open `docs/prism/lessons/2026-05-25-dev-install-inventory.md`. The existing table has bulk rows for `tools/*.mjs` and `commands/prism-*.md` that already cover the changed files. Add a single explanatory row at the bottom of the table:

```markdown
| `tools/prism-clean.mjs` + `tools/prism-deep-dive.mjs` + `commands/prism-clean.md` + `commands/prism-deep-dive.md` (Phase H append-decision / append-lesson / agent-diff / --upgrade) | (already covered by bulk rows above; re-sync required) | **Phase H** |
```

The cleanup PowerShell block needs no update — the same bulk-remove commands already wipe these files.

- [ ] **Step 4: Commit the inventory update**

```bash
git add docs/prism/lessons/2026-05-25-dev-install-inventory.md
git commit -m "$(cat <<'EOF'
docs(prism): note Phase H re-sync in dev-install inventory

Phase H modified files that the bulk inventory rows already cover, but
the dev-install needs an explicit re-sync to pick them up. Adds a single
row clarifying which files moved and that the cleanup commands are
unchanged.

EOF
)"
```

---

### Task 7: Manual dog-food verification (USER-DRIVEN)

**Why last:** Three end-to-end rhythms can only be fully validated by exercising the slash commands in a real Claude Code session. Helper-level tests cover the deterministic surfaces; only a real session covers the LLM-judged orchestration.

**This task is user-driven.** Implementer marks the plan complete and hands off these steps to the user.

- [ ] **Step 1: Test per-decision pointer append**

In a project that has a `master-<slug>` agent (e.g., the `competition_agents/` testbed if it still has the Phase D-generated master), simulate a panel decision:

1. Open a Claude Code session in the project.
2. Manually trigger `/prism-clean` (or follow the workflow that produces a D### file).
3. Pick a small synthetic decision to capture (e.g., "the testbed should use the same lint config as prism_3").
4. After the D### file lands at `docs/prism/adjudications/D###-<slug>.md`, check `.claude/agents/MEMORY.md`:

   ```bash
   grep -A 5 "Recent decisions" .claude/agents/MEMORY.md
   ```

   The new D### pointer line should appear under the anchor.

- [ ] **Step 2: Test per-session lesson append**

In the same session:

1. Pick a synthetic lesson to capture (e.g., "the deep-dive default flip simplified per-project setup").
2. Run `/prism-clean` and approve the lesson candidate when it surfaces.
3. After `tasks/lessons-tactical.md` is appended, check MEMORY.md:

   ```bash
   grep -A 5 "Recent lessons" .claude/agents/MEMORY.md
   ```

   The new `[[lessons-tactical#<date>]]` pointer should appear.

- [ ] **Step 3: Test `/prism-deep-dive --upgrade <slug>`**

In the same project:

1. Run `/prism-deep-dive --upgrade <slug>` where `<slug>` is the project's slug.
2. Expected behaviors:
   - If the agent file is already current: a "no upgrade needed" report and no diff prompt.
   - If you want to force a diff to test the confirm flow: temporarily edit the on-disk `master-<slug>.md` (add a line like `<!-- test diff -->` after the frontmatter), then re-run `--upgrade`. The slash command should now present the diff and ask whether to apply.
3. Try BOTH branches of the confirmation:
   - **Skip:** verify the file is unchanged.
   - **Apply:** verify the file is rewritten and the `<!-- test diff -->` marker is gone.

- [ ] **Step 4: Test 25 KB cap refusal**

Synthetic edge case (skip if time-limited):

1. Pad `.claude/agents/MEMORY.md` with junk content until it's about 24 KB.
2. Run `node tools/prism-clean.mjs append-decision --slug <slug> --d-number 999 --title "<long-enough-title>"` such that the append would cross 25 KB.
3. Expected: exit 8, stderr mentions the cap, MEMORY.md unchanged.

- [ ] **Step 5: Report back to the controller**

If all 4 steps pass, report green. The controller will:

1. Commit an empty milestone marker: `test(prism): Phase H knowledge evolution verified end-to-end`.
2. Mark the Phase H plan complete.
3. Offer to start Phase J (tightened evidence rules) — separate plan via writing-plans.

If any step fails, report exactly what went wrong (which step, what output, what file state) so the controller can triage before declaring Phase H done.

---

## Self-review (writing-plans checklist)

**1. Spec coverage:**

| D004 §H / §5 requirement | Plan task |
|---|---|
| Per-decision pointer append to `master-<slug>` MEMORY.md | Task 1 (tests) + Task 2 (helper) + Task 3 (slash-command wire) |
| Per-session pointer update via `/prism-clean` | Task 1 (tests) + Task 2 (helper) + Task 3 (slash-command wire) |
| Manual `agent-factory --upgrade master-<slug>` with diff preview | Task 4 (`agent-diff` helper + tests) + Task 5 (slash-command `--upgrade` mode) |
| 25 KB MEMORY.md hard cap (D004 risk-register #2) | Task 1 cap-refusal test + Task 2 `writeMemoryMdAtomic` enforcement |
| Per-quarter auto re-synth | EXPLICITLY DEFERRED to v4.1 per D004 §5 (out-of-scope section) |

All 4 in-scope §H deliverables have an assigned task; the 5th is correctly deferred. ✓

**2. Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", every code/command step has exact contents. The only flexibility is in Task 3 (LLM-facing prose changes to `commands/prism-clean.md` where the existing structure determines exact insertion points). ✓

**3. Type consistency:** Anchor comment strings (`<!-- /prism-clean appends \`[[D###]]\` lines here per Phase H. -->` and the lessons variant) match VERBATIM between the deep-dive seed template (existing `tools/prism-deep-dive.mjs:275 / :279`), the new helper constants in Task 2, the test seed scaffold in Task 1. Pointer-line shapes (`- [[D###]] <title>` and `- [[lessons-tactical#<date>]] <title>`) match between Task 1 tests, Task 2 helper output, and Task 3 slash-command prose. Exit codes (5/6/7/8) match between Task 1 tests, Task 2 die() calls, and Task 3 slash-command exit-code-handling prose. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/prism/plans/2026-05-25-phase-h-knowledge-evolution.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review between tasks. Fits this plan well because Tasks 1+2 form a tight TDD red/green pair, Tasks 4+5 form another, Tasks 3 and 6 are docs-only, and Task 7 is user-driven. Six subagent dispatches total; user reviews after each pair.

**2. Inline Execution** — Execute Tasks 1-6 in this session using `superpowers:executing-plans`, with checkpoints after Task 2 (load-bearing helper landed), Task 5 (full deliverable surface complete), and Task 6 (dev install synced). Task 7 is always user-driven.

**Which approach?**
