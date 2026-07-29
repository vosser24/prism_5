#!/usr/bin/env node
// Unit tests for tools/lib/atomic-fs.mjs (F33 — bounded EPERM/EACCES/EBUSY
// retry around atomic tmp+rename writes).
//
// Run: node tests/v3/state/test-atomic-fs.mjs
//
// Provenance / RED-before-fix: this reproduces the exact shape of the filed
// bug — tools/prism-clean.mjs's writeMemoryMdAtomic (pre-fix) called the bare
// `renameSync(tmp, path)` below with no retry, so a single transient Windows
// EPERM (AV/indexer momentarily holding the destination handle) aborted a
// whole /prism-clean capture and threw away the already-synthesized
// MEMORY.md body. "bare rename: rethrows immediately, no retry" documents
// that failure mode as it existed before the fix (it exercises fs.renameSync
// directly, not the shared helper, precisely because that IS the pre-fix
// call-site shape). Every test after it exercises renameWithRetry, the
// shared fix now used at that call site (and the 19 other bare/no-retry
// tmp+rename sites found in the same sweep — see report).

import {renameWithRetry, isTransientRenameError} from '../../../tools/lib/atomic-fs.mjs';

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

function makeEpermThenOk(failCount) {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failCount) { const e = new Error('eperm'); e.code = 'EPERM'; throw e; }
  };
}

// ------------------------------------------------------------ pre-fix shape

test('RED-shape: bare rename with no retry rethrows immediately on first EPERM (documents F33)', () => {
  // This is deliberately NOT renameWithRetry — it is the exact pre-fix
  // writeMemoryMdAtomic shape (tools/prism-clean.mjs, pre-F33): one call,
  // no catch, no retry. A single transient EPERM propagates straight out
  // and aborts the caller. If this test ever starts passing differently
  // (i.e. the bare call stops throwing), the fixture below is broken, not
  // the bug — the assertion is on the OLD code shape, kept here as a
  // permanent regression trip-wire so nobody "fixes" this file by quietly
  // adding a retry to it instead of to the real call sites.
  const bareRenameSync = makeEpermThenOk(1);
  let threw = false, code = null;
  try { bareRenameSync(); }
  catch (e) { threw = true; code = e.code; }
  assert(threw, 'bare rename must throw on the very first transient error — no retry exists');
  assertEq(code, 'EPERM');
});

// -------------------------------------------------------- renameWithRetry

test('renameWithRetry: retries then succeeds (survives the same EPERM the bare call above did not)', () => {
  const fn = makeEpermThenOk(2);
  // Must not throw: fn fails on calls 1-2, succeeds on call 3, well within budget.
  renameWithRetry(fn, 'src.tmp', 'dst', {retries: 5, delayMs: 1});
});

test('renameWithRetry: calls exactly N+1 times when N transient failures precede success', () => {
  let calls = 0;
  const fn = () => {
    calls++;
    if (calls <= 2) { const e = new Error('ebusy'); e.code = 'EBUSY'; throw e; }
  };
  renameWithRetry(fn, 'src.tmp', 'dst', {retries: 5, delayMs: 1});
  assertEq(calls, 3, 'fn called exactly 3 times (2 failures + 1 success)');
});

test('renameWithRetry: bounded — gives up after exactly `retries` attempts, does not loop forever', () => {
  let calls = 0;
  const fn = () => { calls++; const e = new Error('eperm'); e.code = 'EPERM'; throw e; };
  let threw = false;
  try { renameWithRetry(fn, 'src.tmp', 'dst', {retries: 3, delayMs: 1}); }
  catch { threw = true; }
  assert(threw, 'should throw after exhausting the retry budget');
  assertEq(calls, 3, 'fn called exactly `retries` times, never more');
});

test('renameWithRetry: original error (code + message) survives exhaustion unchanged', () => {
  const fn = () => { const e = new Error('EPERM: operation not permitted, rename tmp -> dst'); e.code = 'EPERM'; throw e; };
  let caught = null;
  try { renameWithRetry(fn, 'src.tmp', 'dst', {retries: 2, delayMs: 1}); }
  catch (e) { caught = e; }
  assert(caught, 'must throw');
  assertEq(caught.code, 'EPERM', 'code preserved — failure stays diagnosable, not rewritten to a generic "rename failed after retries"');
  assert(caught.message.includes('operation not permitted'), 'original message text preserved verbatim');
});

test('renameWithRetry: non-retryable code (ENOSPC) rethrows immediately, is NOT retried', () => {
  let calls = 0;
  const fn = () => { calls++; const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e; };
  let threw = false, code = null;
  try { renameWithRetry(fn, 'src.tmp', 'dst', {retries: 5, delayMs: 1}); }
  catch (e) { threw = true; code = e.code; }
  assert(threw, 'should throw on non-transient error');
  assertEq(calls, 1, 'fn called exactly once — no retry attempted for a non-transient code');
  assertEq(code, 'ENOSPC', 'original non-transient code preserved');
});

test('renameWithRetry: non-retryable code (ENOENT) rethrows immediately, is NOT retried', () => {
  let calls = 0;
  const fn = () => { calls++; const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
  let threw = false;
  try { renameWithRetry(fn, 'src.tmp', 'dst', {retries: 5, delayMs: 1}); }
  catch { threw = true; }
  assert(threw);
  assertEq(calls, 1, 'ENOENT is not in the transient set — must not be retried');
});

test('renameWithRetry: succeeds first try with zero overhead when there is no contention', () => {
  let calls = 0;
  const fn = () => { calls++; };
  renameWithRetry(fn, 'src.tmp', 'dst', {retries: 5, delayMs: 1});
  assertEq(calls, 1);
});

// ------------------------------------------------------ isTransientRenameError

test('isTransientRenameError: true for EPERM, EACCES, EBUSY', () => {
  assert(isTransientRenameError({code: 'EPERM'}));
  assert(isTransientRenameError({code: 'EACCES'}));
  assert(isTransientRenameError({code: 'EBUSY'}));
});

test('isTransientRenameError: false for other codes and falsy input', () => {
  assert(!isTransientRenameError({code: 'ENOSPC'}));
  assert(!isTransientRenameError({code: 'ENOENT'}));
  assert(!isTransientRenameError(null));
  assert(!isTransientRenameError(undefined));
  assert(!isTransientRenameError({}));
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
