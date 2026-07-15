#!/usr/bin/env node
// Drift-guard for the v4.2 Phase 0 lesson:
//   .claude-plugin/plugin.json (the marketplace install contract) and
//   settings.fragment.json (the manual / dev-install contract) are two
//   sources of truth for the same hook surface. They drifted silently
//   across v3.5.0, v4.0, and v4.1 — by v4.1, plugin.json was 5 hooks
//   behind. This test fails the build if they drift again.
//
// Assertions:
//   1. plugin.json.version matches the top semver entry of CHANGELOG.md
//      (anyone bumping the changelog must also bump the manifest).
//   2. Object.keys(plugin.hooks).sort() === Object.keys(settings.hooks).sort()
//      (no event key is present in one and missing in the other).
//   3. For each shared event, the (matcher | handler-basename) multiset
//      is identical (same handlers register with the same matchers; path
//      prefixes differ — plugin uses ${CLAUDE_PLUGIN_ROOT}/hooks/, settings
//      uses ~/.claude/hooks/ via bash prism-exec.sh — but the .mjs
//      basename and matcher must match).
//
// Skips gracefully if either file is missing; fails if both exist and
// drift.
//
// Run: node tests/v3/state/test-plugin-manifest-drift.mjs

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PLUGIN_PATH = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const SETTINGS_PATH = join(REPO_ROOT, 'settings.fragment.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`expected:\n${JSON.stringify(b)}\ngot:\n${JSON.stringify(a)}${msg ? '\n— ' + msg : ''}`);
}

// Skip if either truth-source is absent — drift cannot exist if there is
// only one file. We still want CI to pass on partial checkouts / forks
// that strip plugin packaging.
if (!existsSync(PLUGIN_PATH) || !existsSync(SETTINGS_PATH)) {
  const missing = !existsSync(PLUGIN_PATH) ? 'plugin.json' : 'settings.fragment.json';
  process.stdout.write(`  skip  plugin/settings drift-guard: ${missing} not present\n`);
  process.stdout.write(`\n0 passed, 0 failed, 1 skipped\n`);
  process.exit(0);
}

const plugin = JSON.parse(readFileSync(PLUGIN_PATH, 'utf8'));
const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));

function fingerprint(entries) {
  const out = [];
  for (const entry of entries || []) {
    const matcher = entry.matcher || '';
    for (const h of entry.hooks || []) {
      const m = (h.command || '').match(/([A-Za-z0-9_-]+\.mjs)/);
      if (m) out.push(`${matcher}|${m[1]}`);
    }
  }
  return out.sort();
}

test('plugin.json version matches CHANGELOG.md top semver entry', () => {
  const cl = readFileSync(CHANGELOG_PATH, 'utf8');
  const m = cl.match(/^##\s+\[(\d+\.\d+\.\d+)\]/m);
  assert(m, 'CHANGELOG.md top entry must match `## [X.Y.Z]`');
  assertEq(plugin.version, m[1], `plugin.json version (${plugin.version}) must match CHANGELOG top entry (${m[1]})`);
});

test('plugin.json + settings.fragment.json have identical hook event keys', () => {
  const pluginKeys = Object.keys(plugin.hooks || {}).sort();
  const settingsKeys = Object.keys(settings.hooks || {}).sort();
  assertEq(
    JSON.stringify(pluginKeys),
    JSON.stringify(settingsKeys),
    `event-key drift: plugin=${pluginKeys.join(',')} settings=${settingsKeys.join(',')}`,
  );
});

test('each shared hook event has identical (matcher | handler-basename) multisets', () => {
  const shared = Object.keys(plugin.hooks || {}).filter(k => k in (settings.hooks || {}));
  for (const eventKey of shared) {
    const pluginFp = fingerprint(plugin.hooks[eventKey]);
    const settingsFp = fingerprint(settings.hooks[eventKey]);
    assertEq(
      JSON.stringify(pluginFp),
      JSON.stringify(settingsFp),
      `event ${eventKey}: handler drift\n  plugin   = ${pluginFp.join(', ')}\n  settings = ${settingsFp.join(', ')}`,
    );
  }
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
