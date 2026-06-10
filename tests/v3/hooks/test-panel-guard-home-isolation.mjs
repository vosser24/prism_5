#!/usr/bin/env node
// TDD for prism-panel-guard.mjs home-path resolution (handoff PENDING: panel-
// guard captures `const H` / LOG_PATH / POLICY_PATH / ROSTER_PATH at MODULE
// LOAD. Under the in-process dispatcher this both (a) defeats test isolation —
// a single import freezes HOME for the whole process — and (b) inherits the
// `undefined/` bug. Fix: resolve home (via prismHome) at CALL time inside the
// functions. This test imports ONCE under home A, flips HOME to B, and asserts
// the home-derived write lands under B.
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-panel-guard.mjs');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const homeA = mkdtempSync(join(tmpdir(), 'prism-pg-A-'));
const homeB = mkdtempSync(join(tmpdir(), 'prism-pg-B-'));
const prevH = process.env.HOME, prevU = process.env.USERPROFILE, prevMode = process.env.PRISM_PANEL_GUARD;

try {
  // Import the module while HOME=A. A module-top `const H` freezes A here.
  process.env.HOME = homeA; process.env.USERPROFILE = homeA;
  delete process.env.PRISM_PANEL_GUARD; // default 'soft' so the no-personas path runs + logs
  const mod = await import(pathToFileURL(HOOK).href);
  assert(typeof mod.runSubagentStop === 'function', 'panel-guard must export runSubagentStop');

  await test('home-derived writes follow the CURRENT env, not the import-time env', async () => {
    // Flip HOME to B AFTER import.
    process.env.HOME = homeB; process.env.USERPROFILE = homeB;
    const res = mod.runSubagentStop({
      subagent_type: 'panel',
      output: 'the analysis is complete and fully indexed; nothing to flag here.',
      session_id: 'iso',
    });
    assert(res.exit === 0, 'soft no-personas path exits 0');
    const logB = join(homeB, '.claude', '.prism-routing.jsonl');
    const logA = join(homeA, '.claude', '.prism-routing.jsonl');
    assert(existsSync(logB), 'routing log must be written under the CURRENT home B (lazy resolution)');
    assert(!existsSync(logA), 'must NOT write under the import-time home A (module-top capture bug)');
  });
} finally {
  if (prevH === undefined) delete process.env.HOME; else process.env.HOME = prevH;
  if (prevU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevU;
  if (prevMode === undefined) delete process.env.PRISM_PANEL_GUARD; else process.env.PRISM_PANEL_GUARD = prevMode;
  rmSync(homeA, {recursive: true, force: true});
  rmSync(homeB, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
