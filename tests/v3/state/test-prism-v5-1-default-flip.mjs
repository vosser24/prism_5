#!/usr/bin/env node
// Drift-guard for the v5.1 default-flip (project-master opt-in → default-on)
// and the claude-mem two-mode memory docs. Asserts the LIVE doc surfaces
// describe default-on behaviour and do NOT carry the stale opt-in prose.
//
// Origin: docs/prism/plans/2026-06-02-project-master-default-and-lifecycle.md (P4).
// House pattern mirrors test-master-orchestrator-v5-architect.mjs.
// The "default-flip prose sweep" lesson (feedback-default-flip-prose-sweep):
// every prose surface that referenced the old default must be enumerated here.
//
// Run: node tests/v3/state/test-prism-v5-1-default-flip.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const bootstrap = read('commands', 'prism-bootstrap.md');
const help = read('commands', 'prism-help.md');
const readme = read('README.md');
const deepDive = read('commands', 'prism-deep-dive.md');
const skill = read('skills', 'master-orchestrator', 'SKILL.md');

// ── commands/prism-bootstrap.md ─────────────────────────────────────────────
test('bootstrap.md: project-master phase is DEFAULT-ON with --no-master opt-out', () => {
  assert(/[Dd]efault-on/.test(bootstrap), 'must state the phase is default-on');
  assert(/--no-master/.test(bootstrap), 'must document the --no-master opt-out');
});

test('bootstrap.md: --with-deep-dive is documented as an accepted no-op', () => {
  assert(/--with-deep-dive[^\n]*no-?op/i.test(bootstrap), 'must mark --with-deep-dive a no-op');
});

test('bootstrap.md: carries NO stale opt-in/skipped-by-default project-master prose', () => {
  assert(!/Opt-in only/i.test(bootstrap), 'stale "Opt-in only" must be gone');
  assert(!/opt-in to phase 6/i.test(bootstrap), 'stale "opt-in to phase 6" must be gone');
  assert(!/skipped by default/i.test(bootstrap), 'stale "skipped by default" must be gone from bootstrap.md');
  assert(!/opt into the project-master phase/i.test(bootstrap), 'stale opt-into prose must be gone');
});

test('bootstrap.md: documents the claude-mem offer + two memory modes', () => {
  assert(/detect-claude-mem/.test(bootstrap), 'must call the detect-claude-mem helper');
  assert(/Memory modes/i.test(bootstrap), 'must have a Memory modes section');
  assert(/Mode A/.test(bootstrap) && /Mode B/.test(bootstrap), 'must describe Mode A and Mode B');
});

// ── commands/prism-help.md ──────────────────────────────────────────────────
test('help.md: bootstrap row says default-on, not "opt into the project-master phase"', () => {
  assert(/default-on/i.test(help), 'help bootstrap row must say default-on');
  assert(!/opt into the project-master phase/i.test(help), 'stale opt-into prose must be gone');
});

test('help.md: deep-dive row no longer calls it the "Opt-in entry point"', () => {
  assert(!/Opt-in entry point/i.test(help), 'stale "Opt-in entry point" must be gone from help.md');
});

// ── README.md ───────────────────────────────────────────────────────────────
test('README.md: project-master row says default-on (no stale opt-in-via-flag prose)', () => {
  assert(/[Dd]efault-on/.test(readme), 'README must state project-master is default-on');
  assert(!/Opt-in via `\/prism-bootstrap --with-deep-dive`/.test(readme), 'stale README opt-in line must be gone');
});

// ── commands/prism-deep-dive.md ─────────────────────────────────────────────
test('deep-dive.md: frontmatter no longer claims "Opt-in entry point for v4.0 project-master surface"', () => {
  assert(!/Opt-in entry point for v4\.0 project-master surface/i.test(deepDive), 'stale frontmatter opt-in claim must be gone');
});

// ── skills/master-orchestrator/SKILL.md ─────────────────────────────────────
test('SKILL.md: wrapper-degrade note reflects default-on (no-project-master is now rare)', () => {
  assert(/rare/i.test(skill) && /--no-master/.test(skill), 'must note no-project-master is rare (default-on / --no-master)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
