#!/usr/bin/env node
// tests/v3/state/test-blindness-canary.mjs
// D042 both-paths proof for the self-blindness canary
// (tools/prism-telemetry-aggregate.mjs --blindness-canary):
//   (a) a hook logging the same bail action ~100% of the time over
//       enough volume MUST be flagged loudly.
//   (b) a healthy/varied log MUST stay quiet (flagged === []).
// Dep-free: only node:child_process, node:fs, node:os, node:path.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const AGG = join(repoRoot, 'tools', 'prism-telemetry-aggregate.mjs');

let pass = 0, total = 0;
function check(label, cond, extra) {
  total++;
  if (cond) { pass++; console.log(`PASS: ${label}`); }
  else console.log(`FAIL: ${label}${extra ? `  (${extra})` : ''}`);
}

function runCanary(routingLogPath) {
  const r = spawnSync(process.execPath, [AGG, '--blindness-canary', '--routing-log', routingLogPath], { encoding: 'utf8' });
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = { _raw: r.stdout, _stderr: r.stderr }; }
  return { parsed, stderr: r.stderr, code: r.status };
}

function writeLog(dir, name, lines) {
  const p = join(dir, name);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const scratch = mkdtempSync(join(tmpdir(), 'prism-canary-test-'));

// ── (a) BAD PATH: one hook logs the same bail action 100% of the time ──
// Mirrors the real-world case: phase_1_5_oob logging 'no-agent-name'
// on every single invocation (silently-dead reviewer path).
{
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: 'no-agent-name', session_id: 's1' });
  }
  const logPath = writeLog(scratch, 'bad.jsonl', lines);
  const { parsed, stderr, code } = runCanary(logPath);
  console.log('--- bad-path stdout ---');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('--- bad-path stderr ---');
  console.log(stderr);

  check('bad-path: exits 0 (fail-open contract)', code === 0, `code=${code}`);
  check('bad-path: status ok', parsed.status === 'ok', parsed.status);
  check('bad-path: hooks_checked >= 1', parsed.hooks_checked >= 1, parsed.hooks_checked);
  check('bad-path: FLAGS phase_1_5_oob', Array.isArray(parsed.flagged) && parsed.flagged.some(f => f.hook === 'phase_1_5_oob'),
    JSON.stringify(parsed.flagged));
  const flag = (parsed.flagged || []).find(f => f.hook === 'phase_1_5_oob');
  check('bad-path: flagged top_action is no-agent-name', flag && flag.top_action === 'no-agent-name', flag && flag.top_action);
  check('bad-path: flagged top_action_share === 1', flag && flag.top_action_share === 1, flag && flag.top_action_share);
  check('bad-path: flagged carries a human-readable LOUD message', flag && /silently-dead/i.test(flag.message || ''), flag && flag.message);
  check('bad-path: stderr prints the LOUD banner', /BLINDNESS CANARY/.test(stderr), stderr);
}

// ── (b) GOOD PATH: healthy, varied log stays quiet ──────────────────────
// Multiple hooks, each with a spread of actions, no single action
// dominating at >=95% share. Includes a hook whose action happens to be
// in the no-op class but is comfortably under both the volume floor and
// the share threshold, to prove the canary isn't trigger-happy.
{
  const lines = [];
  const actionsA = ['dispatched', 'dispatched', 'dispatched', 'blocked', 'passthrough'];
  for (let i = 0; i < 100; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'dispatch_guard', action: actionsA[i % actionsA.length], session_id: 's2' });
  }
  const actionsB = ['verdict-written', 'verdict-written', 'pending-written', 'no-output', 'agent-not-tagged'];
  for (let i = 0; i < 60; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: actionsB[i % actionsB.length], session_id: 's2' });
  }
  // Below the volume floor (NO_OP_CANARY_MIN_VOLUME=20) even though 100% no-op —
  // must NOT be flagged.
  for (let i = 0; i < 5; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'skill_trigger_guard', action: 'skip', session_id: 's2' });
  }
  const logPath = writeLog(scratch, 'good.jsonl', lines);
  const { parsed, stderr, code } = runCanary(logPath);
  console.log('--- good-path stdout ---');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('--- good-path stderr ---');
  console.log(JSON.stringify(stderr));

  check('good-path: exits 0', code === 0, `code=${code}`);
  check('good-path: status ok', parsed.status === 'ok', parsed.status);
  check('good-path: hooks_checked >= 2 (dispatch_guard + phase_1_5_oob cross floor)', parsed.hooks_checked >= 2, parsed.hooks_checked);
  check('good-path: STAYS QUIET — flagged is empty', Array.isArray(parsed.flagged) && parsed.flagged.length === 0, JSON.stringify(parsed.flagged));
  check('good-path: below-floor skill_trigger_guard not present in checked list', !(parsed.all || []).some(r => r.hook === 'skill_trigger_guard'),
    JSON.stringify(parsed.all));
  check('good-path: stderr has no LOUD banner', !/BLINDNESS CANARY/.test(stderr), stderr);
}

// ── (c) NO-DATA PATH: missing log fails open, not an error ─────────────
{
  const missingPath = join(scratch, 'does-not-exist.jsonl');
  const { parsed, code } = runCanary(missingPath);
  check('no-data path: exits 0 (fail-open, not an error)', code === 0, `code=${code}`);
  check('no-data path: status is no-data', parsed.status === 'no-data', parsed.status);
  check('no-data path: flagged is empty', Array.isArray(parsed.flagged) && parsed.flagged.length === 0, JSON.stringify(parsed.flagged));
}

console.log(`\ntests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
