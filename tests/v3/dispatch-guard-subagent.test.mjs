#!/usr/bin/env node
// Package F (v2.6.0) — regression harness for the dispatch-guard dead-end
// false-positive that blocked legitimately-dispatched research subagents.
//
// Spawns hooks/prism-parent-dispatch-guard.mjs via child_process, feeds synthetic
// PreToolUse stdin payloads, and asserts allow vs deny by parsing the hook's
// exit code + JSON/stderr output.
//
// Cases:
//   1. SUBAGENT WebFetch                          -> ALLOWED (read-only exemption)
//   2. SUBAGENT WebSearch                         -> ALLOWED (read-only exemption)
//   3. SUBAGENT Bash (valid subagent signal)      -> ALLOWED (subagent bypass)
//   4. PARENT   WebFetch                          -> ALLOWED (read-only exemption)
//   5. PARENT   Bash, ROUTINE tier, no dispatch   -> DENIED  (core purpose kept)
//   6. PARENT   Edit, ROUTINE tier, no dispatch   -> DENIED  (core purpose kept)
// Plus extra rigor:
//   7. SUBAGENT WebFetch with NO subagent signal  -> ALLOWED (exemption is
//                                                     detection-independent)
//   8. PARENT   WebSearch                         -> ALLOWED (read-only exemption)
//
// Run: node tests/v3/dispatch-guard-subagent.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'prism-parent-dispatch-guard.mjs');

const SID = 'dispatch-guard-subagent-test';

let pass = 0, total = 0;
const check = (label, cond) => {
  total++;
  if (cond) { pass++; console.log('PASS: ' + label); }
  else { console.log('FAIL: ' + label); }
};

// Run the guard against a fresh temp HOME whose sentinel encodes the tier/dispatch
// state for this case. CLAUDE_CODE_ENTRYPOINT is cleared unless a case sets it, so
// ambient env can never make a parent-context case look like a subagent.
function runGuard(payload, { sentinel = {}, env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prism-dgf-home-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const s = {
      tier: 'sonnet', score: 0, force_opus: false,
      dispatched: false, summon_panel: false, orchestrator_dispatched: false,
      ...sentinel,
    };
    writeFileSync(join(home, '.claude', `.prism-turn-tier-${SID}.json`), JSON.stringify(s));
    const childEnv = {
      ...process.env, HOME: home, USERPROFILE: home,
      CLAUDE_CODE_ENTRYPOINT: '', PRISM_DISPATCH_GUARD: 'hard', ...env,
    };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, ...payload }),
      encoding: 'utf-8', env: childEnv, timeout: 10000,
    });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const isDeny = (r) =>
  r.status === 2 ||
  /"permissionDecision"\s*:\s*"deny"/i.test(r.out) ||
  /permissionDecision":"deny/i.test(r.out);
const allowed = (r) => !isDeny(r);
const denied = (r) => isDeny(r);

// ── 1. SUBAGENT WebFetch → ALLOWED ──────────────────────────────────────────
check('SUBAGENT WebFetch -> ALLOWED',
  allowed(runGuard(
    { tool_name: 'WebFetch', parent_tool_use_id: 'p1', tool_input: { url: 'https://example.com' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 2. SUBAGENT WebSearch → ALLOWED ─────────────────────────────────────────
check('SUBAGENT WebSearch -> ALLOWED',
  allowed(runGuard(
    { tool_name: 'WebSearch', parent_tool_use_id: 'p1', tool_input: { query: 'prism dispatch guard' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 3. SUBAGENT Bash (valid subagent signal) → ALLOWED ──────────────────────
// A genuinely MUTATING command (npm run build) so the pass is NOT the read-only
// Bash fast-path — it must be the subagent bypass (parent_tool_use_id). Sentinel
// dispatched=false so sentinel.dispatched cannot be doing the work either.
check('SUBAGENT Bash (parent_tool_use_id) -> ALLOWED',
  allowed(runGuard(
    { tool_name: 'Bash', parent_tool_use_id: 'p1', tool_input: { command: 'npm run build' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 3b. SUBAGENT Bash via CLAUDE_CODE_ENTRYPOINT=subagent → ALLOWED ──────────
check('SUBAGENT Bash (CLAUDE_CODE_ENTRYPOINT=subagent) -> ALLOWED',
  allowed(runGuard(
    { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
    { sentinel: { tier: 'sonnet', dispatched: false }, env: { CLAUDE_CODE_ENTRYPOINT: 'subagent' } })));

// ── 4. PARENT WebFetch → ALLOWED (read-only exemption) ──────────────────────
check('PARENT WebFetch -> ALLOWED (read-only exemption)',
  allowed(runGuard(
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 5. PARENT Bash, ROUTINE tier, no dispatch → DENIED (core purpose kept) ──
check('PARENT Bash (sonnet tier, no dispatch) -> DENIED',
  denied(runGuard(
    { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 6. PARENT Edit, ROUTINE tier, no dispatch → DENIED (core purpose kept) ──
check('PARENT Edit (sonnet tier, no dispatch) -> DENIED',
  denied(runGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 7. SUBAGENT WebFetch, NO subagent signal → ALLOWED (detection-independent) ─
check('WebFetch with NO subagent signal, sonnet no-dispatch -> ALLOWED',
  allowed(runGuard(
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 8. PARENT WebSearch → ALLOWED (read-only exemption) ─────────────────────
check('PARENT WebSearch -> ALLOWED (read-only exemption)',
  allowed(runGuard(
    { tool_name: 'WebSearch', tool_input: { query: 'x' } },
    { sentinel: { tier: 'sonnet', dispatched: false } })));

// ── 9. REGRESSION: PARENT Edit on a PANEL turn still DENIED (gate preserved) ─
check('PARENT Edit on panel turn (opus+summon_panel, no orchestrator) -> DENIED',
  denied(runGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' } },
    { sentinel: { tier: 'opus', summon_panel: true, orchestrator_dispatched: false, dispatched: false } })));

// ── 10. REGRESSION: SUBAGENT WebFetch on a PANEL turn → ALLOWED (the exact bug) ─
check('SUBAGENT WebFetch on panel turn -> ALLOWED (the reported dead-end)',
  allowed(runGuard(
    { tool_name: 'WebFetch', parent_tool_use_id: 'p1', tool_input: { url: 'https://example.com' } },
    { sentinel: { tier: 'opus', summon_panel: true, orchestrator_dispatched: false, dispatched: false } })));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
