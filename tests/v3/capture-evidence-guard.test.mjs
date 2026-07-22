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
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
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

// v6.6.1 FIX-4c-follow-up (UAT bypass): the append-to-end-of-file shape --
// old_string anchors on the TRAILING text that already contains the
// historical **Verified:** line, new_string reproduces that anchor verbatim
// then appends a brand-new heading + unverified claim. The raw new_string
// therefore CARRIES the old **Verified:** line even though the genuinely new
// material has none of its own -- addedMaterial() must not be fooled by that
// carried-over anchor.
const VERIFIED_TAIL = '**Verified:** node tools/repro-lock.mjs -> reproduced the storm, confirmed clearing the lock fixes it (see run log 2026-07-14T10:02Z)\n\n## Diagnosis\nThe bug is caused by a stale lock file left behind by a crashed worker. This\nfix resolves the retry storm.\n';
await test('A(t) FIX-4c-follow-up: Edit anchored on the Verified line, appending a NEW unverified entry -> deny (was: bypass)', () => {
  const filePath = seedFile('docs/prism/adjudications/D990-anchor-bypass.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: VERIFIED_TAIL,
      new_string: VERIFIED_TAIL + '\n## New finding\nthe fix works\n',
    },
  });
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

// Companion: same anchor shape, but the delta itself carries no new heading
// (pure typo fix appended inline via the same anchor pattern) -> still allow.
await test('A(u) FIX-4c-follow-up: Edit anchored on the Verified line, delta has no new heading -> allow', () => {
  const filePath = seedFile('docs/prism/adjudications/D990-anchor-typo.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: VERIFIED_TAIL,
      new_string: VERIFIED_TAIL.replace('crashed worker', 'crashed background worker'),
    },
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// Companion: same anchor shape, but the delta carries its OWN **Verified:**
// line for the new entry -> allow (the new entry is itself evidenced).
await test('A(v) FIX-4c-follow-up: Edit anchored on the Verified line, delta carries its OWN Verified field -> allow', () => {
  const filePath = seedFile('docs/prism/adjudications/D990-anchor-ownverified.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: VERIFIED_TAIL,
      new_string: VERIFIED_TAIL + '\n## New finding\nthe fix works\n**Verified:** node tools/repro-new.mjs -> confirmed\n',
    },
  });
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

// v6.6.1 second-round regression (independent cross-model verification):
// the char-level prefix/suffix stripping in addedRegion() absorbs shared
// LEADING/TRAILING CHARACTERS (not whole lines) when a shallower heading is
// inserted immediately above a deeper existing heading. "##" and "#" are
// common characters that straddle the true insertion point, so they get
// stripped as "common prefix"/"common suffix" even though they belong to
// TWO DIFFERENT heading lines -- the delta comes out missing its leading
// "#"s and NEW_HEADING_RE no longer matches. addedRegion must diff at LINE
// granularity, not character granularity.
const NESTED_VERIFIED_ADJUDICATION = `# The retry loop is caused by a stale lock file

**Status:** Locked
**Date:** 2026-07-14
**Captured by:** manual
**Rule:** Always clear the lock file before retrying.
**Verified:** node tools/repro-lock.mjs -> reproduced the storm, confirmed clearing the lock fixes it (see run log 2026-07-14T10:02Z)

## Diagnosis
### Subsection
The bug is caused by a stale lock file left behind by a crashed worker. This
fix resolves the retry storm.
`;

await test('A(w) FIX-4c-follow-up round 2: middle-insert of a new ## heading between an existing ## and ### heading -> deny (was: char-strip bypass)', () => {
  const filePath = seedFile('docs/prism/adjudications/D989-middle-insert.md', NESTED_VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '## Diagnosis\n### Subsection\n',
      new_string: '## Diagnosis\n## New finding works\n### Subsection\n',
    },
  });
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

await test('A(x) FIX-4c-follow-up round 2: prepend a shallower ## heading directly above an existing ### heading -> deny (was: char-strip bypass)', () => {
  const filePath = seedFile('docs/prism/adjudications/D989-prepend-hh.md', NESTED_VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '### Subsection\n',
      new_string: '## New finding works\n### Subsection\n',
    },
  });
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

await test('A(y) FIX-4c-follow-up round 2: prepend a shallower # heading directly above an existing ## heading -> deny (was: char-strip bypass)', () => {
  const filePath = seedFile('docs/prism/adjudications/D988-prepend-h.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '## Diagnosis\n',
      new_string: '# X works\n## Diagnosis\n',
    },
  });
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

// Sanity: equal-level heading prepended above another heading of the SAME
// level still denies (not just the shallower-above-deeper shape).
await test('A(z) FIX-4c-follow-up round 2: prepend an equal-level ## heading above another ## heading -> deny', () => {
  const filePath = seedFile('docs/prism/adjudications/D987-equal-level.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: '## Diagnosis\n',
      new_string: '## New finding works\n## Diagnosis\n',
    },
  });
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
});

// Sanity: identical old_string/new_string (no-op edit) -> delta is empty,
// no crash, no false deny.
await test('A(aa) FIX-4c-follow-up round 2: no-op edit (old_string === new_string) -> allow, no crash', () => {
  const filePath = seedFile('docs/prism/adjudications/D986-noop.md', VERIFIED_ADJUDICATION);
  const r = run({
    tool_name: 'Edit',
    tool_input: {file_path: filePath, old_string: '## Diagnosis\n', new_string: '## Diagnosis\n'},
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

// =====================================================================
// C. D057 absence-claim tripwire tests (RED phase — Phase B1). See
// docs/prism/plans/2026-07-21-D057-absence-claim-gate-FIX-PLAN.md §4/§5 and
// docs/prism/plans/2026-07-21-NEXT-SESSION-EXECUTION-RUNBOOK.md Phase B1/B2.
// hooks/prism-capture-evidence-guard.mjs is NOT edited by this pass (T8,
// Phase B2, opus, separate commit) — these tests exercise the CURRENTLY
// SHIPPED CLAIM_TRIGGER_RE (line 85, no absence-claim alternates yet) via
// the real run() imported above, so the "expect deny" fixtures are expected
// to FAIL (RED) until T8 lands.
// =====================================================================

// PRE_PANEL_DRAFT_RE reproduces the FIRST (pre-Seat-3) absence-regex draft
// described in docs/prism/plans/2026-07-21-D057-absence-claim-gate-FIX-PLAN.md
// PANEL RECONCILIATION row 3 and §4 intro ("the pre-panel regex below the
// fold is DEAD -- it MISSES the motivating incident's own text"): a naive
// `ha(?:s|ve|d) no [a-z_]...` extension with NO markup-wrapper tolerance and
// NO placeholder exclusions, plus the since-dropped `no \w+ matched`
// alternate (P5). This never shipped as code (git-ignored plan/position
// files, superseded in place) -- it is reconstructed here, to its documented
// shape, ONLY so G-abs6 can prove the backticked/bolded incident text
// escaped THAT draft too, not just today's live regex.
const PRE_PANEL_DRAFT_RE = /\b(works|is fixed|are fixed|was fixed|resolves?|resolved|is broken|are broken|was broken|root[\s-]*cause|caused by|confirms?|confirmed|reproduces?|reproduced|no longer (fails|occurs)|now passes|passes now|is now working|bug is|tests? pass(es|ed)?|(all |the )?tests? (are |were )?(green|passing)|suite (is )?green|ha(?:s|ve|d) no [a-z_][\w-]*|(is|are|was|were) empty|(is|are|was|were) missing|no \w+ matched)\b/i;

await test('G-abs1 absence claim ("Eight agents have no core_domains."), no Verified -> deny, exit 2', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D999-absence.md');
  const content = `# Absence claim fixture (no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

Eight agents have no core_domains.
`;
  const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content}});
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

await test('G-abs2 "is empty" absence claim (backticked field), no Verified -> deny', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D998-absence-empty.md');
  const content = `# Absence claim fixture (empty, no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

The \`core_domains\` field is empty for three of them.
`;
  const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content}});
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

await test('G-abs3 absence claim WITH Verified -> allow, exit 0 (proves composition, not a new deny class)', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D997-absence-verified.md');
  const content = `# Absence claim fixture (with Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual
**Verified:** node tools/roster-scan.mjs -> confirmed 8/40 agents carry no core_domains field (see run log 2026-07-21T09:00Z)

Eight agents have no core_domains.
`;
  const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content}});
  assert(r.exit === 0, `exit=${r.exit} stdout=${r.stdout}`);
});

await test('G-abs4 ratchet interplay: Edit appends unverified absence entry to a verified file -> deny, ratchet: per-entry', () => {
  const filePath = seedFile('docs/prism/adjudications/D996-abs-ratchet.md', VERIFIED_ADJUDICATION);
  const scratchHome = mkdtempSync(join(tmpdir(), 'prism-ceg-home-gabs4-'));
  mkdirSync(join(scratchHome, '.claude'), {recursive: true});
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
  try {
    const r = run({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: 'fix resolves the retry storm.\n',
        new_string: 'fix resolves the retry storm.\n\n## New finding\nTwo roster entries have no core_domains field.\n',
      },
    });
    assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
    const logPath = join(scratchHome, '.claude', '.prism-routing.jsonl');
    const logLines = existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean) : [];
    const last = logLines.length ? JSON.parse(logLines[logLines.length - 1]) : {};
    assert(last.ratchet === 'per-entry', `routing-log last record=${JSON.stringify(last)}`);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    rmSync(scratchHome, {recursive: true, force: true});
  }
});

await test('G-abs5 NEGATIVE CONTROL: "has no side effects" / "empty by design" -> allow, no-claim (precision floor, green before AND after)', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D995-absence-negcontrol.md');
  const content = `# Precision-floor negative control (no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

This helper has no side effects. The retry list is empty by design.
`;
  const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content}});
  assert(r.exit === 0 && r.stdout === '', `exit=${r.exit} stdout=${r.stdout}`);
});

await test('G-abs6 backticked object ("have no `core_domains`") -> deny against BOTH the current live regex and the pre-panel draft', () => {
  const backtickedContent = `# Motivating-incident fixture (backticked field)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

Eight agents have no \`core_domains\` field.
`;
  // Historical control: the fixture escapes the never-shipped pre-panel
  // draft too (no markup-wrapper tolerance in that draft) -- proves the
  // wrapper-class repair (P4), not just the placeholder exclusions, is
  // load-bearing.
  assert(PRE_PANEL_DRAFT_RE.test('Eight agents have no `core_domains` field.') === false,
    'pre-panel draft (no markup-wrapper tolerance) should NOT match the backticked incident text');

  const filePathBacktick = scratchPath('docs', 'prism', 'adjudications', 'D994-abs-backtick.md');
  const rBacktick = run({tool_name: 'Write', tool_input: {file_path: filePathBacktick, content: backtickedContent}});
  assert(rBacktick.exit === 2, `exit=${rBacktick.exit} stdout=${rBacktick.stdout}`);
  const parsedBacktick = JSON.parse(rBacktick.stdout);
  assert(parsedBacktick.hookSpecificOutput.permissionDecision === 'deny', `stdout=${rBacktick.stdout}`);

  const boldedContent = `# Motivating-incident fixture (bolded field)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

Eight agents have no **core_domains** frontmatter.
`;
  assert(PRE_PANEL_DRAFT_RE.test('Eight agents have no **core_domains** frontmatter.') === false,
    'pre-panel draft (no markup-wrapper tolerance) should NOT match the bolded incident text');

  const filePathBold = scratchPath('docs', 'prism', 'adjudications', 'D993-abs-bold.md');
  const rBold = run({tool_name: 'Write', tool_input: {file_path: filePathBold, content: boldedContent}});
  assert(rBold.exit === 2, `exit=${rBold.exit} stdout=${rBold.stdout}`);
  const parsedBold = JSON.parse(rBold.stdout);
  assert(parsedBold.hookSpecificOutput.permissionDecision === 'deny', `stdout=${rBold.stdout}`);
});

await test('G-abs7 NEGATIVE CONTROL: single-letter placeholder rule-quotes -> allow, no-claim; paired positive still denies', () => {
  const placeholderContent = `# Rule-quote fixture (placeholder form only, no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

The D057 rule covers sentences shaped like "X has no Y", "X is empty", and "N are missing Z" -- quote the source before writing any of those.
`;
  const filePathPlaceholder = scratchPath('docs', 'prism', 'adjudications', 'D992-abs-placeholder.md');
  const rPlaceholder = run({tool_name: 'Write', tool_input: {file_path: filePathPlaceholder, content: placeholderContent}});
  assert(rPlaceholder.exit === 0 && rPlaceholder.stdout === '', `exit=${rPlaceholder.exit} stdout=${rPlaceholder.stdout}`);

  // Paired positive: a REAL absence claim in the same shape family must
  // still deny, or the exclusion is too wide.
  const positiveContent = `# Paired positive fixture (no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

3 are missing core_domains.
`;
  const filePathPositive = scratchPath('docs', 'prism', 'adjudications', 'D991-abs-positive-pair.md');
  const rPositive = run({tool_name: 'Write', tool_input: {file_path: filePathPositive, content: positiveContent}});
  assert(rPositive.exit === 2, `exit=${rPositive.exit} stdout=${rPositive.stdout}`);
  const parsedPositive = JSON.parse(rPositive.stdout);
  assert(parsedPositive.hookSpecificOutput.permissionDecision === 'deny', `stdout=${rPositive.stdout}`);
});

await test('G-abs8 rule-quoting amendment ratchet -> allow; a REAL absence claim in the same amendment still denies', () => {
  // The exclusions must be narrow enough to let a quoted rule through AND wide
  // enough to still catch a real claim sitting next to it in the SAME added
  // region. Both halves run against the LIVE hook -- no test-side regex
  // literal is asserted on (anti-tautology, runbook Phase B1).

  // Half 1 (allow): amendment body only QUOTES the rule in placeholder form.
  const quoteOnlyBody = 'the D057 rule covers phrasings like "X has no Y" and "N are missing Z" -- quote the source before writing either shape.';
  const quotePath = seedFile('docs/prism/adjudications/D990-abs-ratchet-amend.md', VERIFIED_ADJUDICATION);
  const rQuote = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: quotePath,
      old_string: 'fix resolves the retry storm.\n',
      new_string: `fix resolves the retry storm.\n\n## Amendment\n${quoteOnlyBody}\n`,
    },
  });
  assert(rQuote.exit === 0, `quote-only amendment should ALLOW: exit=${rQuote.exit} stdout=${rQuote.stdout}`);

  // Half 2 (deny, RED until T8): same ratchet shape, same quoted rule, but the
  // amendment ALSO asserts a real absence. The per-entry ratchet must fire.
  const mixedBody = 'the D057 rule covers phrasings like "X has no Y" -- and, checked today, two seats have no position file.';
  const mixedPath = seedFile('docs/prism/adjudications/D988-abs-ratchet-mixed.md', VERIFIED_ADJUDICATION);
  const rMixed = run({
    tool_name: 'Edit',
    tool_input: {
      file_path: mixedPath,
      old_string: 'fix resolves the retry storm.\n',
      new_string: `fix resolves the retry storm.\n\n## Amendment\n${mixedBody}\n`,
    },
  });
  assert(rMixed.exit === 2, `mixed amendment should DENY: exit=${rMixed.exit} stdout=${rMixed.stdout}`);
  const parsedMixed = JSON.parse(rMixed.stdout);
  assert(parsedMixed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${rMixed.stdout}`);
});

await test('G-abs9 NEGATIVE CONTROL / DOCUMENTED BEHAVIOUR: conditional "is missing" prose denies under the Locked regex (recorded decision)', () => {
  const filePath = scratchPath('docs', 'prism', 'adjudications', 'D989-abs-conditional.md');
  const content = `# Conditional-prose fixture (no Verified)

**Status:** Draft
**Date:** 2026-07-21
**Captured by:** manual

Skip the test gracefully if either file is missing.
`;
  const r = run({tool_name: 'Write', tool_input: {file_path: filePath, content}});
  // This is a DOCUMENTED, chosen behaviour (Seat 3's leakiest-alternate
  // finding), not a bug to be fixed: assert the outcome the Locked regex
  // actually produces so it is on record, not a surprise in production.
  assert(r.exit === 2, `exit=${r.exit} stdout=${r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.hookSpecificOutput.permissionDecision === 'deny', `stdout=${r.stdout}`);
});

console.log(`\ncapture-evidence-guard: ${pass} passed, ${fail} failed`);
try { rmSync(WORK, {recursive: true, force: true}); } catch {}
process.exit(fail ? 1 : 0);
