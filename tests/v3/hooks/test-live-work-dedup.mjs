#!/usr/bin/env node
// tests/v3/hooks/test-live-work-dedup.mjs — USAGE TEST for
// hooks/prism-live-work-dedup.mjs (task #19, 4a)
//
// The guard ADVISES (soft, exit 0, additionalContext) when a fresh Agent()
// dispatch topically overlaps the CURRENT task summary of a LIVE agent —
// including scope assigned mid-flight via SendMessage (the 2026-07-14 incident
// shape). It stays quiet on independent work, solo/no-live-agent sessions, and
// with the kill-switch off. It NEVER denies.
//
// Run: node tests/v3/hooks/test-live-work-dedup.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

const HOME = mkdtempSync(join(tmpdir(), 'prism-livework-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run } = await import(pathToFileURL(join(HOOKS, 'prism-live-work-dedup.mjs')).href);
const { appendRecord, keywordsOf, taskOverlap, collectLiveWork } =
  await import(pathToFileURL(join(HOOKS, 'lib', 'prism-live-agents.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const dispatch = (session_id, name, description, prompt, extra = {}) =>
  ({ tool_name: 'Agent', session_id, tool_input: { name, subagent_type: 'general-purpose', description, prompt }, ...extra });
const send = (session_id, to, message) =>
  ({ tool_name: 'SendMessage', session_id, tool_input: { to, message } });
const advisoryOf = (r) => {
  if (!r.stdout) return '';
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};
const markRunning = (sid, id) =>
  appendRecord(HOME, sid, { agentId: id, agentType: id, status: 'running', startedAt: new Date().toISOString() });
const markCompleted = (sid, id) =>
  appendRecord(HOME, sid, { agentId: id, status: 'completed', endedAt: new Date().toISOString() });

// Incident-shaped texts (2026-07-14 diagnosis): original dispatch about the
// SessionStart payload, scope EXPANDED via SendMessage to advisory precision,
// then a fresh independent dispatch of that same advisory-precision question.
const ORIGINAL_TASK = 'Audit the SessionStart payload size. Break the injected payload down by section and measure bytes per section of the SessionStart context injection.';
const SM_EXPANSION = 'Also measure how often the skill-equip advisory and the specialist-routing advisory fire, and estimate their precision and false-positive rate from hooks/prism-skill-equip-nudge.mjs matching logic.';
const FRESH_DUP = 'Measure how often the skill-equip advisory fires and estimate advisory precision and false-positive rate from the matching logic in hooks/prism-skill-equip-nudge.mjs.';
const FRESH_INDEPENDENT = 'Refactor the greedy settlement algorithm in the coffee-ledger backend to handle multi-currency rounding drift in balances.';

try {
  // ── unit: keyword extraction + overlap are deterministic ────────────────────
  {
    const a = keywordsOf('Measure advisory precision for skill-equip nudge matching');
    const b = keywordsOf('measure ADVISORY precision for skill-equip nudge matching!!');
    check('keywordsOf deterministic across case/punctuation',
      [...a].sort().join(',') === [...b].sort().join(','));
    check('keywordsOf drops short tokens and stopwords',
      !a.has('for') && !a.has('the'));
    const ov = taskOverlap(a, keywordsOf(FRESH_DUP));
    check('taskOverlap finds shared topics on incident texts', ov.shared.length >= 4 && ov.coefficient >= 0.3);
    const ov2 = taskOverlap(keywordsOf(ORIGINAL_TASK), keywordsOf(FRESH_INDEPENDENT));
    check('taskOverlap near-zero on unrelated texts', ov2.shared.length < 4);
  }

  // ── fail-open ────────────────────────────────────────────────────────────────
  check('fail-open empty {}', (await run({})).exit === 0);
  check('fail-open non-routed tool', (await run({ tool_name: 'Bash', tool_input: {} })).exit === 0);

  // ── FIRES: the real incident shape (SendMessage-expanded scope) ─────────────
  {
    const sid = 'sIncident';
    // 1. dilution-audit dispatched with the ORIGINAL task (records its summary).
    const r1 = await run(dispatch(sid, 'dilution-audit', 'Audit SessionStart payload size', ORIGINAL_TASK));
    check('incident: original dispatch → quiet exit 0', r1.exit === 0 && !advisoryOf(r1));
    markRunning(sid, 'dilution-audit'); // SubagentStart lands
    // 2. scope expanded via SendMessage (the invisible channel, now visible).
    const r2 = await run(send(sid, 'dilution-audit', SM_EXPANSION));
    check('incident: scope-assigning SendMessage → quiet exit 0', r2.exit === 0 && !advisoryOf(r2));
    // 3. fresh independent dispatch of the SAME question → ADVISORY.
    const r3 = await run(dispatch(sid, 'advisory-precision', 'Measure advisory precision', FRESH_DUP));
    const adv = advisoryOf(r3);
    check('incident: duplicate fresh dispatch → exit 0 (advisory-only, never deny)', r3.exit === 0);
    check('incident: advisory FIRES naming the live agent', /LIVE-WORK DEDUP/.test(adv) && /dilution-audit/.test(adv));
    // The ORIGINAL dispatch text alone must NOT explain the match — prove the
    // SendMessage expansion is what made it visible (the actual 07-14 miss).
    const ovOrig = taskOverlap(keywordsOf(FRESH_DUP), keywordsOf(ORIGINAL_TASK));
    check('incident: original text ALONE would not match (SendMessage carry is load-bearing)',
      !(ovOrig.shared.length >= 4 && ovOrig.coefficient >= 0.3));
  }

  // ── QUIET: legitimate independent dispatch alongside live work ──────────────
  {
    const sid = 'sIndependent';
    await run(dispatch(sid, 'worker-A', 'Audit SessionStart payload size', ORIGINAL_TASK));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Refactor settlement algorithm', FRESH_INDEPENDENT));
    check('independent dispatch beside live agent → quiet', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: re-steering the SAME agent is not a duplicate ────────────────────
  {
    const sid = 'sSame';
    await run(dispatch(sid, 'worker-A', 'Measure advisory precision', FRESH_DUP));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-A', 'Measure advisory precision', FRESH_DUP));
    check('same-agent re-dispatch → quiet (not a live-work dup)', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: completed agent's work no longer matches ─────────────────────────
  {
    const sid = 'sDone';
    await run(dispatch(sid, 'worker-A', 'Measure advisory precision', FRESH_DUP));
    markRunning(sid, 'worker-A');
    markCompleted(sid, 'worker-A'); // SubagentStop lands
    const r = await run(dispatch(sid, 'worker-B', 'Measure advisory precision', FRESH_DUP));
    check('duplicate of a COMPLETED agent\'s work → quiet', r.exit === 0 && !advisoryOf(r));
  }

  // ── QUIET: status pings over SendMessage are not recorded as scope ──────────
  {
    const sid = 'sPing';
    markRunning(sid, 'worker-A');
    await run(send(sid, 'worker-A', 'Status: phase 2 complete, all nine test files green, moving on to the release checklist now.'));
    check('status ping not recorded as task scope',
      (collectLiveWork(HOME, sid).get('worker-A') || { texts: [] }).texts.length === 0);
  }

  // ── kill-switch ──────────────────────────────────────────────────────────────
  {
    const sid = 'sKill';
    await run(dispatch(sid, 'worker-A', 'Measure advisory precision', FRESH_DUP));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Measure advisory precision', FRESH_DUP),
      { ...process.env, PRISM_LIVE_WORK_DEDUP: 'off' });
    check('PRISM_LIVE_WORK_DEDUP=off → quiet even on a true dup', r.exit === 0 && !advisoryOf(r));
  }

  // ── subagent context is skipped ──────────────────────────────────────────────
  {
    const sid = 'sNested';
    await run(dispatch(sid, 'worker-A', 'Measure advisory precision', FRESH_DUP));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Measure advisory precision', FRESH_DUP, { parent_tool_use_id: 'toolu_1' }));
    check('subagent-context dispatch → quiet (skipped)', r.exit === 0 && !advisoryOf(r));
  }
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
