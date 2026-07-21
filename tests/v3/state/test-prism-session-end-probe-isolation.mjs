#!/usr/bin/env node
// SessionEnd ⇄ Task-API-probe BLAST-RADIUS ISOLATION (D042 both legs).
//
// Defect this locks (found by independent adversarial validation, 2026-07-21,
// tasks/workspace/task-api-probe-validation-2026-07-21.md FINDING 1):
//
//   The probe call in hooks/prism-session-end.mjs used to sit INSIDE the same
//   `try {}` as — and BEFORE — the task-snapshot construction. A THROWING probe
//   therefore left SessionEnd teardown looking healthy (exit 0, session .md
//   still written) while SILENTLY destroying the task-carryover pointer
//   (<cwd>/.claude/.prism-open-tasks.json) and its sidecar, because the throw
//   skipped every remaining statement in that try block.
//
//   That is the worst possible coupling: the carryover pointer is what feeds
//   the next SessionStart's TASK-RECALL block. A probe built to DETECT silent
//   task loss must never CAUSE it.
//
// Method: reproduction, not inspection. A mirror copy of hooks/ is made in a
// temp dir and its hooks/lib/prism-task-api-probe.mjs is replaced with a stub
// whose entry points unconditionally `throw`. The REAL hook body then runs
// against a real transcript fixture under a fully sandboxed HOME+USERPROFILE.
//
// Both legs are asserted:
//   CONTROL  — real probe      -> pointer + sidecar written  (fixture is valid)
//   ISOLATED — throwing probe  -> pointer + sidecar STILL written
//
// Before the fix, ISOLATED produced NONE of them. Run:
//   node tests/v3/state/test-prism-session-end-probe-isolation.mjs

import {cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${extra ? ` -- ${extra}` : ''}\n`); }
}

const THROWING_PROBE = `// test stub: every entry point throws.
function probeTaskApiLines() { throw new Error('probe boom (test stub)'); }
function probeTaskApiTranscript() { throw new Error('probe boom (test stub)'); }
const TASK_TOOL_NAMES = new Set();
const SCORING_TASK_TOOLS = new Set();
const EXPECTED_UNAVAILABLE_TOOLS = new Set();
const NOT_ENABLED_RE = /x^/;
export {probeTaskApiLines, probeTaskApiTranscript, TASK_TOOL_NAMES, SCORING_TASK_TOOLS, EXPECTED_UNAVAILABLE_TOOLS, NOT_ENABLED_RE};
`;

// A minimal but REAL-SHAPED transcript: one successful TaskCreate, so
// extractTaskSnapshot reconstructs exactly one open (pending) task and the hook
// has a non-null taskSnapshotPayload to write.
const TRANSCRIPT = [
  JSON.stringify({
    type: 'assistant', timestamp: '2026-07-21T10:00:00.000Z',
    message: {role: 'assistant', content: [{type: 'tool_use', id: 'tu_iso1', name: 'TaskCreate',
      input: {subject: 'isolation fixture task', description: 'must survive a throwing probe', activeForm: 'surviving'}}]},
  }),
  JSON.stringify({
    type: 'user', timestamp: '2026-07-21T10:00:01.000Z',
    message: {role: 'user', content: [{type: 'tool_result', content: 'Task #4242 created', tool_use_id: 'tu_iso1'}]},
    toolUseResult: {task: {id: '4242', subject: 'isolation fixture task'}},
  }),
].join('\n') + '\n';

const scratch = mkdtempSync(join(tmpdir(), 'prism-probe-isolation-'));

/**
 * Run a mirrored copy of the SessionEnd hook with a sandboxed HOME/USERPROFILE.
 * `throwingProbe=true` swaps in the stub above.
 */
function runVariant(label, throwingProbe) {
  const base = join(scratch, label);
  const home = join(base, 'home');
  const proj = join(base, 'proj');
  const mirrorHooks = join(base, 'hooks');
  mkdirSync(home, {recursive: true});
  mkdirSync(proj, {recursive: true});
  cpSync(join(ROOT, 'hooks'), mirrorHooks, {recursive: true});
  if (throwingProbe) {
    writeFileSync(join(mirrorHooks, 'lib', 'prism-task-api-probe.mjs'), THROWING_PROBE, 'utf-8');
  }
  const transcript = join(base, 'session.jsonl');
  writeFileSync(transcript, TRANSCRIPT, 'utf-8');

  const sessionId = `iso-${label}`;
  const res = spawnSync(process.execPath, [join(mirrorHooks, 'prism-session-end.mjs')], {
    input: JSON.stringify({session_id: sessionId, transcript_path: transcript, cwd: proj}),
    encoding: 'utf-8',
    // BOTH must be set: different PRISM modules read USERPROFILE||HOME and
    // HOME||USERPROFILE, so setting one leaves paths half-isolated.
    env: {...process.env, HOME: home, USERPROFILE: home, PRISM_DISABLE_TASK_SNAPSHOT: '0'},
  });

  const mdPath = join(home, '.claude', '.prism-sessions', `${sessionId}.md`);
  const sidecarPath = join(home, '.claude', '.prism-sessions', `${sessionId}.tasks.json`);
  const pointerPath = join(proj, '.claude', '.prism-open-tasks.json');
  return {
    exit: res.status,
    stderr: (res.stderr || '').trim(),
    md: existsSync(mdPath),
    sidecar: existsSync(sidecarPath),
    pointer: existsSync(pointerPath),
    pointerJson: existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, 'utf-8')) : null,
    home,
  };
}

// ── CONTROL: the real probe. Proves the fixture genuinely produces carryover. ──
{
  const c = runVariant('control', false);
  check('control hook exits 0', c.exit === 0, `exit=${c.exit} stderr=${c.stderr}`);
  check('control writes the session .md', c.md === true);
  check('control writes the task sidecar', c.sidecar === true);
  check('control writes the carryover pointer', c.pointer === true);
  check('control pointer carries the open task #4242',
    !!c.pointerJson && Array.isArray(c.pointerJson.open_tasks) && c.pointerJson.open_tasks.some(t => String(t.id) === '4242'),
    JSON.stringify(c.pointerJson && c.pointerJson.open_tasks));
}

// ── ISOLATED: a probe that throws must not take carryover down with it. ───────
{
  const t = runVariant('throwing', true);
  check('throwing probe: hook still exits 0 (fail-open preserved)', t.exit === 0, `exit=${t.exit} stderr=${t.stderr}`);
  check('throwing probe: session .md still written', t.md === true);
  // THE REGRESSION. Both of these were FALSE before the probe call got its own
  // try/catch — silently, with exit 0 and an intact .md.
  check('throwing probe: task sidecar STILL written', t.sidecar === true);
  check('throwing probe: carryover pointer STILL written', t.pointer === true);
  check('throwing probe: pointer still carries the open task #4242',
    !!t.pointerJson && Array.isArray(t.pointerJson.open_tasks) && t.pointerJson.open_tasks.some(x => String(x.id) === '4242'),
    JSON.stringify(t.pointerJson && t.pointerJson.open_tasks));
}

// ── the isolation must be LOCAL: nothing else may be swallowed silently ──────
{
  const src = readFileSync(join(ROOT, 'hooks', 'prism-session-end.mjs'), 'utf-8');
  check('session-end still calls probeTaskApiTranscript', /probeTaskApiTranscript\(/.test(src));
  check('session-end still emits task_api_unavailable', /task_api_unavailable/.test(src));
}

try { rmSync(scratch, {recursive: true, force: true}); } catch {}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
