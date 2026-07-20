#!/usr/bin/env node
// tests/v3/hooks/test-subagent-stop-telemetry.mjs
// D042 pair for F1 Layer C — SubagentStop telemetry event.
//
// hooks/prism-subagent-stop.mjs run() now appends ONE routing-log line per
// subagent stop:
//   {event:'subagent_stop', ts, session_id, agent, model, tokens}
// and, when PRISM_DEBUG_SUBAGENT_PAYLOAD=1, an extra `payload_keys` array of the
// input key NAMES only (no values). This makes the #56 worker-stall rate
// measurable and is the discovery instrument F1-B / F2 depend on.
//
// Fixture style: temp HOME override (prismHome() reads HOME/USERPROFILE), and we
// drive the hook through its stdin shim as a subprocess so exit codes and the
// malformed-payload fail-open path are exercised end-to-end.
//
//   FIRE : valid SubagentStop payload on stdin → exactly ONE subagent_stop line
//          with the expected fields (and, with the debug env, payload_keys).
//   QUIET: malformed/empty stdin → exit 0, no throw, NO subagent_stop line.
//
// Run: node tests/v3/hooks/test-subagent-stop-telemetry.mjs

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-subagent-stop.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? '\n        ' + detail : ''}\n`); }
}

// Spawn the hook as a real hook process with an isolated temp HOME.
// stdinText is fed on stdin; extraEnv merges over a HOME-overridden env.
function runHook(home, stdinText, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Ensure the debug flag is OFF unless a test explicitly sets it.
  delete env.PRISM_DEBUG_SUBAGENT_PAYLOAD;
  Object.assign(env, extraEnv);
  const res = spawnSync(process.execPath, [HOOK], { input: stdinText, env, encoding: 'utf-8' });
  return res;
}

function routingLog(home) { return join(home, '.claude', '.prism-routing.jsonl'); }

// Parse all subagent_stop events from a home's routing log.
function stopEvents(home) {
  const p = routingLog(home);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'subagent_stop');
}

// ── FIRE 1: valid payload → exactly one subagent_stop line, correct fields ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-fire-'));
  try {
    const payload = {
      agent_type: 'my-specialist',
      session_id: 'sess-fire-1',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    const res = runHook(home, JSON.stringify(payload));
    check('FIRE: hook exits 0', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    const evs = stopEvents(home);
    check('FIRE: exactly ONE subagent_stop line appended', evs.length === 1, `got ${evs.length}`);
    const ev = evs[0] || {};
    check('FIRE: event=subagent_stop', ev.event === 'subagent_stop');
    check('FIRE: session_id carried', ev.session_id === 'sess-fire-1', `got ${ev.session_id}`);
    check('FIRE: agent resolved from payload', ev.agent === 'my-specialist', `got ${ev.agent}`);
    check('FIRE: model carried', ev.model === 'claude-opus-4-8', `got ${ev.model}`);
    check('FIRE: tokens summed (10+5=15)', ev.tokens === 15, `got ${ev.tokens}`);
    check('FIRE: ts present (ISO)', typeof ev.ts === 'string' && ev.ts.includes('T'));
    check('FIRE: no payload_keys without debug env', !('payload_keys' in ev));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── FIRE 2: PRISM_DEBUG_SUBAGENT_PAYLOAD=1 → payload_keys = key NAMES only ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-dbg-'));
  try {
    const payload = { agent_type: 'dbg-agent', session_id: 'sess-dbg', model: 'claude-haiku-4-5', usage: {}, secret_value: 'DO-NOT-LEAK' };
    const res = runHook(home, JSON.stringify(payload), { PRISM_DEBUG_SUBAGENT_PAYLOAD: '1' });
    check('DEBUG: hook exits 0', res.status === 0, `status=${res.status}`);
    const ev = stopEvents(home)[0] || {};
    check('DEBUG: payload_keys present and is an array', Array.isArray(ev.payload_keys), JSON.stringify(ev.payload_keys));
    check('DEBUG: payload_keys carries the key NAMES', Array.isArray(ev.payload_keys) && ev.payload_keys.includes('agent_type') && ev.payload_keys.includes('secret_value'));
    // Privacy: only NAMES, never values — the secret value must not appear anywhere in the line.
    check('DEBUG: no payload VALUES leaked into the line', !JSON.stringify(ev).includes('DO-NOT-LEAK'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── QUIET: malformed stdin → exit 0, no throw, NO subagent_stop line ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-quiet-'));
  try {
    const res = runHook(home, 'this is not valid json {{{');
    check('QUIET: malformed payload still exits 0 (fail-open)', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    const evs = stopEvents(home);
    check('QUIET: NO subagent_stop line written on malformed payload', evs.length === 0, `got ${evs.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ── QUIET 2: empty stdin → exit 0, no line ──
{
  const home = mkdtempSync(join(tmpdir(), 'prism-substop-empty-'));
  try {
    const res = runHook(home, '');
    check('QUIET: empty stdin exits 0', res.status === 0, `status=${res.status}`);
    check('QUIET: empty stdin writes no subagent_stop line', stopEvents(home).length === 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
