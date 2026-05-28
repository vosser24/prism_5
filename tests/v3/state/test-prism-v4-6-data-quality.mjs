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

// Q2: panel-guard classifies challenge evidence_class at panel-write
const pg = readFileSync(join(repoRoot, 'hooks', 'prism-panel-guard.mjs'), 'utf-8');
check('Q2 panel-guard has classifyEvidenceClass', pg.includes('classifyEvidenceClass'));
check('Q2 uses 7-class taxonomy names',
  pg.includes('PRECEDENT') && pg.includes('MEASUREMENT') && pg.includes('REASONED-INFERENCE'));
check('Q2 writes evidence_class back onto challenges', /\.evidence_class\s*=/.test(pg));

// Q4: --agreement no longer joins the non-existent phase_1_5_verdict event
const agg = readFileSync(join(repoRoot, 'tools', 'prism-telemetry-aggregate.mjs'), 'utf-8');
check('Q4 agreement reads the verdict JSONL, not phantom event',
  agg.includes('.prism-phase-1-5-verdicts.jsonl') || agg.includes('phase_1_5_oob'));
check('Q4 agreement no longer keys on phase_1_5_verdict',
  !/'phase_1_5_verdict'|"phase_1_5_verdict"/.test(agg));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
