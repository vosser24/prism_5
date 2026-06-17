#!/usr/bin/env node
// tests/v3/hooks/acl-sessionend.test.mjs — F1.5 TDD test: SessionEnd hook
//
// Primary proof is STRUCTURAL (source guards), not timing — Node startup on
// Windows is ~350-450ms, so a raw <50ms process threshold is impossible.
// Instead we verify: (a) source has detached+stdio:'ignore'+.unref() pattern,
// (b) hook exits < 700ms (worker detaches; blocking path would take far longer),
// (c) spawn marker written, (d) debounce is respected.

import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '../../../hooks/prism-acl-sessionend.mjs');
const SRC = readFileSync(HOOK, 'utf-8');

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-se-test-'));
const CLAUDE_DIR = join(tmpHome, '.claude');
const payload = JSON.stringify({ event: 'SessionEnd', session_id: 'test-sess-1' });

mkdirSync(CLAUDE_DIR, { recursive: true });

function runHook(home, extraEnv = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    timeout: 5000,
    encoding: 'utf-8',
  });
  return { ...r, elapsed: Date.now() - t0 };
}

try {
  // ── STRUCTURAL GUARDS (primary proof of fire-and-forget) ─────────────────

  // (S1) source has detached:true
  assert.ok(
    SRC.includes('detached: true') || SRC.includes('detached:true'),
    'source must contain detached:true',
  );

  // (S2) source has stdio:'ignore'
  assert.ok(
    SRC.includes("stdio: 'ignore'") || SRC.includes("stdio:'ignore'") || SRC.includes('stdio: "ignore"'),
    "source must contain stdio:'ignore'",
  );

  // (S3) source has .unref()
  assert.ok(SRC.includes('.unref()'), 'source must contain .unref()');

  // (S4) source does NOT call spawnSync (which would block)
  const syncCalls = [...SRC.matchAll(/spawnSync\s*\(/g)];
  assert.strictEqual(syncCalls.length, 0, `source must not call spawnSync() — found ${syncCalls.length} call(s)`);

  // ── TIMING (hook returns quickly, far faster than a blocking path) ────────

  const r1 = runHook(tmpHome);
  console.log(`  [timing] first run elapsed=${r1.elapsed}ms (threshold: 700ms, node-floor: ~350ms)`);
  assert.strictEqual(r1.status, 0, `hook must exit 0, got ${r1.status}; stderr: ${r1.stderr}`);
  assert.ok(r1.elapsed < 700, `hook must return in <700ms (fire-and-forget), took ${r1.elapsed}ms`);

  // ── BEHAVIORAL: debounce stamp was written ────────────────────────────────

  const debounceFile = join(CLAUDE_DIR, '.prism-acl-debounce');
  assert.ok(existsSync(debounceFile), 'debounce stamp must be written after first call');

  // ── BEHAVIORAL: spawn marker was written ─────────────────────────────────

  const markerFile = join(CLAUDE_DIR, '.prism-acl-spawn-marker');
  assert.ok(existsSync(markerFile), `spawn marker must be written at ${markerFile}`);
  const marker1 = readFileSync(markerFile, 'utf-8').trim();
  assert.ok(marker1.length > 0, 'spawn marker must be non-empty');

  // ── BEHAVIORAL: debounce — second call within cadence is a no-op ─────────

  // DEBOUNCE_MS=60000 (default); the stamp was just written → second call skips
  const r2 = runHook(tmpHome);
  assert.strictEqual(r2.status, 0, `second call must exit 0, got ${r2.status}; stderr: ${r2.stderr}`);
  const marker2 = readFileSync(markerFile, 'utf-8').trim();
  assert.strictEqual(marker1, marker2, 'spawn marker must NOT change on debounced second call');

  // ── BEHAVIORAL: detection NOT run inline ─────────────────────────────────
  // The hook must not write a detect-inline sentinel synchronously.
  // The detached worker may write it eventually, but by the time spawnSync
  // returns the worker has barely started (it's detached and takes >200ms to
  // load ESM modules). We verify the sentinel is NOT present immediately after.
  const inlineMarker = join(CLAUDE_DIR, '.prism-acl-detect-inline');
  assert.ok(!existsSync(inlineMarker), 'hook must NOT run detection inline (sentinel present)');

  console.log('ok');
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
