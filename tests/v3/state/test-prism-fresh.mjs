#!/usr/bin/env node
// Tests for the /prism-fresh command (command-consolidation B6).
// Run: node tests/v3/state/test-prism-fresh.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// /prism-fresh is a thin, refresh-ONLY alias for /prism-deep-dive --refresh.
// The locked decision (handoff 2026-06-03 §THE PLAN B6): refresh and upgrade
// stay SEPARATE — prism-fresh must never invoke --upgrade (which rewrites the
// learned master agent body). These tests pin that contract plus manifest +
// help-index wiring.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

const CMD = join(REPO, 'commands', 'prism-fresh.md');

test('commands/prism-fresh.md exists', () => {
  assert(existsSync(CMD), 'prism-fresh.md missing');
});

test('frontmatter declares name: prism-fresh', () => {
  const body = readFileSync(CMD, 'utf-8');
  assert(/^---[\s\S]*?\nname:\s*prism-fresh\b/m.test(body), 'missing/incorrect name frontmatter');
});

test('wraps /prism-deep-dive --refresh', () => {
  const body = readFileSync(CMD, 'utf-8');
  assert(/\/prism-deep-dive\s+--refresh/.test(body), 'does not reference /prism-deep-dive --refresh');
});

test('refresh-only: never silently invokes --upgrade', () => {
  const body = readFileSync(CMD, 'utf-8');
  // --upgrade may be MENTIONED (to point users at the separate path) but must
  // be framed as a separate action, never as something prism-fresh performs.
  assert(/does not rewrite|NOT do|separate|distinct/i.test(body),
    'must explicitly state it does NOT perform the upgrade');
  assert(!/prism-fresh[\s\S]{0,40}--upgrade/i.test(body),
    'prism-fresh must not be described as running --upgrade');
});

test('present in install-manifest.json files[]', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'tools', 'install-manifest.json'), 'utf-8'));
  const srcs = new Set(manifest.files.map(f => f.src.replace(/\\/g, '/')));
  assert(srcs.has('commands/prism-fresh.md'), 'not in install-manifest files[]');
});

test('covered by a remove_on_upgrade_pattern', () => {
  const manifest = JSON.parse(readFileSync(join(REPO, 'tools', 'install-manifest.json'), 'utf-8'));
  const pats = manifest.remove_on_upgrade_patterns || [];
  // commands/prism-*.md covers it.
  assert(pats.includes('commands/prism-*.md'), 'no remove pattern covers commands/prism-fresh.md');
});

test('listed in /prism-help index', () => {
  const help = readFileSync(join(REPO, 'commands', 'prism-help.md'), 'utf-8');
  assert(/\/prism-fresh/.test(help), 'prism-fresh not referenced in prism-help.md');
});

process.stdout.write(`tests passed: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
