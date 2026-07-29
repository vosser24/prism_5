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

  // ════════════════════════════════════════════════════════════════════════════
  // F2.3: learn() refuses to upgrade a FLAT-owned agent (manifest / hand-authored)
  //       and clears the stuck pending_upgrade flag.
  // ════════════════════════════════════════════════════════════════════════════

  // Seed a FLAT agent file agents/flat-owned-agent.md (the manifest layout).
  const flatAgentsDir = join(claudeDir, 'agents');
  mkdirSync(flatAgentsDir, { recursive: true });
  const flatAgentFile = join(flatAgentsDir, 'flat-owned-agent.md');
  writeFileSync(flatAgentFile, [
    '---',
    'name: flat-owned-agent',
    'description: A shipped, flat-owned agent',
    '---',
    '',
    '# flat-owned-agent',
  ].join('\n'), 'utf-8');

  // Roster: agent flagged for upgrade (pending_upgrade) at version 1.
  const rosterF23 = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  if (!rosterF23.agents) rosterF23.agents = {};
  rosterF23.agents['flat-owned-agent'] = {
    description: 'A shipped, flat-owned agent',
    version: 1,
    pending_upgrade: true,
    status: 'upgrade_needed',
    corrections_since_last_upgrade: 0,
  };
  writeFileSync(rosterPath, JSON.stringify(rosterF23, null, 2), 'utf-8');

  // A factory that MUST NOT run for a flat-owned agent.
  let flatFactoryCalled = false;
  function guardTripFactory(spec, stagingDir) {
    flatFactoryCalled = true;
    const dest = join(stagingDir, spec.name + '.md');
    writeFileSync(dest, '---\nname: x\ndescription: y\n---\n', 'utf-8');
    return dest;
  }

  await learn({ home: tmpHome, factory: guardTripFactory, rosterPath });

  // (a) factory never invoked for the flat-owned agent
  assert.strictEqual(flatFactoryCalled, false,
    'learn() must NOT invoke the factory for a flat-owned agent');

  // (b) no nested agents/<name>/ dir created
  assert.ok(!existsSync(join(claudeDir, 'agents', 'flat-owned-agent', 'flat-owned-agent.md')),
    'learn() must NOT create a nested copy of a flat-owned agent');

  // (c) version unchanged, pending_upgrade cleared, status reset
  const rosterAfterF23 = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const fo = rosterAfterF23.agents['flat-owned-agent'];
  assert.strictEqual(fo.version, 1, `flat-owned-agent version must stay 1, got ${fo.version}`);
  assert.strictEqual(fo.pending_upgrade, false,
    `flat-owned-agent pending_upgrade must be cleared, got ${fo.pending_upgrade}`);
  assert.strictEqual(fo.status, 'active',
    `flat-owned-agent status must reset to active, got ${fo.status}`);

  console.log('F2.3 learn() flat-owned guard: PASS');

  // ════════════════════════════════════════════════════════════════════════════
  // F34: learn() must not leak a stray tmpLive `.tmp` file when the atomic
  //      promote's renameWithRetry(tmpLive -> liveFilePath) step fails.
  //
  //      Regression guard: the shipped cleanup line on the failure path was
  //      `try { renameSync(tmpLive, tmpLive); } catch {}` — a no-op self-rename
  //      (source === destination) inside an empty catch, so it silently did
  //      nothing and left the copied `.tmp` file on disk forever. Fixed to
  //      `unlinkSync(tmpLive)`, matching the cleanup-after-failed-
  //      renameWithRetry idiom used elsewhere in this repo (e.g.
  //      tools/lib/prism-state.mjs, tools/prism-installer.mjs).
  // ════════════════════════════════════════════════════════════════════════════

  const promoteFailName = 'promote-fail-skill';
  const promoteFailDir = join(claudeDir, 'skills', promoteFailName);
  mkdirSync(promoteFailDir, { recursive: true });

  // Force renameSync(tmpLive, liveFilePath) to fail: pre-create the live
  // file path AS A DIRECTORY. copyFileSync(staging, tmpLive) still succeeds
  // (tmpLive is a distinct sibling path), but the rename-over-a-directory
  // throws (EPERM on Windows), driving execution into the catch/cleanup path.
  const liveFilePathForFail = join(promoteFailDir, promoteFailName + '.md');
  mkdirSync(liveFilePathForFail, { recursive: true });

  const rosterForFail = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  rosterForFail.skills[promoteFailName] = {
    description: 'Skill whose promote step is forced to fail',
    version: 1,
    corrections_since_last_upgrade: 3,
  };
  writeFileSync(rosterPath, JSON.stringify(rosterForFail, null, 2), 'utf-8');

  function stubFactoryForFail(spec, stagingDir) {
    const dest = join(stagingDir, spec.name + '.md');
    writeFileSync(dest, [
      '---',
      `name: ${spec.name}`,
      `description: ${spec.description} (upgraded)`,
      'type: skill',
      'version: 2',
      '---',
      '',
      `# ${spec.name} v2`,
    ].join('\n'), 'utf-8');
    return dest;
  }

  await learn({ home: tmpHome, factory: stubFactoryForFail, rosterPath });

  // Sanity: the promote genuinely failed (roster untouched — the update-roster
  // block only runs after a successful atomic promote).
  const rosterAfterFail = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const failedEntry = rosterAfterFail.skills[promoteFailName];
  assert.strictEqual(failedEntry.version, 1,
    `promote-fail-skill version must stay 1 (promote must have failed), got ${failedEntry.version}`);
  assert.strictEqual(failedEntry.corrections_since_last_upgrade, 3,
    `promote-fail-skill counter must be untouched by a failed promote, got ${failedEntry.corrections_since_last_upgrade}`);

  // The actual regression check: no stray `.tmp` file left behind.
  const filesAfterFail = readdirSync(promoteFailDir);
  const strayTmp = filesAfterFail.filter(f => f.endsWith('.tmp'));
  assert.deepStrictEqual(strayTmp, [],
    `promote failure must not leak a .tmp file; found: ${JSON.stringify(filesAfterFail)}`);

  console.log('F34 learn() promote-failure leaves no stray tmp file: PASS');
  console.log('ok');
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
