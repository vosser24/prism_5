#!/usr/bin/env node
// Tests for hooks/lib/nlm-call.sh — hard-timeout wrapper for NotebookLM (F11/F13).
//
// Three cases driven via spawnSync, substituting NLM_BIN with stubs:
//   1. hang (sleep 60, NLM_TIMEOUT=2)  → returns <5s, exit 3, stderr has timeout msg
//   2. success (echo ok, exit 0)       → exit 0, stdout carries "ok"
//   3. error (exit 1, print HTTP 502)  → non-zero, output carries "502"
//
// Run: node tests/v3/agents/test-notebooklm-timeout-wrapper.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'nlm-call.sh');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function makeStub(content) {
  const dir = mkdtempSync(join(tmpdir(), 'nlm-stub-'));
  const stub = join(dir, 'nlm-stub.sh');
  writeFileSync(stub, content);
  chmodSync(stub, 0o755);
  return {stub, dir};
}

// Case 1: hang → returns within timeout, exit 3, stderr has timeout marker
test('hang stub (NLM_TIMEOUT=2, sleep 60) → exit 3, stderr timeout msg, <5s wall clock', () => {
  const {stub, dir} = makeStub('#!/usr/bin/env sh\nsleep 60\n');
  try {
    const before = Date.now();
    const r = spawnSync('sh', [WRAPPER, 'source', 'add-research', 'test query'], {
      env: {...process.env, NLM_BIN: stub, NLM_TIMEOUT: '2', NLM_KILL_AFTER: '2'},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    const elapsed = Date.now() - before;
    assert(elapsed < 5000, `should return in <5s but took ${elapsed}ms`);
    assert(r.status === 3, `exit should be 3 (timeout normalized) but was ${r.status}`);
    assert((r.stderr || '').includes('NotebookLM call timed out'),
      `stderr must contain timeout msg: ${JSON.stringify(r.stderr)}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Case 2: success → exit 0, stdout carries "ok"
test('success stub (echo ok, exit 0) → exit 0, stdout="ok"', () => {
  const {stub, dir} = makeStub('#!/usr/bin/env sh\necho ok\n');
  try {
    const r = spawnSync('sh', [WRAPPER, '--version'], {
      env: {...process.env, NLM_BIN: stub},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert(r.status === 0, `exit should be 0 but was ${r.status}`);
    assert((r.stdout || '').includes('ok'), `stdout must include "ok": ${JSON.stringify(r.stdout)}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Case 3: error passthrough (exit 1, prints HTTP 502)
test('error stub (exit 1, HTTP 502) → non-zero exit, output carries "502"', () => {
  const {stub, dir} = makeStub('#!/usr/bin/env sh\necho "HTTP 502 Bad Gateway"\nexit 1\n');
  try {
    const r = spawnSync('sh', [WRAPPER, 'source', 'add-research', 'test query'], {
      env: {...process.env, NLM_BIN: stub},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert(r.status !== 0, `exit should be non-zero but was ${r.status}`);
    const combined = (r.stdout || '') + (r.stderr || '');
    assert(combined.includes('502'), `output must carry "502": stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
