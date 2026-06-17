#!/usr/bin/env node
// tests/v3/hooks/acl-rollback.test.mjs — F3.1 TDD test: rollback guard
//
// The rollback guard is triggered POST-DISPATCH: when an agent that was
// recently upgraded (has last_upgraded_at + last_upgrade_version in roster)
// receives a correction attributed to a session where it was dispatched,
// the guard reverts the live capability file to the previous version
// (versions/<n-1>/) and flags it in the digest (rolledback:[{name,from,to}]).
//
// Tests:
//   1. Upgraded agent + correction in same session → guard reverts live to v1,
//      roster version decremented, digest has rolledback entry.
//   2. Healthy (no correction) upgraded agent → untouched.
//   3. Agent at v1 (no prior version) → safe no-op.
//   4. Agent with prior version but a non-correction event → untouched.

import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '../../../hooks/prism-acl-rollback-guard.mjs');

function runGuard(home, payload) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 5000,
    encoding: 'utf-8',
  });
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-acl-rg-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function seedSkill(home, name, liveVersion, hasV1 = true) {
  const skillDir = join(home, '.claude', 'skills', name);
  mkdirSync(skillDir, { recursive: true });

  const liveContent = [
    '---',
    `name: ${name}`,
    `description: Test skill ${name}`,
    'type: skill',
    `version: ${liveVersion}`,
    '---',
    '',
    `# ${name} v${liveVersion}`,
    `Live version content v${liveVersion}.`,
  ].join('\n');
  const liveFile = join(skillDir, name + '.md');
  writeFileSync(liveFile, liveContent, 'utf-8');

  if (hasV1) {
    const ver1Dir = join(skillDir, 'versions', '1');
    mkdirSync(ver1Dir, { recursive: true });
    const v1Content = [
      '---',
      `name: ${name}`,
      `description: Test skill ${name}`,
      'type: skill',
      'version: 1',
      '---',
      '',
      `# ${name} v1`,
      'Prior v1 content.',
    ].join('\n');
    writeFileSync(join(ver1Dir, name + '.md'), v1Content, 'utf-8');
  }

  return liveFile;
}

function seedRoster(home, rosterData) {
  const rDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rDir, { recursive: true });
  const rPath = join(rDir, 'roster.json');
  writeFileSync(rPath, JSON.stringify(rosterData, null, 2), 'utf-8');
  return rPath;
}

// ── Test 1: upgraded agent + correction → revert to v1 ──────────────────────
{
  const home = makeHome();
  const NAME = 'watchdog-monitor-builder';
  const liveFile = seedSkill(home, NAME, 2);
  const rosterPath = seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'Watchdog monitor skill',
        version: 2,
        path: liveFile,
        corrections_received: 0,
        corrections_since_last_upgrade: 0,
        last_upgraded_at: new Date().toISOString(),
        last_upgrade_version: 2,
        acl_promoted: true,
      },
    },
  });

  // Payload: a correction attributed to a session where NAME was dispatched
  const payload = {
    event: 'correction',
    session_id: 'sess-test-1',
    cap_name: NAME,
    type: 'correction',
    content: 'The agent gave wrong output',
  };

  const r = runGuard(home, payload);
  assert.strictEqual(r.status, 0, `test 1: guard must exit 0; stderr=${r.stderr}`);

  // Live file should now contain v1 content
  const liveContent = readFileSync(liveFile, 'utf-8');
  assert.ok(
    liveContent.includes('version: 1') || liveContent.includes('Prior v1 content'),
    `test 1: live file must be reverted to v1 content; got: ${liveContent.slice(0, 100)}`,
  );

  // Roster version should be decremented to 1
  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = roster.skills[NAME];
  assert.ok(entry, 'test 1: roster entry must still exist');
  assert.strictEqual(entry.version, 1, `test 1: roster version must be decremented to 1; got ${entry.version}`);

  // Digest should have rolledback entry
  const digestPath = join(home, '.claude', '.prism-acl-digest.json');
  assert.ok(existsSync(digestPath), 'test 1: digest file must exist');
  const digest = JSON.parse(readFileSync(digestPath, 'utf-8'));
  assert.ok(Array.isArray(digest.rolledback) && digest.rolledback.length > 0,
    `test 1: digest.rolledback must be non-empty; got ${JSON.stringify(digest.rolledback)}`);
  const rb = digest.rolledback[0];
  assert.strictEqual(rb.name, NAME, `test 1: rolledback entry name must be ${NAME}`);
  assert.strictEqual(rb.from, 2, 'test 1: rolledback from must be 2');
  assert.strictEqual(rb.to, 1, 'test 1: rolledback to must be 1');

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 1: upgraded agent + correction → reverted to v1, digest flagged');
}

// ── Test 2: no correction event → agent untouched ────────────────────────────
{
  const home = makeHome();
  const NAME = 'healthy-skill-builder';
  const liveFile = seedSkill(home, NAME, 2);
  const v2Content = readFileSync(liveFile, 'utf-8');
  const rosterPath = seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'Healthy skill',
        version: 2,
        path: liveFile,
        last_upgraded_at: new Date().toISOString(),
        last_upgrade_version: 2,
        acl_promoted: true,
      },
    },
  });

  // Payload: a non-correction event (normal dispatch, no correction)
  const payload = {
    event: 'dispatch',
    session_id: 'sess-healthy',
    cap_name: NAME,
    description: 'just a normal dispatch',
  };

  const r = runGuard(home, payload);
  assert.strictEqual(r.status, 0, `test 2: guard must exit 0; stderr=${r.stderr}`);

  // Live file should be unchanged
  const liveAfter = readFileSync(liveFile, 'utf-8');
  assert.strictEqual(liveAfter, v2Content, 'test 2: live file must be unchanged for non-correction event');

  // No digest rollback entry
  const digestPath = join(home, '.claude', '.prism-acl-digest.json');
  if (existsSync(digestPath)) {
    const digest = JSON.parse(readFileSync(digestPath, 'utf-8'));
    const rolledback = digest.rolledback || [];
    assert.ok(!rolledback.some(r => r && r.name === NAME),
      `test 2: no rollback entry expected; got ${JSON.stringify(rolledback)}`);
  }

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 2: healthy agent (no correction) → untouched');
}

// ── Test 3: agent at v1, no prior version → safe no-op ───────────────────────
{
  const home = makeHome();
  const NAME = 'v1-only-skill-builder';
  const liveFile = seedSkill(home, NAME, 1, false); // no v1 snapshot dir (IS v1 itself)
  const v1Content = readFileSync(liveFile, 'utf-8');
  const rosterPath = seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'V1 skill',
        version: 1,
        path: liveFile,
        acl_promoted: true,
        // No last_upgraded_at → not recently upgraded
      },
    },
  });

  const payload = {
    event: 'correction',
    session_id: 'sess-v1',
    cap_name: NAME,
    type: 'correction',
    content: 'correction on v1',
  };

  const r = runGuard(home, payload);
  assert.strictEqual(r.status, 0, `test 3: guard must exit 0 for v1-only agent; stderr=${r.stderr}`);

  // Live file should be unchanged (no prior to roll back to)
  const liveAfter = readFileSync(liveFile, 'utf-8');
  assert.strictEqual(liveAfter, v1Content, 'test 3: v1-only agent must be untouched');

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 3: v1-only agent + correction → safe no-op');
}

// ── Test 4: agent upgraded but correction is in a different cap → untouched ──
{
  const home = makeHome();
  const NAME = 'unrelated-skill-builder';
  const liveFile = seedSkill(home, NAME, 2);
  const v2Content = readFileSync(liveFile, 'utf-8');
  seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'Unrelated skill',
        version: 2,
        path: liveFile,
        last_upgraded_at: new Date().toISOString(),
        last_upgrade_version: 2,
        acl_promoted: true,
      },
    },
  });

  // Correction attributed to a DIFFERENT cap
  const payload = {
    event: 'correction',
    session_id: 'sess-diff',
    cap_name: 'some-other-skill',
    type: 'correction',
    content: 'correction on other skill',
  };

  const r = runGuard(home, payload);
  assert.strictEqual(r.status, 0, `test 4: guard must exit 0; stderr=${r.stderr}`);

  const liveAfter = readFileSync(liveFile, 'utf-8');
  assert.strictEqual(liveAfter, v2Content, 'test 4: unrelated agent must be untouched when correction is for different cap');

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 4: correction attributed to different cap → unrelated agent untouched');
}

console.log('ok');
