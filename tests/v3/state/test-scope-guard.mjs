#!/usr/bin/env node
// tests/v3/state/test-scope-guard.mjs
// v4.5 Layer 4 (D3) — SCOPE GUARD enforcement test
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0; let total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

function runPanelGuard(sandbox, panelObj, panelRelPath = '.prism-task-d3/panel.json') {
  const taskDir = join(sandbox, dirname(panelRelPath));
  mkdirSync(taskDir, { recursive: true });
  const panelPath = join(sandbox, panelRelPath);
  writeFileSync(panelPath, JSON.stringify(panelObj));
  const payload = { tool_name: 'Write', tool_input: { file_path: panelPath } };
  const hookPath = join(repoRoot, 'hooks', 'prism-panel-guard.mjs');
  return spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

// Case 1: clearly out-of-scope position → exit 2 + stderr mentions scope
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-bad-'));
  const panel = {
    task_sha: 'd3',
    scope: 'narrow refactor of hooks/foo.mjs',
    positions: [
      { title: 'A', specialist: 'spec-a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] },
      { title: 'Rewrite the entire build system', specialist: 'spec-b', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }
    ],
  };
  const r = runPanelGuard(sandbox, panel);
  check('out-of-scope: panel-guard exits non-zero', r.status !== 0);
  check('out-of-scope: stderr mentions scope', /scope/i.test(r.stderr ?? ''));
  rmSync(sandbox, { recursive: true, force: true });
}

// Case 2: in-scope panel → exit 0 (or passes silently)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-good-'));
  const panel = {
    task_sha: 'd3',
    scope: 'refactor hooks/foo.mjs for clarity',
    positions: [
      { title: 'Refactor hooks/foo.mjs into smaller functions', specialist: 'spec-a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] },
      { title: 'Improve hooks/foo.mjs readability', specialist: 'spec-b', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }
    ],
  };
  const r = runPanelGuard(sandbox, panel);
  check('in-scope: panel-guard exits 0', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// Case 3: missing scope field is tolerated (backwards-compat — pre-v4.5 panels)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-noscope-'));
  const panel = {
    task_sha: 'd3',
    positions: [
      { title: 'Any position is fine', specialist: 'spec-a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }
    ],
  };
  const r = runPanelGuard(sandbox, panel);
  check('no-scope-field: panel-guard exits 0 (backwards-compat)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// Case 4: PRISM_DISABLE_SCOPE_GUARD=1 bypasses scope check
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-killswitch-'));
  const panel = {
    task_sha: 'd3',
    scope: 'narrow refactor of hooks/foo.mjs',
    positions: [
      { title: 'Rewrite the entire build system', specialist: 'spec-b', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }
    ],
  };
  const taskDir = join(sandbox, '.prism-task-d3');
  mkdirSync(taskDir, { recursive: true });
  const panelPath = join(taskDir, 'panel.json');
  writeFileSync(panelPath, JSON.stringify(panel));
  const payload = { tool_name: 'Write', tool_input: { file_path: panelPath } };
  const hookPath = join(repoRoot, 'hooks', 'prism-panel-guard.mjs');
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PRISM_DISABLE_SCOPE_GUARD: '1' },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  check('kill-switch: PRISM_DISABLE_SCOPE_GUARD=1 exits 0', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// G2: alternatives_considered field — well-formed array passes
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-good-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }],
    rationale: { alternatives_considered: [
      { approach: 'Inline the helper', why_not: 'duplicates logic' },
      { approach: 'Keep current shape', why_not: 'chosen' }
    ]}
  };
  const r = runPanelGuard(sandbox, panel);
  check('G2: well-formed alternatives passes', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// G2: alternatives_considered as non-array fails
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-bad1-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }],
    rationale: { alternatives_considered: 'not an array' }
  };
  const r = runPanelGuard(sandbox, panel);
  check('G2: non-array alternatives exits 2', r.status === 2);
  check('G2: stderr explains array requirement', /must be an array/i.test(r.stderr ?? ''));
  rmSync(sandbox, { recursive: true, force: true });
}

// G2: alternatives entry missing why_not fails
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-bad2-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }],
    rationale: { alternatives_considered: [{ approach: 'Foo' }] }
  };
  const r = runPanelGuard(sandbox, panel);
  check('G2: incomplete entry exits 2', r.status === 2);
  check('G2: stderr mentions approach + why_not', /approach.*why_not|why_not/i.test(r.stderr ?? ''));
  rmSync(sandbox, { recursive: true, force: true });
}

// G2: alternatives ABSENT passes (additive — backwards-compat)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-absent-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }],
    // no rationale field at all
  };
  const r = runPanelGuard(sandbox, panel);
  check('G2: absent alternatives passes (backwards-compat)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// G2: PRISM_DISABLE_ALTERNATIVES_CHECK=1 bypasses alternatives check
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-killswitch-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }],
    rationale: { alternatives_considered: 'not an array' }
  };
  const taskDir = join(sandbox, '.prism-task-g2');
  mkdirSync(taskDir, { recursive: true });
  const panelPath = join(taskDir, 'panel.json');
  writeFileSync(panelPath, JSON.stringify(panel));
  const payload = { tool_name: 'Write', tool_input: { file_path: panelPath } };
  const hookPath = join(repoRoot, 'hooks', 'prism-panel-guard.mjs');
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PRISM_DISABLE_ALTERNATIVES_CHECK: '1' },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  check('G2 kill-switch: PRISM_DISABLE_ALTERNATIVES_CHECK=1 exits 0', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
