#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-data-quality.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// Q1: dispatch-cap hook emits actual_parallel + queue_depth and schema_version 4
const dc = readFileSync(join(repoRoot, 'hooks', 'prism-dispatch-cap.mjs'), 'utf-8');
check('Q1 dispatch-cap emits actual_parallel', dc.includes('actual_parallel'));
check('Q1 dispatch-cap emits queue_depth', dc.includes('queue_depth'));
check('Q1 dispatch-cap schema_version 4', /schema_version:\s*4/.test(dc));
check('Q1 counts fresh .prism-task dirs (mtime filter)', /mtime|statSync|freshness/i.test(dc));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
