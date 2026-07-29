#!/usr/bin/env node
// tests/v3/state/acl-promote-merge-preserve.test.mjs — task #51 (F35 / D088 Part B
// follow-up): tools/prism-capability-promote.mjs must spread-merge over an
// existing roster.skills[<name>] entry rather than bare-replace it.
//
// roster.skills[<name>] is a shared namespace across three writers with three
// different schemas (see docs/prism/plans/2026-07-28-prism-index-options-and-
// schema-reconciliation.md Part B):
//   - indexer schema (hooks/prism-skill-write-register.mjs): type/source/
//     domains/keywords/trigger_phrases/last_indexed/frontmatter_mtime/
//     auto_registered
//   - capability-promote schema (tools/prism-capability-promote.mjs, fixed by
//     this task): description/version/path/created_at/acl_promoted/keywords
//   - ACL-learn schema (tools/prism-capability-learn.mjs): corrections_received/
//     corrections_since_last_upgrade/pending_upgrade/last_upgraded_at, and a
//     version bump on upgrade
//
// Before the fix, promote()'s unconditional `roster.skills[name] = entry`
// (line ~191) would silently DROP every field not in its own schema whenever
// it wrote over an entry already touched by the other two writers.
//
// tools/prism-index.mjs does not exist (explicitly out of scope for this
// task — see the brief), so this test cannot literally run "the indexer".
// Instead it seeds roster.skills[<name>] with an entry carrying BOTH the
// indexer-only fields and the ACL-learn-only fields (i.e. what the roster
// would look like today, right before a second promote() call), then
// exercises the REAL, now-fixed promote() write path and asserts every field
// promote() does not itself own survives the write.

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promote } from '../../../tools/prism-capability-promote.mjs';

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-promote-merge-'));

const rosterDir = join(tmpHome, '.claude', 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');

const name = 'watchdog-monitor-builder'; // deriveName('watchdog-monitor-builder') is a no-op (already ends -builder)

// Pre-existing entry shaped like the roster would look after:
//   1. hooks/prism-skill-write-register.mjs auto-registered it (indexer schema)
//   2. tools/prism-capability-promote.mjs promoted it once already (version/acl_promoted)
//   3. tools/prism-capability-learn.mjs attributed corrections + completed one upgrade
const preExisting = {
  // indexer-only fields — promote()'s entry never sets these
  type: 'skill',
  source: 'user',
  domains: ['ops', 'monitoring'],
  trigger_phrases: ['watchdog trigger phrase'],
  last_indexed: '2026-01-01T00:00:00.000Z',
  frontmatter_mtime: '2026-01-01T00:00:00.000Z',
  auto_registered: true,
  // ACL-learn-only fields — promote()'s entry never sets these
  corrections_received: 7,
  corrections_since_last_upgrade: 2,
  pending_upgrade: false,
  last_upgraded_at: '2026-02-01T00:00:00.000Z',
  // fields promote() DOES own — stale values that a fresh promote() call is
  // expected to legitimately refresh, not "preserve"
  description: 'stale description',
  version: 3,
  path: join(tmpHome, '.claude', 'skills', name, 'old-file.md'),
  created_at: '2026-01-01T00:00:00.000Z',
  acl_promoted: true,
  keywords: ['stale', 'keyword'],
};

writeFileSync(rosterPath, JSON.stringify({ agents: {}, skills: { [name]: preExisting } }, null, 2), 'utf-8');

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
    'Re-promoted stub content.',
  ].join('\n');
  writeFileSync(dest, content, 'utf-8');
  return dest;
}

const candidate = {
  kind: 'promote',
  label: name,
  members: ['build a watchdog process', 'monitor service health', 'set up uptime checker'],
  sessions: ['sess-A', 'sess-A', 'sess-B'],
  suggestedType: 'skill',
};

let pass = 0, total = 0;
const check = (label, cond) => { total++; if (cond) pass++; else console.log('FAIL: ' + label); };

try {
  const result = await promote(candidate, { home: tmpHome, factory: stubFactory });
  check('promote() derives the same name (no accidental rename)', result.name === name);

  const roster = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = roster.skills[name];
  check('entry still present after re-promote', !!entry);

  // ── The regression this test guards: fields NOT in promote()'s own schema
  //    must SURVIVE a second promote() write. Before the fix, a bare
  //    `roster.skills[name] = entry` would have dropped every one of these.
  check('corrections_received SURVIVES', entry.corrections_received === 7);
  check('corrections_since_last_upgrade SURVIVES', entry.corrections_since_last_upgrade === 2);
  check('pending_upgrade SURVIVES', entry.pending_upgrade === false);
  check('last_upgraded_at SURVIVES', entry.last_upgraded_at === '2026-02-01T00:00:00.000Z');
  check('type (indexer field) SURVIVES', entry.type === 'skill');
  check('source (indexer field) SURVIVES', entry.source === 'user');
  check('domains (indexer field) SURVIVES', JSON.stringify(entry.domains) === JSON.stringify(['ops', 'monitoring']));
  check('trigger_phrases (indexer field) SURVIVES', JSON.stringify(entry.trigger_phrases) === JSON.stringify(['watchdog trigger phrase']));
  check('last_indexed (indexer field) SURVIVES', entry.last_indexed === '2026-01-01T00:00:00.000Z');
  check('frontmatter_mtime (indexer field) SURVIVES', entry.frontmatter_mtime === '2026-01-01T00:00:00.000Z');
  check('auto_registered (indexer field) SURVIVES', entry.auto_registered === true);

  // ── Sanity: fields promote() DOES own are legitimately refreshed, not
  //    frozen at their stale pre-existing values (proves the merge didn't
  //    turn into an accidental no-op / reverse-merge).
  check('acl_promoted still true (own field, refreshed)', entry.acl_promoted === true);
  check('version refreshed from new frontmatter (own field)', entry.version === 1);
  check('description refreshed (own field)', entry.description !== 'stale description');
  check('path refreshed to new livePath (own field)', entry.path === result.livePath && entry.path !== preExisting.path);
  check('keywords refreshed (own field)', JSON.stringify(entry.keywords) !== JSON.stringify(['stale', 'keyword']));

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
