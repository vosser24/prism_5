#!/usr/bin/env node
// tests/v3/state/test-prism-oob-spawn-lib.mjs
// RB-06 — shared OOB spawn helper (hooks/lib/prism-oob-spawn.mjs) dedup test.
//
// Root cause: phase-0d-oob.mjs and phase-1-5-oob.mjs each defined a
// byte-identical resolveClaudeBin() and independently hardcoded the reviewer
// spawnSync timeout (90_000 in phase-0d, 240_000 in phase-1-5 per D064
// remedy-2). The duplication meant the 50s->240s D064 timeout fix landed in
// phase-1-5 only, leaving phase-0d hardcoded at 90_000 (RB-06 defect: Phase 0d
// reviewer always times out at 90s).
//
// This test locks two invariants:
//   1. hooks/lib/prism-oob-spawn.mjs exports OOB_REVIEWER_TIMEOUT_MS === 240000.
//   2. Neither hook file contains a bare `timeout: 90_000` literal, and both
//      import OOB_REVIEWER_TIMEOUT_MS from the shared lib — so the constant
//      can never again drift between the two call sites.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const libPath = join(repoRoot, 'hooks', 'lib', 'prism-oob-spawn.mjs');
const oob0dPath = join(repoRoot, 'hooks', 'prism-phase-0d-oob.mjs');
const oob15Path = join(repoRoot, 'hooks', 'prism-phase-1-5-oob.mjs');

// 1. The shared lib exports the correct constant.
let libMod;
try {
  libMod = await import(new URL(`file://${libPath.replace(/\\/g, '/')}`).href);
  check('lib exports OOB_REVIEWER_TIMEOUT_MS === 240000', libMod.OOB_REVIEWER_TIMEOUT_MS === 240_000);
  check('lib exports resolveClaudeBin as a function', typeof libMod.resolveClaudeBin === 'function');
} catch (e) {
  check(`lib import failed: ${e.message}`, false);
  check('lib exports OOB_REVIEWER_TIMEOUT_MS === 240000', false);
}

// 2. Static source assertions — the drift-can't-recur invariant.
const oob0d = readFileSync(oob0dPath, 'utf-8');
const oob15 = readFileSync(oob15Path, 'utf-8');

check('phase-0d does NOT contain bare timeout: 90_000 literal', !/timeout:\s*90_000\b/.test(oob0d));
check('phase-1-5 does NOT contain bare timeout: 90_000 literal', !/timeout:\s*90_000\b/.test(oob15));
check('phase-0d imports OOB_REVIEWER_TIMEOUT_MS from shared lib', /import\s*\{[^}]*OOB_REVIEWER_TIMEOUT_MS[^}]*\}\s*from\s*['"]\.\/lib\/prism-oob-spawn\.mjs['"]/.test(oob0d));
check('phase-1-5 imports OOB_REVIEWER_TIMEOUT_MS from shared lib', /import\s*\{[^}]*OOB_REVIEWER_TIMEOUT_MS[^}]*\}\s*from\s*['"]\.\/lib\/prism-oob-spawn\.mjs['"]/.test(oob15));
check('phase-0d no longer defines its own resolveClaudeBin', !/function\s+resolveClaudeBin\s*\(/.test(oob0d));
check('phase-1-5 no longer defines its own resolveClaudeBin', !/function\s+resolveClaudeBin\s*\(/.test(oob15));
check('phase-0d imports resolveClaudeBin from shared lib', /import\s*\{[^}]*resolveClaudeBin[^}]*\}\s*from\s*['"]\.\/lib\/prism-oob-spawn\.mjs['"]/.test(oob0d));
check('phase-1-5 imports resolveClaudeBin from shared lib', /import\s*\{[^}]*resolveClaudeBin[^}]*\}\s*from\s*['"]\.\/lib\/prism-oob-spawn\.mjs['"]/.test(oob15));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
