#!/usr/bin/env node
// Tests for hooks/lib/prism-claude-mem-detect.mjs (v5.1).
// claudeMemInstalled(home) detects the optional claude-mem ambient-memory tier
// so PRISM's save-nudge can stand down (avoid double UserPromptSubmit + redundant
// capture). Canonical signal: the ~/.claude-mem/ dir; corroborating: a claude-mem
// hook string in ~/.claude/settings.json.
//
// Run: node tests/v3/state/test-prism-claude-mem-detect.mjs

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-claude-mem-detect.mjs');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); } catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); } }
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}${msg ? ' — ' + msg : ''}`); }

const {claudeMemInstalled} = await import(pathToFileURL(LIB).href);

function home(label) { return mkdtempSync(join(tmpdir(), `cmem-${label}-`)); }

test('false when no markers', () => {
  const h = home('none');
  try {
    mkdirSync(join(h, '.claude'), {recursive: true});
    assertEq(claudeMemInstalled(h), false);
  } finally { rmSync(h, {recursive: true, force: true}); }
});

test('true when ~/.claude-mem dir exists (canonical signal)', () => {
  const h = home('dir');
  try {
    mkdirSync(join(h, '.claude-mem'), {recursive: true});
    assertEq(claudeMemInstalled(h), true);
  } finally { rmSync(h, {recursive: true, force: true}); }
});

test('true when settings.json references a claude-mem hook (corroborating signal)', () => {
  const h = home('hook');
  try {
    mkdirSync(join(h, '.claude'), {recursive: true});
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({hooks: {SessionStart: [{hooks: [{command: 'npx claude-mem session-start'}]}]}}));
    assertEq(claudeMemInstalled(h), true);
  } finally { rmSync(h, {recursive: true, force: true}); }
});

test('false when settings.json present but no claude-mem reference', () => {
  const h = home('clean');
  try {
    mkdirSync(join(h, '.claude'), {recursive: true});
    writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({hooks: {SessionStart: [{hooks: [{command: 'bash prism-session-start.mjs'}]}]}}));
    assertEq(claudeMemInstalled(h), false);
  } finally { rmSync(h, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
