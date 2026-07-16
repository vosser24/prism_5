#!/usr/bin/env node
// Task #17 (2026-07-16) — SendMessage joins the PreToolUse pipeline.
//
// Proves BOTH paths (D042) end-to-end through the REAL dispatcher subprocess
// (exactly how Claude Code invokes it), with an isolated HOME so no state
// leaks into the real ~/.claude:
//   FIRES: a SendMessage that ASSIGNS work → dispatch-preamble clauses are
//          appended to tool_input.message via updatedInput.
//   QUIET: ordinary teammate traffic — a status relay, a question, and a
//          structured protocol message — passes through byte-untouched.
//   KILL-SWITCH: PRISM_SENDMESSAGE_ROUTE=off restores pre-#17 behavior.
//   IDEMPOTENT: a message already carrying the preamble tag is not doubled.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); } }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function runDispatcher(payload, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-smp-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...env},
    });
    return {exit: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim()};
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

const ASSIGNMENT =
  'New task — TASK #99: build the widget. You are a PRISM worker in this repo. ' +
  'GOAL: the widget exists and is tested. BUILD: add widget.mjs under tools/. ' +
  'ACCEPTANCE: both paths demonstrated — fires on bad input, quiet on good. ' +
  'Deliverable: paste real command output. Budget ~20 tool calls.';

const STATUS_RELAY =
  'PHASE 3 complete. Both deliverables shipped; every claim source-verified against the on-disk files. ' +
  'The census doc is written with the Locked header block, and the deny message fix landed as two ' +
  'string-literal lines with zero control-flow change. Both paths were demonstrated: the guard fires ' +
  'with the honest text on a subagent Agent() call and stays silent on a subagent Edit call.';

const QUESTION =
  'Quick question — should the guard census also cover PostToolUse hooks, or only PreToolUse?';

function send(message, env = {}) {
  return runDispatcher({tool_name: 'SendMessage', session_id: 'smp', tool_input: {to: 'worker-x', summary: 's', message}}, env);
}

test('FIRES: work-assignment message gets the preamble via updatedInput', () => {
  const r = send(ASSIGNMENT);
  assert(r.exit === 0, `exit ${r.exit}`);
  const j = JSON.parse(r.stdout);
  const ui = j.hookSpecificOutput && j.hookSpecificOutput.updatedInput;
  assert(ui && typeof ui.message === 'string', 'updatedInput.message present');
  assert(ui.message.startsWith(ASSIGNMENT), 'original message preserved as prefix');
  assert(ui.message.includes('[PRISM dispatch-preamble]'), 'preamble tag appended');
  assert(ui.message.includes('WRITE YOUR OUTPUT TO DISK'), 'clause 1 present');
  assert(ui.message.includes('REPRODUCE before you fix'), 'clause 3 present');
  assert(ui.to === 'worker-x' && ui.summary === 's', 'sibling fields carried through');
  assert(!j.hookSpecificOutput.permissionDecision, 'never denies/asks');
});

test('QUIET: status relay passes through untouched (no output, exit 0)', () => {
  const r = send(STATUS_RELAY);
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.stdout === '' && r.stderr === '', `expected silence, got stdout=${JSON.stringify(r.stdout)}`);
});

test('QUIET: question passes through untouched (no output, exit 0)', () => {
  const r = send(QUESTION);
  assert(r.exit === 0, `exit ${r.exit}`);
  assert(r.stdout === '' && r.stderr === '', `expected silence, got stdout=${JSON.stringify(r.stdout)}`);
});

test('QUIET: structured protocol message (object, not string) never touched', () => {
  const r = runDispatcher({tool_name: 'SendMessage', session_id: 'smp', tool_input: {to: 'lead', message: {type: 'shutdown_response', request_id: 'x', approve: true}}});
  assert(r.exit === 0 && r.stdout === '' && r.stderr === '', `expected silence, got ${JSON.stringify(r)}`);
});

test('KILL-SWITCH: PRISM_SENDMESSAGE_ROUTE=off restores pre-#17 passthrough', () => {
  const r = send(ASSIGNMENT, {PRISM_SENDMESSAGE_ROUTE: 'off'});
  assert(r.exit === 0 && r.stdout === '' && r.stderr === '', `expected silence, got ${JSON.stringify(r)}`);
});

test('KILL-SWITCH: hook-wide PRISM_DISPATCH_PREAMBLE=off also silences the route', () => {
  const r = send(ASSIGNMENT, {PRISM_DISPATCH_PREAMBLE: 'off'});
  assert(r.exit === 0 && r.stdout === '' && r.stderr === '', `expected silence, got ${JSON.stringify(r)}`);
});

test('IDEMPOTENT: assignment already carrying the tag is not rewritten again', () => {
  const r = send(ASSIGNMENT + '\n---\n[PRISM dispatch-preamble] Before you report a result, hold yourself to these: ...');
  assert(r.exit === 0 && r.stdout === '' && r.stderr === '', `expected silence, got ${JSON.stringify(r)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
