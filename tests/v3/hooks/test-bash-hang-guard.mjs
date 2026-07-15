#!/usr/bin/env node
// tests/v3/hooks/test-bash-hang-guard.mjs — USAGE TEST for hooks/prism-bash-hang-guard.mjs
//
// The guard blocks a NARROW set of provably-hang Bash patterns (infinite loops,
// poll-sleep loops, state-file tight-polls, unbounded follows, long foreground
// sleeps, mass-kill storms) at PreToolUse. Everything else PASSES (fail-open).
//
// Tests import run() directly (fast; no node-spawn). HOME is redirected to a temp
// dir so the guard's routing-log append doesn't touch the real ~/.claude.
//
// Run: node tests/v3/hooks/test-bash-hang-guard.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', '..', 'hooks', 'prism-bash-hang-guard.mjs');

// Redirect HOME before importing so any log path resolves into the sandbox.
const HOME = mkdtempSync(join(tmpdir(), 'prism-hang-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run } = await import(pathToFileURL(GUARD).href);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra } });
const exitOf = (payload, env) => run(payload, { ...process.env, ...(env || {}) }).exit;

try {
  // ── BLOCK: infinite loops ──────────────────────────────────────────────────
  check('block while true', exitOf(bash('while true; do echo x; done')) === 2);
  check('block while :', exitOf(bash('while :; do ls; done')) === 2);
  check('block until false', exitOf(bash('until false; do echo x; done')) === 2);

  // ── BLOCK: poll-sleep loops ────────────────────────────────────────────────
  check('block while+sleep poll', exitOf(bash('while [ ! -f x ]; do sleep 2; done')) === 2);
  check('block for+sleep poll', exitOf(bash('for i in 1 2 3; do curl x; sleep 5; done')) === 2);

  // ── BLOCK: state-file tight poll ───────────────────────────────────────────
  check('block loop reading init_state.json', exitOf(bash('while ! grep done init_state.json; do :; done')) === 2);
  check('block loop reading a .lock', exitOf(bash('until [ -f .reclassify_lock ]; do echo waiting; done')) === 2);

  // ── BLOCK: unbounded follow / watch ────────────────────────────────────────
  check('block tail -f', exitOf(bash('tail -f server.log')) === 2);
  check('block tail --follow', exitOf(bash('tail --follow=name app.log')) === 2);
  check('block watch cmd', exitOf(bash('watch ls -la')) === 2);
  check('block Get-Content -Wait', exitOf(bash('pwsh -c "Get-Content app.log -Wait"')) === 2);

  // ── BLOCK: long foreground sleep ───────────────────────────────────────────
  check('block sleep 30', exitOf(bash('sleep 30')) === 2);
  check('block sleep 2m', exitOf(bash('sleep 2m')) === 2);
  check('block sleep 1h', exitOf(bash('sleep 1h')) === 2);

  // ── BLOCK: mass-kill storms ────────────────────────────────────────────────
  check('block taskkill /IM', exitOf(bash('taskkill /IM node.exe /F')) === 2);
  check('block taskkill /FI', exitOf(bash('taskkill /FI "IMAGENAME eq node.exe" /F')) === 2);
  check('block taskkill wildcard', exitOf(bash('taskkill /F /FI "PID gt 0" *')) === 2);
  check('block pkill', exitOf(bash('pkill -f chroma')) === 2);
  check('block killall', exitOf(bash('killall node')) === 2);
  check('block Stop-Process -Name', exitOf(bash('Stop-Process -Name node -Force')) === 2);

  // ── ALLOW: safe commands (fail-open default) ───────────────────────────────
  check('allow ls', exitOf(bash('ls -la hooks/')) === 0);
  check('allow git status', exitOf(bash('git status --short')) === 0);
  check('allow short sleep 5', exitOf(bash('sleep 5')) === 0);
  check('allow bounded for loop without sleep', exitOf(bash('for f in *.mjs; do node --check "$f"; done')) === 0);
  check('allow single-PID taskkill', exitOf(bash('taskkill /PID 1234 /F')) === 0);
  check('allow single-PID Stop-Process -Id', exitOf(bash('Stop-Process -Id 1234 -Force')) === 0);
  check('allow bounded tail -n', exitOf(bash('tail -n 200 app.log')) === 0);
  check('allow git switch (not watch)', exitOf(bash('git switch main')) === 0);

  // ── ALLOW: quoted trigger tokens are stripped before matching ──────────────
  check('allow echo "while true ..." (quoted)', exitOf(bash('echo "while true example in a string"')) === 0);
  check('allow commit msg mentioning tail -f', exitOf(bash('git commit -m "doc: explain tail -f usage"')) === 0);

  // ── ALLOW: run_in_background exempts the infinite-loop/follow family ────────
  check('allow while true when run_in_background', exitOf(bash('while true; do echo x; sleep 1; done', { run_in_background: true })) === 0);
  check('allow tail -f when run_in_background', exitOf(bash('tail -f server.log', { run_in_background: true })) === 0);
  // ...but mass-kill still fires even backgrounded
  check('still block taskkill /IM even backgrounded', exitOf(bash('taskkill /IM node.exe', { run_in_background: true })) === 2);

  // ── FAIL-OPEN: malformed / empty payloads ──────────────────────────────────
  check('fail-open empty payload {}', run({}, process.env).exit === 0);
  check('fail-open empty command', exitOf(bash('')) === 0);
  check('fail-open non-Bash tool', run({ tool_name: 'Read', tool_input: {} }, process.env).exit === 0);

  // ── MODES ──────────────────────────────────────────────────────────────────
  check('off mode passes a while-true through', exitOf(bash('while true; do echo x; done'), { PRISM_BASH_HANG_GUARD: 'off' }) === 0);
  check('soft mode is advisory (exit 0) on a block pattern', exitOf(bash('tail -f x'), { PRISM_BASH_HANG_GUARD: 'soft' }) === 0);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
