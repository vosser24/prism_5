#!/usr/bin/env node
// Unit test for the updatedInput plumbing added to
// hooks/prism-pretooluse-dispatcher.mjs (Package B, task 1).
//
// Imports the dispatcher's exported normalize() + consolidate() directly and
// drives them with SYNTHETIC per-guard results. Importing the module MUST NOT
// run its main() (guarded by the `__isMain` check) — if it did, this process
// would block on stdin.
//
// Asserts the documented precedence:
//   (1) no-updatedInput  → byte-identical behavior to the pre-change dispatcher
//   (2) single updatedInput + all-allow → consolidated allow carries it
//   (3) updatedInput + sibling deny → DENY wins, updatedInput dropped
//   (4) updatedInput + sibling ask  → ASK wins, updatedInput dropped
//   (5) two updatedInputs, same field → first-writer wins + a warning logged
//       (plus: disjoint keys merge with NO warning)

import {pathToFileURL, fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', '..', 'hooks', 'prism-pretooluse-dispatcher.mjs');
const {normalize, consolidate} = await import(pathToFileURL(DISPATCHER).href);

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  PASS  ${name}`); }
function bad(name, msg) { fail++; console.log(`  FAIL  ${name}\n        ${msg}`); }
function check(name, cond, msg) { if (cond) ok(name); else bad(name, msg || 'assertion failed'); }

// Build a decision from a synthetic guard {exit, stdout, stderr}, tagged source.
function dec(source, r) { const d = normalize(r); d.source = source; return d; }
const allowCtx = (src, text) => dec(src, {exit: 0, stdout: text, stderr: ''});
const allowUpd = (src, updatedInput) => dec(src, {exit: 0, stdout: JSON.stringify({hookSpecificOutput: {updatedInput}}), stderr: ''});
const denyG = (src, reason) => dec(src, {exit: 2, stdout: '', stderr: reason});
const askG = (src, reason) => dec(src, {exit: 0, stdout: JSON.stringify({hookSpecificOutput: {permissionDecision: 'ask', permissionDecisionReason: reason}}), stderr: ''});

// ---- CASE 1: no updatedInput anywhere → behavior byte-identical to before ----

// 1a. all-allow with advisory context — expected exact bytes (old dispatcher shape)
{
  const out = consolidate([allowCtx('g1', 'alpha'), allowCtx('g2', 'beta')]);
  const expected = JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: 'alpha\nbeta'}});
  check('1a allow+context → byte-identical additionalContext, exit 0',
    out.exit === 0 && out.stdout === expected && out.warnings.length === 0,
    `exit=${out.exit} stdout=${out.stdout}`);
}

// 1b. all-allow with NO context and NO updatedInput → empty stdout (write nothing)
{
  const out = consolidate([allowCtx('g1', ''), allowCtx('g2', '')]);
  check('1b allow, empty → stdout "" (writes nothing), exit 0',
    out.exit === 0 && out.stdout === '' && out.warnings.length === 0,
    `exit=${out.exit} stdout=${JSON.stringify(out.stdout)}`);
}

// 1c. a deny still denies (exit 2, deny JSON)
{
  const out = consolidate([allowCtx('g1', 'note'), denyG('g2', 'blocked reason')]);
  const expected = JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked reason'}});
  check('1c deny → exit 2 + deny JSON (byte-identical)',
    out.exit === 2 && out.stdout === expected && out.stderr === 'blocked reason',
    `exit=${out.exit} stdout=${out.stdout}`);
}

// 1d. an ask still asks (exit 0, ask JSON with combined context)
{
  const out = consolidate([askG('g1', 'confirm?'), allowCtx('g2', 'ctx')]);
  const expected = JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'confirm?', additionalContext: 'ctx'}});
  check('1d ask → exit 0 + ask JSON (byte-identical)',
    out.exit === 0 && out.stdout === expected,
    `exit=${out.exit} stdout=${out.stdout}`);
}

// ---- CASE 2: single updatedInput + all-allow → allow carries updatedInput ----
{
  const out = consolidate([allowCtx('g1', ''), allowUpd('g2', {model: 'haiku'})]);
  let parsed = null; try { parsed = JSON.parse(out.stdout); } catch {}
  const ui = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput;
  check('2 single updatedInput + all-allow → consolidated allow carries it',
    out.exit === 0 && ui && ui.model === 'haiku' && out.warnings.length === 0,
    `exit=${out.exit} stdout=${out.stdout}`);
}

// 2b. updatedInput coexists with an advisory context
{
  const out = consolidate([allowCtx('g1', 'note'), allowUpd('g2', {model: 'haiku'})]);
  const parsed = JSON.parse(out.stdout);
  const hso = parsed.hookSpecificOutput;
  check('2b updatedInput + context both present',
    hso.additionalContext === 'note' && hso.updatedInput.model === 'haiku',
    `stdout=${out.stdout}`);
}

// ---- CASE 3: updatedInput + sibling deny → DENY wins, updatedInput dropped ----
{
  const out = consolidate([allowUpd('g1', {model: 'haiku'}), denyG('g2', 'nope')]);
  check('3 deny wins over sibling updatedInput (dropped)',
    out.exit === 2 && !/updatedInput/.test(out.stdout) && /permissionDecision":"deny/.test(out.stdout),
    `exit=${out.exit} stdout=${out.stdout}`);
}

// ---- CASE 4: updatedInput + sibling ask → ASK wins, updatedInput dropped ----
{
  const out = consolidate([allowUpd('g1', {model: 'haiku'}), askG('g2', 'sure?')]);
  check('4 ask wins over sibling updatedInput (dropped)',
    out.exit === 0 && !/updatedInput/.test(out.stdout) && /permissionDecision":"ask/.test(out.stdout),
    `exit=${out.exit} stdout=${out.stdout}`);
}

// ---- CASE 5: two updatedInputs, SAME field → first-writer wins + warning ----
{
  // g1 is earlier in route order → its value is kept, g2's is dropped + warned.
  const out = consolidate([allowUpd('g1', {model: 'haiku'}), allowUpd('g2', {model: 'sonnet'})]);
  const ui = JSON.parse(out.stdout).hookSpecificOutput.updatedInput;
  const w = out.warnings[0];
  check('5 same-field conflict → first writer kept (haiku)',
    ui.model === 'haiku', `merged model=${ui && ui.model}`);
  check('5 same-field conflict → exactly one warning, correctly attributed',
    out.warnings.length === 1 && w && w.field === 'model' && w.keptFrom === 'g1' && w.droppedFrom === 'g2' && w.kept === 'haiku' && w.dropped === 'sonnet',
    `warnings=${JSON.stringify(out.warnings)}`);
}

// 5b. DISJOINT keys → merged, NO warning
{
  const out = consolidate([allowUpd('g1', {model: 'haiku'}), allowUpd('g2', {prompt: 'x'})]);
  const ui = JSON.parse(out.stdout).hookSpecificOutput.updatedInput;
  check('5b disjoint keys merge with no warning',
    ui.model === 'haiku' && ui.prompt === 'x' && out.warnings.length === 0,
    `ui=${JSON.stringify(ui)} warnings=${out.warnings.length}`);
}

// ---- normalize() sanity: array/non-object updatedInput is ignored ----
{
  const d = normalize({exit: 0, stdout: JSON.stringify({hookSpecificOutput: {updatedInput: ['bad']}}), stderr: ''});
  check('normalize ignores non-object updatedInput (array)',
    d.kind === 'allow' && d.updatedInput === undefined,
    `updatedInput=${JSON.stringify(d.updatedInput)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
