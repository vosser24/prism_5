#!/usr/bin/env node
// tests/v3/hooks/test-dispatch-dedup-guard.mjs — USAGE TEST for
// hooks/prism-dispatch-dedup-guard.mjs
//
// The guard BLOCKS an exact-signature Agent dispatch (same subagent_type +
// description + first ~400 chars of prompt) while an identical one is still
// in-flight, and clears the in-flight entry at SubagentStop (FIFO-by-type). A
// 12-min TTL backstops a missed clear. Fail-open everywhere.
//
// Imports run()/runSubagentStop()/signatureOf() directly; HOME is redirected to a
// temp dir so the per-session ledger + routing-log writes stay sandboxed. Each
// scenario uses a distinct session_id (the ledger is per-session).
//
// Run: node tests/v3/hooks/test-dispatch-dedup-guard.mjs

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', '..', 'hooks', 'prism-dispatch-dedup-guard.mjs');

const HOME = mkdtempSync(join(tmpdir(), 'prism-dedup-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run, runSubagentStop, signatureOf } = await import(pathToFileURL(GUARD).href);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const dispatch = (session_id, subagent_type, description, prompt, extra = {}) =>
  ({ tool_name: 'Agent', session_id, tool_input: { subagent_type, description, prompt }, ...extra });
const exitOf = async (payload, env) => (await run(payload, { ...process.env, ...(env || {}) })).exit;
const ledgerPath = (sid) => join(HOME, '.claude', `.prism-inflight-dispatches-${sid}.json`);

try {
  // ── signature stability ────────────────────────────────────────────────────
  check('signatureOf is stable for identical inputs',
    signatureOf('general-purpose', 'count files', 'do the thing') ===
    signatureOf('general-purpose', 'count files', 'do the thing'));
  check('signatureOf differs for different prompts',
    signatureOf('general-purpose', 'count files', 'A') !==
    signatureOf('general-purpose', 'count files', 'B'));
  check('signatureOf stable across whitespace noise',
    signatureOf('general-purpose', 'Count  Files', ' do  THE thing ') ===
    signatureOf('general-purpose', 'count files', 'do the thing'));

  // ── fail-open ───────────────────────────────────────────────────────────────
  check('fail-open empty {}', await exitOf({}) === 0);
  check('fail-open non-Agent tool', await exitOf({ tool_name: 'Bash', tool_input: {} }) === 0);

  // ── first dispatch allowed + duplicate blocked ──────────────────────────────
  check('first dispatch → allow', await exitOf(dispatch('sDup', 'general-purpose', 'count hooks', 'count the hooks')) === 0);
  check('identical in-flight dispatch → BLOCK (exit 2)', await exitOf(dispatch('sDup', 'general-purpose', 'count hooks', 'count the hooks')) === 2);
  check('different prompt same session → allow (different signature)', await exitOf(dispatch('sDup', 'general-purpose', 'count tests', 'count the tests')) === 0);

  // ── subagent-context dispatch is skipped (nested-dispatch guard owns it) ─────
  check('subagent-context duplicate → allow (skipped)',
    await exitOf(dispatch('sDup', 'general-purpose', 'count hooks', 'count the hooks', { parent_tool_use_id: 'toolu_1' })) === 0);

  // ── soft mode: advisory only ────────────────────────────────────────────────
  check('soft: first → allow', await exitOf(dispatch('sSoft', 'general-purpose', 't', 'p'), { PRISM_DISPATCH_DEDUP: 'soft' }) === 0);
  check('soft: duplicate → advisory exit 0', await exitOf(dispatch('sSoft', 'general-purpose', 't', 'p'), { PRISM_DISPATCH_DEDUP: 'soft' }) === 0);

  // ── off mode: pass-through, still records ───────────────────────────────────
  check('off: first → allow', await exitOf(dispatch('sOff', 'general-purpose', 't', 'p'), { PRISM_DISPATCH_DEDUP: 'off' }) === 0);
  check('off: duplicate → allow (off)', await exitOf(dispatch('sOff', 'general-purpose', 't', 'p'), { PRISM_DISPATCH_DEDUP: 'off' }) === 0);

  // ── SubagentStop clears the in-flight entry → re-dispatch allowed ───────────
  check('clear: first → allow', await exitOf(dispatch('sClear', 'general-purpose', 'build x', 'build the x')) === 0);
  check('clear: duplicate while open → BLOCK', await exitOf(dispatch('sClear', 'general-purpose', 'build x', 'build the x')) === 2);
  await runSubagentStop({ session_id: 'sClear', agent_name: 'general-purpose' }, process.env);
  check('clear: after SubagentStop → re-dispatch allowed', await exitOf(dispatch('sClear', 'general-purpose', 'build x', 'build the x')) === 0);

  // ── TTL: an expired open entry no longer blocks (sweep on read) ──────────────
  await exitOf(dispatch('sTTL', 'general-purpose', 'slow task', 'a slow task'));
  // Backdate the open entry to 20 min ago (> 12-min TTL) directly in the ledger.
  {
    const p = ledgerPath('sTTL');
    const entries = JSON.parse(readFileSync(p, 'utf-8'));
    entries.forEach(e => { e.ts = new Date(Date.now() - 20 * 60000).toISOString(); });
    writeFileSync(p, JSON.stringify(entries));
  }
  check('TTL: re-dispatch after entry expired → allowed', await exitOf(dispatch('sTTL', 'general-purpose', 'slow task', 'a slow task')) === 0);
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
