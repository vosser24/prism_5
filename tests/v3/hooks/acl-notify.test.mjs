#!/usr/bin/env node
// tests/v3/hooks/acl-notify.test.mjs — F1.6 TDD test: SessionStart notifier
// Tests:
//   1. With digest {created:['monitoring-builder'],upgraded:[]}: emits exactly
//      one line "PRISM learned: +skill monitoring-builder" and clears digest.
//   2. With no digest file: emits nothing.
//   3. With empty digest {created:[],upgraded:[]}: emits nothing.
import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '../../../hooks/prism-acl-notify.mjs');

function runNotify(home) {
  const payload = JSON.stringify({ event: 'SessionStart', session_id: 'test-notify' });
  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 5000,
    encoding: 'utf-8',
  });
}

// ── Test 1: digest with created skill ─────────────────────────────────────────
const home1 = mkdtempSync(join(tmpdir(), 'prism-acl-notify-t1-'));
const claudeDir1 = join(home1, '.claude');
mkdirSync(claudeDir1, { recursive: true });
const digestPath1 = join(claudeDir1, '.prism-acl-digest.json');
writeFileSync(digestPath1, JSON.stringify({ created: ['monitoring-builder'], upgraded: [] }), 'utf-8');

try {
  const r1 = runNotify(home1);
  assert.strictEqual(r1.status, 0, `test 1: hook must exit 0; stderr=${r1.stderr}`);

  // Emits JSON with additionalContext containing the learn notice
  assert.ok(r1.stdout.trim().length > 0, 'test 1: stdout must be non-empty when digest has entries');

  let parsed1;
  try { parsed1 = JSON.parse(r1.stdout.trim()); } catch (e) {
    throw new Error(`test 1: stdout must be valid JSON; got: ${r1.stdout.trim().slice(0, 200)}`);
  }

  const ctx1 = parsed1?.hookSpecificOutput?.additionalContext || '';
  assert.ok(
    ctx1.includes('PRISM learned: +skill monitoring-builder'),
    `test 1: additionalContext must include "PRISM learned: +skill monitoring-builder"; got: "${ctx1}"`,
  );

  // Digest must be cleared/rotated after pickup
  assert.ok(existsSync(digestPath1), 'test 1: digest file should still exist after rotation');
  const digest1After = JSON.parse(readFileSync(digestPath1, 'utf-8'));
  assert.deepStrictEqual(digest1After.created, [], 'test 1: digest.created must be empty after pickup');

  console.log('  ok  test 1: created skill notice emitted and digest cleared');
} finally {
  rmSync(home1, { recursive: true, force: true });
}

// ── Test 2: no digest file → emit nothing ────────────────────────────────────
const home2 = mkdtempSync(join(tmpdir(), 'prism-acl-notify-t2-'));
mkdirSync(join(home2, '.claude'), { recursive: true });

try {
  const r2 = runNotify(home2);
  assert.strictEqual(r2.status, 0, `test 2: hook must exit 0; stderr=${r2.stderr}`);
  // stdout must be empty (no digest → no notice)
  assert.strictEqual(r2.stdout.trim(), '', `test 2: stdout must be empty when no digest; got: ${r2.stdout.trim().slice(0, 200)}`);
  console.log('  ok  test 2: no digest → no output');
} finally {
  rmSync(home2, { recursive: true, force: true });
}

// ── Test 3: empty digest → emit nothing ──────────────────────────────────────
const home3 = mkdtempSync(join(tmpdir(), 'prism-acl-notify-t3-'));
const claudeDir3 = join(home3, '.claude');
mkdirSync(claudeDir3, { recursive: true });
writeFileSync(join(claudeDir3, '.prism-acl-digest.json'), JSON.stringify({ created: [], upgraded: [] }), 'utf-8');

try {
  const r3 = runNotify(home3);
  assert.strictEqual(r3.status, 0, `test 3: hook must exit 0; stderr=${r3.stderr}`);
  assert.strictEqual(r3.stdout.trim(), '', `test 3: stdout must be empty for empty digest; got: ${r3.stdout.trim().slice(0, 200)}`);
  console.log('  ok  test 3: empty digest → no output');
} finally {
  rmSync(home3, { recursive: true, force: true });
}

console.log('ok');
