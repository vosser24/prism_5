#!/usr/bin/env node
// F13 — /prism-audit-full ships a partial, non-functional harness to manual installs.
//
// Repro: install-manifest.json copies tools/prism-audit-runner.mjs to a manual
// install's ~/.claude/tools/, but NOT tests/v3/audit-scenarios.json or
// tests/v3/analyze-audit.mjs (those live only in a source-repo checkout).
// The runner's default scenariosPath is join(__dirname, '..', 'tests/v3/audit-scenarios.json')
// — so on a manual install it resolves to ~/.claude/tests/v3/audit-scenarios.json,
// which never exists, and the runner FATALs with a bare "file not found" that
// does not explain WHY or what to do instead.
//
// This test simulates the manual-install directory shape (runner present,
// no sibling tests/ dir at all) and asserts the runner's FATAL message
// explains the manual-install condition and points at an alternative,
// rather than the current bare "scenarios file not found at <path>".
//
// Run: node tests/v3/test-audit-runner-manual-install.mjs
// Exit: 0 = all pass; 1 = any failure.

import {mkdtempSync, mkdirSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const RUNNER_SRC = join(REPO, 'tools', 'prism-audit-runner.mjs');
const HOME_HELPER_SRC = join(REPO, 'hooks', 'lib', 'prism-home.mjs');

let pass = 0, fail = 0;
async function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

await test('manual-install shape (runner present, no sibling tests/) gets an explained abort, not a bare "file not found"', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'prism-f13-manual-install-'));
  try {
    // Mimic install-manifest.json's real manual-install shape: tools/ gets the
    // runner, but tests/ is never copied (confirmed against tools/install-manifest.json).
    const toolsDir = join(tmp, 'tools');
    mkdirSync(toolsDir, {recursive: true});
    copyFileSync(RUNNER_SRC, join(toolsDir, 'prism-audit-runner.mjs'));
    const hooksLibDir = join(tmp, 'hooks', 'lib');
    mkdirSync(hooksLibDir, {recursive: true});
    copyFileSync(HOME_HELPER_SRC, join(hooksLibDir, 'prism-home.mjs'));
    // Deliberately do NOT create <tmp>/tests — that's the manual-install condition.

    const r = spawnSync(process.execPath, [join(toolsDir, 'prism-audit-runner.mjs')], {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: 15000,
    });

    assert(r.status !== 0, `expected non-zero exit on missing scenarios, got ${r.status}`);
    const stderr = r.stderr || '';
    assert(stderr.length > 0, 'expected a non-empty stderr message (not a silent swallow)');
    assert(/manual install/i.test(stderr),
      `expected stderr to explain the manual-install condition; got:\n${stderr}`);
    assert(/prism-audit\b/.test(stderr),
      `expected stderr to name the working alternative (/prism-audit); got:\n${stderr}`);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
