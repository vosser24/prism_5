#!/usr/bin/env node
// tests/v3/hooks/test-phase-0d-latch-trigger.mjs
//
// F7 Phase 3 — NATURAL-PATH integration test for the STOP-GATED phase-0d OOB
// reviewer trigger, decoupled from any model-authored panel.json Write (D072).
//
// WHAT THIS PROVES (the acceptance bar): a panel run that NEVER Writes a
// model-authored panel.json still yields a phase-0d verdict file
// (~/.claude/.prism-phase-0d-verdicts-*.json), produced from the master
// transcript + the Phase-2 structural panel.json, fired off the Stop event.
// It exercises the REAL chain: the Phase-2 producer
// (hooks/prism-panel-seat-recorder.mjs) records >=2 seats, then the REAL Stop
// hook (hooks/prism-session-end.mjs, spawned as a subprocess with a Stop
// payload) resolves the structural panel + transcript and fires the reviewer.
// The ONLY thing stubbed is the `claude -p` LLM (PRISM_PHASE_0D_MOCK_VERDICT
// routes phase-0d-oob.run() through its synchronous mock branch so the verdict
// is written before the subprocess exits).
//
// Also asserts the two revision requirements:
//   • THROTTLE — a second Stop inside the throttle window does NOT re-fire.
//   • STABLE-SHA OVERWRITE — a third Stop (throttle disabled) reuses the same
//     per-latch sha, so the verdict COUNT stays 1 (overwrite, not leak).
//
// Dep-free. Flips BOTH HOME and USERPROFILE to a fresh mkdtemp sandbox.
// Run: node tests/v3/hooks/test-phase-0d-latch-trigger.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const sessionEndHook = join(repoRoot, 'hooks', 'prism-session-end.mjs');

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }

// ── Sandbox home (flip BOTH; prismHome reads HOME first, os.homedir reads
//    USERPROFILE on win32, verdict-flag home() reads HOME||USERPROFILE) ───────
const sandbox = mkdtempSync(join(tmpdir(), 'prism-p0d-stop-'));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
const claudeDir = join(sandbox, '.claude');
mkdirSync(join(claudeDir, 'skills', 'prism-plan', 'references'), {recursive: true});
writeFileSync(join(claudeDir, 'skills', 'prism-plan', 'references', 'roster.json'),
  JSON.stringify({agents: {}}, null, 2));

// Transcript WITH challenge content — presence is load-bearing for the S6 gate.
const transcriptPath = join(sandbox, 'master-transcript.jsonl');
writeFileSync(transcriptPath, [
  '{"role":"assistant","text":"Panel seat 1 (security): the token store must be encrypted at rest."}',
  '{"role":"assistant","text":"Seat 2 (perf) CHALLENGES seat 1: +3ms/op per the 2026-06 benchmark log line 44."}',
  '{"role":"assistant","text":"Seat 1 REBUTS: amortized; commit ab12cd3 cached the KEK, net +0.2ms."}',
  '{"role":"assistant","text":"Seat 2 concedes the rebuttal; panel converges on encrypt-at-rest with KEK cache."}',
].join('\n') + '\n');

const sessionId = 'natural-stop-panel-001';

// Arm the latch (production: tier-router arms it on the summon turn).
const {writePanelLatch, readPanelLatch} = await import(pathToFileURL(join(repoRoot, 'hooks', 'lib', 'prism-panel-latch.mjs')).href);
writePanelLatch(sessionId);
const latch = readPanelLatch(sessionId);
const openedTs = latch && latch.opened_ts ? String(latch.opened_ts) : '';
const stableSha = createHash('sha256').update(sessionId + '|' + openedTs).digest('hex').slice(0, 16);

// Drive the REAL Phase-2 producer to record 2 hook-recorded seats (no model
// panel.json Write anywhere).
const {run: recordSeat} = await import(pathToFileURL(join(repoRoot, 'hooks', 'prism-panel-seat-recorder.mjs')).href);
await recordSeat({tool_name: 'Agent', session_id: sessionId, transcript_path: transcriptPath,
  tool_input: {subagent_type: 'security-architect', name: 'Security'}});
await recordSeat({tool_name: 'Agent', session_id: sessionId, transcript_path: transcriptPath,
  tool_input: {subagent_type: 'performance-engineer', name: 'Perf'}});

const {resolvePanelPath} = await import(pathToFileURL(join(repoRoot, 'hooks', 'prism-panel-seat-recorder.mjs')).href);
const panelPath = resolvePanelPath(sessionId);
{
  const panel = existsSync(panelPath) ? JSON.parse(readFileSync(panelPath, 'utf-8')) : null;
  check('producer: structural panel.json created with seat_producer hook-recorded (no model Write)',
    panel && panel.seat_producer === 'hook-recorded');
  check('producer: 2 seats recorded', panel && panel.positions.length === 2);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const mockVerdict = JSON.stringify({
  schema_version: '1', severity: 'UN-CITED',
  panel_scope_coverage: 'FULL', rationale_completeness: 'PARTIAL',
  headline_finding: 'deliberation graded from transcript',
  meta: {deliberation_visible: true, schema_version_seen: 1, alternatives_field_absent: true},
});
function verdictFiles() {
  return readdirSync(claudeDir).filter(f => f.startsWith('.prism-phase-0d-verdicts-') && f.endsWith('.json'));
}
function routingActions() {
  const p = join(claudeDir, '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return {}; } })
    .filter(o => o.event === 'phase_0d_stop_trigger').map(o => o.action);
}
function fireStop(extraEnv) {
  const payload = JSON.stringify({session_id: sessionId, transcript_path: transcriptPath, cwd: repoRoot});
  return spawnSync(process.execPath, [sessionEndHook], {
    input: payload, encoding: 'utf-8',
    env: {...process.env, HOME: sandbox, USERPROFILE: sandbox, PRISM_PHASE_0D_MOCK_VERDICT: mockVerdict, ...extraEnv},
  });
}

// ── FIRE 1 — latch live + 2 seats + transcript → produces one verdict ───────
{
  const res = fireStop({});
  check('fire 1: Stop hook exits 0', res.status === 0);
  const vf = verdictFiles();
  check('fire 1: exactly ONE phase-0d verdict file produced from the Stop path', vf.length === 1);
  check('fire 1: verdict file is named by the STABLE per-latch sha',
    vf.length === 1 && vf[0] === `.prism-phase-0d-verdicts-${stableSha}.json`);
  if (vf.length === 1) {
    const v = JSON.parse(readFileSync(join(claudeDir, vf[0]), 'utf-8'));
    check('fire 1: verdict.kind is 0d', v.kind === '0d');
    check('fire 1: verdict.sha is the stable sha', v.sha === stableSha);
    check('fire 1: verdict points at the HOOK-WRITTEN structural panel.json', v.panel_path === panelPath);
    check('fire 1: mocked verdict carried through (severity + meta.deliberation_visible)',
      v.verdict && v.verdict.severity === 'UN-CITED' && v.verdict.meta && v.verdict.meta.deliberation_visible === true);
  }
  check('fire 1: routing log records a fire', routingActions().includes('fire'));
  check('fire 1: throttle stamp written', existsSync(join(claudeDir, `.prism-phase-0d-throttle-${stableSha}.json`)));
}

// ── FIRE 2 — immediate re-Stop under default throttle → must NOT re-fire ─────
{
  const res = fireStop({}); // default throttle (~2.5min)
  check('fire 2: Stop hook exits 0', res.status === 0);
  check('fire 2: still exactly ONE verdict file (throttle prevented a second fire)', verdictFiles().length === 1);
  check('fire 2: routing log records a throttled event', routingActions().includes('throttled'));
}

// ── FIRE 3 — throttle disabled → re-fires, but STABLE sha overwrites (no leak) ─
{
  const res = fireStop({PRISM_PHASE_0D_THROTTLE_MS: '0'});
  check('fire 3: Stop hook exits 0', res.status === 0);
  check('fire 3: STILL exactly ONE verdict file (stable-sha overwrite, not a new file)', verdictFiles().length === 1);
  check('fire 3: routing log now has >=2 fire events (overwrite path exercised)',
    routingActions().filter(a => a === 'fire').length >= 2);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
try { rmSync(sandbox, {recursive: true, force: true}); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
