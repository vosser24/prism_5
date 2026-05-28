#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-calibration.mjs
// v4.6 K0/K1/K2/K3 — calibration engine against synthetic fixtures
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const AGG = join(repoRoot, 'tools', 'prism-telemetry-aggregate.mjs');
const fix = n => join(__dirname, 'fixtures', 'calibration', n);
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

function recommend(routingLog, home) {
  const r = spawnSync(process.execPath, [AGG, '--recommend-calibration', '--routing-log', routingLog, '--home', home, '--force'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { _raw: r.stdout, _err: r.stderr }; }
}

// Cap-hot fixture → K1 recommends raising the cap
const hot = recommend(fix('cap-hot.jsonl'), '/tmp/v46-cal-hot');
const k1 = (hot.recommendations || []).find(x => x.knob === 'dispatch_cap');
check('K0 returns a recommendations array', Array.isArray(hot.recommendations));
check('K1 recommends raising cap on hot fixture', k1 && k1.recommended > k1.current);
check('K1 is report-only (no apply command, manual note)', k1 && /dispatch-shapes\.md|edit by hand|report-only/i.test(JSON.stringify(k1)));
// Thin fixture → insufficient data, keep defaults
const thin = recommend(fix('thin.jsonl'), '/tmp/v46-cal-thin');
const thinK1 = (thin.recommendations || []).find(x => x.knob === 'dispatch_cap');
check('K0 degrades to insufficient data on thin fixture', thinK1 && /insufficient/i.test(thinK1.evidence || thinK1.status || ''));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
