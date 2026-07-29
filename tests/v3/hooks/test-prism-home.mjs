#!/usr/bin/env node
// TDD for hooks/lib/prism-home.mjs — the validating home-path resolver that
// kills the `undefined/.claude/...` artifact bug (USERPROFILE supplied as the
// literal string "undefined" by some Windows hook contexts; truthy, so the old
// `HOME || USERPROFILE` returned it verbatim → join("undefined", ".claude")).
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
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

// ---------------------------------------------------------------------------
// PRISM task #22 (F21): repo-scan so the raw HOME-resolution idiom
// (`process.env.HOME || process.env.USERPROFILE`, or a bare `os.homedir()`
// fallback) cannot silently reappear in hooks/ or tools/ now that all 64
// genuine sites have been migrated to prismHome().
//
// D084-scoping (locked): "a check that greps a whole artifact whose prose
// discusses the identifier under test is self-satisfying." This scan is
// scoped to avoid that trap two ways:
//   1. It walks `git ls-files hooks tools` (tracked .mjs files only — same
//      discovery mode as tests/v3/run-all.sh, so gitignored/local junk can't
//      hide a real site or inflate a fake one). It does NOT touch tests/, so
//      THIS file's own comments/fixtures — which necessarily discuss the
//      idiom in prose (this header) and in the detection regex itself — are
//      out of scope by directory. (Deliberately NOT asserting "this file has
//      zero matches for the idiom regex": that assertion is false on its
//      face — the regex literal and this allowlist comment both contain the
//      strings being matched — and a scan that had to launder its own source
//      clean would be a worse trap than the one D084 warns about.)
//   2. Within the scanned files, hooks/lib/prism-home.mjs (the implementation
//      itself — raw usage there IS the mechanism, D057) is excluded by exact
//      path, and the two documentation-comment lines named in the ticket
//      (tools/lib/prism-kb-knowledge-query.mjs and tools/prism-knowledge-index.mjs)
//      are excluded by exact LINE TEXT, not by whole-file — so if a genuine
//      raw HOME site were later added anywhere else in those two files, this
//      scan would still catch it.
await test('repo-scan: no raw HOME/USERPROFILE/os.homedir() idiom remains in hooks/ or tools/ outside prismHome()', () => {
  const IDIOM_RE = /process\.env\.HOME\b|process\.env\.USERPROFILE\b|os\.homedir\(\)/;
  // git ls-files always emits forward-slash-separated paths regardless of OS,
  // so these keys need no separator normalization.
  const DEFINITION_FILE = 'hooks/lib/prism-home.mjs';
  // Exact allowed LINE TEXT (not whole-file exemptions) — a new raw site
  // added anywhere else in these same two files still fails the scan.
  const ALLOWED_LINES = new Map([
    ['tools/lib/prism-kb-knowledge-query.mjs', new Set([
      '//   home          string   default os.homedir()',
    ])],
    ['tools/prism-knowledge-index.mjs', new Set([
      '//   - HOME: process.env.HOME || process.env.USERPROFILE',
    ])],
  ]);

  const lsOut = execFileSync('git', ['ls-files', '--', 'hooks', 'tools'], {cwd: REPO_ROOT, encoding: 'utf8'});
  const files = lsOut.split('\n').map(l => l.trim()).filter(l => l.endsWith('.mjs'));
  assert(files.length > 0, 'git ls-files returned no .mjs files under hooks/tools — scan scope is empty, check cwd/REPO_ROOT');

  const offenders = [];
  for (const rel of files) {
    if (rel === DEFINITION_FILE) continue;
    const abs = join(REPO_ROOT, ...rel.split('/'));
    const lines = readFileSync(abs, 'utf8').split('\n');
    const allowedSet = ALLOWED_LINES.get(rel);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!IDIOM_RE.test(line)) continue;
      if (allowedSet && allowedSet.has(line.trim())) continue;
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
  assert(offenders.length === 0, `raw HOME idiom found outside prismHome() call sites (migrate to prismHome() or update the allowlist if this is a deliberate new documented example):\n  ${offenders.join('\n  ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
