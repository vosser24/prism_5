#!/usr/bin/env node
// tools/prism-drift-check.mjs — installed-vs-repo DRIFT guard.
//
// The bug class this guards: on 2026-07-14 a whole session built + verified
// 6 mechanisms into the REPO while the live session ran the OLD hooks from
// ~/.claude/ (repo had MIN_SKILL_SCORE=2, installed had =1; three hook files
// were absent from ~/.claude/hooks/ entirely). "shipped != installed" is a
// written lesson violated twice — so it gets a MECHANISM.
//
// What it compares: every file the installer would copy — manifest `files[]`
// plus a recursive walk of manifest `directories[]` (minus `preserve_files`,
// which are user state and legitimately diverge) — repo copy vs installed
// copy under CLAUDE_DIR, by sha256. Missing installed files are drift too.
// The `.prism-version` marker vs manifest `prism_version` is reported as
// context (it is the cheap first-line signal /prism-health Step 0 already
// reads; content drift can exist even when versions match).
//
// ANTI-CRY-WOLF RULE (the load-bearing design decision): a repo-vs-installed
// difference is only reported as DRIFT when the repo copy is CLEAN vs git
// HEAD (committed). A developer editing the repo ALWAYS has uncommitted
// drift; firing on every edit = noise = the guard gets disabled. Dirty files
// are skipped and counted in `skipped_dirty`. Committing the work is what
// arms the guard. If git is unavailable the check degrades to informational
// (differences listed as `unverified`, exit 0) rather than crying wolf.
//
// WHERE IT FIRES: /prism-health (deliberate diagnostic run), NOT SessionStart.
// Measured 2026-07-16 on this SMB-mounted repo: sha256 of all 152 manifest
// file pairs took ~10.2s — two orders of magnitude over any SessionStart
// budget. A deliberate health run can afford it; a hot path cannot.
//
// Usage:
//   node tools/prism-drift-check.mjs [--repo <dir>] [--claude-dir <dir>]
//                                    [--home <dir>] [--json] [--quiet]
// Exit codes:
//   0  no drift (or not applicable: no manifest / running from installed copy
//      / git unavailable so committedness cannot be verified)
//   1  drift found (committed repo state differs from installed state)
//   2  usage error
//
// Dep-free, deterministic, no network. Mirrors prism-installer.mjs path
// resolution so the two tools always agree on what "installed" means.

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ────────────────────────────────────────────────────────────────
function parseFlags(args) {
  const flags = {repo: null, claudeDir: null, home: null, json: false, quiet: false};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') flags.repo = args[++i];
    else if (a === '--claude-dir') flags.claudeDir = args[++i];
    else if (a === '--home') flags.home = args[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--quiet') flags.quiet = true;
    else {
      console.error(`[prism-drift-check] unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}
const flags = parseFlags(process.argv.slice(2));

const REPO_ROOT = resolve(flags.repo || resolve(__dirname, '..'));
const CLAUDE_DIR = resolve(
  flags.claudeDir ||
  join(flags.home || process.env.HOME || process.env.USERPROFILE || homedir(), '.claude')
);
const MANIFEST_PATH = join(REPO_ROOT, 'tools', 'install-manifest.json');

function log(...a) { if (!flags.quiet && !flags.json) console.log(...a); }

function notApplicable(reason) {
  const out = {status: 'not-applicable', reason, drift: [], drift_count: 0};
  if (flags.json) console.log(JSON.stringify(out, null, 2));
  else log(`[prism-drift-check] not applicable: ${reason}`);
  process.exit(0);
}

// ─── git: set of repo-relative paths with uncommitted changes ────────────────
// Includes staged, unstaged, AND untracked (-uall) — an untracked new hook is
// exactly the "built but not yet committed" state that must stay quiet.
// Returns null when git is unavailable / not a repo (committedness unknowable).
function gitDirtySet(repoRoot) {
  let r;
  try {
    r = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true,
    });
  } catch { return null; }
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const dirty = new Set();
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue;
    let path = line.slice(3);
    // Renames: "R  old -> new" — both sides are unsettled
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) {
      dirty.add(unquoteGitPath(path.slice(0, arrow)));
      path = path.slice(arrow + 4);
    }
    dirty.add(unquoteGitPath(path));
  }
  return dirty;
}

function unquoteGitPath(p) {
  p = p.trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    // Minimal C-unquote: git quotes paths with special chars
    p = p.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return p;
}

// ─── build the (repoRel, installedRel) pair list from the manifest ───────────
function walkFiles(dir, acc, base) {
  let entries;
  try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc, base);
    else acc.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return acc;
}

function buildPairs(manifest) {
  const pairs = [];
  for (const f of manifest.files || []) {
    pairs.push({src: f.src.replace(/\\/g, '/'), dst: f.dst.replace(/\\/g, '/')});
  }
  for (const d of manifest.directories || []) {
    const srcBase = join(REPO_ROOT, d.src);
    if (!existsSync(srcBase)) continue;
    const preserve = new Set((d.preserve_files || []).map(p => p.replace(/\\/g, '/')));
    for (const rel of walkFiles(srcBase, [], srcBase)) {
      if (preserve.has(rel)) continue;  // user state — legitimately diverges
      pairs.push({
        src: `${d.src.replace(/\\/g, '/')}/${rel}`,
        dst: `${d.dst.replace(/\\/g, '/')}/${rel}`,
      });
    }
  }
  return pairs;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ─── main ─────────────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();

  if (!existsSync(MANIFEST_PATH)) {
    notApplicable(`no manifest at ${MANIFEST_PATH} (not running from a PRISM repo clone)`);
  }
  if (REPO_ROOT === CLAUDE_DIR) {
    notApplicable('repo root IS the install dir (running from the installed copy — run from the repo clone)');
  }

  let manifest;
  try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
  catch (e) {
    console.error(`[prism-drift-check] manifest JSON invalid: ${e.message}`);
    process.exit(2);
  }

  const dirty = gitDirtySet(REPO_ROOT);  // null → git unavailable
  const pairs = buildPairs(manifest);

  const drift = [];        // committed repo state != installed state → FIRES
  const unverified = [];   // differs, but git unavailable → informational only
  let skippedDirty = 0;    // differs, but repo copy uncommitted → quiet by design
  let matched = 0;
  let srcMissing = 0;      // manifest points at a nonexistent repo file (installer warns too)

  for (const {src, dst} of pairs) {
    const srcAbs = join(REPO_ROOT, src);
    const dstAbs = join(CLAUDE_DIR, dst);
    if (!existsSync(srcAbs)) { srcMissing++; continue; }

    let differs, kind;
    if (!existsSync(dstAbs)) { differs = true; kind = 'missing-installed'; }
    else if (sha256(srcAbs) === sha256(dstAbs)) { differs = false; }
    else { differs = true; kind = 'content-differs'; }
    if (!differs) { matched++; continue; }

    if (dirty === null) unverified.push({file: src, kind});
    else if (dirty.has(src)) skippedDirty++;
    else drift.push({file: src, kind});
  }

  // Version markers — context, not drift by itself
  let installedVersion = null;
  try {
    const vp = join(CLAUDE_DIR, '.prism-version');
    if (existsSync(vp)) installedVersion = readFileSync(vp, 'utf8').trim() || null;
  } catch {}

  const elapsedMs = Date.now() - t0;
  const result = {
    status: drift.length > 0 ? 'drift' : 'clean',
    repo: REPO_ROOT,
    claude_dir: CLAUDE_DIR,
    shipped_version: manifest.prism_version || null,
    installed_version: installedVersion,
    files_compared: pairs.length - srcMissing,
    matched,
    drift_count: drift.length,
    drift,
    skipped_dirty: skippedDirty,
    unverified,
    git_available: dirty !== null,
    elapsed_ms: elapsedMs,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log(`[prism-drift-check] repo=${REPO_ROOT}`);
    log(`[prism-drift-check] install=${CLAUDE_DIR}`);
    log(`[prism-drift-check] versions: shipped=${result.shipped_version} installed=${installedVersion ?? '(no .prism-version marker)'}`);
    log(`[prism-drift-check] compared ${result.files_compared} files in ${elapsedMs}ms — ${matched} match, ${drift.length} drift, ${skippedDirty} skipped (uncommitted in repo), ${unverified.length} unverified`);
    if (drift.length > 0) {
      log('');
      log('DRIFT — committed repo state differs from the installed copy:');
      for (const d of drift) log(`  ${d.kind === 'missing-installed' ? 'MISSING' : 'STALE  '}: ${d.file}`);
      log('');
      log('The live session is NOT running what the repo ships. Fix:');
      log('  node tools/prism-installer.mjs update');
    } else if (unverified.length > 0) {
      log('NOTE: git unavailable — differences found but committedness unverifiable (not reported as drift):');
      for (const d of unverified) log(`  ${d.kind}: ${d.file}`);
    } else {
      log('[prism-drift-check] no drift — installed copy matches committed repo state.');
    }
  }

  process.exit(drift.length > 0 ? 1 : 0);
}

main();
