#!/usr/bin/env node
// Tests for hooks/prism-dispatch-preamble.mjs (Package: dispatch preamble).
//
// PRISM already mechanically appends an anti-over-delegation footer to every
// Agent() worker prompt (prism-anti-nesting-inject.mjs). This hook adds a
// SECOND clause set (write-to-disk / no-bug-is-valid / reproduce-first /
// artifacts-not-prose) via the same updatedInput mechanism.
//
// Proves:
//   (a) the clauses land in the rewritten prompt for a fresh Agent() call —
//       both in isolation (unit-level run()) AND through the REAL dispatcher
//       subprocess with the sibling anti-nesting hook also registered, which
//       is the case that actually matters: the dispatcher's updatedInput
//       merge is first-writer-wins PER KEY on a same-key conflict, and both
//       hooks target tool_input.prompt — so this also proves the composition
//       fix (calling the sibling's run() instead of racing it) actually works
//       end-to-end, not just in a mocked unit test.
//   (b) idempotency — no double-append when clauses already present (both
//       re-dispatching an already-augmented prompt, and a hand-pasted prompt
//       that already carries equivalent doctrine text).
//   (c) the kill-switch (PRISM_DISPATCH_PREAMBLE=off) disables it, and does
//       NOT interfere with the sibling anti-nesting hook still firing.
//
// Run: node tests/v3/dispatch-preamble.test.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {HOLDING_STRING_BAN} from '../../hooks/prism-anti-nesting-inject.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', 'hooks');
const DISPATCHER = join(HOOKS, 'prism-pretooluse-dispatcher.mjs');
const HOOK = join(HOOKS, 'prism-dispatch-preamble.mjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  PASS  ${name}`); }
function bad(name, msg) { fail++; console.log(`  FAIL  ${name}\n        ${msg}`); }
function check(name, cond, msg) { if (cond) ok(name); else bad(name, msg || 'assertion failed'); }

// ---------------------------------------------------------------------------
// Part 1 — hook driven as a FRESH SUBPROCESS (`node hooks/prism-dispatch-
// preamble.mjs`) for every env-dependent case. Both this hook and its sibling
// capture their kill-switch as a MODULE-LEVEL constant read once at import
// time (`const MODE = ...`) — correct for production, where each dispatcher
// invocation is a fresh subprocess, but it means mutating process.env AFTER
// this test file's own top-level `await import()` has ALREADY loaded the
// module has no effect on that already-cached MODE. A fresh `spawnSync`
// process is the only way to actually exercise the env-dependent branches,
// and is also the most faithful reproduction of "a fresh Agent() call".
// ---------------------------------------------------------------------------

function runHook(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: {...process.env, ...env},
  });
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch {}
  const hso = parsed && parsed.hookSpecificOutput;
  return {
    exit: r.status,
    stdout: (r.stdout || '').trim(),
    prompt: hso && hso.updatedInput && hso.updatedInput.prompt,
    message: hso && hso.updatedInput && hso.updatedInput.message,
  };
}

const AGENT_PAYLOAD = {
  tool_name: 'Agent',
  tool_input: {prompt: 'Investigate the failing checkout test.', subagent_type: 'general-purpose', description: 'investigate checkout'},
  session_id: 'unit-test',
};

// 1a. fresh call, sibling isolated off → all 4 clauses land, exactly once
{
  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  check('1a fresh call → updatedInput.prompt present',
    typeof prompt === 'string' && prompt.length > 0, `stdout=${r.stdout}`);
  const clauses = [
    'WRITE YOUR OUTPUT TO DISK',
    'is a VALID outcome',
    'REPRODUCE before you fix',
    'Report ARTIFACTS, not counters',
    'KARPATHY DISCIPLINE: make surgical, minimal changes',
    'verifiable success criteria',
  ];
  for (const c of clauses) {
    check(`1a clause present: "${c}"`, typeof prompt === 'string' && prompt.includes(c), `prompt=${prompt}`);
  }
  check('1a original prompt text preserved',
    typeof prompt === 'string' && prompt.startsWith(AGENT_PAYLOAD.tool_input.prompt), `prompt=${prompt}`);
  check('1a tag present exactly once',
    typeof prompt === 'string' && (prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 1,
    `prompt=${prompt}`);
  check('1a sibling isolated off → no anti-nesting tag',
    typeof prompt === 'string' && !prompt.includes('[PRISM anti-nesting]'), `prompt=${prompt}`);
}

// 1b. non-Agent tool → no-op
{
  const r = runHook({tool_name: 'Bash', tool_input: {command: 'ls'}});
  check('1b non-Agent tool → no-op (empty stdout)', r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// 1c. empty prompt → no-op
{
  const r = runHook({tool_name: 'Agent', tool_input: {prompt: '   '}});
  check('1c empty prompt → no-op', r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// ---------------------------------------------------------------------------
// Part 1 (b) — idempotency, sibling isolated off throughout
// ---------------------------------------------------------------------------

{
  // Re-run on the ALREADY-augmented prompt from 1a — must not double-append.
  const first = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const second = runHook(
    {...AGENT_PAYLOAD, tool_input: {...AGENT_PAYLOAD.tool_input, prompt: first.prompt}},
    {PRISM_ANTI_NESTING_INJECT: 'off'}
  );
  check('idempotency: re-dispatching an already-augmented prompt → no rewrite',
    second.exit === 0 && second.stdout === '', `stdout=${second.stdout}`);

  // Hand-pasted doctrine text (not produced by this hook) also suppresses
  // re-injection of OUR clauses. With the sibling isolated off, the sibling
  // has nothing to add either, so the whole call is a true no-op.
  const handPasted = 'Do the task. REPRODUCE before you fix and report ARTIFACTS, not counters or prose.';
  const third = runHook(
    {...AGENT_PAYLOAD, tool_input: {...AGENT_PAYLOAD.tool_input, prompt: handPasted}},
    {PRISM_ANTI_NESTING_INJECT: 'off'}
  );
  check('idempotency: hand-pasted equivalent doctrine (sibling off) → no rewrite',
    third.exit === 0 && third.stdout === '', `stdout=${third.stdout}`);

  // Same hand-pasted text but with the sibling ON: OUR clauses still must not
  // double, even though the sibling legitimately fires (it sees no nesting
  // doctrine in this text) and adds ITS OWN footer.
  const fourth = runHook({...AGENT_PAYLOAD, tool_input: {...AGENT_PAYLOAD.tool_input, prompt: handPasted}});
  check('idempotency: hand-pasted doctrine (sibling on) → sibling fires, ours does not double',
    typeof fourth.prompt === 'string'
      && fourth.prompt.includes('[PRISM anti-nesting]')
      && (fourth.prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 0,
    `prompt=${fourth.prompt}`);
}

// ---------------------------------------------------------------------------
// Part 1 (c) — kill-switch, hook-level subprocess
// ---------------------------------------------------------------------------

{
  const r = runHook(AGENT_PAYLOAD, {PRISM_DISPATCH_PREAMBLE: 'off'});
  check('kill-switch: PRISM_DISPATCH_PREAMBLE=off (hook-level) → no rewrite',
    r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// ---------------------------------------------------------------------------
// Part 2 — REAL dispatcher subprocess: proves composition with the sibling
// anti-nesting hook actually survives the first-writer-wins updatedInput
// merge (this is the case that matters — a naive same-key rewrite by each
// hook would silently drop one footer here).
// ---------------------------------------------------------------------------

function runDispatcher(payload, envOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-preamble-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  writeFileSync(
    join(home, '.claude', `.prism-turn-tier-${payload.session_id || 'anon'}.json`),
    JSON.stringify({tier: 'opus', rationale: 't', source: 't', dispatched: false})
  );
  try {
    const r = spawnSync(process.execPath, [DISPATCHER], {
      input: JSON.stringify(payload),
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home, ...envOverrides},
    });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch {}
    const hso = parsed && parsed.hookSpecificOutput;
    return {
      exit: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
      prompt: hso && hso.updatedInput && hso.updatedInput.prompt,
      additionalContext: hso && hso.additionalContext,
    };
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

{
  const payload = {
    tool_name: 'Agent',
    tool_input: {prompt: 'Fix the flaky checkout test.', subagent_type: 'general-purpose', description: 'fix flaky test'},
    session_id: 'dispatcher-composition-test',
  };
  const r = runDispatcher(payload);
  check('2a dispatcher run → exit 0 (never denies)', r.exit === 0, `exit=${r.exit} stderr=${r.stderr}`);
  check('2a dispatcher run → updatedInput.prompt present', typeof r.prompt === 'string' && r.prompt.length > 0, `stdout=${r.stdout}`);
  check('2a BOTH footers present: dispatch-preamble tag',
    typeof r.prompt === 'string' && r.prompt.includes('[PRISM dispatch-preamble]'), `prompt=${r.prompt}`);
  check('2a BOTH footers present: anti-nesting tag',
    typeof r.prompt === 'string' && r.prompt.includes('[PRISM anti-nesting]'), `prompt=${r.prompt}`);
  check('2a original prompt preserved at the start',
    typeof r.prompt === 'string' && r.prompt.startsWith(payload.tool_input.prompt), `prompt=${r.prompt}`);
  check('2a each tag appears exactly once (no duplication from the merge)',
    typeof r.prompt === 'string'
      && (r.prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 1
      && (r.prompt.match(/\[PRISM anti-nesting\]/g) || []).length === 1,
    `prompt=${r.prompt}`);
}

// 2b. kill-switch through the real dispatcher: dispatch-preamble off, sibling
// anti-nesting hook still fires normally (proves no interference).
{
  const payload = {
    tool_name: 'Agent',
    tool_input: {prompt: 'Investigate the flaky login test.', subagent_type: 'general-purpose', description: 'investigate login'},
    session_id: 'dispatcher-killswitch-test',
  };
  const r = runDispatcher(payload, {PRISM_DISPATCH_PREAMBLE: 'off'});
  check('2b kill-switch (dispatcher-level): no dispatch-preamble tag',
    !(typeof r.prompt === 'string' && r.prompt.includes('[PRISM dispatch-preamble]')), `prompt=${r.prompt}`);
  check('2b kill-switch (dispatcher-level): sibling anti-nesting still fires',
    typeof r.prompt === 'string' && r.prompt.includes('[PRISM anti-nesting]'), `prompt=${r.prompt}`);
}

// 2c. idempotency through the real dispatcher: re-dispatch the already-fully-
// augmented prompt from 2a — must not double either footer.
{
  const payload = {
    tool_name: 'Agent',
    tool_input: {prompt: 'Fix the flaky checkout test.', subagent_type: 'general-purpose', description: 'fix flaky test'},
    session_id: 'dispatcher-idempotency-test',
  };
  const first = runDispatcher(payload);
  const second = runDispatcher({...payload, tool_input: {...payload.tool_input, prompt: first.prompt}});
  check('2c dispatcher idempotency: no updatedInput on re-dispatch (or no duplication)',
    !second.prompt
      || ((second.prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 1
          && (second.prompt.match(/\[PRISM anti-nesting\]/g) || []).length === 1),
    `first.prompt=${first.prompt}\nsecond.prompt=${second.prompt}`);
}

// ---------------------------------------------------------------------------
// Part 3 (F1 Layer A) — SendMessage work-assignment path carries the
// holding-string ban. Before the fix, the ban reached only the Agent dispatch
// path (prism-anti-nesting-inject FOOTER/FORK_FOOTER); SendMessage assignments
// — ~half of agent-teams hand-offs — never received it. D042 fire/quiet pair.
// ---------------------------------------------------------------------------

// 3a. FIRE — a SendMessage payload that passes ALL 5 gating heuristics
// (plain string; ≥200 chars; no status-open marker; assignment marker in the
// first 400 chars; completion-criteria marker present) → the ban text lands in
// updatedInput.message.
{
  const assignment = [
    'Your task: implement the exponential-backoff retry helper in src/net/retry.mjs.',
    'You are the worker for this unit. Read the existing HTTP client, add retry with',
    'jitter, and cap attempts at five before surfacing the last error to the caller.',
    'Acceptance: the unit tests cover the backoff sequence and the attempt cap.',
    'Deliverables: the helper plus its tests. Done when node tests/net-retry.test.mjs',
    'passes with zero failures and the existing client call sites remain unchanged.',
  ].join(' ');
  const payload = {
    tool_name: 'SendMessage',
    tool_input: {to: 'worker-1', message: assignment},
    session_id: 'sendmessage-fire-test',
  };
  const r = runHook(payload);
  check('3a SendMessage assignment passes all gates → updatedInput.message present',
    typeof r.message === 'string' && r.message.length > 0, `stdout=${r.stdout}`);
  check('3a original assignment text preserved at the start',
    typeof r.message === 'string' && r.message.startsWith(assignment), `message=${r.message}`);
  check('3a dispatch-preamble tag present (idempotency anchor)',
    typeof r.message === 'string' && r.message.includes('[PRISM dispatch-preamble]'), `message=${r.message}`);
  check('3a holding-string ban text present in the assignment',
    typeof r.message === 'string' && r.message.includes(HOLDING_STRING_BAN), `message=${r.message}`);
  check('3a ban text is byte-identical to the anti-nesting export (single source of truth)',
    r.message.includes("holding/status string (e.g. 'verifying...', 'the child is checking...') is a FAILED result."),
    `message=${r.message}`);
}

// 3b. QUIET — a short status ping → all gates fail (length < 200 AND opens with
// a status marker) → no rewrite, empty stdout.
{
  const payload = {
    tool_name: 'SendMessage',
    tool_input: {to: 'main', message: 'status: phase 1 done, all green — verifying now.'},
    session_id: 'sendmessage-quiet-ping',
  };
  const r = runHook(payload);
  check('3b short status ping → no rewrite (empty stdout)',
    r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// 3c. QUIET — a structured (non-string) protocol message is never touched.
{
  const payload = {
    tool_name: 'SendMessage',
    tool_input: {to: 'main', message: {type: 'shutdown', reason: 'complete'}},
    session_id: 'sendmessage-quiet-struct',
  };
  const r = runHook(payload);
  check('3c structured (non-string) message → no rewrite (empty stdout)',
    r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// 3d. QUIET — a long report ABOUT work (no assignment/criteria markers) stays
// untouched: proves the ban rides only on genuine work assignments, not on
// teammate chatter that merely happens to be long.
{
  const chatter = [
    'I finished tracing the failing checkout path and confirmed the root cause is',
    'a stale cache key in the pricing module. I have not changed anything yet — just',
    'wanted to share the findings so we can decide the next step together whenever',
    'you have a moment. The relevant code is in src/pricing/cache.mjs, right around',
    'the memoization wrapper that keys on the raw request instead of the normalized one.',
  ].join(' ');
  const payload = {
    tool_name: 'SendMessage',
    tool_input: {to: 'main', message: chatter},
    session_id: 'sendmessage-quiet-chatter',
  };
  const r = runHook(payload);
  check('3d long status report (no assignment/criteria markers) → no rewrite (empty stdout)',
    r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

// ---------------------------------------------------------------------------
// Part 4 (D057 §5, runbook Phase B1) — absence-claim tripwire tests. See
// docs/prism/plans/2026-07-21-D057-absence-claim-gate-FIX-PLAN.md §3/§4/§5
// and docs/prism/plans/2026-07-21-NEXT-SESSION-EXECUTION-RUNBOOK.md Phase
// B1/B2 for the authoritative spec. RED-PHASE ONLY: hooks/prism-dispatch-
// preamble.mjs and hooks/prism-capture-evidence-guard.mjs are NOT edited by
// this pass (Phase B2, opus, separate commit). The FINAL CLAIM_TRIGGER_RE
// (and PRESENT_RE / SM_ASSIGN_RE / SM_CRITERIA_RE / SM_STATUS_OPEN_RE) are
// imported LIVE via dynamic import below, never copied as string/regex
// literals into this file — a copied literal would keep passing against a
// stale copy even if the shipped hook regressed, proving nothing. Test 6e is
// "the panel's central finding": clause 6's own text must not self-fire the
// regex it ships alongside.
// ---------------------------------------------------------------------------

const CAPTURE_GUARD = join(HOOKS, 'prism-capture-evidence-guard.mjs');
const captureGuardModule = await import(pathToFileURL(CAPTURE_GUARD).href);
const dispatchPreambleModule = await import(pathToFileURL(HOOK).href);

// 6a. clause-6 (absence-is-a-claim) lands on a fresh Agent dispatch.
{
  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  check('6a clause-6 lands: "ABSENCE IS A CLAIM"',
    typeof prompt === 'string' && prompt.includes('ABSENCE IS A CLAIM'), `prompt=${prompt}`);
  check('6a clause-6 lands: "not evidence the source lacks data"',
    typeof prompt === 'string' && prompt.includes('not evidence the source lacks data'), `prompt=${prompt}`);
}

// 6a-bis. clause-5 fold (Chesterton's-fence change discipline) lands INSIDE
// the clause-5 line, not as a stray standalone line.
{
  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  const clause5Line = typeof prompt === 'string' ? (prompt.match(/^5\. KARPATHY[^\n]*$/m) || [])[0] : undefined;
  check('6a-bis clause-5 fold text present somewhere in the prompt',
    typeof prompt === 'string' && prompt.includes('QUOTE the comment saying why it is there'), `prompt=${prompt}`);
  check('6a-bis clause-5 fold text lands INSIDE the "5. KARPATHY" line (not a stray line)',
    typeof clause5Line === 'string' && clause5Line.includes('QUOTE the comment saying why it is there'),
    `clause5Line=${clause5Line}`);
}

// 6b. SendMessage renumber: the holding-string ban becomes clause 7, and
// exactly one line is numbered "6." (the absence clause), not two.
{
  const assignment = [
    'Your task: implement the exponential-backoff retry helper in src/net/retry.mjs.',
    'You are the worker for this unit. Read the existing HTTP client, add retry with',
    'jitter, and cap attempts at five before surfacing the last error to the caller.',
    'Acceptance: the unit tests cover the backoff sequence and the attempt cap.',
    'Deliverables: the helper plus its tests. Done when node tests/net-retry.test.mjs',
    'passes with zero failures and the existing client call sites remain unchanged.',
  ].join(' ');
  const payload = {
    tool_name: 'SendMessage',
    tool_input: {to: 'worker-6b', message: assignment},
    session_id: 'sendmessage-6b-renumber-test',
  };
  const r = runHook(payload);
  const {message} = r;
  check('6b SendMessage renumber: holding-string ban is clause 7 (\'\\n7. \' + HOLDING_STRING_BAN)',
    typeof message === 'string' && message.includes('\n7. ' + HOLDING_STRING_BAN), `message=${message}`);
  check('6b SendMessage renumber: exactly one line numbered "6. "',
    typeof message === 'string' && (message.match(/^6\. /gm) || []).length === 1, `message=${message}`);
  check('6b SendMessage renumber: clause 6 is the absence-is-a-claim clause',
    typeof message === 'string' && /^6\. ABSENCE IS A CLAIM/m.test(message), `message=${message}`);
}

// 6c. idempotency with the new footer — guards P9 (PRESENT_RE unchanged).
{
  const first = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const second = runHook(
    {...AGENT_PAYLOAD, tool_input: {...AGENT_PAYLOAD.tool_input, prompt: first.prompt}},
    {PRISM_ANTI_NESTING_INJECT: 'off'}
  );
  check('6c idempotency: tag appears exactly once on the 6a-augmented prompt',
    typeof first.prompt === 'string' && (first.prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 1,
    `first.prompt=${first.prompt}`);
  check('6c idempotency: "ABSENCE IS A CLAIM" appears exactly once on the 6a-augmented prompt',
    typeof first.prompt === 'string' && (first.prompt.match(/ABSENCE IS A CLAIM/g) || []).length === 1,
    `first.prompt=${first.prompt}`);
  check('6c idempotency: re-running the hook on the already-augmented prompt is a no-op',
    second.exit === 0 && second.stdout === '', `stdout=${second.stdout}`);
}

// 6e. THE PANEL'S CENTRAL FINDING — the SHIPPED CLAIM_TRIGGER_RE (imported
// live from hooks/prism-capture-evidence-guard.mjs, never copied) must NOT
// match clause 6's text, clause 5's text, or the whole rendered FOOTER; the
// clause text must also stay clean against PRESENT_RE / SM_ASSIGN_RE /
// SM_CRITERIA_RE / SM_STATUS_OPEN_RE (all imported live from
// hooks/prism-dispatch-preamble.mjs).
{
  const LIVE_CLAIM_TRIGGER_RE = captureGuardModule.CLAIM_TRIGGER_RE;
  const LIVE_PRESENT_RE = dispatchPreambleModule.PRESENT_RE;
  const LIVE_SM_ASSIGN_RE = dispatchPreambleModule.SM_ASSIGN_RE;
  const LIVE_SM_CRITERIA_RE = dispatchPreambleModule.SM_CRITERIA_RE;
  const LIVE_SM_STATUS_OPEN_RE = dispatchPreambleModule.SM_STATUS_OPEN_RE;

  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  const clause6Line = typeof prompt === 'string' ? (prompt.match(/^6\. [^\n]*$/m) || [])[0] : undefined;
  const clause5Line = typeof prompt === 'string' ? (prompt.match(/^5\. KARPATHY[^\n]*$/m) || [])[0] : undefined;

  function cleanAgainst(re, str, label) {
    const isRe = re instanceof RegExp;
    const hasStr = typeof str === 'string';
    check(label,
      isRe && hasStr && re.test(str) === false,
      !isRe ? 'regex not exported live (undefined) -- cannot verify'
        : !hasStr ? 'target string not present (clause missing from rendered FOOTER)'
        : `matched: ${str}`);
  }

  cleanAgainst(LIVE_CLAIM_TRIGGER_RE, clause6Line, '6e CLAIM_TRIGGER_RE (live) does NOT match the shipped clause-6 string');
  cleanAgainst(LIVE_CLAIM_TRIGGER_RE, clause5Line, '6e CLAIM_TRIGGER_RE (live) does NOT match the shipped clause-5 string');
  cleanAgainst(LIVE_CLAIM_TRIGGER_RE, prompt, '6e CLAIM_TRIGGER_RE (live) does NOT match the whole rendered FOOTER');
  // PRESENT_RE detects the `[PRISM dispatch-preamble]` tag, which the whole
  // augmented prompt contains BY CONSTRUCTION -- passing `prompt` here made
  // the assertion unsatisfiable. Per the runbook's row-5 spec it is the
  // CLAUSE TEXT that must stay clean against PRESENT_RE, not the whole prompt.
  cleanAgainst(LIVE_PRESENT_RE, clause6Line, '6e clause text stays clean against PRESENT_RE (live)');
  cleanAgainst(LIVE_SM_ASSIGN_RE, prompt, '6e clause text stays clean against SM_ASSIGN_RE (live)');
  cleanAgainst(LIVE_SM_CRITERIA_RE, prompt, '6e clause text stays clean against SM_CRITERIA_RE (live)');
  cleanAgainst(LIVE_SM_STATUS_OPEN_RE, prompt, '6e clause text stays clean against SM_STATUS_OPEN_RE (live)');
}

// 6f. FOOTER budget — <=6 numbered clauses, <=1100 chars. Composed with a
// presence check for the new clause: a footer that HASN'T grown yet
// trivially satisfies "<=6 clauses" for the wrong reason, so this test also
// requires clause 6 to actually be present (anti-tautology).
{
  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  const original = AGENT_PAYLOAD.tool_input.prompt;
  const footerOnly = typeof prompt === 'string' && prompt.startsWith(original)
    ? prompt.slice(original.length + 1) : undefined;
  const numberedClauses = typeof footerOnly === 'string' ? (footerOnly.match(/^\d+\. /gm) || []).length : -1;
  const footerChars = typeof footerOnly === 'string' ? footerOnly.length : -1;
  check('6f FOOTER budget: clause 6 (ABSENCE IS A CLAIM) actually present',
    typeof footerOnly === 'string' && footerOnly.includes('ABSENCE IS A CLAIM'),
    `footerOnly=${footerOnly}`);
  check(`6f FOOTER budget: <=6 numbered clauses (measured ${numberedClauses})`,
    numberedClauses >= 0 && numberedClauses <= 6, `numberedClauses=${numberedClauses}`);
  check(`6f FOOTER budget: <=1100 chars (measured ${footerChars})`,
    footerChars >= 0 && footerChars <= 1100, `footerChars=${footerChars}`);
}

// 6d. NEGATIVE CONTROL — existing 1a/1b/1c must stay green throughout Part
// B. 1a's clause-5 assertion (above) is an includes(), not an equality, so
// it survives clause 5 gaining an appended sentence (T2) — verified by
// reading the source, not assumed.
{
  const r = runHook(AGENT_PAYLOAD, {PRISM_ANTI_NESTING_INJECT: 'off'});
  const {prompt} = r;
  check('6d NEGATIVE CONTROL: clause 1 (WRITE YOUR OUTPUT TO DISK) still present',
    typeof prompt === 'string' && prompt.includes('WRITE YOUR OUTPUT TO DISK'), `prompt=${prompt}`);
  check('6d NEGATIVE CONTROL: clause 5 (KARPATHY DISCIPLINE) still present via includes(), not equality',
    typeof prompt === 'string' && prompt.includes('KARPATHY DISCIPLINE: make surgical, minimal changes'), `prompt=${prompt}`);
  check('6d NEGATIVE CONTROL: dispatch-preamble tag still appears exactly once',
    typeof prompt === 'string' && (prompt.match(/\[PRISM dispatch-preamble\]/g) || []).length === 1, `prompt=${prompt}`);
}
{
  const r = runHook({tool_name: 'Bash', tool_input: {command: 'ls'}});
  check('6d NEGATIVE CONTROL: non-Agent tool still no-ops (1b unaffected)', r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}
{
  const r = runHook({tool_name: 'Agent', tool_input: {prompt: '   '}});
  check('6d NEGATIVE CONTROL: empty prompt still no-ops (1c unaffected)', r.exit === 0 && r.stdout === '', `stdout=${r.stdout}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
