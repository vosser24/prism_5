#!/usr/bin/env node
// tests/v3/cli/acl-cli.test.mjs — F3.2 TDD test: observability CLIs
//
// Tests for tools/prism-capability-cli.mjs
//
// Tests:
//   1. `log` command: prints create/upgrade/rollback history from digest.
//   2. `rollback <name>` command: restores prior version + updates roster.
//   3. `rollback <name>` idempotency: already-rolled-back skill is a no-op.
//   4. `rollback <name>` at v1 with no prior version: safe no-op, exits 0.

import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../../../tools/prism-capability-cli.mjs');

function runCLI(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 5000,
    encoding: 'utf-8',
  });
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-acl-cli-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

function writeDigest(home, digest) {
  writeFileSync(
    join(home, '.claude', '.prism-acl-digest.json'),
    JSON.stringify(digest, null, 2),
    'utf-8',
  );
}

function seedSkillV2(home, name) {
  const skillDir = join(home, '.claude', 'skills', name);
  mkdirSync(skillDir, { recursive: true });

  // v1 snapshot
  const ver1Dir = join(skillDir, 'versions', '1');
  mkdirSync(ver1Dir, { recursive: true });
  const v1Content = [
    '---', `name: ${name}`, `description: Skill ${name}`, 'type: skill', 'version: 1', '---',
    '', `# ${name} v1`, 'Prior v1 content.',
  ].join('\n');
  writeFileSync(join(ver1Dir, name + '.md'), v1Content, 'utf-8');

  // v2 live file (current)
  const ver2Dir = join(skillDir, 'versions', '2');
  mkdirSync(ver2Dir, { recursive: true });
  const v2Content = [
    '---', `name: ${name}`, `description: Skill ${name}`, 'type: skill', 'version: 2', '---',
    '', `# ${name} v2`, 'Upgraded v2 content.',
  ].join('\n');
  const liveFile = join(skillDir, name + '.md');
  writeFileSync(liveFile, v2Content, 'utf-8');
  writeFileSync(join(ver2Dir, name + '.md'), v2Content, 'utf-8');

  return liveFile;
}

function seedRoster(home, rosterData) {
  const rDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rDir, { recursive: true });
  const rPath = join(rDir, 'roster.json');
  writeFileSync(rPath, JSON.stringify(rosterData, null, 2), 'utf-8');
  return rPath;
}

// ── Test 1: `log` prints history from digest ─────────────────────────────────
{
  const home = makeHome();
  const digest = {
    created: ['watchdog-monitor-builder'],
    upgraded: [{ name: 'watchdog-monitor-builder', from: 1, to: 2 }],
    rolledback: [{ name: 'watchdog-monitor-builder', from: 2, to: 1 }],
  };
  writeDigest(home, digest);

  const r = runCLI(home, ['log']);
  assert.strictEqual(r.status, 0, `test 1: cli log must exit 0; stderr=${r.stderr}`);

  const out = r.stdout;
  assert.ok(out.includes('watchdog-monitor-builder'), `test 1: log must mention the skill name; got: ${out.slice(0, 200)}`);
  assert.ok(out.match(/created|Created|create/i), `test 1: log must mention 'created'; got: ${out.slice(0, 200)}`);
  assert.ok(out.match(/upgraded|Upgraded|upgrade/i), `test 1: log must mention 'upgraded'; got: ${out.slice(0, 200)}`);
  assert.ok(out.match(/rolled.?back|Rolled.?back|rollback/i), `test 1: log must mention 'rolledback'; got: ${out.slice(0, 200)}`);

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 1: log prints create/upgrade/rollback history from digest');
}

// ── Test 2: `rollback <name>` restores prior version + updates roster ─────────
{
  const home = makeHome();
  const NAME = 'watchdog-monitor-builder';
  const liveFile = seedSkillV2(home, NAME);
  const rosterPath = seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'Watchdog skill',
        version: 2,
        path: liveFile,
        last_upgraded_at: new Date().toISOString(),
        acl_promoted: true,
      },
    },
  });

  const r = runCLI(home, ['rollback', NAME]);
  assert.strictEqual(r.status, 0, `test 2: cli rollback must exit 0; stderr=${r.stderr} stdout=${r.stdout}`);

  // Live file should now contain v1 content
  const liveContent = readFileSync(liveFile, 'utf-8');
  assert.ok(
    liveContent.includes('version: 1') || liveContent.includes('Prior v1 content'),
    `test 2: live file must be v1 content after rollback; got: ${liveContent.slice(0, 100)}`,
  );

  // Roster version should be 1
  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = roster.skills[NAME];
  assert.ok(entry, 'test 2: roster entry must exist');
  assert.strictEqual(entry.version, 1, `test 2: roster version must be 1; got ${entry.version}`);

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 2: rollback <name> restores v1 + updates roster');
}

// ── Test 3: idempotency — already at v1 → no-op ──────────────────────────────
{
  const home = makeHome();
  const NAME = 'already-v1-builder';
  const skillDir = join(home, '.claude', 'skills', NAME);
  mkdirSync(skillDir, { recursive: true });
  const v1Content = [
    '---', `name: ${NAME}`, `description: Skill`, 'type: skill', 'version: 1', '---',
    '', `# ${NAME} v1`, 'Already v1 content.',
  ].join('\n');
  const liveFile = join(skillDir, NAME + '.md');
  writeFileSync(liveFile, v1Content, 'utf-8');

  const rosterPath = seedRoster(home, {
    agents: {},
    skills: {
      [NAME]: {
        description: 'Already v1 skill',
        version: 1,
        path: liveFile,
        acl_promoted: true,
        // No last_upgraded_at — never upgraded
      },
    },
  });

  const r = runCLI(home, ['rollback', NAME]);
  assert.strictEqual(r.status, 0, `test 3: cli rollback at v1 must exit 0; stderr=${r.stderr}`);

  // Content must be unchanged
  const liveAfter = readFileSync(liveFile, 'utf-8');
  assert.strictEqual(liveAfter, v1Content, 'test 3: v1 content must be unchanged after idempotent rollback');

  // Roster version still 1
  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  assert.strictEqual(roster.skills[NAME].version, 1, 'test 3: roster version must remain 1');

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 3: rollback <name> at v1 → idempotent no-op');
}

// ── Test 4: `log` with empty digest → graceful output ────────────────────────
{
  const home = makeHome();
  writeDigest(home, { created: [], upgraded: [], rolledback: [] });

  const r = runCLI(home, ['log']);
  assert.strictEqual(r.status, 0, `test 4: cli log with empty digest must exit 0; stderr=${r.stderr}`);

  rmSync(home, { recursive: true, force: true });
  console.log('  ok  test 4: log with empty digest → graceful (exit 0)');
}

console.log('ok');
