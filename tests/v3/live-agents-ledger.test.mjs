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
    const line = lib.renderSummary(map);
    const expected = 'Live agents (session): 1 running [a1:coffee-ledger-expert], 1 completed [b2:software-architecture-expert].';
    ok('(3) renderSummary exact one-line format', line === expected, line);
    // module run() returns the same line as stdout.
    const res = await summaryMod.run({ session_id: SESSION2 });
    ok('(3) summary module run() emits the line as stdout', res && res.stdout === expected && res.exit === 0, res && res.stdout);
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
    ok('(4b) malformed ledger: renders valid record', line3 === 'Live agents (session): 1 running [good:x], 0 completed [].', line3);

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
} finally {
  // Restore env + clean temp.
  if (origHOME === undefined) delete process.env.HOME; else process.env.HOME = origHOME;
  if (origUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUP;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
