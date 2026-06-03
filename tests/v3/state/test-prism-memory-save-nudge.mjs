#!/usr/bin/env node
// Tests for hooks/prism-memory-save-nudge.mjs (v5.1 — claude-mem-aware).
// - Mode B (claude-mem absent): fires at turn 15, directive points at /prism-clean.
// - Mode A (claude-mem present): stands down entirely (no double UserPromptSubmit).
//
// Run: node tests/v3/state/test-prism-memory-save-nudge.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-memory-save-nudge.mjs');

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); } catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); } }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function runNudge(home, turns = 1, sessionId = 's1') {
  let out = '';
  for (let i = 0; i < turns; i++) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({session_id: sessionId}),
      env: {...process.env, HOME: home, USERPROFILE: home, PRISM_MEMORY_NUDGE: 'on'},
      encoding: 'utf8',
    });
    out = r.stdout || '';
  }
  return out;
}

function home(label) { const h = mkdtempSync(join(tmpdir(), `nudge-${label}-`)); mkdirSync(join(h, '.claude'), {recursive: true}); return h; }

test('fires at turn 15 and points at /prism-clean (claude-mem absent → Mode B)', () => {
  const h = home('fires');
  try {
    const out = runNudge(h, 15);
    assert(out.includes('additionalContext'), 'should inject at turn 15: ' + out);
    assert(/prism-clean/.test(out), 'directive should point at /prism-clean: ' + out);
  } finally { rmSync(h, {recursive: true, force: true}); }
});

test('stands down entirely when claude-mem is installed (no double UserPromptSubmit)', () => {
  const h = home('standdown');
  try {
    mkdirSync(join(h, '.claude-mem'), {recursive: true});  // claude-mem marker
    const out = runNudge(h, 15);
    assert(out.trim() === '', 'must produce NO output when claude-mem present: ' + JSON.stringify(out));
  } finally { rmSync(h, {recursive: true, force: true}); }
});

test('silent before turn 15 (existing behavior preserved)', () => {
  const h = home('early');
  try {
    const out = runNudge(h, 5);
    assert(out.trim() === '', 'no nudge before turn 15: ' + JSON.stringify(out));
  } finally { rmSync(h, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
