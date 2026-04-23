#!/usr/bin/env node
// PRISM install verification. Exits 0 on success, non-zero on failure.
//
// v2.8.0: no longer uses a hardcoded required-files list. Reads manifest.json
// from the repo (passed via --manifest arg, or auto-located relative to this
// script) and checks every `dest` entry actually exists under ~/.claude/.
// Catches silent install failures where step 3 (file copy) missed one or more
// manifest entries — previously only 11 of 75 files were checked, so an
// install could "succeed" while leaving e.g. prism-opus-classifier.mjs
// uncopied, then crash at first UserPromptSubmit.

import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const H = homedir();
const CLAUDE = join(H, '.claude');
const IS_WIN = platform() === 'win32';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function findManifest() {
  // 1. CLI arg
  const argIdx = process.argv.indexOf('--manifest');
  if (argIdx !== -1 && process.argv[argIdx + 1]) return resolve(process.argv[argIdx + 1]);
  // 2. cwd
  if (existsSync(resolve(process.cwd(), 'manifest.json'))) return resolve(process.cwd(), 'manifest.json');
  // 3. repo root relative to this script (scripts/verify.mjs → ../manifest.json)
  if (existsSync(resolve(SCRIPT_DIR, '..', 'manifest.json'))) return resolve(SCRIPT_DIR, '..', 'manifest.json');
  return null;
}

function expandDest(dest) {
  if (dest.startsWith('~/')) return join(H, dest.slice(2));
  if (dest.startsWith('~\\')) return join(H, dest.slice(2));
  return dest;
}

let failed = 0;
let warnings = 0;
let checked = 0;

// --- Manifest-driven file checks (v2.8.0) ---
const manifestPath = findManifest();
if (!manifestPath) {
  console.log('  WARN  manifest.json not found (tried --manifest flag, cwd, and ../manifest.json from script dir). Falling back to minimal hardcoded list.');
  warnings++;
  const fallback = [
    'hooks/prism-hook.mjs',
    'hooks/prism-session-start.mjs',
    'hooks/prism-safety.mjs',
    'tools/prism-kb-indexer.mjs',
    'tools/prism-kb-query.mjs',
    'tools/subagent-summary.py',
    'statusline-command.sh',
    'settings.json',
    'agents/master-orchestrator.md',
    'skills/prism-plan/SKILL.md',
    IS_WIN ? 'hooks/lib/prism-exec.cmd' : 'hooks/lib/prism-exec.sh',
  ];
  for (const rel of fallback) {
    const p = join(CLAUDE, rel);
    checked++;
    if (existsSync(p)) console.log(`  OK  ${rel}`);
    else { console.log(`  MISSING  ${rel}`); failed++; }
  }
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); }
  catch (err) {
    console.error(`  FAIL  manifest.json at ${manifestPath} is invalid JSON: ${err.message}`);
    process.exit(1);
  }

  console.log(`  Using manifest: ${manifestPath} (v${manifest.version})`);
  console.log(`  Checking ${manifest.files.length} manifest entries + infrastructure...`);

  const missingList = [];
  for (const entry of manifest.files) {
    if (!entry.dest) continue;
    const destPath = expandDest(entry.dest);
    checked++;
    if (existsSync(destPath)) {
      // Quiet OK — printing 75 "OK" lines is noisy. Only summarize at end.
    } else {
      missingList.push(entry.dest);
      failed++;
    }
  }

  if (missingList.length === 0) {
    console.log(`  OK  all ${manifest.files.length} manifest entries present in ~/.claude/`);
  } else {
    console.log(`  MISSING  ${missingList.length} of ${manifest.files.length} manifest entries:`);
    for (const m of missingList) console.log(`           ${m}`);
  }

  // OS-specific wrapper must exist (Windows uses .cmd; POSIX uses .sh).
  const wrapperRel = IS_WIN ? 'hooks/lib/prism-exec.cmd' : 'hooks/lib/prism-exec.sh';
  checked++;
  if (existsSync(join(CLAUDE, wrapperRel))) console.log(`  OK  ${wrapperRel} (OS-specific wrapper)`);
  else { console.log(`  MISSING  ${wrapperRel} (required for your OS)`); failed++; }
}

// --- settings.json wiring checks (unchanged behavior, v2.3.0+) ---
try {
  const s = readFileSync(join(CLAUDE, 'settings.json'), 'utf-8');
  if (!s.includes('prism-hook.mjs')) { console.log('  MISSING  settings.json has no prism-hook entry'); failed++; }
  else console.log('  OK  settings.json wired');
  if (!s.includes('statusline-command.sh')) { console.log('  WARN  settings.json missing statusLine entry (optional)'); warnings++; }

  const wrapperToken = IS_WIN ? 'prism-exec.cmd' : 'prism-exec.sh';
  if (!s.includes(wrapperToken)) {
    console.log(`  WARN  settings.json does not reference ${wrapperToken} — hooks may be calling node directly (pre-2.3 install)`);
    warnings++;
  } else console.log(`  OK  settings.json uses ${wrapperToken}`);

  const staleRe = IS_WIN
    ? /"command"\s*:\s*"node\s+%USERPROFILE%\\\\?\.claude\\\\?hooks\\\\?prism-[^"]+\.mjs"/
    : /"command"\s*:\s*"node\s+~\/\.claude\/hooks\/prism-[^"]+\.mjs"/;
  if (staleRe.test(s)) {
    console.log('  WARN  settings.json has stale raw-node PRISM hook entries (pre-2.3). Re-run INSTALL.md §4 to prune.');
    warnings++;
  }
} catch { console.log('  MISSING  settings.json unreadable'); failed++; }

// --- prism.env (v2.3.0+) ---
const prismEnv = join(CLAUDE, 'prism.env');
if (existsSync(prismEnv)) console.log('  OK  prism.env present (hook fast path)');
else {
  console.log('  HINT  prism.env absent — wrappers will auto-discover node each hook firing. Re-run INSTALL.md §2.5 to pin.');
  warnings++;
}

// --- Summary ---
console.log('');
console.log(`Checked: ${checked} files + settings.json + prism.env`);
console.log(`Failures: ${failed}  Warnings: ${warnings}`);

if (failed) { console.error(`\nFAILED: ${failed} checks did not pass.`); process.exit(1); }
console.log('\nPRISM install verified.');
