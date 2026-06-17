#!/usr/bin/env node
// Tests for F7 fix: claudeMemHealthy gate on the memory-save-nudge standdown.
// Three cases drive the hook through 15 turns (same session_id) and assert
// on the 15th-turn stdout:
//   1. installed + healthy (consecutiveFailures:0)  → suppressed (empty)
//   2. installed + unhealthy (consecutiveFailures:5) → fires (nudge text present)
//   3. installed + no state file (fail-open)         → fires (nudge text present)
//
// Run: node tests/v3/state/test-memory-nudge-claude-mem-health.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-memory-save-nudge.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function runNudge15(home, sessionId = 'health-test') {
  let lastOut = '';
  for (let i = 0; i < 15; i++) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({session_id: sessionId, hook_event_name: 'UserPromptSubmit'}),
      env: {...process.env, HOME: home, USERPROFILE: home, PRISM_MEMORY_NUDGE: 'on'},
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    lastOut = r.stdout || '';
  }
  return lastOut;
}

function makeHome(label) {
  const h = mkdtempSync(join(tmpdir(), `nudge-health-${label}-`));
  mkdirSync(join(h, '.claude'), {recursive: true});
  return h;
}

// Case 1: installed + healthy (consecutiveFailures:0) → standdown → suppressed
test('installed + healthy (consecutiveFailures:0) → standdown → empty stdout', () => {
  const h = makeHome('healthy');
  try {
    mkdirSync(join(h, '.claude-mem', 'state'), {recursive: true});
    writeFileSync(
      join(h, '.claude-mem', 'state', 'hook-failures.json'),
      JSON.stringify({consecutiveFailures: 0}),
    );
    const out = runNudge15(h);
    assert(out.trim() === '', 'healthy worker → nudge must be suppressed (standdown): ' + JSON.stringify(out));
  } finally { rmSync(h, {recursive: true, force: true}); }
});

// Case 2: installed + unhealthy (consecutiveFailures:5) → fall-through → fires
test('installed + unhealthy (consecutiveFailures:5) → fallback → nudge fires', () => {
  const h = makeHome('unhealthy');
  try {
    mkdirSync(join(h, '.claude-mem', 'state'), {recursive: true});
    writeFileSync(
      join(h, '.claude-mem', 'state', 'hook-failures.json'),
      JSON.stringify({consecutiveFailures: 5, lastFailureAt: 1781088718074}),
    );
    const out = runNudge15(h);
    assert(out.includes('additionalContext'), 'unhealthy worker → nudge must fire: ' + JSON.stringify(out));
    assert(out.includes('PRISM MEMORY-SAVE NUDGE'), 'additionalContext must contain nudge text: ' + JSON.stringify(out));
  } finally { rmSync(h, {recursive: true, force: true}); }
});

// Case 3: installed + NO state file (fail-open → treat as unhealthy → fires)
test('installed + no state file (fail-open) → nudge fires', () => {
  const h = makeHome('nostate');
  try {
    // .claude-mem dir present but no state/hook-failures.json
    mkdirSync(join(h, '.claude-mem'), {recursive: true});
    const out = runNudge15(h);
    assert(out.includes('additionalContext'), 'missing state file → fail-open → nudge must fire: ' + JSON.stringify(out));
    assert(out.includes('PRISM MEMORY-SAVE NUDGE'), 'additionalContext must contain nudge text: ' + JSON.stringify(out));
  } finally { rmSync(h, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
