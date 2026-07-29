#!/usr/bin/env node
// F11 (task #26) — tools/lib/prism-roster-reconcile.mjs.
//
// Exercises reconcileRoster() against ephemeral testbeds (no subprocess spawn
// needed — plain ESM module, direct import). Covers all four report
// categories plus the two false-positive traps this task exists to close:
//   (a) scope conflation — a project agent legitimately absent from the
//       GLOBAL roster must NOT be reported as an orphan.
//   (b) recursive-walk over-collection — an agent-factory support subdir
//       (references/, experience/, lessons/) must NOT be misread as an
//       orphaned agent (this was a real bug caught during manual
//       verification against the live repo before this test existed).
//
// Run: node tests/v3/state/test-prism-roster-reconcile.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { reconcileRoster } from '../../../tools/lib/prism-roster-reconcile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function agentFrontmatter(name, extra = '') {
  return `---\nname: ${name}\ndescription: test fixture\n${extra}---\n\nBody.\n`;
}

function writeRoster(path, agents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: '3.1.0', schema_version: '3.1.0', agents, skills: {}, tools: {}, mcps: {} }, null, 2));
}

const home = mkdtempSync(join(tmpdir(), 'prism-roster-reconcile-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'prism-roster-reconcile-cwd-'));

try {
  const globalAgentsDir = join(home, '.claude', 'agents');
  const globalRosterPath = join(globalAgentsDir, '..', 'skills', 'prism-plan', 'references', 'roster.json');
  const projectAgentsDir = join(cwd, '.claude', 'agents');
  const projectRosterPath = join(projectAgentsDir, 'roster.json');
  mkdirSync(globalAgentsDir, { recursive: true });
  mkdirSync(projectAgentsDir, { recursive: true });

  // ── 1. orphanRosterEntries — roster key, no file on disk ──────────────────
  // ── 2. orphanDiskFiles — flat file on disk, no roster entry ────────────────
  // ── 3. renamedOrphans — file exists but frontmatter name != roster key ─────
  writeFileSync(join(globalAgentsDir, 'stale-agent.md'), 'placeholder, never referenced');
  // wait — stale-agent.md above is itself an orphanDiskFile candidate; keep it
  // deliberately to exercise that case (see assertion below), then also add a
  // roster entry pointing at a file that plain doesn't exist:
  const globalAgents = {
    'gone-agent': {
      agent_path: join(globalAgentsDir, 'gone-agent.md'), // never written
    },
    'renamed-target': {
      agent_path: join(globalAgentsDir, 'renamed-target.md'),
    },
    'healthy-flat': {
      agent_path: join(globalAgentsDir, 'healthy-flat.md'),
    },
    'healthy-nested': {
      agent_path: join(globalAgentsDir, 'healthy-nested', 'agent.md'),
    },
  };
  writeRoster(globalRosterPath, globalAgents);

  // renamed-target.md exists, but its OWN frontmatter now says a different name
  // (simulating a rename after registration — the literal F11 shape).
  writeFileSync(join(globalAgentsDir, 'renamed-target.md'), agentFrontmatter('renamed-target-v2'));
  writeFileSync(join(globalAgentsDir, 'healthy-flat.md'), agentFrontmatter('healthy-flat'));
  mkdirSync(join(globalAgentsDir, 'healthy-nested'), { recursive: true });
  writeFileSync(join(globalAgentsDir, 'healthy-nested', 'agent.md'), agentFrontmatter('healthy-nested'));
  // Agent-factory support subdirs (the false-positive trap this task closed —
  // see file header (b)). Must NOT be reported as orphaned agents.
  mkdirSync(join(globalAgentsDir, 'healthy-nested', 'references'), { recursive: true });
  writeFileSync(join(globalAgentsDir, 'healthy-nested', 'references', 'core-expertise.md'), '# notes');
  mkdirSync(join(globalAgentsDir, 'healthy-nested', 'lessons'), { recursive: true });
  writeFileSync(join(globalAgentsDir, 'healthy-nested', 'lessons', 'improvements.md'), '# notes');
  mkdirSync(join(globalAgentsDir, 'healthy-nested', 'experience', 'context-adapters'), { recursive: true });
  writeFileSync(join(globalAgentsDir, 'healthy-nested', 'experience', 'decisions.md'), '# notes');
  writeFileSync(join(globalAgentsDir, 'healthy-nested', 'experience', 'context-adapters', 'some-project.md'), '# notes');

  // ── 4. shadowed — project entry shares a name with a global entry ─────────
  writeRoster(projectRosterPath, {
    'healthy-flat': { agent_path: join(projectAgentsDir, 'healthy-flat.md') }, // collides with global
    'project-only-agent': { agent_path: join(projectAgentsDir, 'project-only-agent.md') },
  });
  writeFileSync(join(projectAgentsDir, 'healthy-flat.md'), agentFrontmatter('healthy-flat'));
  writeFileSync(join(projectAgentsDir, 'project-only-agent.md'), agentFrontmatter('project-only-agent'));

  const report = reconcileRoster({ home, cwd });

  // ── assertions ──────────────────────────────────────────────────────────
  ok('roster files parsed cleanly', !report.global_roster_unparseable && !report.project_roster_unparseable);

  const orphanKeys = report.orphanRosterEntries.map((o) => o.roster_key);
  ok('orphanRosterEntries flags gone-agent (roster entry, no file)', orphanKeys.includes('gone-agent'));
  ok('orphanRosterEntries does NOT flag healthy-flat/healthy-nested/renamed-target',
    !orphanKeys.includes('healthy-flat') && !orphanKeys.includes('healthy-nested') && !orphanKeys.includes('renamed-target'));

  const orphanDiskIdentities = report.orphanDiskFiles.map((o) => o.inferred_identity);
  ok('orphanDiskFiles flags stale-agent.md (file, no roster entry)', orphanDiskIdentities.includes('stale-agent'));
  ok('orphanDiskFiles does NOT misread support subdirs as orphaned agents (the recursive-walk false positive)',
    !orphanDiskIdentities.some((id) => ['references', 'experience', 'lessons', 'context-adapters'].includes(id)),
    `got: ${JSON.stringify(orphanDiskIdentities)}`);
  ok('orphanDiskFiles count is exactly 1 (only stale-agent.md, nothing from healthy-nested support dirs)',
    report.orphanDiskFiles.length === 1, `got ${report.orphanDiskFiles.length}: ${JSON.stringify(orphanDiskIdentities)}`);

  const renamedKeys = report.renamedOrphans.map((r) => r.roster_key);
  ok('renamedOrphans flags renamed-target (file exists, frontmatter name drifted)', renamedKeys.includes('renamed-target'));
  ok('renamedOrphans does NOT flag healthy-flat/healthy-nested (frontmatter matches key)',
    !renamedKeys.includes('healthy-flat') && !renamedKeys.includes('healthy-nested'));

  ok('shadowed flags healthy-flat (project entry name collides with global)',
    report.shadowed.some((s) => s.name === 'healthy-flat'));
  ok('shadowed does NOT flag project-only-agent (no global collision)',
    !report.shadowed.some((s) => s.name === 'project-only-agent'));

  // ── the trap: project-only agent must never appear as a GLOBAL orphan ────
  ok('project-only-agent is NOT reported as a user-global orphan (the scope-conflation trap)',
    !report.orphanRosterEntries.some((o) => o.scope === 'user-global' && o.roster_key === 'project-only-agent') &&
    !report.orphanDiskFiles.some((o) => o.scope === 'user-global' && o.inferred_identity === 'project-only-agent'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
