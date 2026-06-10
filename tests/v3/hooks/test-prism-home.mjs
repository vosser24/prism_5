#!/usr/bin/env node
// TDD for hooks/lib/prism-home.mjs — the validating home-path resolver that
// kills the `undefined/.claude/...` artifact bug (USERPROFILE supplied as the
// literal string "undefined" by some Windows hook contexts; truthy, so the old
// `HOME || USERPROFILE` returned it verbatim → join("undefined", ".claude")).
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-home.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function withEnv(env, fn) {
  const keys = ['HOME', 'USERPROFILE'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    return fn();
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const {prismHome} = await import(pathToFileURL(LIB).href);

await test('returns HOME when HOME is a valid existing dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-home-a-'));
  try { withEnv({HOME: home, USERPROFILE: undefined}, () => assert(prismHome() === home, 'should return HOME')); }
  finally { rmSync(home, {recursive: true, force: true}); }
});

await test('falls back to USERPROFILE when HOME is unset', async () => {
  const up = mkdtempSync(join(tmpdir(), 'prism-home-b-'));
  try { withEnv({HOME: undefined, USERPROFILE: up}, () => assert(prismHome() === up, 'should return USERPROFILE')); }
  finally { rmSync(up, {recursive: true, force: true}); }
});

await test('rejects the literal string "undefined" (the bug) — never returns it', async () => {
  withEnv({HOME: undefined, USERPROFILE: 'undefined'}, () => {
    const h = prismHome();
    assert(h !== 'undefined', 'must not return literal "undefined", got: ' + h);
    assert(existsSync(h), 'resolved home must be an existing path, got: ' + h);
  });
});

await test('rejects "null" and empty string', async () => {
  withEnv({HOME: '', USERPROFILE: 'null'}, () => {
    const h = prismHome();
    assert(h !== '' && h !== 'null', 'must reject empty/null, got: ' + h);
    assert(existsSync(h), 'resolved home must exist, got: ' + h);
  });
});

await test('prefers a valid USERPROFILE over an "undefined" HOME', async () => {
  const up = mkdtempSync(join(tmpdir(), 'prism-home-c-'));
  try { withEnv({HOME: 'undefined', USERPROFILE: up}, () => assert(prismHome() === up, 'should skip bad HOME for good USERPROFILE')); }
  finally { rmSync(up, {recursive: true, force: true}); }
});

await test('never returns a non-existent path even when all env is bad', async () => {
  withEnv({HOME: 'undefined', USERPROFILE: 'undefined'}, () => {
    const h = prismHome();
    assert(typeof h === 'string' && h.length > 0, 'returns a string');
    assert(existsSync(h), 'last-resort home must exist, got: ' + h);
  });
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
