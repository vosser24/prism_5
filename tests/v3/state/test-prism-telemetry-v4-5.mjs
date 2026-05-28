#!/usr/bin/env node
// tests/v3/state/test-prism-telemetry-v4-5.mjs
// v4.5 Layer 1 — telemetry tooling tests
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

let pass = 0;
let total = 0;

function check(label, cond) {
  total++;
  if (cond) { pass++; } else { console.log(`FAIL: ${label}`); }
}

// Layer 1 hook files exist
check('hooks/prism-phase-0d-challenges.mjs exists',
  existsSync(join(repoRoot, 'hooks', 'prism-phase-0d-challenges.mjs')));
check('hooks/prism-dispatch-cap.mjs exists',
  existsSync(join(repoRoot, 'hooks', 'prism-dispatch-cap.mjs')));

// Telemetry aggregate has --agreement mode
const aggPath = join(repoRoot, 'tools', 'prism-telemetry-aggregate.mjs');
const aggSrc = readFileSync(aggPath, 'utf-8');
check('telemetry-aggregate has --agreement mode',
  aggSrc.includes('--agreement') && aggSrc.includes('reviewer-agreement'));

// Schema version is 4 (v4.6 bumped the routing-log writer 3 -> 4; additive)
const routerPath = join(repoRoot, 'hooks', 'prism-prompt-tier-router.mjs');
const routerSrc = readFileSync(routerPath, 'utf-8');
check('.prism-routing.jsonl schema_version bumped to 4',
  /schema_version["\s:]+4\b/.test(routerSrc));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
