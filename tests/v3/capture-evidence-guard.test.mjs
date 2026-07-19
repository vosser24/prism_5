#!/usr/bin/env node
// Tests for hooks/prism-capture-evidence-guard.mjs — the BLOCKING PreToolUse
// guard that denies a captured-knowledge write (docs/prism/adjudications/**,
// docs/prism/lessons/**, tasks/lessons-*.md) when the content asserts a
// factual verification-style claim ("works"/"fixed"/"root cause"/"confirmed")
// with no `**Verified:**` evidence field anywhere in the resulting file.
//
// Two layers:
//   A. Direct unit tests against the guard's exported run()/resultingContent()
//      — precise, no subprocess.
//   B. Integration tests through the REAL prism-pretooluse-dispatcher.mjs
//      subprocess — proves the guard is actually wired into the Write/Edit/
//      MultiEdit routes and composes correctly with the sibling
//      parent-dispatch-guard (deny wins; no updatedInput collision).
//
// Run: node tests/v3/capture-evidence-guard.test.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', 'hooks', 'prism-capture-evidence-guard.mjs');
const DISPATCHER = join(__dirname, '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');
const {run} = await import(pathToFileURL(GUARD).href);

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// ---------- scratch workspace for real on-disk target files ----------
const WORK = mkdtempSync(join(tmpdir(), 'prism-ceg-'));
function scratchPath(...segs) { return join(WORK, ...segs); }
function seedFile(relPath, content) {
  const p = scratchPath(...relPath.split('/'));
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, content, 'utf-8');
  return p;
}

const UNVERIFIED_ADJUDICATION = `# The retry loop is caused by a stale lock file

**Status:** Locked
**Date:** 2026-07-14
**Captured by:** manual
**Rule:** Always clear the lock file before retrying.

## Diagnosis
The bug is caused by a stale lock file left behind by a crashed worker. This
fix resolves the retry storm.
`;

const VERIFIED_ADJUDICATION = `# The retry loop is caused by a stale lock file

**Status:** Locked
**Date:** 2026-07-14
**Captured by:** manual
**Rule:** Always clear the lock file before retrying.
**Verified:** node tools/repro-lock.mjs -> reproduced the storm, confirmed clearing the lock fixes it (see run log 2026-07-14T10:02Z)

## Diagnosis
The bug is caused by a stale lock file left behind by a crashed worker. This
fix resolves the retry storm.
`;

const DISCLAIMED_ADJUDICATION = `# The retry loop is caused by a stale lock file

**Status:** Draft
**Date:** 2026-07-14
**Captured by:** manual
**Rule:** Always clear the lock file before retrying (unconfirmed).
**Verified:** NOT REPRODUCED -- inherited diagnosis from a prior session, unconfirmed

## Diagnosis
The bug is caused by a stale lock file left behind by a crashed worker. This
fix resolves the retry storm (claimed, not checked).
`;

const NO_CLAIM_ADJUDICATION = `# Naming convention for D-numbered files

**Status:** Locked
**Date:** 2026-07-14
**Captured by:** manual
**Rule:** Adjudications are named D###-slug.md, sequential, never reused.

## Deliberately NOT doing
- NOT renumbering existing files.
`;

// =====================================================================
// A. Direct unit tests
// =====================================================================

// (a) adjudication, factual claim, NO evidence field -> DENY, exit 2
await test('A(a) unverified adjudication claim -> deny, exit 2', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D999-test.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: UNVERIFIED_ADJUDICATION},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
  assert(/CAPTURE-EVIDENCE GATE/.test(parsed.hookSpecificOutput.permissionDecisionReason), 'reason should name the gate');
  assert(/\*\*Verified:\*\*/.test(parsed.hookSpecificOutput.permissionDecisionReason), 'reason should tell the author what to add');
});

// (b) same write WITH **Verified:** command+output -> PASS
await test('A(b) verified adjudication (command + real output) -> allow, exit 0', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D999-test.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: VERIFIED_ADJUDICATION},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// (c) explicit "NOT REPRODUCED" disclaimer -> PASS (visibility, not prohibition)
await test('A(c) "NOT REPRODUCED" disclaimer -> allow, exit 0', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D999-test.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: DISCLAIMED_ADJUDICATION},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// (d) ordinary source file -> UNAFFECTED, even with claim-y language and no evidence field
await test('A(d) ordinary source file with claim-y prose -> unaffected, exit 0, no stdout', () => {
  const filePath = scratchPath('src', 'lib', 'retry.mjs');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '// This fix resolves the retry storm; the bug is caused by a stale lock.\nexport function retry() {}\n'},
  });
  assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
});

// (e) kill-switch: PRISM_CAPTURE_EVIDENCE_GATE=off -> unverified claim still passes
await test('A(e) kill-switch off -> unverified adjudication passes, exit 0', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D999-test.md');
  const prev = process.env.PRISM_CAPTURE_EVIDENCE_GATE;
  process.env.PRISM_CAPTURE_EVIDENCE_GATE = 'off';
  try {
    const r = run({
      tool_name: 'Write',
      tool_input: {file_path: filePath, content: UNVERIFIED_ADJUDICATION},
    });
    assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
  } finally {
    if (prev === undefined) delete process.env.PRISM_CAPTURE_EVIDENCE_GATE;
    else process.env.PRISM_CAPTURE_EVIDENCE_GATE = prev;
  }
});

// Extra rigor ------------------------------------------------------------

// No claim at all -> allowed even with no evidence field (trigger-gated, not blanket).
await test('A(f) no factual claim in content -> allow regardless of missing field', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D998-naming.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: NO_CLAIM_ADJUDICATION},
  });
  assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
});

// tasks/lessons-*.md path is in scope.
await test('A(g) tasks/lessons-tactical.md claim with no field -> deny', () => {
  const filePath = scratchPath('tasks', 'lessons-tactical.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# Tactical lessons\n\n2026-07-14 — the deadlock is caused by a double-lock; this fix resolves it.\n'},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

// docs/prism/lessons/** path is in scope.
await test('A(h) docs/prism/lessons claim with no field -> deny', () => {
  const filePath = scratchPath('docs', 'prism', 'lessons', '2026-07-14-session.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# Session lessons\n\n**Status:** Locked\n**Date:** 2026-07-14\n\nConfirmed the cache invalidation bug is fixed.\n'},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

// Edit reconstructs FULL resulting content from disk: editing an unrelated
// part of an already-evidenced file must NOT false-positive just because the
// diff itself doesn't carry the field.
await test('A(i) Edit on already-evidenced file, diff has no field -> allow (full-file reconstruction)', () => {
  const filePath = seedFile('docs/prism/adjudications/D997-existing.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {file_path: filePath, old_string: '**Status:** Locked', new_string: '**Status:** Locked -- amended note'},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// Edit that introduces a NEW claim into a file with no evidence anywhere -> deny.
await test('A(j) Edit introducing a new unverified claim into a bare file -> deny', () => {
  const filePath = seedFile('docs/prism/adjudications/D996-bare.md', NO_CLAIM_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '## Deliberately NOT doing',
      new_string: '## Update\nConfirmed this fix resolves the naming collision.\n\n## Deliberately NOT doing',
    },
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

// MultiEdit is covered by the same reconstruction path.
await test('A(k) MultiEdit introducing an unverified claim -> deny', () => {
  const filePath = seedFile('docs/prism/adjudications/D995-multi.md', NO_CLAIM_ADJUDICATION);
  const r = run({
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: filePath,
      edits: [
        {old_string: '## Deliberately NOT doing', new_string: '## Update\nThis is now working end to end.\n\n## Deliberately NOT doing'},
      ],
    },
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

// soft mode: nudge via additionalContext, never blocks.
await test('A(l) soft mode -> nudge context, exit 0, never denies', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D994-soft.md');
  const prev = process.env.PRISM_CAPTURE_EVIDENCE_GATE;
  process.env.PRISM_CAPTURE_EVIDENCE_GATE = 'soft';
  try {
    const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content: UNVERIFIED_ADJUDICATION}});
    assert(r.exit === 0, `exit=${r.exit}`);
    const parsed = JSON.parse(r.stdout);
    assert(parsed.hookSpecificOutput.permissionDecision === undefined, 'soft must not deny');
    assert(/CAPTURE-EVIDENCE GATE/.test(parsed.hookSpecificOutput.additionalContext || ''), 'soft should still nudge');
  } finally {
    if (prev === undefined) delete process.env.PRISM_CAPTURE_EVIDENCE_GATE;
    else process.env.PRISM_CAPTURE_EVIDENCE_GATE = prev;
  }
});

// Non-Write/Edit/MultiEdit tools are never touched.
await test('A(m) non-mutation tool (Bash) -> always exit 0, no stdout', () => {
  const r = run({tool_name: 'Bash', tool_input: {command: 'echo hi > docs/prism/adjudications/D993.md'}});
  assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
});

// v6.6.0 FIX-4c: close the per-file ratchet for NEW entries. One historical
// **Verified:** field anywhere in an append-only file previously immunized
// every future unverified entry -- EVIDENCE_FIELD_RE.test(content) scans the
// WHOLE resulting file, so any subsequent Edit appending a brand-new
// claim-bearing entry sailed through on the file's pre-existing evidence.
// The heading gate keeps typo fixes / same-entry amendments immune (no new
// heading in the added text -> today's whole-file behavior still applies).
await test('A(r) FIX-4c: Edit appending a NEW heading + unverified claim to an already-evidenced file -> deny', () => {
  const filePath = seedFile('docs/prism/adjudications/D991-ratchet.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '## Diagnosis',
      new_string: '## New lesson\nthe fix works\n\n## Diagnosis',
    },
  });
  assert(r.exit === 2, `exit=${r.exit}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

await test('A(s) FIX-4c: Edit fixing a typo in that same already-evidenced file (no new heading) -> allow', () => {
  const filePath = seedFile('docs/prism/adjudications/D991-ratchet.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: 'left behind by a crashed worker.',
      new_string: 'left behind by a crashed background worker.',
    },
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// v6.6.0 FIX-4a: CLAIM_TRIGGER_RE gained "tests pass" vocabulary — closes the
// reported conversational gap where "the tests pass" asserted a verification
// claim in prose but no existing alternative (works/fixed/confirmed/root
// cause/now passes/passes now) matched it.
await test('A(n) FIX-4a: "the tests pass" claim with no evidence field -> deny', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D992-testspass.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# A fix\n\n**Status:** Locked\n**Date:** 2026-07-19\n\nAfter the change, the tests pass.\n'},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

await test('A(o) FIX-4a: "the tests pass" claim WITH **Verified:** field -> allow', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D992-testspass.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# A fix\n\n**Status:** Locked\n**Date:** 2026-07-19\n**Verified:** node tests/x.mjs -> 5/5 passed\n\nAfter the change, the tests pass.\n'},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// v6.6.0 FIX-4b: IN_SCOPE_RE gained docs/prism/deviations/ — agent-authored
// factual reports (capture-conventions bucket table) are exactly the
// claim-bearing class this guard exists for. docs/prism/smoke/ is
// deliberately NOT added (runbook imperative prose false-fires by
// construction) — the second assertion below proves that exclusion holds.
await test('A(p) FIX-4b: docs/prism/deviations/ claim with no evidence field -> deny', () => {
  const filePath = scratchPath('docs', 'prism', 'deviations', '2026-07-19-x-deviation.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# Deviation report\n\n**Status:** Draft\n**Date:** 2026-07-19\n\nThe workaround confirmed the root cause and the issue is now fixed.\n'},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
});

await test('A(q) FIX-4b: docs/prism/smoke/ with the same claim language -> allow (intentionally out of scope)', () => {
  const filePath = scratchPath('docs', 'prism', 'smoke', 'smoke-x.md');
  const r = run({
    tool_name: 'Write',
    tool_input: {file_path: filePath, content: '# Smoke procedure\n\n**Status:** Draft\n**Date:** 2026-07-19\n\nThe workaround confirmed the root cause and the issue is now fixed.\n'},
  });
  assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
});

// =====================================================================
// B. Integration through the real dispatcher (proves wiring + composition)
// =====================================================================

function runDispatcher(payload, {sentinel = null, env = {}} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ceg-home-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const sessionId = payload.session_id || 'ceg-int';
  const sent = sentinel || {tier: 'sonnet', dispatched: false, force_opus: false};
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${sessionId}.json`), JSON.stringify(sent));
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify({session_id: sessionId, ...payload}),
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...env},
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    const hso = parsed && parsed.hookSpecificOutput;
    return {
      exit: r.status,
      stdout: (r.stdout || '').trim(),
      decision: hso && hso.permissionDecision,
      reason: hso && hso.permissionDecisionReason,
    };
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

// Subagent-context call (parent_tool_use_id set) so the sibling
// parent-dispatch-guard bypasses immediately (isSubagent -> done(0)) and the
// dispatcher's consolidated decision reflects ONLY the capture-evidence-guard.
await test('B(1) dispatcher: subagent Write, unverified claim -> deny (real wiring)', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D992-int.md');
  const r = runDispatcher({
    tool_name: 'Write',
    parent_tool_use_id: 'toolu_fake123',
    tool_input: {file_path: filePath, content: UNVERIFIED_ADJUDICATION},
  });
  assert(r.exit === 2, `exit=${r.exit}`);
  assert(r.decision === 'deny', `decision=${r.decision}`);
  assert(/CAPTURE-EVIDENCE GATE/.test(r.reason || ''), `reason=${r.reason}`);
});

await test('B(2) dispatcher: subagent Write, verified claim -> allow', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D992-int.md');
  const r = runDispatcher({
    tool_name: 'Write',
    parent_tool_use_id: 'toolu_fake123',
    tool_input: {file_path: filePath, content: VERIFIED_ADJUDICATION},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

await test('B(3) dispatcher: subagent Write to ordinary source file -> unaffected', () => {
  const filePath = scratchPath('src', 'lib', 'retry2.mjs');
  const r = runDispatcher({
    tool_name: 'Write',
    parent_tool_use_id: 'toolu_fake123',
    tool_input: {file_path: filePath, content: 'export function fixedRetry() { /* this fix resolves the loop */ }\n'},
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

await test('B(4) dispatcher: kill-switch off -> unverified claim passes through real wiring', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D992-int.md');
  const r = runDispatcher(
    {tool_name: 'Write', parent_tool_use_id: 'toolu_fake123', tool_input: {file_path: filePath, content: UNVERIFIED_ADJUDICATION}},
    {env: {PRISM_CAPTURE_EVIDENCE_GATE: 'off'}}
  );
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

console.log(`\ncapture-evidence-guard: ${pass} passed, ${fail} failed`);
try { rmSync(WORK, {recursive: true, force: true}); } catch {}
process.exit(fail ? 1 : 0);
