#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-oob-spawn.mjs
// v4.6 H4 — Windows claude resolution + mock-verdict env short-circuits
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const oob0d = readFileSync(join(repoRoot, 'hooks', 'prism-phase-0d-oob.mjs'), 'utf-8');
const oob15 = readFileSync(join(repoRoot, 'hooks', 'prism-phase-1-5-oob.mjs'), 'utf-8');

check('0d hook resolves claude binary (not bare literal in spawnSync)', /resolveClaudeBin|claudeBin/.test(oob0d));
check('1-5 hook resolves claude binary', /resolveClaudeBin|claudeBin/.test(oob15));
check('0d hook honors PRISM_PHASE_0D_MOCK_VERDICT', oob0d.includes('PRISM_PHASE_0D_MOCK_VERDICT'));
check('1-5 hook honors PRISM_PHASE_1_5_MOCK_VERDICT', oob15.includes('PRISM_PHASE_1_5_MOCK_VERDICT'));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
