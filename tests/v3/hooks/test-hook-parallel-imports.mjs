#!/usr/bin/env node
// tests/v3/hooks/test-hook-parallel-imports.mjs
// E-P1: prism-hook.mjs top-level imports must run in parallel, not serial.
// Assertion: first run() after fresh module load completes < 280ms.
// (Serial path ≥380ms; parallel path ≤~200ms on Windows.)
import {mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-hook.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

const home = mkdtempSync(join(tmpdir(), 'prism-ep1-'));
mkdirSync(join(home, '.claude'), {recursive: true});
const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
process.env.HOME = home; process.env.USERPROFILE = home;

try {
  const mod = await import(pathToFileURL(HOOK).href);

  await test('top-level imports complete in parallel (wall-clock < 280ms)', async () => {
    const t0 = Date.now();
    await mod.run({prompt: 'hello world', session_id: 'test-ep1'});
    const elapsed = Date.now() - t0;
    assert(elapsed < 280, `elapsed ${elapsed}ms — imports are still sequential (serial floor ≈380ms)`);
  });

  await test('run() still returns exit:0 and string stdout after parallel import', async () => {
    const res = await mod.run({prompt: 'hello world', session_id: 'test-ep1b'});
    assert(res && res.exit === 0, `exit should be 0, got ${res && res.exit}`);
    assert(typeof res.stdout === 'string', 'stdout must be string');
  });
} finally {
  process.env.HOME = prevH; process.env.USERPROFILE = prevU;
  rmSync(home, {recursive: true, force: true});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
