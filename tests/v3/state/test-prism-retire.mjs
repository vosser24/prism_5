#!/usr/bin/env node
// Tests for tools/prism-retire.mjs (§6.C hardening — v5.0 stress-test).
// Closes the finding that /prism-retire was unguarded skill-prose (model
// hand-edits roster.json: no lock, no atomic write, no validation, no
// path-traversal guard). The executable mirrors prism-uninstall-cleanup's safe
// pattern: parse-roster-before-touching-disk, withRosterLock + atomic tmp+rename,
// and a traversal guard on the (user-supplied) agent name.
//
// Real-subprocess harness with ephemeral --home sandboxes (mirrors
// test-prism-uninstall-cleanup.mjs). [[feedback-installer-state-test-flaky-windows]]:
// if a run varies, re-run standalone before treating it as a regression.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = join(__dirname, '..', '..', '..', 'tools', 'prism-retire.mjs');
let pass = 0, total = 0;
const check = (label, cond) => { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); };

const REF = ['.claude', 'skills', 'prism-plan', 'references'];
function sandbox(agents) {
  const h = mkdtempSync(join(tmpdir(), 'prism-retire-'));
  mkdirSync(join(h, ...REF), { recursive: true });
  mkdirSync(join(h, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(h, ...REF, 'roster.json'),
    typeof agents === 'string' ? agents : JSON.stringify({ version: '3.1.0', agents }, null, 2));
  return h;
}
const agentDir = (h, n) => join(h, '.claude', 'agents', n);
const archiveDir = (h, n) => join(h, '.claude', 'agents-archive', n);
function mkDir(h, n) { mkdirSync(agentDir(h, n), { recursive: true }); writeFileSync(join(agentDir(h, n), 'agent.md'), '# ' + n); }
function mkFlat(h, n) { writeFileSync(join(h, '.claude', 'agents', n + '.md'), '# ' + n); }
function run(h, args) { const r = spawnSync('node', [TOOL, ...args, '--home', h], { encoding: 'utf8', timeout: 20000 }); return { status: r.status, out: r.stdout || '', err: r.stderr || '' }; }
const roster = (h) => { try { return JSON.parse(readFileSync(join(h, ...REF, 'roster.json'), 'utf8')); } catch { return null; } };
const tmpLingers = (h) => readdirSync(join(h, ...REF)).some(f => f.includes('.tmp'));

const TWO = { 'keep-me': { installed_via: 'manual', status: 'available' }, 'retire-me': { installed_via: 'plugin', status: 'available' } };

// ── 1. retire dir-form agent: archived + roster entry removed + atomic ──
{
  const h = sandbox(TWO); mkDir(h, 'retire-me'); mkDir(h, 'keep-me');
  const r = run(h, ['retire-me']);
  check('1 exit 0', r.status === 0);
  check('1 roster entry removed', roster(h) && !roster(h).agents['retire-me']);
  check('1 other agent preserved in roster', roster(h) && !!roster(h).agents['keep-me']);
  check('1 live agent dir gone', !existsSync(agentDir(h, 'retire-me')));
  check('1 archived to agents-archive/', existsSync(archiveDir(h, 'retire-me')));
  check('1 other agent dir preserved on disk', existsSync(agentDir(h, 'keep-me')));
  check('1 roster still valid JSON', !!roster(h) && !!roster(h).agents);
  check('1 atomic write — no .tmp lingers', !tmpLingers(h));
  rmSync(h, { recursive: true, force: true });
}

// ── 2. retire flat-file agent + accepts leading '@' ──
{
  const h = sandbox({ 'flat-agent': { installed_via: 'manual' } }); mkFlat(h, 'flat-agent');
  const r = run(h, ['@flat-agent']);
  check('2 exit 0 (leading @ accepted)', r.status === 0);
  check('2 flat .md moved out of agents/', !existsSync(join(h, '.claude', 'agents', 'flat-agent.md')));
  check('2 flat .md archived', existsSync(join(h, '.claude', 'agents-archive', 'flat-agent.md')));
  check('2 roster entry removed', roster(h) && !roster(h).agents['flat-agent']);
  rmSync(h, { recursive: true, force: true });
}

// ── 3. agent not found (not in roster, not on disk) → non-zero, no change ──
{
  const h = sandbox(TWO); mkDir(h, 'retire-me'); mkDir(h, 'keep-me');
  const r = run(h, ['ghost']);
  check('3 not-found → non-zero exit', r.status !== 0);
  check('3 not-found → roster unchanged (both agents intact)', roster(h) && !!roster(h).agents['retire-me'] && !!roster(h).agents['keep-me']);
  rmSync(h, { recursive: true, force: true });
}

// ── 4. corrupt roster → exit 13, NO archive move (fail-safe before touching disk) ──
{
  const h = sandbox('{ not valid json ]['); mkDir(h, 'retire-me');
  const r = run(h, ['retire-me']);
  check('4 corrupt roster → exit 13', r.status === 13);
  check('4 corrupt roster → live dir NOT moved (no partial mutation)', existsSync(agentDir(h, 'retire-me')) && !existsSync(archiveDir(h, 'retire-me')));
  rmSync(h, { recursive: true, force: true });
}

// ── 5. missing roster → exit 13, no crash ──
{
  const h = mkdtempSync(join(tmpdir(), 'prism-retire-'));
  mkdirSync(join(h, '.claude', 'agents'), { recursive: true });
  const r = run(h, ['retire-me']);
  check('5 missing roster → exit 13', r.status === 13);
  rmSync(h, { recursive: true, force: true });
}

// ── 6. PATH-TRAVERSAL guard: unsafe names rejected, no escape ──
for (const bad of ['../evil', '..', 'a/b', 'a\\b']) {
  const h = sandbox(TWO); mkDir(h, 'retire-me');
  const r = run(h, [bad]);
  check(`6 traversal name "${bad}" rejected (exit 2)`, r.status === 2);
  check(`6 traversal "${bad}" caused no roster change`, roster(h) && !!roster(h).agents['retire-me']);
  rmSync(h, { recursive: true, force: true });
}

// ── 7. --dry-run reports, mutates nothing ──
{
  const h = sandbox(TWO); mkDir(h, 'retire-me');
  const r = run(h, ['retire-me', '--dry-run']);
  check('7 dry-run exit 0', r.status === 0);
  check('7 dry-run names the agent', /retire-me/.test(r.out));
  check('7 dry-run mutated nothing (roster + dir intact)', !!roster(h).agents['retire-me'] && existsSync(agentDir(h, 'retire-me')) && !existsSync(archiveDir(h, 'retire-me')));
  rmSync(h, { recursive: true, force: true });
}

// ── 8. roster entry present but on-disk already gone → still removes entry, no crash ──
{
  const h = sandbox(TWO); mkDir(h, 'keep-me'); // retire-me in roster but NO dir
  const r = run(h, ['retire-me']);
  check('8 roster-only agent → exit 0, entry removed, no crash', r.status === 0 && roster(h) && !roster(h).agents['retire-me']);
  rmSync(h, { recursive: true, force: true });
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
