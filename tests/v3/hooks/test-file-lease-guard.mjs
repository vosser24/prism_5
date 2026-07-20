#!/usr/bin/env node
// tests/v3/hooks/test-file-lease-guard.mjs — USAGE TEST for
// hooks/prism-file-lease-guard.mjs (task #19, 4b)
//
// Declared file-ownership lease: `PRISM-LEASE: agent=<id> files=<a>,<b>` lines
// in an Agent() prompt or SendMessage message record session-scoped leases.
// A declaration colliding with a live lease held by a DIFFERENT agent yields an
// ADVISORY (exit 0) — but ONLY when >1 agent is genuinely concurrent. Solo
// sessions never see it. TTL expiry and SubagentStop both release leases.
// It NEVER denies.
//
// Run: node tests/v3/hooks/test-file-lease-guard.mjs

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

const HOME = mkdtempSync(join(tmpdir(), 'prism-lease-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run, runSubagentStop, parseLeases, normFile } =
  await import(pathToFileURL(join(HOOKS, 'prism-file-lease-guard.mjs')).href);
const { appendRecord } = await import(pathToFileURL(join(HOOKS, 'lib', 'prism-live-agents.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const dispatch = (session_id, prompt) =>
  ({ tool_name: 'Agent', session_id, tool_input: { subagent_type: 'general-purpose', description: 'work', prompt } });
const send = (session_id, to, message) =>
  ({ tool_name: 'SendMessage', session_id, tool_input: { to, message } });
const advisoryOf = (r) => {
  if (!r.stdout) return '';
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};
const markRunning = (sid, id) =>
  appendRecord(HOME, sid, { agentId: id, agentType: id, status: 'running', startedAt: new Date().toISOString() });
const leaseFile = (sid) => join(HOME, '.claude', `.prism-file-leases-${sid}.json`);
const routingLog = () => join(HOME, '.claude', '.prism-routing.jsonl');
// All file_lease_guard events logged for a given session (parsed).
const leaseEvents = (sid) => {
  let txt = '';
  try { txt = readFileSync(routingLog(), 'utf-8'); } catch { return []; }
  return txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(o => o && o.event === 'file_lease_guard' && o.session_id === sid);
};

const LEASE_A = 'Fix the summary renderer.\nPRISM-LEASE: agent=worker-A files=hooks/lib/prism-live-agents.mjs';
const LEASE_B_SAME = 'Extend the ledger schema.\nPRISM-LEASE: agent=worker-B files=hooks\\lib\\prism-live-agents.mjs';
const LEASE_B_OTHER = 'Write the changelog.\nPRISM-LEASE: agent=worker-B files=CHANGELOG.md,docs/notes.md';

try {
  // ── unit: declaration parsing + path normalization ──────────────────────────
  {
    const d = parseLeases('intro\nPRISM-LEASE: agent=@Worker-A files=.\\Hooks\\A.mjs, tools/b.mjs\nrest');
    check('parseLeases extracts agent (@-stripped, lowercased) + files',
      d.length === 1 && d[0].agent === 'worker-a' && d[0].files.length === 2);
    check('normFile: backslashes + leading ./ + case normalized',
      d[0].files[0] === 'hooks/a.mjs' && normFile('.\\Hooks\\A.mjs') === 'hooks/a.mjs');
    check('parseLeases: no declaration → empty', parseLeases('just some prose about files=x').length === 0);
  }

  // ── fail-open ────────────────────────────────────────────────────────────────
  check('fail-open empty {}', (await run({})).exit === 0);
  check('fail-open non-routed tool', (await run({ tool_name: 'Bash', tool_input: {} })).exit === 0);
  check('no declaration in prompt → quiet', (await run(dispatch('sNone', 'no lease lines here'))).exit === 0 && !advisoryOf(await run(dispatch('sNone', 'still none'))));

  // ── FIRES: true collision, 2 concurrent agents, same declared file ──────────
  {
    const sid = 'sCollide';
    const r1 = await run(dispatch(sid, LEASE_A)); // worker-A declares
    check('collision: first declaration → quiet exit 0', r1.exit === 0 && !advisoryOf(r1));
    markRunning(sid, 'worker-A'); // A is now genuinely live
    const r2 = await run(dispatch(sid, LEASE_B_SAME)); // B declares the SAME file (win path spelling)
    const adv = advisoryOf(r2);
    check('collision: second declaration → exit 0 (advisory-only, never deny)', r2.exit === 0);
    check('collision: advisory FIRES naming holder + claimant + file',
      /FILE-LEASE/.test(adv) && /worker-a/i.test(adv) && /worker-b/i.test(adv) && /hooks\/lib\/prism-live-agents\.mjs/.test(adv));
    const entries = JSON.parse(readFileSync(leaseFile(sid), 'utf-8'));
    check('collision: incumbent keeps the lease (no overwrite)',
      entries.filter(e => e.file === 'hooks/lib/prism-live-agents.mjs').length === 1 &&
      entries.find(e => e.file === 'hooks/lib/prism-live-agents.mjs').agent === 'worker-a');
  }

  // ── QUIET: independent files, 2 concurrent agents ───────────────────────────
  {
    const sid = 'sIndep';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, LEASE_B_OTHER));
    check('independent files beside live agent → quiet', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: solo session (only 1 concurrent agent) even on a stale collision ─
  {
    const sid = 'sSolo';
    await run(dispatch(sid, LEASE_A)); // lease recorded; worker-A never marked running (solo)
    const r = await run(dispatch(sid, LEASE_B_SAME));
    check('solo session: collision recorded but NEVER advised', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: SubagentStop clears the holder's lease ───────────────────────────
  {
    const sid = 'sStop';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    await runSubagentStop({ session_id: sid, agent_name: 'worker-A' });
    const r = await run(dispatch(sid, LEASE_B_SAME));
    check('after SubagentStop clear → re-declaration quiet', r.exit === 0 && !advisoryOf(r));
    const entries = JSON.parse(readFileSync(leaseFile(sid), 'utf-8'));
    check('after SubagentStop: worker-B now holds the lease',
      entries.find(e => e.file === 'hooks/lib/prism-live-agents.mjs').agent === 'worker-b');
  }

  // ── QUIET: TTL expiry releases a crashed agent's lease ──────────────────────
  {
    const sid = 'sTTL';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    // Backdate the lease to 20 min ago (> 15-min TTL) — a crashed agent.
    const p = leaseFile(sid);
    const entries = JSON.parse(readFileSync(p, 'utf-8'));
    entries.forEach(e => { e.ts = new Date(Date.now() - 20 * 60000).toISOString(); });
    writeFileSync(p, JSON.stringify(entries));
    const r = await run(dispatch(sid, LEASE_B_SAME));
    check('after TTL expiry → re-declaration quiet (stuck lock self-heals)', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: same-agent re-declaration refreshes, never advises ───────────────
  {
    const sid = 'sRefresh';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    const r = await run(send(sid, 'worker-A', LEASE_A));
    check('same-agent re-declaration (via SendMessage) → quiet refresh', r.exit === 0 && !advisoryOf(r));
  }

  // ── SendMessage declaration path fires too (2 live agents) ──────────────────
  {
    const sid = 'sSend';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    markRunning(sid, 'worker-B'); // both genuinely live
    const r = await run(send(sid, 'worker-B', LEASE_B_SAME));
    check('SendMessage-declared collision with 2 live agents → advisory', r.exit === 0 && /FILE-LEASE/.test(advisoryOf(r)));
  }

  // ── F4: observe the MISS — build-class fan-out with NO declaration ──────────
  // FIRE: Agent build-class dispatch, ledger seeded with 2 running records, no
  // lease line → no_declaration event logged + producer-nudge advisory on stdout.
  {
    const sid = 'sMissFire';
    markRunning(sid, 'worker-A'); // seed 2 genuinely-live agents
    markRunning(sid, 'worker-B');
    const BUILD_NO_LEASE = 'Implement the new endpoint and build the component. Write the code.';
    const r = await run(dispatch(sid, BUILD_NO_LEASE));
    const adv = advisoryOf(r);
    check('miss/fire: build-class + ≥2 concurrent + no lease → advisory FIRES',
      r.exit === 0 && /FILE-LEASE/.test(adv) && /no file ownership/.test(adv) && /PRISM-LEASE: agent=/.test(adv));
    const evs = leaseEvents(sid);
    check('miss/fire: exactly one no_declaration event logged (declared:0, concurrent≥2)',
      evs.length === 1 && evs[0].no_declaration === true && evs[0].declared === 0 &&
      evs[0].advised === false && evs[0].concurrent >= 2 && evs[0].tool_name === 'Agent');
  }

  // QUIET-1: solo dispatch (no other live agent), no lease line → no event, no stdout.
  {
    const sid = 'sMissSolo';
    const BUILD_NO_LEASE = 'Implement the new endpoint and build the component.';
    const r = await run(dispatch(sid, BUILD_NO_LEASE));
    check('miss/quiet-solo: solo build-class dispatch, no lease → quiet (no stdout)',
      r.exit === 0 && !advisoryOf(r));
    check('miss/quiet-solo: no file_lease_guard event logged for a solo session',
      leaseEvents(sid).length === 0);
  }

  // QUIET-1b: read-class fan-out (≥2 concurrent) with no lease → miss logged but
  // NO producer nudge (build-class gate holds — advisory stays silent).
  {
    const sid = 'sMissRead';
    markRunning(sid, 'worker-A');
    markRunning(sid, 'worker-B');
    const READ_NO_LEASE = 'Investigate and audit the codebase; map out and read the modules.';
    const r = await run(dispatch(sid, READ_NO_LEASE));
    check('miss/quiet-read: read-class fan-out logs the miss but emits NO nudge',
      r.exit === 0 && !advisoryOf(r) && leaseEvents(sid).length === 1 && leaseEvents(sid)[0].no_declaration === true);
  }

  // ── kill-switch ──────────────────────────────────────────────────────────────
  {
    const sid = 'sKill';
    await run(dispatch(sid, LEASE_A));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, LEASE_B_SAME), { ...process.env, PRISM_FILE_LEASE: 'off' });
    check('PRISM_FILE_LEASE=off → quiet even on a true collision', r.exit === 0 && !advisoryOf(r));
  }
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
