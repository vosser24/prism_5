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

// tools/lib/prism-state.mjs exports its own PRISM_VERSION constant — a THIRD
// canonical version source that the two checks above never touch. It drifted
// stuck at 6.1.0 through the 6.6.6 release even while plugin.json and the
// manifest agreed with each other. Deliberately does NOT check SCHEMA_VERSION
// (also exported from that file) — SCHEMA_VERSION is an independent
// state-schema version (currently 2) that must NOT track the release version.
const statePath = join(ROOT, 'tools', 'lib', 'prism-state.mjs');
const stateSrc = readFileSync(statePath, 'utf-8');
const PRISM_VERSION_RE = /^export const PRISM_VERSION = '([^']+)';\s*$/m;
const stateVersionMatch = stateSrc.match(PRISM_VERSION_RE);
const stateVersion = stateVersionMatch ? stateVersionMatch[1] : null;
ok(
  'tools/lib/prism-state.mjs PRISM_VERSION === install-manifest prism_version',
  stateVersion !== null && stateVersion === manifest.prism_version,
  stateVersion === null
    ? `could not find "export const PRISM_VERSION = '...';" in ${statePath} — regex out of date? (this must FAIL, not silently pass, when the constant can't be located)`
    : `tools/lib/prism-state.mjs PRISM_VERSION=${stateVersion} but install-manifest.prism_version=${manifest.prism_version} — bump BOTH on every release (this exact constant was stuck at 6.1.0 through the 6.6.6 release)`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
