#!/usr/bin/env node
// tests/v3/state/acl-learn.test.mjs — F2.1 + F2.2 TDD tests: Learner/Upgrader
//
// F2.1: attribute() maps correction ts → dispatched agent via routing log;
//        bumps corrections_received and corrections_since_last_upgrade under lock.
//
// F2.2: learn() with an agent that has corrections_since_last_upgrade >= 3
//        triggers factory-upgrade, versions v1→v2 snapshot, resets counters,
//        and appends digest upgraded entry.

import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync,
} from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { attribute, learn } from '../../../tools/prism-capability-learn.mjs';
import { digestPath, versionsPath } from '../../../tools/lib/prism-acl-store.mjs';

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-learn-test-'));

// ── Setup shared paths ────────────────────────────────────────────────────────

const claudeDir = join(tmpHome, '.claude');
mkdirSync(claudeDir, { recursive: true });

const rosterDir = join(claudeDir, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');

const lessonsPath = join(claudeDir, '.prism-lessons.jsonl');
const routingPath = join(claudeDir, '.prism-routing.jsonl');

// ── Seed routing log: dispatches with agent names ─────────────────────────────
// sess-A dispatched 'watchdog-monitor-builder' twice
// sess-B dispatched 'other-agent' once
const routingLines = [
  { event: 'dispatch_cap', session_id: 'sess-A', cap_name: 'watchdog-monitor-builder', ts: '2026-06-17T10:00:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-A', cap_name: 'watchdog-monitor-builder', ts: '2026-06-17T10:05:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-B', cap_name: 'other-agent', ts: '2026-06-17T11:00:00Z' },
];
writeFileSync(routingPath, routingLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed lessons: correction rows mapped to sessions ─────────────────────────
// Two corrections in sess-A → should attribute to watchdog-monitor-builder
// One correction in sess-B → should attribute to other-agent
const lessonLines = [
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:02:00Z', content: 'correction 1' },
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:06:00Z', content: 'correction 2' },
  { type: 'correction', session_id: 'sess-B', ts: '2026-06-17T11:02:00Z', content: 'correction 3' },
];
writeFileSync(lessonsPath, lessonLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed roster with both agents ──────────────────────────────────────────────
const initialRoster = {
  agents: {},
  skills: {
    'watchdog-monitor-builder': {
      description: 'Watchdog monitor skill',
      version: 1,
      corrections_received: 0,
      corrections_since_last_upgrade: 0,
    },
    'other-agent': {
      description: 'Other skill',
      version: 1,
      corrections_received: 0,
      corrections_since_last_upgrade: 0,
    },
  },
};
writeFileSync(rosterPath, JSON.stringify(initialRoster, null, 2), 'utf-8');

try {
  // ════════════════════════════════════════════════════════════════════════════
  // F2.1: attribute() attribution test
  // ════════════════════════════════════════════════════════════════════════════

  await attribute({ home: tmpHome, lessonsPath, routingPath, rosterPath });

  const roster1 = JSON.parse(readFileSync(rosterPath, 'utf-8'));

  // watchdog-monitor-builder: 2 corrections from sess-A
  const watchdog = roster1.skills['watchdog-monitor-builder'];
  assert.ok(watchdog, 'watchdog-monitor-builder must still be in roster');
  assert.strictEqual(watchdog.corrections_received, 2,
    `corrections_received should be 2, got ${watchdog.corrections_received}`);
  assert.strictEqual(watchdog.corrections_since_last_upgrade, 2,
    `corrections_since_last_upgrade should be 2, got ${watchdog.corrections_since_last_upgrade}`);

  // other-agent: 1 correction from sess-B
  const other = roster1.skills['other-agent'];
  assert.ok(other, 'other-agent must still be in roster');
  assert.strictEqual(other.corrections_received, 1,
    `other-agent corrections_received should be 1, got ${other.corrections_received}`);
  assert.strictEqual(other.corrections_since_last_upgrade, 1,
    `other-agent corrections_since_last_upgrade should be 1, got ${other.corrections_since_last_upgrade}`);

  console.log('F2.1 attribute(): PASS');

  // ════════════════════════════════════════════════════════════════════════════
  // F2.2: learn() upgrade trigger test
  // ════════════════════════════════════════════════════════════════════════════

  // Seed a live skill file for watchdog-monitor-builder (v1)
  const skillDir = join(claudeDir, 'skills', 'watchdog-monitor-builder');
  mkdirSync(skillDir, { recursive: true });
  const liveFile = join(skillDir, 'watchdog-monitor-builder.md');
  const v1Content = [
    '---',
    'name: watchdog-monitor-builder',
    'description: Watchdog monitor skill',
    'type: skill',
    'version: 1',
    '---',
    '',
    '# watchdog-monitor-builder v1',
    '',
    'Original v1 content.',
  ].join('\n');
  writeFileSync(liveFile, v1Content, 'utf-8');

  // Create a v1 snapshot (versions/1/)
  const verBasePath = versionsPath(tmpHome, 'skill', 'watchdog-monitor-builder');
  const ver1Dir = join(verBasePath, '1');
  mkdirSync(ver1Dir, { recursive: true });
  copyFileSync(liveFile, join(ver1Dir, basename(liveFile)));

  // Update roster: set corrections_since_last_upgrade = 3 to trigger upgrade
  const rosterForUpgrade = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  rosterForUpgrade.skills['watchdog-monitor-builder'].corrections_since_last_upgrade = 3;
  rosterForUpgrade.skills['watchdog-monitor-builder'].path = liveFile;
  writeFileSync(rosterPath, JSON.stringify(rosterForUpgrade, null, 2), 'utf-8');

  // Stub upgrade factory: writes a v2 .md file into stagingDir
  function stubUpgradeFactory(spec, stagingDir) {
    const dest = join(stagingDir, spec.name + '.md');
    const content = [
      '---',
      `name: ${spec.name}`,
      `description: ${spec.description} (upgraded)`,
      `type: ${spec.type || 'skill'}`,
      'version: 2',
      '---',
      '',
      `# ${spec.name} v2`,
      '',
      'Upgraded stub content.',
    ].join('\n');
    writeFileSync(dest, content, 'utf-8');
    return dest;
  }

  // Run learn()
  await learn({ home: tmpHome, factory: stubUpgradeFactory, rosterPath });

  // (a) Version snapshot v2 must exist
  const ver2Dir = join(verBasePath, '2');
  assert.ok(existsSync(ver2Dir),
    `v2 snapshot dir must exist at ${ver2Dir}`);
  assert.ok(existsSync(join(ver2Dir, 'watchdog-monitor-builder.md')),
    'v2 snapshot must contain watchdog-monitor-builder.md');

  // (a') Prior v1 must be retained (for rollback)
  assert.ok(existsSync(ver1Dir),
    `v1 snapshot must still exist for rollback at ${ver1Dir}`);
  assert.ok(existsSync(join(ver1Dir, basename(liveFile))),
    'v1 snapshot file must still exist');

  // (b) counters reset in roster
  const roster2 = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const watchdog2 = roster2.skills['watchdog-monitor-builder'];
  assert.ok(watchdog2, 'watchdog-monitor-builder must be in roster after learn()');
  assert.strictEqual(watchdog2.corrections_since_last_upgrade, 0,
    `corrections_since_last_upgrade must reset to 0, got ${watchdog2.corrections_since_last_upgrade}`);

  // (c) digest has upgraded entry {name, from, to}
  const dp = digestPath(tmpHome);
  assert.ok(existsSync(dp), 'digest file must exist after learn()');
  const digest = JSON.parse(readFileSync(dp, 'utf-8'));
  assert.ok(Array.isArray(digest.upgraded), 'digest.upgraded must be an array');
  const upgradeEntry = digest.upgraded.find(u => u && u.name === 'watchdog-monitor-builder');
  assert.ok(upgradeEntry,
    `digest.upgraded must contain an entry for watchdog-monitor-builder; got: ${JSON.stringify(digest.upgraded)}`);
  assert.strictEqual(upgradeEntry.from, 1,
    `from version must be 1, got ${upgradeEntry.from}`);
  assert.strictEqual(upgradeEntry.to, 2,
    `to version must be 2, got ${upgradeEntry.to}`);

  console.log('F2.2 learn() upgrade: PASS');
  console.log('ok');
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
