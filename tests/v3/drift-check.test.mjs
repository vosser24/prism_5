#!/usr/bin/env node
// tests/v3/drift-check.test.mjs
//
// Both-paths proof for tools/prism-drift-check.mjs (D042): the guard must
// FIRE when committed repo state differs from the installed copy, and stay
// QUIET both on a clean matching tree AND — the anti-cry-wolf rule — when
// the only differences are UNCOMMITTED repo edits (a developer mid-edit
// always has drift; firing on it would get the guard disabled).
//
// Builds a throwaway fixture: a minimal git repo with a 2-file manifest and
// a fake .claude install dir, then drives the real tool CLI through five
// states:
//
//   1. QUIET  — fresh matching install → status clean, exit 0
//   2. QUIET  — repo file edited but NOT committed → skipped_dirty, exit 0
//   3. FIRES  — same edit committed → STALE drift, exit 1
//   4. FIRES  — installed file deleted → MISSING drift, exit 1
//   5. QUIET  — brand-new repo hook, untracked → exit 0; commit it → FIRES
//
// Run: node tests/v3/drift-check.test.mjs

import {mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, unlinkSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = join(__dirname, '..', '..', 'tools', 'prism-drift-check.mjs');

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', ...args], {cwd, encoding: 'utf8', windowsHide: true});
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runTool(repo, claudeDir) {
  const r = spawnSync(process.execPath, [TOOL, '--repo', repo, '--claude-dir', claudeDir, '--json'],
    {encoding: 'utf8', windowsHide: true});
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  return {exit: r.status, out, raw: r.stdout + r.stderr};
}

// ─── fixture setup ────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'prism-drift-test-'));
const repo = join(root, 'repo');
const claudeDir = join(root, 'dot-claude');

mkdirSync(join(repo, 'tools'), {recursive: true});
mkdirSync(join(repo, 'hooks'), {recursive: true});
mkdirSync(join(repo, 'skills', 'demo'), {recursive: true});
mkdirSync(claudeDir, {recursive: true});

writeFileSync(join(repo, 'hooks', 'a.mjs'), 'export const MIN_SKILL_SCORE = 1;\n');
writeFileSync(join(repo, 'hooks', 'b.mjs'), 'export const B = true;\n');
writeFileSync(join(repo, 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
writeFileSync(join(repo, 'skills', 'demo', 'user-state.json'), '{"user":"state"}\n');
writeFileSync(join(repo, 'tools', 'install-manifest.json'), JSON.stringify({
  prism_version: '9.9.9',
  files: [
    {src: 'hooks/a.mjs', dst: 'hooks/a.mjs'},
    {src: 'hooks/b.mjs', dst: 'hooks/b.mjs'},
  ],
  directories: [
    {src: 'skills/demo', dst: 'skills/demo', preserve_files: ['user-state.json']},
  ],
}, null, 2));

git(repo, 'init', '-q');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'initial');

// simulate a clean install: copy manifest targets into the fake .claude
for (const rel of ['hooks/a.mjs', 'hooks/b.mjs', 'skills/demo/SKILL.md']) {
  mkdirSync(dirname(join(claudeDir, rel)), {recursive: true});
  cpSync(join(repo, rel), join(claudeDir, rel));
}
// installed user-state diverges on purpose — preserve_files must exempt it
writeFileSync(join(claudeDir, 'skills', 'demo', 'user-state.json'), '{"user":"DIVERGED"}\n');
writeFileSync(join(claudeDir, '.prism-version'), '9.9.9');

try {
  // ── 1. QUIET on a clean matching tree ──────────────────────────────────────
  let r = runTool(repo, claudeDir);
  check('1. clean tree → exit 0', r.exit === 0, r.raw);
  check('1. clean tree → status clean, drift_count 0',
    r.out && r.out.status === 'clean' && r.out.drift_count === 0, JSON.stringify(r.out));
  check('1. preserve_files exempt (diverged user-state.json not compared)',
    r.out && !JSON.stringify(r.out.drift).includes('user-state.json') && r.out.files_compared === 3,
    JSON.stringify(r.out));

  // ── 2. ANTI-CRY-WOLF: uncommitted repo edit stays QUIET ────────────────────
  writeFileSync(join(repo, 'hooks', 'a.mjs'), 'export const MIN_SKILL_SCORE = 2;\n');
  r = runTool(repo, claudeDir);
  check('2. uncommitted edit → exit 0 (no drift)', r.exit === 0, r.raw);
  check('2. uncommitted edit → counted as skipped_dirty',
    r.out && r.out.drift_count === 0 && r.out.skipped_dirty === 1, JSON.stringify(r.out));

  // ── 3. FIRES once the edit is committed ────────────────────────────────────
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'raise MIN_SKILL_SCORE');
  r = runTool(repo, claudeDir);
  check('3. committed edit → exit 1 (drift)', r.exit === 1, r.raw);
  check('3. committed edit → STALE hooks/a.mjs reported',
    r.out && r.out.drift.some(d => d.file === 'hooks/a.mjs' && d.kind === 'content-differs'),
    JSON.stringify(r.out && r.out.drift));

  // ── 4. FIRES on installed file missing entirely ────────────────────────────
  cpSync(join(repo, 'hooks', 'a.mjs'), join(claudeDir, 'hooks', 'a.mjs'));  // heal 3
  unlinkSync(join(claudeDir, 'hooks', 'b.mjs'));
  r = runTool(repo, claudeDir);
  check('4. installed file deleted → exit 1 (drift)', r.exit === 1, r.raw);
  check('4. MISSING hooks/b.mjs reported',
    r.out && r.out.drift.some(d => d.file === 'hooks/b.mjs' && d.kind === 'missing-installed'),
    JSON.stringify(r.out && r.out.drift));

  // ── 5. new repo hook: untracked = QUIET, committed = FIRES ────────────────
  cpSync(join(repo, 'hooks', 'b.mjs'), join(claudeDir, 'hooks', 'b.mjs'));  // heal 4
  writeFileSync(join(repo, 'hooks', 'c.mjs'), 'export const C = true;\n');
  const manifest = JSON.parse(readFileSync(join(repo, 'tools', 'install-manifest.json'), 'utf8'));
  manifest.files.push({src: 'hooks/c.mjs', dst: 'hooks/c.mjs'});
  writeFileSync(join(repo, 'tools', 'install-manifest.json'), JSON.stringify(manifest, null, 2));
  r = runTool(repo, claudeDir);
  check('5a. new hook untracked → exit 0 (quiet)', r.exit === 0 && r.out && r.out.drift_count === 0,
    r.raw);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add hook c');
  r = runTool(repo, claudeDir);
  check('5b. new hook committed but not installed → MISSING drift, exit 1',
    r.exit === 1 && r.out && r.out.drift.some(d => d.file === 'hooks/c.mjs' && d.kind === 'missing-installed'),
    JSON.stringify(r.out && r.out.drift));
} finally {
  try { rmSync(root, {recursive: true, force: true}); } catch {}
}

console.log(failures === 0
  ? '\nAll drift-check both-paths assertions passed.'
  : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
