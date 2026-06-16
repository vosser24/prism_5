#!/usr/bin/env node
// v5.3.2 — read-only quick-check fast path in hooks/prism-parent-dispatch-guard.mjs.
// On a haiku/sonnet turn (work tools normally force-dispatched), a PROVABLY
// read-only Bash/PowerShell probe must run in the PARENT (exit 0, no deny),
// while anything not provably read-only still gets denied. FAIL-CLOSED.
//
// Run: node tests/v3/state/test-prism-ro-bash-fastpath.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-parent-dispatch-guard.mjs');

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) pass++; else console.log('FAIL: ' + l); };

const SID = 'ro-fastpath-test';
// Run the guard on a haiku turn (not dispatched, not force_opus) so work tools
// are denied UNLESS the read-only fast path exempts them.
function runGuard(command, toolName = 'Bash', extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ro-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`),
      JSON.stringify({ tier: 'haiku', dispatched: false, force_opus: false, summon_panel: false, mode: 'hard' }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, PRISM_DISPATCH_GUARD: 'hard', ...extraEnv };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { command }, session_id: SID }),
      encoding: 'utf-8', env, timeout: 10000,
    });
    return { status: r.status, out: r.stdout || '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const exempt = (c, tool = 'Bash') => { const r = runGuard(c, tool); return r.status === 0 && !/denied/i.test(r.out); };
const denied = (c, tool = 'Bash') => { const r = runGuard(c, tool); return r.status === 2 && /denied/i.test(r.out); };

// ── EXEMPT: provably read-only probes run in the parent ──
for (const c of [
  'git status', 'git log --oneline -20', 'git diff HEAD~1', 'git show abc123', 'git rev-parse HEAD',
  'ls -la', 'cat file.txt', 'head -50 log.txt', 'tail -n 50 app.log', 'wc -l x.js',
  'grep -rn TODO src', 'rg pattern .',
  'git log | grep fix | head -5',
  // v5.7.8 — a leading `cd <path>` no longer defeats the read-only fast path
  'cd /c/foo && git status', 'cd /c/foo && git status --short && git diff --stat',
  'cd repo && git ls-files --others --exclude-standard', 'cd a && cd b && git log --oneline -5',
]) check(`EXEMPT: ${c}`, exempt(c));
check('EXEMPT (PowerShell): Get-Content .\\x.log', exempt('Get-Content .\\x.log', 'PowerShell'));
check('EXEMPT (PowerShell pipe): Get-Process | Select-Object Name', exempt('Get-Process | Select-Object Name', 'PowerShell'));

// ── NOT EXEMPT: still denied (fail-closed) ──
for (const c of [
  'python -c "print(1)"', 'python manage.py shell -c "x"', 'node -e "x"',          // arbitrary code
  'git commit -m x', 'git push', 'git checkout main',                               // git write
  'cat x > out.txt', 'ls >> log.txt', 'git log | tee out.txt',                       // redirect / tee
  'npm install', 'pip install foo',                                                   // mutators
  'ls; rm -rf build', 'git status && python evil.py',                                // compound w/ bad segment
  'cd build && rm -rf .', 'cd x && npm install', 'cd x && git commit -m y',           // v5.7.8: cd does NOT whitelist a bad trailing segment
  'cat $(python -c x)', 'echo `whoami`',                                              // command substitution
  'git branch --list', 'git tag -l', 'git config --get x',  // conservative: branch/tag/remote/config can write → not fast-pathed
  'sort -o out.txt in.txt', 'uniq in.txt out.txt',           // write-via-flag / positional output holes
  'git diff --output=patch.txt',                              // --output writes
]) check(`DENIED: ${c}`, denied(c));
check('DENIED (PowerShell scriptblock): gci | ? { Remove-Item $_ }', denied('gci | ? { Remove-Item $_ }', 'PowerShell'));

// ── v5.3.3 Layer-2: read-only TOOLS (not Bash) exit 0 even on a haiku turn ──
// (belt-and-suspenders for pre-upgrade installs still on the old "" matcher).
function runGuardTool(toolName) {
  const home = mkdtempSync(join(tmpdir(), 'prism-ro-tool-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`),
      JSON.stringify({ tier: 'haiku', dispatched: false, force_opus: false, summon_panel: false, mode: 'hard' }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, PRISM_DISPATCH_GUARD: 'hard' };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { file_path: '/tmp/x' }, session_id: SID }),
      encoding: 'utf-8', env, timeout: 10000,
    });
    return { status: r.status, out: r.stdout || '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
for (const t of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) {
  const r = runGuardTool(t);
  check(`Layer-2: ${t} exits 0 on haiku turn (read-only early-exit)`, r.status === 0 && !/denied/i.test(r.out));
}
// Control: a work tool on the same turn IS still denied (guard still bites).
{
  const r = runGuardTool('Edit');
  check('Layer-2 control: Edit still denied on haiku turn', r.status === 2 && /denied/i.test(r.out));
}

// ── kill switch: PRISM_RO_BASH_FASTPATH=off → even a read-only probe is denied ──
{
  const r = runGuard('git status', 'Bash', { PRISM_RO_BASH_FASTPATH: 'off' });
  check('kill switch disables the fast path (git status denied)', r.status === 2 && /denied/i.test(r.out));
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
