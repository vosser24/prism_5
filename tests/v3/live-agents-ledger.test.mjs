// Package E — live-agents ledger tests (dep-free node).
// Exercises the SubagentStart/Stop confabulation ledger end-to-end:
//   (1) SubagentStart payload  → a `running` record is written.
//   (2) SubagentStop same id   → reconciles to `completed` (agentType preserved).
//   (3) summary module renders the expected one-line format from a ledger.
//   (4) fail-open on missing / malformed ledger (no throw, no output).
// Hermetic: HOME/USERPROFILE are pointed at a throwaway temp dir so the real
// ~/.claude is never touched. Prints PASS/FAIL per case, exits non-zero on any
// failure.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', 'hooks');
const asUrl = (p) => new URL('file://' + p.replace(/\\/g, '/')).href;

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// ── Hermetic temp HOME ────────────────────────────────────────────────────────
const TMP_HOME = mkdtempSync(join(tmpdir(), 'prism-live-agents-test-'));
mkdirSync(join(TMP_HOME, '.claude'), { recursive: true });
const origHOME = process.env.HOME;
const origUP = process.env.USERPROFILE;
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const SESSION = 'sess-ABC123';
const ledgerFile = join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION}.jsonl`);

// Load the shared lib + hook modules (invokedDirectly guards keep import side-effect-free).
const lib = await import(asUrl(join(HOOKS, 'lib', 'prism-live-agents.mjs')));
const startHook = await import(asUrl(join(HOOKS, 'prism-subagent-start.mjs')));
const stopHook = await import(asUrl(join(HOOKS, 'prism-subagent-stop.mjs')));
const summaryMod = await import(asUrl(join(HOOKS, 'prism-live-agents-summary.mjs')));

try {
  // ── (1) SubagentStart → running record ──────────────────────────────────────
  await startHook.run({ session_id: SESSION, agent_type: 'claude-master' });
  ok('(1) ledger file created on SubagentStart', existsSync(ledgerFile));
  {
    const lines = readFileSync(ledgerFile, 'utf-8').trim().split('\n').filter(Boolean);
    ok('(1) exactly one record after start', lines.length === 1, `lines=${lines.length}`);
    const rec = JSON.parse(lines[0]);
    ok('(1) agentId resolved from agent_type', rec.agentId === 'claude-master', JSON.stringify(rec.agentId));
    ok('(1) status is running', rec.status === 'running', rec.status);
    ok('(1) startedAt present (ISO)', typeof rec.startedAt === 'string' && !Number.isNaN(Date.parse(rec.startedAt)));
    ok('(1) agentType captured', rec.agentType === 'claude-master', rec.agentType);
  }

  // ── (2) SubagentStop same id → reconciles to completed ──────────────────────
  await stopHook.run({ session_id: SESSION, agent_type: 'claude-master' });
  {
    const map = lib.reconcile(TMP_HOME, SESSION);
    ok('(2) start & stop key on the SAME id (one entry)', map.size === 1, `size=${map.size}`);
    const rec = map.get('claude-master');
    ok('(2) reconciled record exists for claude-master', !!rec);
    ok('(2) reconciled status is completed (last-write-wins)', rec && rec.status === 'completed', rec && rec.status);
    ok('(2) agentType preserved from start record', rec && rec.agentType === 'claude-master', rec && rec.agentType);
    ok('(2) completedAt present', rec && typeof rec.completedAt === 'string');
    // append-only crash-safety: both raw records are still on disk.
    const raw = readFileSync(ledgerFile, 'utf-8').trim().split('\n').filter(Boolean);
    ok('(2) append-only — 2 raw records on disk', raw.length === 2, `lines=${raw.length}`);
  }

  // ── (3) summary module renders the expected one-line format ─────────────────
  {
    // Synthetic ledger with one running + one completed agent, in a fresh session.
    const SESSION2 = 'sess-RENDER';
    const f2 = join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION2}.jsonl`);
    writeFileSync(f2, [
      JSON.stringify({ agentId: 'a1', agentType: 'coffee-ledger-expert', status: 'running', startedAt: '2026-07-06T00:00:00Z' }),
      JSON.stringify({ agentId: 'b2', agentType: 'software-architecture-expert', status: 'running', startedAt: '2026-07-06T00:00:01Z' }),
      JSON.stringify({ agentId: 'b2', status: 'completed', completedAt: '2026-07-06T00:01:00Z' }),
    ].join('\n') + '\n');
    const map = lib.reconcile(TMP_HOME, SESSION2);
    const line = lib.renderSummary(map, { now: Date.parse('2026-07-06T00:05:00Z'), ttlMs: 3600000 });
    const expected = 'Live agents (session): 1 running [coffee-ledger-expert], 1 completed [software-architecture-expert].';
    ok('(3) renderSummary exact one-line format', line === expected, line);
    // module run() uses live Date.now() internally — a1's startedAt is a fixed
    // 2026-07-06 date, far outside the default running-TTL cap by the time this
    // suite actually executes, so only assert the completed entry's shape here.
    const res = await summaryMod.run({ session_id: SESSION2 });
    ok('(3) summary module run() includes the completed entry', !!(res && typeof res.stdout === 'string' && res.stdout.includes('1 completed [software-architecture-expert]') && res.exit === 0), res && res.stdout);
  }

  // ── (4) fail-open on missing / malformed ledger ─────────────────────────────
  {
    // missing ledger → empty map, '' summary, module emits nothing, no throw.
    let threw = false, map, line, res;
    try {
      map = lib.reconcile(TMP_HOME, 'no-such-session');
      line = lib.renderSummary(map);
      res = await summaryMod.run({ session_id: 'no-such-session' });
    } catch { threw = true; }
    ok('(4a) missing ledger: no throw', !threw);
    ok('(4a) missing ledger: empty map', map && map.size === 0);
    ok('(4a) missing ledger: empty summary', line === '');
    ok('(4a) missing ledger: module emits nothing', res && res.stdout === '' && res.exit === 0);

    // malformed ledger (garbage + partial lines) → skipped, no throw.
    const SESSION3 = 'sess-BAD';
    const f3 = join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION3}.jsonl`);
    writeFileSync(f3, 'not json\n{"agentId":"good","agentType":"x","status":"running"}\n{broken json\n\n');
    let threw2 = false, map3, line3;
    try { map3 = lib.reconcile(TMP_HOME, SESSION3); line3 = lib.renderSummary(map3); } catch { threw2 = true; }
    ok('(4b) malformed ledger: no throw', !threw2);
    ok('(4b) malformed ledger: only the valid record survives', map3 && map3.size === 1 && map3.has('good'), map3 && `size=${map3.size}`);
    ok('(4b) malformed ledger: renders valid record', line3 === 'Live agents (session): 1 running [x], 0 completed [].', line3);

    // defensive: renderSummary(null / non-map) → '' no throw; extractAgentId bad input.
    let threw3 = false;
    try {
      ok('(4c) renderSummary(null) → ""', lib.renderSummary(null) === '');
      ok('(4c) renderSummary(undefined) → ""', lib.renderSummary(undefined) === '');
      ok('(4c) extractAgentId(null) → ""', lib.extractAgentId(null) === '');
      ok('(4c) extractAgentId({}) → ""', lib.extractAgentId({}) === '');
      ok('(4c) appendRecord(no session) → false', lib.appendRecord(TMP_HOME, '', { agentId: 'x' }) === false);
    } catch { threw3 = true; }
    ok('(4c) defensive inputs: no throw', !threw3);

    // start hook with missing session_id / missing id → no ledger, no throw.
    let threw4 = false;
    try {
      await startHook.run({ agent_type: 'orphan' });          // no session_id
      await startHook.run({ session_id: 'sess-NOID' });        // no agent id
    } catch { threw4 = true; }
    ok('(4d) start hook missing fields: no throw', !threw4);
    ok('(4d) start hook missing session_id → no ledger written',
      !existsSync(join(TMP_HOME, '.claude', '.prism-live-agents-undefined.jsonl')));
    ok('(4d) start hook missing agent id → no ledger for that session',
      !existsSync(join(TMP_HOME, '.claude', '.prism-live-agents-sess-NOID.jsonl')));
  }

  // ── (5) FIRE — two concurrent same-type agents don't collide on one key ─────
  {
    const SESSION5 = 'sess-FIRE';
    const idA = 'ageneral-purpose-aaaa000000000001';
    const idB = 'ageneral-purpose-bbbb000000000002';
    await startHook.run({ session_id: SESSION5, agent_type: 'general-purpose', agent_id: idA });
    await startHook.run({ session_id: SESSION5, agent_type: 'general-purpose', agent_id: idB });
    await stopHook.run({ session_id: SESSION5, agent_type: 'general-purpose', agent_id: idA });
    const map = lib.reconcile(TMP_HOME, SESSION5);
    ok('(5) FIRE: two per-instance ledger entries (no collision)', map.size === 2, `size=${map.size}`);
    const line = lib.renderSummary(map, { now: Date.now() + 60000, ttlMs: 3600000 });
    ok('(5) FIRE: shows 1 running', /1 running/.test(line), line);
    ok('(5) FIRE: shows 1 completed', /1 completed/.test(line), line);
    ok('(5) FIRE: does not collapse to 2 completed', !/2 completed/.test(line), line);
    const runningCount = Number((line.match(/(\d+) running/) || [])[1] || 0);
    ok('(5) FIRE: running count is nonzero', runningCount !== 0, line);
    ok('(5) FIRE: running label disambiguated with #-suffix (last4 of idB)', /general-purpose#0002/.test(line), line);
  }

  // ── (6) QUIET — different types never disambiguate, no raw id ever shown ────
  {
    const SESSION6 = 'sess-QUIET';
    const idDb = 'adb-expert-1111111111111111';
    const idApi = 'aapi-expert-2222222222222222';
    await startHook.run({ session_id: SESSION6, agent_type: 'db-expert', agent_id: idDb });
    await startHook.run({ session_id: SESSION6, agent_type: 'api-expert', agent_id: idApi });
    await stopHook.run({ session_id: SESSION6, agent_type: 'db-expert', agent_id: idDb });
    const map = lib.reconcile(TMP_HOME, SESSION6);
    const line = lib.renderSummary(map, { now: Date.now() + 60000, ttlMs: 3600000 });
    const expected = 'Live agents (session): 1 running [api-expert], 1 completed [db-expert].';
    ok('(6) QUIET: exact plain-type-label line, no #, no raw a<type>-<hex> id', line === expected, line);
  }

  // ── (7) TTL — a stale `running` entry is age-capped out, a fresh one isn't ──
  {
    const SESSION7 = 'sess-TTL';
    const f7 = join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION7}.jsonl`);
    const oldStarted = new Date(Date.now() - 20 * 3600000).toISOString();
    const freshStarted = new Date(Date.now() - 60000).toISOString();
    writeFileSync(f7, [
      JSON.stringify({ agentId: 'idA', agentType: 'typeA', status: 'running', startedAt: oldStarted }),
      JSON.stringify({ agentId: 'idB', agentType: 'typeB', status: 'running', startedAt: freshStarted }),
    ].join('\n') + '\n');
    const map = lib.reconcile(TMP_HOME, SESSION7);
    const now = Date.now();
    const line1 = lib.renderSummary(map, { now, ttlMs: 3600000 });
    ok('(7) TTL: shows fresh typeB running', /typeB/.test(line1), line1);
    ok('(7) TTL: excludes stale typeA (20h > 1h cap)', !/typeA/.test(line1), line1);
    const line2 = lib.renderSummary(map, { now, ttlMs: 21 * 3600000 });
    ok('(7) TTL: wider ttl shows both', /typeA/.test(line2) && /typeB/.test(line2), line2);
  }

  // ── (8) extractAgentKey — per-instance preferred, type fallback for legacy ──
  {
    const payload8a = { agent_type: 'general-purpose', agent_id: 'ageneral-purpose-deadbeefdeadbeef' };
    ok('(8a) extractAgentKey prefers agent_id', lib.extractAgentKey(payload8a) === 'ageneral-purpose-deadbeefdeadbeef', lib.extractAgentKey(payload8a));
    const SESSION8A = 'sess-KEY8A';
    await startHook.run({ session_id: SESSION8A, ...payload8a });
    await stopHook.run({ session_id: SESSION8A, ...payload8a });
    const raw8a = readFileSync(join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION8A}.jsonl`), 'utf-8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    ok('(8a) both raw records keyed byte-identical to agent_id', raw8a.length === 2 && raw8a.every(r => r.agentId === payload8a.agent_id), JSON.stringify(raw8a));

    const SESSION8B = 'sess-KEY8B';
    await startHook.run({ session_id: SESSION8B, agent_type: 'legacy' });
    await stopHook.run({ session_id: SESSION8B, agent_type: 'legacy' });
    const raw8b = readFileSync(join(TMP_HOME, '.claude', `.prism-live-agents-${SESSION8B}.jsonl`), 'utf-8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    ok('(8b) legacy payload (no agent_id): both records keyed on type', raw8b.length === 2 && raw8b.every(r => r.agentId === 'legacy'), JSON.stringify(raw8b));
    const map8b = lib.reconcile(TMP_HOME, SESSION8B);
    ok('(8b) reconcile size 1', map8b.size === 1, `size=${map8b.size}`);
  }

  // ── (9) dedup no-regression — MUST fail on a naive extractAgentKey-only fix ──
  // (taskText records still key on the TYPE string; status records now key on
  // the per-instance id — collectLiveWork must bridge them via agentType or a
  // completed agent's texted entry stays falsely "live" forever within TTL.)
  {
    const SESSION9 = 'sess-DEDUP9';
    lib.appendTaskSummary(TMP_HOME, SESSION9, 'coffee-expert', 'reconcile the ledger balances across accounts');
    const startPayload9 = { session_id: SESSION9, agent_type: 'coffee-expert', agent_id: 'acoffee-expert-1111111111111111' };
    await startHook.run(startPayload9);
    const live9a = lib.collectLiveWork(TMP_HOME, SESSION9);
    ok('(9) dedup: live entry keyed by type present after Start', live9a.has('coffee-expert'), [...live9a.keys()].join(','));
    await stopHook.run(startPayload9);
    const live9b = lib.collectLiveWork(TMP_HOME, SESSION9);
    ok('(9) dedup: no-regression — live entry gone after Stop despite fresh taskTs', !live9b.has('coffee-expert'), [...live9b.keys()].join(','));
  }

  // ── (10) resume — Start→Stop→Start on the same agent_id reconciles to one ───
  {
    const SESSION10 = 'sess-RESUME10';
    const payload10 = { session_id: SESSION10, agent_type: 'resumable-agent', agent_id: 'aresumable-agent-9999999999999999' };
    await startHook.run(payload10);
    await stopHook.run(payload10);
    await startHook.run(payload10);
    const map10 = lib.reconcile(TMP_HOME, SESSION10);
    ok('(10) resume: reconcile size 1', map10.size === 1, `size=${map10.size}`);
    const rec10 = map10.get(payload10.agent_id);
    ok('(10) resume: final status running', rec10 && rec10.status === 'running', rec10 && rec10.status);
  }
} finally {
  // Restore env + clean temp.
  if (origHOME === undefined) delete process.env.HOME; else process.env.HOME = origHOME;
  if (origUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUP;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
