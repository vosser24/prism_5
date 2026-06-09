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

function runPanelGuard(sandbox, panelObj, panelRelPath = '.prism-task-d3/panel.json', extraEnv = {}) {
  const taskDir = join(sandbox, dirname(panelRelPath));
  mkdirSync(taskDir, { recursive: true });
  const panelPath = join(sandbox, panelRelPath);
  writeFileSync(panelPath, JSON.stringify(panelObj));
  const payload = { tool_name: 'Write', tool_input: { file_path: panelPath } };
  const hookPath = join(repoRoot, 'hooks', 'prism-panel-guard.mjs');
  return spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

// Case 1: clearly out-of-scope position → advisory by default (exit 0 + stderr)
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
  // Advisory by default: stderr warns but exits 0
  check('out-of-scope (advisory): exits 0', r.status === 0);
  check('out-of-scope (advisory): stderr mentions scope', /scope/i.test(r.stderr ?? ''));
  check('out-of-scope (advisory): stderr mentions advisory', /advisory/i.test(r.stderr ?? ''));
  rmSync(sandbox, { recursive: true, force: true });
}

// Case 1b: strict mode — same out-of-scope panel must exit 2
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-strict-'));
  const panel = {
    task_sha: 'd3',
    scope: 'narrow refactor of hooks/foo.mjs',
    positions: [
      { title: 'A', specialist: 'spec-a', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] },
      { title: 'Rewrite the entire build system', specialist: 'spec-b', challenges: [{ evidence_class: 'PRECEDENT', text: 'cite' }] }
    ],
  };
  const r = runPanelGuard(sandbox, panel, '.prism-task-d3/panel.json', { PRISM_SCOPE_GUARD: 'strict' });
  check('out-of-scope strict: exits 2', r.status === 2);
  check('out-of-scope strict: stderr mentions scope', /scope/i.test(r.stderr ?? ''));
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

// F2 regression: realistic PRISM-shape scopes should not block even when
// position titles use domain-specific vocabulary not in the scope phrase
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-fp1-'));
  const panel = {
    task_sha: 'fp1',
    scope: 'ship v4.5 Phase 4 coverage/hygiene',
    positions: [{ title: 'D3 SCOPE GUARD enforcement test', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }]
  };
  const r = runPanelGuard(sandbox, panel);
  check('F2: PRISM-shape scope/title pair exits 0 (advisory)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-fp2-'));
  const panel = {
    task_sha: 'fp2',
    scope: 'design auth subsystem',
    positions: [{ title: 'Use OAuth2 with PKCE flow', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }]
  };
  const r = runPanelGuard(sandbox, panel);
  check('F2: auth/OAuth2 scope/title pair exits 0 (advisory)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-fp3-'));
  const panel = {
    task_sha: 'fp3',
    scope: 'migrate database from Postgres 14 to 16',
    positions: [{ title: 'Run pg_upgrade on replica first', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }]
  };
  const r = runPanelGuard(sandbox, panel);
  check('F2: database migration scope/title pair exits 0 (advisory)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// F3 edge: non-string title silently continues (no crash, no block)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-nonstr-'));
  const panel = {
    task_sha: 'edge',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 42, specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }]
  };
  const r = runPanelGuard(sandbox, panel);
  check('F3: non-string title exits 0', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}
// F3 edge: empty positions array exits 0
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-empty-'));
  const panel = { task_sha: 'edge', scope: 'refactor hooks/foo.mjs', positions: [] };
  const r = runPanelGuard(sandbox, panel);
  check('F3: empty positions exits 0', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}
// F3 edge: scope tokenizes to nothing (all stopwords + punctuation)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-d3-stopwords-'));
  const panel = {
    task_sha: 'edge',
    scope: 'the of for to',
    positions: [{ title: 'Anything goes here', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }]
  };
  const r = runPanelGuard(sandbox, panel);
  check('F3: scope of only stopwords exits 0 (skips enforcement)', r.status === 0);
  rmSync(sandbox, { recursive: true, force: true });
}

// F4: alternatives entry with empty approach string fails
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-empty-str-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }],
    rationale: { alternatives_considered: [{ approach: '', why_not: 'tried' }] }
  };
  const r = runPanelGuard(sandbox, panel);
  check('F4: empty approach string exits 2', r.status === 2);
  check('F4: stderr mentions non-empty', /non-empty/i.test(r.stderr ?? ''));
  rmSync(sandbox, { recursive: true, force: true });
}
// F4: alternatives entry as array fails (not a plain object)
{
  const sandbox = mkdtempSync(join(tmpdir(), 'prism-g2-arrayentry-'));
  const panel = {
    task_sha: 'g2',
    scope: 'refactor hooks/foo.mjs',
    positions: [{ title: 'Refactor hooks/foo.mjs', specialist: 'a', challenges: [{ evidence_class: 'PRECEDENT', text: 'c' }] }],
    rationale: { alternatives_considered: [['a','b']] }
  };
  const r = runPanelGuard(sandbox, panel);
  check('F4: array entry exits 2', r.status === 2);
  rmSync(sandbox, { recursive: true, force: true });
}

// F1 regression: panel-guard must be reachable on PostToolUse Write in both manifests.
// Phase 4b consolidation: panel-guard is now dispatched internally by
// prism-posttooluse-dispatcher.mjs (matcher Write|Edit|MultiEdit|Agent covers Write).
// The check is updated to verify the dispatcher is wired — the dispatcher's own
// tests (test-posttooluse-dispatcher.mjs) enforce that it calls panel-guard for Write.
{
  const plugin = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf-8'));
  const settings = JSON.parse(readFileSync(join(repoRoot, 'settings.fragment.json'), 'utf-8'));
  const has = (manifest) => {
    for (const group of (manifest.hooks?.PostToolUse || [])) {
      for (const h of (group.hooks || [])) {
        if (h.command && h.command.includes('prism-posttooluse-dispatcher.mjs')) return true;
        // legacy: direct panel-guard wiring also accepted (pre-consolidation)
        if (h.command && h.command.includes('prism-panel-guard.mjs')) return true;
      }
    }
    return false;
  };
  check('F1: plugin.json registers panel-guard on PostToolUse Write', has(plugin));
  check('F1: settings.fragment.json registers panel-guard on PostToolUse Write', has(settings));
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
