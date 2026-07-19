#!/usr/bin/env node
// v6.6.0 FIX-6 — superpowers nudge TEXT retirement, signal preserved.
//
// hooks/prism-hook.mjs used to push a "PRISM: ... superpowers is installed
// ..." message string for four regex families (TDD, debug, review, worktree).
// The TEXT was retired (redundant with the harness's always-on skill list,
// and some patterns topic-collided on the PRISM repo itself) but the
// regexes' OTHER job — marking "this turn had an expert-task signal", which
// resets gs.trivial_streak and gates the KB-router fallback — must survive
// byte-identical. This test proves both halves: no superpowers text in
// stdout, AND trivial_streak resets to 0 on a matching prompt (signal kept).
// Second case: 5 consecutive non-matching prompts still trips the
// cost-nudge at streak 5 (unchanged baseline).
//
// Run: node tests/v3/hooks/test-hook-superpowers-retirement.mjs

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-hook.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

const home = mkdtempSync(join(tmpdir(), 'prism-fix6-'));
mkdirSync(join(home, '.claude'), { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), 'prism-fix6-cwd-'));
mkdirSync(join(cwd, '.claude'), { recursive: true });

const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
const prevCwd = process.cwd();
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(cwd);

function readGlobalState() {
  const gsf = join(home, '.claude', '.prism-global-state.json');
  if (!existsSync(gsf)) return null;
  return JSON.parse(readFileSync(gsf, 'utf-8'));
}

try {
  const mod = await import(pathToFileURL(HOOK).href);

  await test('TDD-matching prompt: no superpowers TEXT in stdout, signal preserved (trivial_streak resets to 0)', async () => {
    const sessionId = 'fix6-tdd-session';
    const res = await mod.run({ prompt: 'write tests first for the parser', session_id: sessionId });
    assert(res != null && res.exit === 0, 'hook must exit 0');
    assert(!/superpowers is installed/i.test(res.stdout), `stdout must NOT contain the retired superpowers text; got: ${res.stdout}`);

    const gstate = readGlobalState();
    assert(gstate != null, 'global state file must be written');
    const gs = gstate.sessions[sessionId];
    assert(gs != null, 'session entry must exist in global state');
    assert(gs.trivial_streak === 0, `trivial_streak must be 0 (signal preserved) after a TDD-matching prompt, got ${gs.trivial_streak}`);
  });

  await test('debug/review/worktree-matching prompts also carry no superpowers TEXT', async () => {
    const cases = [
      { prompt: 'I keep debugging this and cannot figure out the root cause', session_id: 'fix6-debug-session' },
      { prompt: 'please review my code before I ship', session_id: 'fix6-review-session' },
      { prompt: 'set up a git worktree for this branch', session_id: 'fix6-worktree-session' },
    ];
    for (const c of cases) {
      const res = await mod.run(c);
      assert(res != null && res.exit === 0, `hook must exit 0 for: ${c.prompt}`);
      assert(!/superpowers is installed/i.test(res.stdout), `stdout must NOT contain retired superpowers text for: ${c.prompt}; got: ${res.stdout}`);
    }
  });

  await test('5 consecutive non-matching prompts still trips the cost-nudge at streak 5 (unchanged baseline)', async () => {
    const sessionId = 'fix6-coststreak-session';
    let lastRes = null;
    for (let i = 0; i < 5; i++) {
      lastRes = await mod.run({ prompt: `just chatting turn ${i}, nothing special here`, session_id: sessionId });
      assert(lastRes != null && lastRes.exit === 0, `hook must exit 0 on turn ${i}`);
    }
    assert(/consecutive turns without an expert-task signal/.test(lastRes.stdout),
      `expected cost-nudge to fire at streak 5; got stdout: ${lastRes.stdout}`);

    const gstate = readGlobalState();
    const gs = gstate.sessions[sessionId];
    assert(gs.trivial_streak === 5, `trivial_streak should be 5 after 5 non-matching turns, got ${gs.trivial_streak}`);
  });
} finally {
  process.env.HOME = prevH;
  process.env.USERPROFILE = prevU;
  process.chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
