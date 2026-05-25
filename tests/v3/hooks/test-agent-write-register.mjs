#!/usr/bin/env node
// Tests for hooks/prism-agent-write-register.mjs (Phase A.3).
// Drives the hook as a subprocess with synthetic PostToolUse input on stdin.
//
// Run: node tests/v3/hooks/test-agent-write-register.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-agent-write-register.mjs');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

// Run the hook with synthetic PostToolUse JSON on stdin. Override HOME via env
// so the hook can't write into the real user home during tests.
function runHook({toolName, filePath, home, env = {}}) {
  const input = JSON.stringify({
    tool_name: toolName,
    tool_input: {file_path: filePath},
  });
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: {...process.env, HOME: home, USERPROFILE: home, ...env},
  });
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function makeFakeHome(label) {
  return mkdtempSync(join(tmpdir(), `prism-hook-test-${label}-`));
}

function writeAgentFile(absPath, name, description) {
  mkdirSync(dirname(absPath), {recursive: true});
  writeFileSync(absPath, `---
name: ${name}
description: ${description}
---
# ${name}

agent body
`);
}

function readRoster(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ------------------------------ tests ------------------------------

test('ignores tool other than Write/Edit/MultiEdit', () => {
  const home = makeFakeHome('skip-tool');
  try {
    const r = runHook({toolName: 'Read', filePath: join(home, '.claude', 'agents', 'foo.md'), home});
    assertEq(r.status, 0, r.stderr);
    // No roster created
    const global = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(!existsSync(global), 'should not create roster for Read tool');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('ignores writes outside .claude/agents/', () => {
  const home = makeFakeHome('skip-path');
  try {
    const r = runHook({toolName: 'Write', filePath: join(home, 'random', 'file.md'), home});
    assertEq(r.status, 0);
    const global = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(!existsSync(global), 'should not create roster for non-agent path');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('disabled via PRISM_DISABLE_AGENT_WRITE_HOOK=1', () => {
  const home = makeFakeHome('disabled');
  try {
    const agentPath = join(home, '.claude', 'agents', 'foo.md');
    writeAgentFile(agentPath, 'foo', 'does foo things');
    const r = runHook({
      toolName: 'Write',
      filePath: agentPath,
      home,
      env: {PRISM_DISABLE_AGENT_WRITE_HOOK: '1'},
    });
    assertEq(r.status, 0);
    const global = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(!existsSync(global), 'should not write roster when disabled');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('global agent write → creates global roster with entry', () => {
  const home = makeFakeHome('global-create');
  try {
    const agentPath = join(home, '.claude', 'agents', 'foo.md');
    writeAgentFile(agentPath, 'foo', 'does foo things');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);
    assert(/registered foo/.test(r.stdout), 'stdout: ' + r.stdout);
    const global = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(existsSync(global), 'global roster created');
    const roster = readRoster(global);
    assert(roster.agents && roster.agents.foo, 'foo registered');
    assertEq(roster.agents.foo.description, 'does foo things');
    assert(roster.agents.foo.auto_registered === true, 'flagged auto_registered');
    assert(roster.agents.foo.created, 'created timestamp set');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('global agent write: appends to existing roster without clobbering', () => {
  const home = makeFakeHome('global-append');
  try {
    const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    mkdirSync(dirname(rosterPath), {recursive: true});
    writeFileSync(rosterPath, JSON.stringify({
      version: '3.1.0',
      agents: {existing: {created: '2025-01-01T00:00:00Z', description: 'old'}},
      skills: {},
      tools: {},
      mcps: {},
    }, null, 2));

    const agentPath = join(home, '.claude', 'agents', 'newone.md');
    writeAgentFile(agentPath, 'newone', 'newly added');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);
    const roster = readRoster(rosterPath);
    assert(roster.agents.existing, 'existing entry preserved');
    assert(roster.agents.newone, 'new entry added');
    assertEq(roster.agents.existing.description, 'old');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('idempotent: re-fire on same agent does not duplicate', () => {
  const home = makeFakeHome('idem');
  try {
    const agentPath = join(home, '.claude', 'agents', 'foo.md');
    writeAgentFile(agentPath, 'foo', 'does foo');
    const r1 = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r1.status, 0);
    const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    const before = readRoster(rosterPath);
    const beforeCreated = before.agents.foo.created;

    const r2 = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r2.status, 0);
    assert(/already registered/.test(r2.stdout) || r2.stdout === '', 'silent or already-msg: ' + r2.stdout);
    const after = readRoster(rosterPath);
    assertEq(after.agents.foo.created, beforeCreated, 'created not bumped');
    assertEq(Object.keys(after.agents).length, 1, 'no duplicates');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('project-local agent write → uses project roster, not global', () => {
  const home = makeFakeHome('project');
  try {
    const projectRoot = join(home, 'work', 'myproj');
    const agentPath = join(projectRoot, '.claude', 'agents', 'projbot.md');
    writeAgentFile(agentPath, 'projbot', 'project-scoped agent');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);
    const projectRoster = join(projectRoot, '.claude', 'agents', 'roster.json');
    assert(existsSync(projectRoster), 'project roster created');
    const roster = readRoster(projectRoster);
    assert(roster.agents.projbot, 'projbot registered in project roster');

    // Global roster should NOT be touched
    const globalRoster = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    assert(!existsSync(globalRoster), 'global roster not created for project write');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('agent file with no frontmatter → registers with empty description', () => {
  const home = makeFakeHome('no-fm');
  try {
    const agentPath = join(home, '.claude', 'agents', 'plain.md');
    mkdirSync(dirname(agentPath), {recursive: true});
    writeFileSync(agentPath, '# just a bare md file\n\nno frontmatter at all\n');
    const r = runHook({toolName: 'Write', filePath: agentPath, home});
    assertEq(r.status, 0, r.stderr);
    const rosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
    const roster = readRoster(rosterPath);
    assert(roster.agents.plain, 'plain registered using filename');
    assertEq(roster.agents.plain.description, '');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('malformed JSON in input → exits 0 silently (defensive)', () => {
  const home = makeFakeHome('malformed');
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: 'not valid json',
      encoding: 'utf8',
      env: {...process.env, HOME: home, USERPROFILE: home},
    });
    assertEq(r.status, 0, r.stderr);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
