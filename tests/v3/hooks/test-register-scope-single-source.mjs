#!/usr/bin/env node
// Tests for D2 / F10 — single source of truth roster invariant.
// Verifies:
//   1. global agent write → entry in global roster (orchestrator's read path)
//   2. project agent write → entry in project roster AND discoverable via resolveRoster
//
// Models test-agent-write-register.mjs (spawnSync hook, synthetic PostToolUse stdin).
//
// Run: node tests/v3/hooks/test-register-scope-single-source.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-agent-write-register.mjs');
const RESOLVER = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-roster-resolve.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function assertEq(a, b, m) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${m ? ' — ' + m : ''}`);
}
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

function writeAgentFile(absPath, name, description) {
  mkdirSync(dirname(absPath), {recursive: true});
  writeFileSync(absPath, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nagent body\n`);
}

function runHook({toolName, filePath, home, cwd}) {
  const input = JSON.stringify({tool_name: toolName, tool_input: {file_path: filePath}});
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: {...process.env, HOME: home, USERPROFILE: home},
    cwd: cwd || undefined,
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ── Test 1: global agent write → global roster (the orchestrator's read path) ──
await test('global agent write → global roster contains the entry', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-sot-global-'));
  try {
    const agentPath = join(home, '.claude', 'agents', 'myagent.md');
    writeAgentFile(agentPath, 'myagent', 'a test agent');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);

    const globalRoster = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(existsSync(globalRoster), 'global roster must exist');
    const roster = JSON.parse(readFileSync(globalRoster, 'utf-8'));
    assert(roster.agents && roster.agents.myagent, 'myagent must be in global roster');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── Test 2: project agent write → project roster present ──
await test('project agent write → project roster has the entry with scope project', () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-sot-proj-'));
  try {
    const projectRoot = join(home, 'work', 'myproj');
    const agentPath = join(projectRoot, '.claude', 'agents', 'projagent.md');
    writeAgentFile(agentPath, 'projagent', 'project-scoped agent');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);

    const projectRoster = join(projectRoot, '.claude', 'agents', 'roster.json');
    assert(existsSync(projectRoster), 'project roster must exist');
    const roster = JSON.parse(readFileSync(projectRoster, 'utf-8'));
    assert(roster.agents && roster.agents.projagent, 'projagent must be in project roster');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── Test 3: resolveRoster surfaces project-scoped agent via merge ──
await test('resolveRoster merges project roster — project-only agent visible with _scope:project', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-sot-resolve-'));
  const projectRoot = join(home, 'work', 'myproj');
  try {
    // Seed global roster (what the orchestrator reads)
    const globalRosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    mkdirSync(dirname(globalRosterPath), {recursive: true});
    writeFileSync(globalRosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {'global-agent': {description: 'global', model: 'sonnet'}},
      skills: {},
      tools: {},
      mcps: {},
    }));

    // Seed project roster (what the hook writes for project-local agents)
    const projectRosterPath = join(projectRoot, '.claude', 'agents', 'roster.json');
    mkdirSync(dirname(projectRosterPath), {recursive: true});
    writeFileSync(projectRosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {'master-myproj': {description: 'project master', model: 'sonnet', _origin: 'project'}},
      skills: {},
      tools: {},
      mcps: {},
    }));

    // Import resolveRoster and call it
    const mod = await import(pathToFileURL(RESOLVER).href);
    const result = mod.resolveRoster(home, projectRoot);

    // Global agent must be present
    assert(result.agents['global-agent'], 'global-agent must appear in merged result');
    // Project agent must be present (merged in)
    assert(result.agents['master-myproj'], 'master-myproj must appear in merged result');
    // Project agent must carry _scope:'project'
    assertEq(result.agents['master-myproj']._scope, 'project', '_scope must be "project"');
    // project_only must list it
    assert(result.project_only.includes('master-myproj'), 'master-myproj must be in project_only');
    // Global agent must NOT be in project_only
    assert(!result.project_only.includes('global-agent'), 'global-agent must not be in project_only');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── Test 4: resolveRoster — global wins on name collision ──
await test('resolveRoster — global entry wins on name collision (project does not override)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-sot-collision-'));
  const projectRoot = join(home, 'work', 'proj2');
  try {
    const globalRosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    mkdirSync(dirname(globalRosterPath), {recursive: true});
    writeFileSync(globalRosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {'shared-agent': {description: 'global version', model: 'opus'}},
      skills: {},
      tools: {},
      mcps: {},
    }));

    const projectRosterPath = join(projectRoot, '.claude', 'agents', 'roster.json');
    mkdirSync(dirname(projectRosterPath), {recursive: true});
    writeFileSync(projectRosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {'shared-agent': {description: 'project override attempt', model: 'haiku'}},
      skills: {},
      tools: {},
      mcps: {},
    }));

    const mod = await import(pathToFileURL(RESOLVER).href);
    const result = mod.resolveRoster(home, projectRoot);

    // Global description must win
    assertEq(result.agents['shared-agent'].description, 'global version', 'global must win on collision');
    // shared-agent must NOT be in project_only (it exists in global)
    assert(!result.project_only.includes('shared-agent'), 'shared-agent not in project_only');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── Test 5: resolveRoster — no project roster → graceful (only global) ──
await test('resolveRoster — no project roster → returns global only, project_only empty', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-sot-noproject-'));
  const projectRoot = join(home, 'work', 'noproj');
  try {
    const globalRosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    mkdirSync(dirname(globalRosterPath), {recursive: true});
    writeFileSync(globalRosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {'global-only': {description: 'only me', model: 'sonnet'}},
      skills: {},
      tools: {},
      mcps: {},
    }));

    const mod = await import(pathToFileURL(RESOLVER).href);
    const result = mod.resolveRoster(home, projectRoot);

    assert(result.agents['global-only'], 'global-only must be present');
    assertEq(result.project_only, [], 'project_only must be empty when no project roster');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
