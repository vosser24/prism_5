#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-calibration.mjs
// v4.6 K0/K1/K2/K3/K4 — calibration engine against synthetic fixtures
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// ── K2: escalate model ────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'v46-cal-k2-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  copyFileSync(fix('verdicts-bad.jsonl'), join(claudeDir, '.prism-phase-1-5-verdicts.jsonl'));
  writeFileSync(join(claudeDir, 'roster.json'), JSON.stringify({ agents: { foo: { pending_upgrade: true, default_model: 'sonnet' } } }));
  const result = recommend(fix('thin.jsonl'), home);
  const k2 = (result.recommendations || []).find(x => x.knob === 'model:foo');
  check('K2 recommends opus for pending_upgrade agent with high bad rate', k2 && k2.recommended === 'opus');
  check('K2 apply includes --set-model foo opus', k2 && /--set-model foo opus/.test(k2.apply || ''));
}

// ── K3: auto-clear pending_upgrade ───────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'v46-cal-k3-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  copyFileSync(fix('verdicts-good.jsonl'), join(claudeDir, '.prism-phase-1-5-verdicts.jsonl'));
  writeFileSync(join(claudeDir, 'roster.json'), JSON.stringify({ agents: { bar: { pending_upgrade: true } } }));
  const result = recommend(fix('thin.jsonl'), home);
  const k3 = (result.recommendations || []).find(x => x.knob === 'clear:bar');
  check('K3 recommends clearing pending_upgrade for clean agent', k3 && k3.recommended === 'pending_upgrade=false');
  check('K3 apply includes --clear-pending-upgrade bar', k3 && /--clear-pending-upgrade bar/.test(k3.apply || ''));
}

// ── K4: override gate ─────────────────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'v46-cal-k4-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const result = recommend(fix('overrides.jsonl'), home);
  const k4 = (result.recommendations || []).find(x => x.knob === 'override_gate');
  check('K4 recommends strict override gate when >=5 overrides logged', k4 && k4.recommended === 'strict');
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
