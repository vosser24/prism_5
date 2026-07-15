#!/usr/bin/env node
// Version-sync guard (v5.12.1). The installer banner, the ~/.claude/.prism-version
// marker, and `prism-installer update` all read `prism_version` from
// tools/install-manifest.json — NOT from .claude-plugin/plugin.json. In v5.12.0
// plugin.json was bumped but the manifest was left at 5.11.0, so the installer
// reported the wrong version (live-repro 2026-06-19). This test fails fast if the
// two canonical version sources ever drift again.
//
// Run: node tests/v3/state/test-version-sync.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `\n        ${detail}` : ''}`); } };

const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools', 'install-manifest.json'), 'utf-8'));

const SEMVER = /^\d+\.\d+\.\d+$/;
ok('plugin.json version is semver', SEMVER.test(plugin.version || ''), `got: ${plugin.version}`);
ok('install-manifest prism_version is semver', SEMVER.test(manifest.prism_version || ''), `got: ${manifest.prism_version}`);
ok(
  'plugin.json version === install-manifest prism_version',
  plugin.version === manifest.prism_version,
  `plugin.json=${plugin.version} but install-manifest.prism_version=${manifest.prism_version} — bump BOTH on every release (the installer reads the manifest, not plugin.json)`
);

// The CHANGELOG must document the current version.
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8');
ok(
  'CHANGELOG has an entry for the current version',
  changelog.includes(`[${plugin.version}]`),
  `no "[${plugin.version}]" heading found in CHANGELOG.md`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
