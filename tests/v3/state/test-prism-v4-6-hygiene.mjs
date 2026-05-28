#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-hygiene.mjs
// v4.6 Layer 4 — H1 lock coverage, H2 verdict-flag kind, H3 --target hook paths
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }
const read = p => readFileSync(join(repoRoot, p), 'utf-8');

// H1: the 3 previously-unwrapped sites now import + use withRosterLock
for (const f of ['hooks/prism-agent-write-register.mjs', 'tools/prism-uninstall-cleanup.mjs', 'tools/prism-installer.mjs']) {
  const s = read(f);
  check(`H1 ${f} uses withRosterLock`, s.includes('withRosterLock'));
}
// H2: verdict-flag takes a kind parameter
const vf = read('tools/lib/prism-verdict-flag.mjs');
check('H2 writeVerdict(kind, sha, payload)', /writeVerdict\s*\(\s*kind\s*,\s*sha/.test(vf));
const oob15 = read('hooks/prism-phase-1-5-oob.mjs');
check('H2 phase-1-5 migrated to kind call', /writeVerdict\(\s*['"]1-5['"]/.test(oob15));
const oob0d = read('hooks/prism-phase-0d-oob.mjs');
check('H2 phase-0d migrated to kind call', /writeVerdict\(\s*['"]0d['"]/.test(oob0d));
// H3: installer rewrites hook command paths target-relative
const inst = read('tools/prism-installer.mjs');
check('H3 installer rewrites hook paths for --target', /PRISM_HOOK_ROOT|rewriteHookPaths|hookRoot/.test(inst));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
