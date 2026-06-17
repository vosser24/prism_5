// tools/lib/prism-acl-store.mjs — ACL shared config, watermark, and path helpers

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export { withRosterLock } from './prism-roster-lock.mjs';

const DEFAULTS = {
  enabled: true,
  cluster_threshold: 3,
  cross_project: true,
  token_budget: 100000,
  cadence: 'session-end',
  notify: true,
  autonomy: 'silent-notified',
};

export function loadConfig(home) {
  const cfgPath = join(home, '.claude', '.prism-acl-config.json');
  let user = {};
  if (existsSync(cfgPath)) {
    try { user = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { /* malformed — ignore */ }
  }
  return { ...DEFAULTS, ...user };
}

export function readWatermark(home) {
  const p = join(home, '.claude', '.prism-acl-watermark');
  if (!existsSync(p)) return 0;
  const raw = readFileSync(p, 'utf-8').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export function writeWatermark(home, n) {
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.prism-acl-watermark'), String(n), 'utf-8');
}

// Path helpers
export const queuePath   = home => join(home, '.claude', '.prism-acl-queue.json');
export const digestPath  = home => join(home, '.claude', '.prism-acl-digest.json');
export const stagingPath = home => join(home, '.claude', '.prism-acl-staging');
export const versionsPath = (home, kind, name) =>
  join(home, '.claude', kind === 'agent' ? `agents/${name}/versions` : `skills/${name}/versions`);
