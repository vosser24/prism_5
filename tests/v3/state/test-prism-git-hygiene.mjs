#!/usr/bin/env node
// Tests for v4.1 Phase A — prism-git-hygiene hook bundle + D005 Phase F.
//
// Covers:
//   - tools/lib/prism-flag-file.mjs (helper unit tests)
//   - hooks/prism-clean-nudge-flag.mjs        (SessionEnd[clear])
//   - hooks/prism-precompact-nudge-flag.mjs   (PreCompact)
//   - hooks/prism-git-clean-nudge.mjs         (SessionEnd dirty-tree)
//   - hooks/prism-prepush-review.mjs          (PreToolUse[Bash])
//   - hooks/prism-session-start.mjs           (flag pickup)
//
// Each test uses an ephemeral $HOME so flag-file writes don't leak
// into the real ~/.claude. Hooks are invoked as subprocesses with
// the harness's JSON-on-stdin contract.
//
// Run: node tests/v3/state/test-prism-git-hygiene.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const HOOK_CLEAN = join(REPO_ROOT, 'hooks', 'prism-clean-nudge-flag.mjs');
const HOOK_PRECOMPACT = join(REPO_ROOT, 'hooks', 'prism-precompact-nudge-flag.mjs');
const HOOK_GIT_CLEAN = join(REPO_ROOT, 'hooks', 'prism-git-clean-nudge.mjs');
const HOOK_PREPUSH = join(REPO_ROOT, 'hooks', 'prism-prepush-review.mjs');
const HOOK_SESSION_START = join(REPO_ROOT, 'hooks', 'prism-session-start.mjs');
const FLAG_HELPER_REPO = join(REPO_ROOT, 'tools', 'lib', 'prism-flag-file.mjs');

let pass = 0, fail = 0;

// Async-aware runner: collect tests, then AWAIT each. The previous harness
// ran fn() synchronously and counted pass++ before any post-`await`
// assertion executed, so async tests false-passed. (v4.7 harness fix.)
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

// Set up an ephemeral $HOME with the flag helper installed at the
// expected path. The hook scripts import via a relative path from
// the hook file, so they read the helper from REPO_ROOT/tools/lib —
// that works in tests because the hook script is invoked from
// REPO_ROOT/hooks/. The session-start hook uses HOME/.claude/tools/lib,
// so we also install the helper there.
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-flag-home-'));
  mkdirSync(join(home, '.claude', 'tools', 'lib'), {recursive: true});
  writeFileSync(
    join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs'),
    readFileSync(FLAG_HELPER_REPO, 'utf-8'),
  );
  return home;
}

function makeGitDir(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-flag-cwd-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  // Default branch name 'main' (avoid 'master' for cross-version stability).
  spawnSync('git', ['checkout', '-qB', 'main'], {cwd: root});
  spawnSync('git', ['config', 'user.email', 'test@example.com'], {cwd: root});
  spawnSync('git', ['config', 'user.name', 'test'], {cwd: root});
  // An initial commit is required so `git rev-parse --abbrev-ref HEAD`
  // resolves a born branch (it exits 128 on an unborn branch, which would
  // make the prepush hook's gate-mode branch lookup fail-open to ''). This
  // also matches reality — you cannot push a commitless repo.
  spawnSync('git', ['commit', '--allow-empty', '-qm', 'init'], {cwd: root});
  return root;
}

function runHook(hookPath, {home, cwd, input, env}) {
  const e = {...process.env, HOME: home, USERPROFILE: home, ...(env || {})};
  const r = spawnSync(process.execPath, [hookPath], {
    cwd: cwd || home,
    encoding: 'utf-8',
    input: JSON.stringify(input || {}),
    env: e,
    timeout: 10000,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function listFlagsFor(home) {
  const dir = join(home, '.claude', '.prism-flags');
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readFlagPayload(home, file) {
  return JSON.parse(readFileSync(join(home, '.claude', '.prism-flags', file), 'utf-8'));
}

// ─────────────────────────────── helper unit tests ──────────────────────────

test('flag-helper: writeFlag creates per-project file', async () => {
  const home = makeHome();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    const cwd = makeGitDir('helper-write');
    try {
      const path = h.writeFlag('git-dirty', cwd, {count: 3});
      assert(existsSync(path), 'flag file should exist');
      const payload = JSON.parse(readFileSync(path, 'utf-8'));
      assertEq(payload.flag, 'git-dirty');
      assertEq(payload.count, 3);
      assert(payload.project, 'payload.project set');
      assert(payload.ts, 'payload.ts set');
    } finally { rmSync(cwd, {recursive: true, force: true}); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('flag-helper: readAndClearFlag returns payload then deletes', async () => {
  const home = makeHome();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    const cwd = makeGitDir('helper-readclear');
    try {
      h.writeFlag('clean-nudge', cwd, {reason: 'clear'});
      const first = h.readAndClearFlag('clean-nudge', cwd);
      assertEq(first.reason, 'clear');
      const second = h.readAndClearFlag('clean-nudge', cwd);
      assertEq(second, null, 'second read returns null');
    } finally { rmSync(cwd, {recursive: true, force: true}); }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('flag-helper: projectKey isolates flags across projects', async () => {
  const home = makeHome();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    const cwdA = makeGitDir('iso-A');
    const cwdB = makeGitDir('iso-B');
    try {
      h.writeFlag('git-dirty', cwdA, {count: 1});
      h.writeFlag('git-dirty', cwdB, {count: 9});
      const fromA = h.readAndClearFlag('git-dirty', cwdA);
      const fromB = h.readAndClearFlag('git-dirty', cwdB);
      assertEq(fromA.count, 1);
      assertEq(fromB.count, 9);
    } finally {
      rmSync(cwdA, {recursive: true, force: true});
      rmSync(cwdB, {recursive: true, force: true});
    }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('flag-helper: rejects invalid flag names', async () => {
  const home = makeHome();
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    let threw = false;
    try { h.writeFlag('../evil', process.cwd(), {}); } catch { threw = true; }
    assert(threw, 'should reject path-traversal flag name');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ────────────────────── prism-clean-nudge-flag tests ────────────────────────

test('clean-nudge-flag: writes flag when reason=clear', () => {
  const home = makeHome();
  const cwd = makeGitDir('cnf-1');
  try {
    const r = runHook(HOOK_CLEAN, {home, cwd, input: {reason: 'clear', cwd, session_id: 's1'}});
    assertEq(r.status, 0, r.stderr);
    const flags = listFlagsFor(home);
    const cleanFlag = flags.find((f) => f.startsWith('clean-nudge__'));
    assert(cleanFlag, 'clean-nudge flag should exist: ' + JSON.stringify(flags));
    const p = readFlagPayload(home, cleanFlag);
    assertEq(p.reason, 'clear');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('clean-nudge-flag: skips when reason != clear (defensive)', () => {
  const home = makeHome();
  const cwd = makeGitDir('cnf-2');
  try {
    const r = runHook(HOOK_CLEAN, {home, cwd, input: {reason: 'exit', cwd}});
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('clean-nudge-flag: off-switch respected', () => {
  const home = makeHome();
  const cwd = makeGitDir('cnf-3');
  try {
    const r = runHook(HOOK_CLEAN, {
      home, cwd,
      input: {reason: 'clear', cwd},
      env: {PRISM_DISABLE_CLEAR_NUDGE: '1'},
    });
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

// ─────────────────── prism-precompact-nudge-flag tests ──────────────────────

test('precompact-nudge-flag: writes flag on any invocation', () => {
  const home = makeHome();
  const cwd = makeGitDir('pcnf-1');
  try {
    const r = runHook(HOOK_PRECOMPACT, {home, cwd, input: {cwd}});
    assertEq(r.status, 0, r.stderr);
    const flags = listFlagsFor(home);
    const flag = flags.find((f) => f.startsWith('clean-nudge__'));
    assert(flag, 'should write clean-nudge flag');
    const p = readFlagPayload(home, flag);
    assertEq(p.reason, 'precompact');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('precompact-nudge-flag: off-switch respected', () => {
  const home = makeHome();
  const cwd = makeGitDir('pcnf-2');
  try {
    const r = runHook(HOOK_PRECOMPACT, {
      home, cwd,
      input: {cwd},
      env: {PRISM_DISABLE_PRECOMPACT_NUDGE: '1'},
    });
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

// ─────────────────────── prism-git-clean-nudge tests ────────────────────────

test('git-clean-nudge: writes flag when working tree dirty', () => {
  const home = makeHome();
  const cwd = makeGitDir('gcn-1');
  try {
    writeFileSync(join(cwd, 'unstaged.txt'), 'pending\n');
    const r = runHook(HOOK_GIT_CLEAN, {home, cwd, input: {reason: 'exit', cwd}});
    assertEq(r.status, 0, r.stderr);
    const flags = listFlagsFor(home);
    const flag = flags.find((f) => f.startsWith('git-dirty__'));
    assert(flag, 'should write git-dirty flag');
    const p = readFlagPayload(home, flag);
    assert(p.count >= 1, 'count should reflect dirty entries');
    assert(Array.isArray(p.sample) && p.sample.length >= 1, 'sample populated');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('git-clean-nudge: no flag when working tree clean', () => {
  const home = makeHome();
  const cwd = makeGitDir('gcn-2');
  try {
    const r = runHook(HOOK_GIT_CLEAN, {home, cwd, input: {reason: 'exit', cwd}});
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0, 'no flag on clean tree');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('git-clean-nudge: no flag in non-git directory', () => {
  const home = makeHome();
  const cwd = mkdtempSync(join(tmpdir(), 'prism-flag-nogit-'));
  try {
    const r = runHook(HOOK_GIT_CLEAN, {home, cwd, input: {reason: 'exit', cwd}});
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('git-clean-nudge: skips when reason=clear (clean-nudge owns that path)', () => {
  const home = makeHome();
  const cwd = makeGitDir('gcn-3');
  try {
    writeFileSync(join(cwd, 'unstaged.txt'), 'pending\n');
    const r = runHook(HOOK_GIT_CLEAN, {home, cwd, input: {reason: 'clear', cwd}});
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('git-clean-nudge: off-switch respected', () => {
  const home = makeHome();
  const cwd = makeGitDir('gcn-4');
  try {
    writeFileSync(join(cwd, 'unstaged.txt'), 'pending\n');
    const r = runHook(HOOK_GIT_CLEAN, {
      home, cwd,
      input: {reason: 'exit', cwd},
      env: {PRISM_DISABLE_GIT_CLEAN_NUDGE: '1'},
    });
    assertEq(r.status, 0);
    assertEq(listFlagsFor(home).length, 0);
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

// ───────────────────── prism-prepush-review tests ───────────────────────────

test('prepush-review: emits ask + additionalContext on git push (both inside hookSpecificOutput)', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-1');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'git push origin feature-branch'}, cwd},
    });
    assertEq(r.status, 0, r.stderr);
    assert(r.stdout && r.stdout.length > 0, 'expected JSON on stdout');
    const obj = JSON.parse(r.stdout);
    assertEq(obj.hookSpecificOutput.hookEventName, 'PreToolUse');
    assertEq(obj.hookSpecificOutput.permissionDecision, 'ask');
    assert(/code-review/.test(obj.hookSpecificOutput.permissionDecisionReason), 'reason mentions code-review');
    // additionalContext MUST be inside hookSpecificOutput per Claude Code's
    // PreToolUse output schema (matches every other PreToolUse hook in
    // this codebase). Top-level additionalContext is discarded.
    assert(obj.hookSpecificOutput.additionalContext, 'additionalContext must be inside hookSpecificOutput');
    assert(/code-review/.test(obj.hookSpecificOutput.additionalContext), 'nested context mentions code-review');
    assert(!('additionalContext' in obj), 'no top-level additionalContext (would be discarded)');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: silent on git push --dry-run (no ask for preview-only pushes)', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-1b');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'git push --dry-run origin main'}, cwd},
    });
    assertEq(r.status, 0, r.stderr);
    assertEq(r.stdout, '', 'no nudge for --dry-run');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: silent on git push --help (doc lookup, not a push)', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-1c');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'git push --help'}, cwd},
    });
    assertEq(r.status, 0, r.stderr);
    assertEq(r.stdout, '');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: silent on non-push Bash commands', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-2');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'ls -la'}, cwd},
    });
    assertEq(r.status, 0);
    assertEq(r.stdout, '', 'no stdout for non-push commands');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: silent on commands that merely contain "push" but aren\'t git push', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-2b');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'echo pushing changes'}, cwd},
    });
    assertEq(r.status, 0);
    assertEq(r.stdout, '');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: silent when a commit message merely MENTIONS "git push" (over-fire fix, UAT prompt 28)', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-2c');
  try {
    // A documentation commit whose -m body cites the very patterns this repo
    // blocks — including the literal text "git push --force". No push is
    // happening; the prepush nudge must NOT fire. (Pre-fix it scanned the RAW
    // command and matched the quoted token — same over-fire class the safety
    // gate fixed via de-quote.)
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command:
        `git commit --allow-empty -m 'docs: refuse dangerous patterns' ` +
        `-m 'blocks rm -rf /, git push --force, mkfs.* and dd if=*of=/dev/*'`}, cwd},
    });
    assertEq(r.status, 0, r.stderr);
    assertEq(r.stdout, '', 'commit message mentioning "git push" must not nudge');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: STILL nudges on a compound real push (unquoted push survives de-quote)', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-2d');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: `git commit -m 'ship it' && git push origin main`}, cwd},
    });
    assertEq(r.status, 0, r.stderr);
    assert(r.stdout && r.stdout.length > 0, 'a real push after && must still nudge');
    const obj = JSON.parse(r.stdout);
    assertEq(obj.hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: review-done gate-mode flag suppresses the ask', async () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-3');
  try {
    // Pre-seed review-done flag for the current branch (main).
    // HOME must point at the temp home BEFORE importing the helper — it
    // captures HOME at module-eval, and the spawned hook reads the same home.
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    h.writeFlag('review-done', cwd, {branch: 'main'});
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'git push origin main'}, cwd},
    });
    assertEq(r.status, 0);
    assertEq(r.stdout, '', 'gate-mode flag should suppress nudge');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('prepush-review: off-switch respected', () => {
  const home = makeHome();
  const cwd = makeGitDir('pp-4');
  try {
    const r = runHook(HOOK_PREPUSH, {
      home, cwd,
      input: {tool_input: {command: 'git push origin main'}, cwd},
      env: {PRISM_DISABLE_PREPUSH_NUDGE: '1'},
    });
    assertEq(r.status, 0);
    assertEq(r.stdout, '');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

// ─────────────────── prism-session-start flag pickup ────────────────────────

test('session-start: picks up clean-nudge flag and emits notice', async () => {
  const home = makeHome();
  const cwd = makeGitDir('ss-1');
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    h.writeFlag('clean-nudge', cwd, {reason: 'clear'});
    const r = runHook(HOOK_SESSION_START, {home, cwd, input: {cwd}});
    assertEq(r.status, 0, r.stderr);
    assert(/clean-nudge|prism-clean/i.test(r.stdout), 'expected nudge text in stdout: ' + JSON.stringify(r.stdout));
    // Flag was consumed.
    const remaining = h.readAndClearFlag('clean-nudge', cwd);
    assertEq(remaining, null, 'flag should be cleared after pickup');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('session-start: picks up git-dirty flag and emits count + sample', async () => {
  const home = makeHome();
  const cwd = makeGitDir('ss-2');
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    h.writeFlag('git-dirty', cwd, {count: 4, sample: ['M src/a.ts', '?? notes.md']});
    const r = runHook(HOOK_SESSION_START, {home, cwd, input: {cwd}});
    assertEq(r.status, 0, r.stderr);
    assert(/uncommitted/i.test(r.stdout), 'expected uncommitted notice: ' + JSON.stringify(r.stdout));
    assert(r.stdout.includes('4'), 'expected count in notice');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('session-start: precompact reason produces "context compaction" wording', async () => {
  const home = makeHome();
  const cwd = makeGitDir('ss-3');
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    const url = pathToFileURL(join(home, '.claude', 'tools', 'lib', 'prism-flag-file.mjs')).href;
    const h = await import(url);
    h.writeFlag('clean-nudge', cwd, {reason: 'precompact'});
    const r = runHook(HOOK_SESSION_START, {home, cwd, input: {cwd}});
    assertEq(r.status, 0);
    assert(/context compaction/i.test(r.stdout), 'expected "context compaction" wording');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('session-start: silent when no flags pending', () => {
  const home = makeHome();
  const cwd = makeGitDir('ss-4');
  try {
    const r = runHook(HOOK_SESSION_START, {home, cwd, input: {cwd}});
    assertEq(r.status, 0);
    // session-start may emit other notices (audit, migration). What we
    // assert is that no clean-nudge/git-dirty notice fires.
    assert(!/PRISM NUDGE/i.test(r.stdout), 'should not emit PRISM NUDGE without a flag');
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd, {recursive: true, force: true});
  }
});

// ─────────────────────────────── summary ────────────────────────────────────

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
