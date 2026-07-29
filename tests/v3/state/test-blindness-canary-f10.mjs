#!/usr/bin/env node
// tests/v3/state/test-blindness-canary-f10.mjs
//
// Regression test for F10 (task #23): the self-blindness canary
// (tools/prism-telemetry-aggregate.mjs --blindness-canary) escalated a hook
// to LOUD "likely a silently-dead mechanism" purely on no-op-action share
// (>=95%), with ZERO cross-check against evidence the SAME function call had
// already computed. Reported live: phase_1_5_oob at 95.1% of 1054 entries
// `agent-not-tagged` (correctly bailing — only 2/21 roster agents are
// tagged `requires_phase_1_5: true`), while its OWN completion-rate metric
// (pending-written -> verdict-written) showed starts:26, completions:26,
// completion_rate:1 in the SAME call — proof of life the canary held and
// ignored before declaring the mechanism dead.
//
// Fix: DEMOTE (not suppress) LOUD -> INFO when the flagged hook's SAME
// windowed slice (the slice the no-op share itself was computed from) also
// shows a LIFECYCLE_PAIRS completion. Deliberately windowed, not
// lifetime-wide — see the inline comment in prism-telemetry-aggregate.mjs
// for why: a hook that completed successfully once, long ago, must not be
// able to mask a genuine RECENT regression using lifetime-wide completions.
//
// MANDATORY per task #23: this file proves BOTH the false-positive fix
// (RED->GREEN below) AND a paired true-positive reproducing the ACTUAL
// D064 historical incident shape verbatim (docs/prism/adjudications/
// D064-shipped-capability-dead-behind-mislabeled-error-code.md, remedy 4:
// "{hook: phase_1_5_oob, start_action: pending-written, complete_action:
// verdict-written, starts: 11, completions: 0, completion_rate: 0}") — a
// hook with GENUINELY ZERO completions must still flag LOUD, unchanged.
//
// Run: node tests/v3/state/test-blindness-canary-f10.mjs

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

const scratch = mkdtempSync(join(tmpdir(), 'prism-canary-f10-test-'));

// ── RED->GREEN: the exact reported false-flag shape ─────────────────────────
// 1054 entries, 95.1% agent-not-tagged (low tag-ratio, correct bail), PLUS
// genuine pending-written/verdict-written completions IN THE SAME WINDOW —
// this is "recent genuine fires exist", the exact condition F10's own
// tracker entry names as the demotion trigger.
{
  const lines = [];
  const total_ = 1054;
  const bailCount = Math.round(total_ * 0.951);
  for (let i = 0; i < bailCount; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: 'agent-not-tagged', session_id: 's' + i });
  }
  const rem = total_ - bailCount;
  for (let i = 0; i < rem; i++) {
    const act = i % 2 === 0 ? 'pending-written' : 'verdict-written';
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: act, session_id: 'g' + i });
  }
  const logPath = writeLog(scratch, 'f10-reported-shape.jsonl', lines);
  const { parsed, stderr, code } = runCanary(logPath);
  console.log('--- F10 reported-shape stdout ---');
  console.log(JSON.stringify(parsed, null, 2));

  check('F10: exits 0 (fail-open contract)', code === 0, `code=${code}`);
  check('F10: hooks_checked >= 1', parsed.hooks_checked >= 1, parsed.hooks_checked);
  const flag = (parsed.flagged || []).find(f => f.hook === 'phase_1_5_oob');
  check('F10: hook is still reported (NOT suppressed)', !!flag, JSON.stringify(parsed.flagged));
  check('F10: top_action_share reproduces the reported 95.1%',
    flag && Math.abs(flag.top_action_share - 0.951) < 0.001, flag && flag.top_action_share);
  check('F10: DEMOTED to INFO (not LOUD) given recent completions in the same window',
    flag && flag.severity === 'INFO', flag && flag.severity);
  check('F10: message does NOT claim "likely a silently-dead mechanism"',
    flag && !/likely a silently-dead mechanism/i.test(flag.message), flag && flag.message);
  check('F10: message DOES explain the demotion reason (recent completions)',
    flag && /recent completion/i.test(flag.message), flag && flag.message);
  check('F10: stderr banner does NOT claim this hook "looks silently dead"',
    !/look silently dead[\s\S]*phase_1_5_oob/i.test(stderr), stderr);
  check('F10: stderr banner DOES surface the INFO finding (not silently dropped)',
    /confirmed recent activity/i.test(stderr) && /phase_1_5_oob/.test(stderr), stderr);
}

// ── MANDATORY PAIRED TRUE POSITIVE: the real D064 historical shape ─────────
// docs/prism/adjudications/D064-...md, remedy 4: "starts: 11, completions: 0,
// completion_rate: 0" — genuinely ZERO completions, ever. This is the exact
// incident the canary exists to catch. Must still flag LOUD after this fix.
{
  const lines = [];
  // 11 genuine pending-written arms (per D064), ZERO verdict-written, ever —
  // plus enough agent-not-tagged volume to cross NO_OP_CANARY_MIN_VOLUME and
  // dominate the window at >=95% share (the D064 log's real 99.28% shape).
  for (let i = 0; i < 11; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: 'pending-written', session_id: 'arm' + i });
  }
  for (let i = 0; i < 400; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: 'agent-not-tagged', session_id: 'bail' + i });
  }
  const logPath = writeLog(scratch, 'd064-real-incident-shape.jsonl', lines);
  const { parsed, stderr, code } = runCanary(logPath);
  console.log('--- D064 true-positive stdout ---');
  console.log(JSON.stringify(parsed, null, 2));

  check('TP (D064 shape): exits 0', code === 0, `code=${code}`);
  const flag = (parsed.flagged || []).find(f => f.hook === 'phase_1_5_oob' && f.severity !== 'INFO');
  check('TP (D064 shape): STILL flags LOUD (genuinely zero completions -> not demoted)',
    flag && flag.severity === 'LOUD', JSON.stringify(parsed.flagged));
  check('TP (D064 shape): message still says "likely a silently-dead mechanism"',
    flag && /likely a silently-dead mechanism/i.test(flag.message), flag && flag.message);
  check('TP (D064 shape): completion_rates independently confirms 0/11 (the D064 remedy-4 finding, unchanged)',
    Array.isArray(parsed.completion_rates) &&
    parsed.completion_rates.some(r => r.hook === 'phase_1_5_oob' && r.starts === 11 && r.completions === 0 && r.completion_rate === 0),
    JSON.stringify(parsed.completion_rates));
  check('TP (D064 shape): stderr banner correctly says "look silently dead"',
    /look silently dead/i.test(stderr) && /phase_1_5_oob/.test(stderr), stderr);
}

// ── Edge case, decided explicitly (per task instructions): completions ─────
// exist ONLY in the hook's FULL lifetime, NOT within the current windowed
// slice — i.e. the mechanism worked long ago but has since gone dead. Must
// NOT be demoted (recentCompletions is windowed, not lifetime-wide) — this
// is the scenario the windowed-vs-lifetime distinction exists to protect.
{
  const lines = [];
  // Old completions, now pushed out of the window by NO_OP_CANARY_WINDOW
  // (2000) worth of more-recent no-op noise — simulate with enough recent
  // agent-not-tagged volume that the window (last 2000 for this hook) no
  // longer contains any of the old pending-written/verdict-written pairs.
  for (let i = 0; i < 5; i++) {
    lines.push({ ts: '2020-01-01T00:00:00.000Z', event: 'phase_1_5_oob', action: 'pending-written', session_id: 'old' + i });
    lines.push({ ts: '2020-01-01T00:00:01.000Z', event: 'phase_1_5_oob', action: 'verdict-written', session_id: 'old' + i });
  }
  for (let i = 0; i < 2100; i++) {
    lines.push({ ts: new Date().toISOString(), event: 'phase_1_5_oob', action: 'agent-not-tagged', session_id: 'recent' + i });
  }
  const logPath = writeLog(scratch, 'stale-completions-shape.jsonl', lines);
  const { parsed } = runCanary(logPath);
  console.log('--- stale-completions-outside-window stdout ---');
  console.log(JSON.stringify({ flagged: parsed.flagged, completion_rates: parsed.completion_rates }, null, 2));

  const flag = (parsed.flagged || []).find(f => f.hook === 'phase_1_5_oob');
  check('edge case: old completions pushed OUTSIDE the window -> NOT demoted (still LOUD)',
    flag && flag.severity === 'LOUD', JSON.stringify(parsed.flagged));
  check('edge case: full-lifetime completion_rates STILL shows the old completions (separate, unwindowed metric, unaffected)',
    Array.isArray(parsed.completion_rates) &&
    parsed.completion_rates.some(r => r.hook === 'phase_1_5_oob' && r.completions === 5),
    JSON.stringify(parsed.completion_rates));
}

console.log(`\ntests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
