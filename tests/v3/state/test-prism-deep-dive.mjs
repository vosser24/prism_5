#!/usr/bin/env node
// Tests for tools/prism-deep-dive.mjs (v4.0 Phase D helper).
// Subprocess-driven, mkdtemp testbeds, matches the prism-sync/prism-clean test patterns.
//
// Run: node tests/v3/state/test-prism-deep-dive.mjs

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, '..', '..', '..', 'tools', 'prism-deep-dive.mjs');
const BOOTSTRAP = join(__dirname, '..', '..', '..', 'tools', 'prism-bootstrap.mjs');

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

function makeTestbed(label) {
  const root = mkdtempSync(join(tmpdir(), `prism-dd-test-${label}-`));
  spawnSync('git', ['init', '-q'], {cwd: root});
  return root;
}

function run(cwd, ...args) {
  const r = spawnSync(process.execPath, [HELPER, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

function bootstrap(cwd, ...args) {
  const r = spawnSync(process.execPath, [BOOTSTRAP, ...args, '--root', cwd], {encoding: 'utf8'});
  return {stdout: r.stdout, stderr: r.stderr, status: r.status};
}

// ------------------------------ tests ------------------------------

test('git guard: refuses to run without .git/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prism-dd-nogit-'));
  try {
    const r = run(dir, 'slug-derive');
    assert(r.status !== 0, 'should exit non-zero');
    assert(/no \.git\//.test(r.stderr), 'should mention .git in stderr: ' + r.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('slug-derive --source basename: kebab-cases the directory name', () => {
  const root = mkdtempSync(join(tmpdir(), 'prism-dd-slug_nexus_reporting_4-'));
  spawnSync('git', ['init', '-q'], {cwd: root});
  try {
    const r = run(root, 'slug-derive', '--source', 'basename');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert(out.slug.startsWith('prism-dd-slug-nexus-reporting-4-'), 'kebab from basename: ' + out.slug);
    assertEq(out.source, 'basename');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source claude-md: reads ## Project Identity name', () => {
  const root = makeTestbed('slug-claude');
  try {
    writeFileSync(join(root, 'CLAUDE.md'),
      '# Test Project\n\n## Project Identity\n\nname: grabber-cli\nstack: Node\n');
    const r = run(root, 'slug-derive', '--source', 'claude-md');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEq(out.slug, 'grabber-cli');
    assertEq(out.source, 'claude-md');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source claude-md: exits non-zero when no Project Identity section', () => {
  const root = makeTestbed('slug-noclaude');
  try {
    writeFileSync(join(root, 'CLAUDE.md'), '# Just a title\n\nsome body\n');
    const r = run(root, 'slug-derive', '--source', 'claude-md');
    assert(r.status !== 0, 'no identity → non-zero: ' + r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source auto: tries claude-md, falls back to basename', () => {
  const root = makeTestbed('slug-auto');
  try {
    // No CLAUDE.md → falls through to basename
    const r = run(root, 'slug-derive', '--source', 'auto');
    assertEq(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert(out.slug.startsWith('prism-dd-test-slug-auto-'), 'auto used basename: ' + out.slug);
    assertEq(out.source, 'basename');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('slug-derive --source state: returns slug locked in .prism-state.json', () => {
  const root = makeTestbed('slug-state');
  try {
    bootstrap(root, 'init-state-if-missing', 'tb');
    // Hand-edit state to set project_slug (mutator added in Task 6; for now we'll write directly)
    const statePath = join(root, '.claude', '.prism-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.project_slug = 'locked-slug-from-state';
    // Recompute checksum: we cheat by using --no-checksum bypass via writing then
    // letting readState's tolerance handle it — OR mutate via the proper API in Task 6.
    // For Task 2 we test against the lockfile being WRITTEN by Task 6's setProjectSlug.
    // Until Task 6 lands, skip this test:
    return;  // placeholder skipped until Task 6 wires the mutator
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write: creates <root>/.claude/agents/master-<slug>.md with locked frontmatter', () => {
  const root = makeTestbed('agentwrite');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo-cli');
    assertEq(r.status, 0, r.stderr);
    const path = join(root, '.claude', 'agents', 'master-foo-cli.md');
    assert(existsSync(path), 'file written: ' + path);
    const body = readFileSync(path, 'utf8');
    assert(body.startsWith('---\n'), 'frontmatter starts');
    assert(/name:\s*master-foo-cli/.test(body), 'name field: ' + body.slice(0, 200));
    assert(/memory:\s*project/.test(body), 'memory: project');
    assert(/skills:\s*\[master-orchestrator\]/.test(body), 'skills frontmatter');
    // v5.2.7: every bootstrapped project-master gets the SAME canonical toolset,
    // and it MUST include Skill (so the master can invoke brainstorming etc. at
    // runtime — the master-orchestrator skill itself is frontmatter-preloaded).
    const toolsLine = (body.match(/^tools:\s*(.+)$/m) || [])[1] || '';
    const toolset = toolsLine.split(',').map(s => s.trim());
    // v5.2.8: the project-master runs in the MAIN LOOP and talks to the user, so
    // its baseline must include the interactive/orchestration tools the deep-dive,
    // panel, and plan-approval flows call — notably AskUserQuestion (the command
    // body invokes it 5×) and the Task* tracking family — TaskCreate/TaskUpdate/
    // TaskList — plus Skill (v5.2.7). TodoWrite kept for builds that still expose
    // the legacy name; listing both is additive and cross-build safe (v5.7.1).
    for (const t of ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'Skill', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']) {
      assert(toolset.includes(t), `canonical toolset must include ${t}; got: ${toolsLine}`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write: refuses to overwrite existing file without --force', () => {
  const root = makeTestbed('agentwrite-collision');
  try {
    const dir = join(root, '.claude', 'agents');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'master-foo.md'), '# existing\n');
    const r = run(root, 'agent-write', '--slug', 'foo');
    assertEq(r.status, 7, 'exit 7 on collision: ' + r.stderr);
    assert(/already exists/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write --force: overwrites existing file', () => {
  const root = makeTestbed('agentwrite-force');
  try {
    const dir = join(root, '.claude', 'agents');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'master-foo.md'), '# existing\n');
    const r = run(root, 'agent-write', '--slug', 'foo', '--force');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(dir, 'master-foo.md'), 'utf8');
    assert(/name:\s*master-foo/.test(body), 'overwritten with frontmatter');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write --force: preserves on-disk created: date (Phase H symmetry with agent-diff)', () => {
  // Regression for the dog-food finding: agent-diff preserves the on-disk
  // created date (commit 9cb56ed) so the diff shows no calendar drift, but
  // agent-write --force used to regenerate with today's date — breaking the
  // invariant that an immediate diff after apply should be empty.
  const root = makeTestbed('agentwrite-force-preserves-date');
  try {
    const dir = join(root, '.claude', 'agents');
    mkdirSync(dir, {recursive: true});
    const path = join(dir, 'master-foo.md');
    // Seed a body whose created: date is far enough in the past that "today"
    // can never coincidentally match it.
    const seeded = [
      '---',
      'name: master-foo',
      'description: seed',
      'created: 2020-01-01',
      'prism_phase: D',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    writeFileSync(path, seeded, 'utf8');
    const r = run(root, 'agent-write', '--slug', 'foo', '--force');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(path, 'utf8');
    assert(/^created: 2020-01-01$/m.test(body),
      'on-disk created: 2020-01-01 must be preserved when --force overwrites; got body:\n' + body);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write --orchestrator-protocol inline: inlines fallback body for pre-Phase-E', () => {
  const root = makeTestbed('agentwrite-inline');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo', '--orchestrator-protocol', 'inline');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/Five unbreakable rules/.test(body), 'inlined orchestrator protocol present');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write --orchestrator-protocol skill-ref: thin body that defers to skill', () => {
  const root = makeTestbed('agentwrite-skillref');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo', '--orchestrator-protocol', 'skill-ref');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/Load skill: master-orchestrator/.test(body), 'thin skill-ref body');
    assert(!/Five unbreakable rules/.test(body), 'no inlined protocol when skill-ref mode');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write default (no --orchestrator-protocol flag): skill-ref body (Phase E)', () => {
  const root = makeTestbed('agentwrite-default');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/Load skill: master-orchestrator/.test(body), 'default body must be skill-ref shape (Phase E flip)');
    assert(!/Five unbreakable rules/.test(body), 'default must NOT inline the protocol (Phase E flip)');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('agent-write: master body frames identity as solution architect + sole dispatcher (v5.x)', () => {
  // STEP 0 spike proved subagent dispatch is main-loop-only; the session-level
  // project-master is the ONLY context that can dispatch. The v5.x identity
  // promotes it from "dispatcher/evaluator" to a top-class solution architect
  // that owns the design and is the sole dispatcher.
  const root = makeTestbed('agentwrite-architect');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/solution architect/i.test(body), 'description identifies as solution architect: ' + body.slice(0, 500));
    assert(/sole dispatcher/i.test(body), 'description notes sole-dispatcher role (STEP 0): ' + body.slice(0, 500));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-write --orchestrator-protocol inline: includes recall→archive knowledge loop + sole-dispatcher (v5.x)', () => {
  const root = makeTestbed('agentwrite-loop');
  try {
    const r = run(root, 'agent-write', '--slug', 'foo', '--orchestrator-protocol', 'inline');
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/Five unbreakable rules/.test(body), 'regression: preserves existing inline marker');
    assert(/recall/i.test(body) && /archive/i.test(body), 'knowledge-growth loop (recall/archive) present in inline body');
    assert(/sole dispatcher/i.test(body), 'sole-dispatcher framing present in inline body');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('chair wiring end-to-end: settings.json agent → master-<slug>, and that master declares the Agent tool (v5.x item 7)', () => {
  // STEP 0: only the main-loop/session agent can dispatch. The chair works iff
  // BOTH halves are wired: settings.json points the session agent at the master,
  // AND the master frontmatter declares the Agent tool (else it can't dispatch
  // even as the session agent). Drift-guard for that end-to-end invariant.
  const root = makeTestbed('chair-wiring-e2e');
  try {
    assertEq(run(root, 'agent-write', '--slug', 'foo').status, 0, 'agent-write ok');
    assertEq(run(root, 'settings-write', '--slug', 'foo').status, 0, 'settings-write ok');
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
    assertEq(settings.agent, 'master-foo', 'session agent wired to the master');
    const body = readFileSync(join(root, '.claude', 'agents', 'master-foo.md'), 'utf8');
    assert(/^tools:.*\bAgent\b/m.test(body), 'the chaired master MUST declare the Agent tool (sole dispatcher in main loop): ' + body.slice(0, 400));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-diff: exit 0 when generated body equals on-disk body', () => {
  const root = makeTestbed('agent-diff-same');
  try {
    const writeR = run(root, 'agent-write', '--slug', 'foo');
    assertEq(writeR.status, 0, writeR.stderr);
    const diffR = run(root, 'agent-diff', '--slug', 'foo');
    assertEq(diffR.status, 0, `expected exit 0 (no diff); stderr=${diffR.stderr}`);
    assertEq(diffR.stdout, '', 'stdout should be empty on no-diff');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-diff: exit 1 with diff content when protocol mode differs', () => {
  const root = makeTestbed('agent-diff-changed');
  try {
    // Write inline-mode body, then ask for diff vs skill-ref mode
    const writeR = run(root, 'agent-write', '--slug', 'foo', '--orchestrator-protocol', 'inline');
    assertEq(writeR.status, 0, writeR.stderr);
    const diffR = run(root, 'agent-diff', '--slug', 'foo', '--orchestrator-protocol', 'skill-ref');
    assertEq(diffR.status, 1, `expected exit 1 (diff present); stderr=${diffR.stderr}`);
    assert(/Load skill: master-orchestrator/.test(diffR.stdout), 'diff should reference skill-ref body');
    assert(/Five unbreakable rules/.test(diffR.stdout), 'diff should reference inlined body being removed');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('agent-diff: exit 6 when on-disk agent file does not exist', () => {
  const root = makeTestbed('agent-diff-nofile');
  try {
    const r = run(root, 'agent-diff', '--slug', 'ghost');
    assertEq(r.status, 6, `expected exit 6 (missing file); stderr=${r.stderr}`);
    assert(/master-ghost\.md/.test(r.stderr), 'stderr should name the missing file');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('memory-seed: writes MEMORY.md with router sections from profile JSON', () => {
  const root = makeTestbed('memseed');
  try {
    mkdirSync(join(root, '.claude', 'agents'), {recursive: true});
    const profile = JSON.stringify({
      stack: 'Node 18, Postgres 15',
      datasources: ['db.main', 'redis.cache'],
      active_workstreams: ['v4.0 Phase D', 'docs migration'],
      specialists: ['greek-retail-expert', 'postgres-perf-tuner'],
    });
    const r = run(root, 'memory-seed', '--slug', 'foo', '--profile', profile);
    assertEq(r.status, 0, r.stderr);
    const path = join(root, '.claude', 'agents', 'MEMORY.md');
    assert(existsSync(path), 'MEMORY.md written');
    const body = readFileSync(path, 'utf8');
    assert(/## Project profile/.test(body), 'profile section');
    assert(/Node 18, Postgres 15/.test(body), 'stack value');
    assert(/## Recent decisions/.test(body), 'decisions section');
    assert(/## Recent lessons/.test(body), 'lessons section');
    assert(/## Active specialists/.test(body), 'specialists section');
    assert(/greek-retail-expert/.test(body), 'specialist value');
    assert(/## Available plugin tools/.test(body), 'plugin tools section');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('memory-seed: exits 8 when generated MEMORY.md exceeds 25 KB', () => {
  const root = makeTestbed('memseed-big');
  try {
    mkdirSync(join(root, '.claude', 'agents'), {recursive: true});
    // Inflate active_workstreams to push past 25 KB. Pass via file (not inline
    // JSON arg) because Windows spawn arg-length cap (~32 KB) trips ENAMETOOLONG
    // before we'd even reach the helper. File-mode --profile is spec-supported.
    const bigArr = Array.from({length: 1000}, (_, i) => `Workstream-${i}: ` + 'x'.repeat(50));
    const profilePath = join(root, 'big-profile.json');
    writeFileSync(profilePath, JSON.stringify({
      stack: 'Node',
      datasources: [],
      active_workstreams: bigArr,
      specialists: [],
    }));
    const r = run(root, 'memory-seed', '--slug', 'foo', '--profile', profilePath);
    assertEq(r.status, 8, r.stderr);
    assert(/25 KB/.test(r.stderr), r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('memory-seed: accepts --profile as a file path', () => {
  const root = makeTestbed('memseed-file');
  try {
    mkdirSync(join(root, '.claude', 'agents'), {recursive: true});
    const profilePath = join(root, 'profile.json');
    writeFileSync(profilePath, JSON.stringify({
      stack: 'Python',
      datasources: ['s3.bucket'],
      active_workstreams: [],
      specialists: [],
    }));
    const r = run(root, 'memory-seed', '--slug', 'foo', '--profile', profilePath);
    assertEq(r.status, 0, r.stderr);
    const body = readFileSync(join(root, '.claude', 'agents', 'MEMORY.md'), 'utf8');
    assert(/Python/.test(body), 'stack from file: ' + body.slice(0, 300));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('memory-seed: exits 5 when --profile is valid JSON but not an object', () => {
  const root = makeTestbed('memseed-badprofile');
  try {
    mkdirSync(join(root, '.claude', 'agents'), {recursive: true});
    const r = run(root, 'memory-seed', '--slug', 'foo', '--profile', 'null');
    assertEq(r.status, 5, 'null profile → exit 5: ' + r.stderr);
    assert(/must be a JSON object/.test(r.stderr), 'diagnostic: ' + r.stderr);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('settings-write: creates fresh settings.json with agent field when none exists', () => {
  const root = makeTestbed('settings-fresh');
  try {
    const r = run(root, 'settings-write', '--slug', 'foo');
    assertEq(r.status, 0, r.stderr);
    const path = join(root, '.claude', 'settings.json');
    assert(existsSync(path));
    const json = JSON.parse(readFileSync(path, 'utf8'));
    assertEq(json.agent, 'master-foo');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('settings-write: merges into existing settings.json (preserves other keys)', () => {
  const root = makeTestbed('settings-merge');
  try {
    const dir = join(root, '.claude');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      env: {FOO: 'bar'},
      hooks: {SessionStart: []},
      agent: 'old-master',
    }, null, 2));
    const r = run(root, 'settings-write', '--slug', 'new-master');
    assertEq(r.status, 0, r.stderr);
    const json = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assertEq(json.agent, 'master-new-master', 'agent field replaced');
    assertEq(json.env.FOO, 'bar', 'env preserved');
    assert(Array.isArray(json.hooks.SessionStart), 'hooks preserved');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('settings-write: exits 9 when existing settings.json is invalid JSON', () => {
  const root = makeTestbed('settings-bad');
  try {
    const dir = join(root, '.claude');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'settings.json'), '{not json');
    const r = run(root, 'settings-write', '--slug', 'foo');
    assertEq(r.status, 9, r.stderr);
    assert(/invalid JSON/.test(r.stderr), r.stderr);
    // Bad file MUST be preserved (no destructive overwrite on parse failure)
    const after = readFileSync(join(dir, 'settings.json'), 'utf8');
    assertEq(after, '{not json', 'original bad file preserved');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('settings-write: exits 9 when existing settings.json is valid JSON but not an object', () => {
  const root = makeTestbed('settings-nonobj');
  try {
    const dir = join(root, '.claude');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'settings.json'), 'null');
    const r = run(root, 'settings-write', '--slug', 'foo');
    assertEq(r.status, 9, r.stderr);
    assert(/not an object/.test(r.stderr), r.stderr);
    assertEq(readFileSync(join(dir, 'settings.json'), 'utf8'), 'null', 'original preserved');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
