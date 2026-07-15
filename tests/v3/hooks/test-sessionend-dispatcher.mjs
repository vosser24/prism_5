#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdtempSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
let pass = 0, fail = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log(`  ok  ${name}`); }, e => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }); }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-se-${label}-`)); }

// ─── Task 4.1: prism-clean-nudge-flag ───────────────────────────────────────

await test('clean-nudge-flag run() no-ops when reason != clear', async () => {
  const home = fakeHome('cnf-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-clean-nudge-flag.mjs')).href);
    assert(typeof mod.run === 'function', 'clean-nudge-flag must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({reason: 'exit', cwd: home});
      assert(res.exit === 0, 'exit 0');
      assert(!existsSync(join(home, '.claude', '.prism-flags')), 'no flag written for non-clear reason');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 4.2: prism-git-clean-nudge ────────────────────────────────────────

await test('git-clean-nudge run() no-ops when reason == clear', async () => {
  const home = fakeHome('gcn-run');
  try {
    const mod = await import(pathToFileURL(join(HOOKS, 'prism-git-clean-nudge.mjs')).href);
    assert(typeof mod.run === 'function', 'git-clean-nudge must export run()');
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({reason: 'clear', cwd: home});
      assert(res.exit === 0, 'exit 0 + skips when reason=clear');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── Task 4.3: SessionEnd dispatcher ────────────────────────────────────────

await test('SessionEnd dispatcher: reason=clear writes clean-nudge flag, not git-dirty', async () => {
  const home = fakeHome('se-disp-clear');
  try {
    const DISP = join(HOOKS, 'prism-sessionend-dispatcher.mjs');
    const r = spawnSync(process.execPath, [DISP], {
      input: JSON.stringify({reason: 'clear', cwd: home, session_id: 's'}),
      encoding: 'utf8', env: {...process.env, HOME: home, USERPROFILE: home},
    });
    assert(r.status === 0, 'exit 0, stderr=' + r.stderr);
    assert(existsSync(join(home, '.claude', '.prism-flags')), 'clean-nudge flag dir created on reason=clear');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
