#!/usr/bin/env node
// tests/v3/state/acl-promote.test.mjs — F1.4 TDD test: Promoter + Validator/Versioner
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promote } from '../../../tools/prism-capability-promote.mjs';

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-promote-test-'));

// Minimal global roster (empty)
const rosterDir = join(tmpHome, '.claude', 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');
writeFileSync(rosterPath, JSON.stringify({ agents: {}, skills: {} }), 'utf-8');

// A stub factory: writes a minimal skill markdown into staging/<name>.md
function stubFactory(spec, stagingDir) {
  const dest = join(stagingDir, spec.name + '.md');
  const content = [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    'type: skill',
    'version: 1',
    '---',
    '',
    `# ${spec.name}`,
    '',
    'Auto-generated stub skill for testing.',
  ].join('\n');
  writeFileSync(dest, content, 'utf-8');
  return dest;
}

const candidate = {
  kind: 'promote',
  label: 'watchdog-monitor-health',
  members: ['build a watchdog process', 'monitor service health', 'set up uptime checker'],
  sessions: ['sess-A', 'sess-A', 'sess-B'],
  suggestedType: 'skill',
};

try {
  const result = await promote(candidate, {
    home: tmpHome,
    factory: stubFactory,
  });

  // (a) live file exists
  assert.ok(result.livePath, 'promote must return livePath');
  assert.ok(existsSync(result.livePath), `live file must exist at ${result.livePath}`);

  // (b) global roster gained the key
  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const skillCount = Object.keys(roster.skills || {}).length;
  assert.ok(skillCount >= 1, `roster.skills must have at least 1 entry, got ${skillCount}`);
  assert.ok(roster.skills[result.name], `roster.skills must contain key "${result.name}"`);

  // (c) version snapshot exists
  assert.ok(result.versionPath, 'promote must return versionPath');
  assert.ok(existsSync(result.versionPath), `version snapshot must exist at ${result.versionPath}`);

  // (d) digest was appended
  const { digestPath } = await import('../../../tools/lib/prism-acl-store.mjs');
  const dp = digestPath(tmpHome);
  assert.ok(existsSync(dp), 'digest file must exist');
  const digest = JSON.parse(readFileSync(dp, 'utf-8'));
  assert.ok(Array.isArray(digest.created), 'digest.created must be an array');
  assert.ok(digest.created.includes(result.name), `digest.created must include "${result.name}"`);

  console.log('ok');
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}

// ── F1.5: promote() refuses to promote over a FLAT-owned agent ────────────────
{
  const tmpHome2 = mkdtempSync(join(tmpdir(), 'prism-acl-promote-guard-'));
  const rosterDir2 = join(tmpHome2, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(rosterDir2, { recursive: true });
  writeFileSync(join(rosterDir2, 'roster.json'), JSON.stringify({ agents: {}, skills: {} }), 'utf-8');

  // Seed a FLAT agent file whose basename matches the name promote() derives.
  // deriveName('claude-master-agent') keeps it (ends with -agent) → same name.
  const flatDir = join(tmpHome2, '.claude', 'agents');
  mkdirSync(flatDir, { recursive: true });
  const flatName = 'claude-master-agent';
  writeFileSync(join(flatDir, flatName + '.md'),
    '---\nname: ' + flatName + '\ndescription: shipped flat agent\n---\n', 'utf-8');

  let factoryCalled = false;
  function guardFactory(spec, stagingDir) {
    factoryCalled = true;
    const dest = join(stagingDir, spec.name + '.md');
    writeFileSync(dest, '---\nname: ' + spec.name + '\ndescription: x\n---\n', 'utf-8');
    return dest;
  }

  const guardCandidate = {
    kind: 'promote',
    label: flatName,              // derives to itself (ends with -agent)
    members: ['a', 'b', 'c'],
    sessions: ['s1', 's2', 's3'],
    suggestedType: 'agent',
  };

  let threw = false;
  try {
    await promote(guardCandidate, { home: tmpHome2, factory: guardFactory });
  } catch (e) {
    threw = true;
    assert.ok(/flat-owned/.test(e.message),
      `promote() must reject with a flat-owned message, got: ${e.message}`);
  }

  assert.ok(threw, 'promote() must throw for a flat-owned agent');
  assert.strictEqual(factoryCalled, false,
    'promote() must not call the factory for a flat-owned agent');
  assert.ok(!existsSync(join(flatDir, flatName, flatName + '.md')),
    'promote() must not create a nested copy of a flat-owned agent');

  rmSync(tmpHome2, { recursive: true, force: true });
  console.log('F1.5 promote() flat-owned guard: PASS');
}
