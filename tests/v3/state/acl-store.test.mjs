#!/usr/bin/env node
import { loadConfig, readWatermark, writeWatermark } from '../../../tools/lib/prism-acl-store.mjs';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-store-test-'));

try {
  // loadConfig: defaults when config file absent
  const cfg = loadConfig(tmpHome);
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.cluster_threshold, 3);
  assert.strictEqual(cfg.autonomy, 'silent-notified');
  assert.strictEqual(cfg.cross_project, true);
  assert.strictEqual(cfg.token_budget, 100000);
  assert.strictEqual(cfg.cadence, 'session-end');
  assert.strictEqual(cfg.notify, true);

  // watermark round-trip
  writeWatermark(tmpHome, 42);
  assert.strictEqual(readWatermark(tmpHome), 42);

  console.log('ok');
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
