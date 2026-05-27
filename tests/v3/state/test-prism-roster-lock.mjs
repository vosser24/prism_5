#!/usr/bin/env node
// tests/v3/state/test-prism-roster-lock.mjs
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0; let total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

check('tools/lib/prism-roster-lock.mjs exists',
  existsSync(join(repoRoot, 'tools', 'lib', 'prism-roster-lock.mjs')));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
