#!/usr/bin/env node
// tests/v3/drift-check-deployed-uncommitted.test.mjs
//
// Regression test for the exact gap found in the 2026-07-27
// verification-integrity audit (task #35): the drift-check's own header
// claims it reports "committed repo state differs from installed state",
// but the comparator read the repo side with a plain fs.readFileSync of the
// WORKING TREE, never `git show HEAD:<path>`. For a file that is (a) dirty
// (uncommitted repo edit) AND (b) already deployed — i.e. the installed copy
// was copied from that same dirty working tree — the old code's
// `sha256(srcAbs) === sha256(dstAbs)` compared working-tree-vs-installed,
// found them equal, and counted the pair as `matched`. The `skipped_dirty`
// branch was structurally unreachable in that case because it only runs
// on the `differs === true` path. Result: "0 drift, 0 skipped" was printed
// both while the edit sat uncommitted-but-deployed AND after it was
// committed — a genuine committed-vs-deployed divergence was invisible.
//
// This test drives the real tool CLI through the isolated fixture pattern
// already used by drift-check.test.mjs (mkdtemp fake repo + fake install
// dir — never touches the real repo or ~/.claude) and asserts:
//
//   1. RED (pre-fix behavior, still checked here as a regression guard):
//      dirty file, deployed (installed == working tree, != HEAD) must NOT
//      be silently counted as `matched`, and must NOT be `skipped_dirty`
//      either (that bucket is for edits that were NOT yet deployed).
//   2. It must land in the new `deployed_uncommitted` bucket, exit 0
//      (not "drift" — nothing to reinstall), with `matched` unchanged from
//      the last known-clean baseline.
//   3. Once committed (repo now clean, installed already matches HEAD),
//      the same file becomes `matched` and the deployed_uncommitted bucket
//      empties — the ordinary "commit fixes it" path.
//   4. Sanity control: a dirty file that is genuinely NOT yet deployed
//      (installed still equals the old HEAD content) stays `skipped_dirty`,
//      not `deployed_uncommitted` — the two buckets must not blur.
//
// Run: node tests/v3/drift-check-deployed-uncommitted.test.mjs

import {mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync} from 'node:fs';
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

// ─── fixture setup: isolated temp repo + fake install dir ───────────────────
const root = mkdtempSync(join(tmpdir(), 'prism-drift-deployuncommit-'));
const repo = join(root, 'repo');
const claudeDir = join(root, 'dot-claude');

mkdirSync(join(repo, 'hooks'), {recursive: true});
mkdirSync(claudeDir, {recursive: true});

writeFileSync(join(repo, 'hooks', 'a.mjs'), 'export const MIN_SKILL_SCORE = 1;\n');
mkdirSync(join(repo, 'tools'), {recursive: true});
writeFileSync(join(repo, 'tools', 'install-manifest.json'), JSON.stringify({
  prism_version: '9.9.9',
  files: [{src: 'hooks/a.mjs', dst: 'hooks/a.mjs'}],
  directories: [],
}, null, 2));

git(repo, 'init', '-q');
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'initial');

// simulate a clean install matching HEAD
mkdirSync(dirname(join(claudeDir, 'hooks', 'a.mjs')), {recursive: true});
cpSync(join(repo, 'hooks', 'a.mjs'), join(claudeDir, 'hooks', 'a.mjs'));
writeFileSync(join(claudeDir, '.prism-version'), '9.9.9');

try {
  // ── 0. baseline: clean tree, installed matches HEAD ────────────────────────
  let r = runTool(repo, claudeDir);
  check('0. baseline clean → exit 0, 1 matched, 0 drift, 0 deployed_uncommitted',
    r.exit === 0 && r.out && r.out.matched === 1 && r.out.drift_count === 0 &&
    r.out.deployed_uncommitted_count === 0,
    JSON.stringify(r.out));

  // ── 1/2. edit the repo file AND deploy the dirty edit (no commit yet) ─────
  // This is the exact "deployed to ~/.claude but NOT committed" condition the
  // audit found: installed now equals the DIRTY working tree, not HEAD.
  writeFileSync(join(repo, 'hooks', 'a.mjs'), 'export const MIN_SKILL_SCORE = 2;\n');
  cpSync(join(repo, 'hooks', 'a.mjs'), join(claudeDir, 'hooks', 'a.mjs'));
  r = runTool(repo, claudeDir);
  check('1. deployed-but-uncommitted → exit 0 (not drift)', r.exit === 0, r.raw);
  check('1. deployed-but-uncommitted → NOT counted as matched (the bug this guards)',
    r.out && r.out.matched === 0, JSON.stringify(r.out));
  check('1. deployed-but-uncommitted → NOT counted as skipped_dirty either',
    r.out && r.out.skipped_dirty === 0, JSON.stringify(r.out));
  check('1. deployed-but-uncommitted → lands in deployed_uncommitted bucket',
    r.out && r.out.deployed_uncommitted_count === 1 &&
    r.out.deployed_uncommitted.some(d => d.file === 'hooks/a.mjs'),
    JSON.stringify(r.out));
  check('1. deployed-but-uncommitted → drift_count stays 0 (distinct WARNING class, not drift)',
    r.out && r.out.drift_count === 0, JSON.stringify(r.out));

  // ── 3. commit the edit — the deployed content now HAS a committed record ──
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'raise MIN_SKILL_SCORE (matches what was already deployed)');
  r = runTool(repo, claudeDir);
  check('3. after commit → exit 0, matched, deployed_uncommitted bucket empties',
    r.exit === 0 && r.out && r.out.matched === 1 && r.out.deployed_uncommitted_count === 0 &&
    r.out.drift_count === 0,
    JSON.stringify(r.out));

  // ── 4. sanity control: dirty edit NOT yet deployed stays skipped_dirty ─────
  writeFileSync(join(repo, 'hooks', 'a.mjs'), 'export const MIN_SKILL_SCORE = 3;\n');
  r = runTool(repo, claudeDir);
  check('4. dirty-but-not-deployed → skipped_dirty (control, must not blur into deployed_uncommitted)',
    r.exit === 0 && r.out && r.out.skipped_dirty === 1 && r.out.deployed_uncommitted_count === 0 &&
    r.out.matched === 0,
    JSON.stringify(r.out));
} finally {
  try { rmSync(root, {recursive: true, force: true}); } catch {}
}

console.log(failures === 0
  ? '\nAll deployed-uncommitted regression assertions passed.'
  : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
