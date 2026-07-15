#!/usr/bin/env node
// PRISM 6.0.0 ROUTINE SINGLE-PASS — end-to-end integration test
//
// Drives the REAL dispatcher scripts via subprocess (same wire protocol Claude Code uses).
// Tests four critical integration paths:
//   (a) ROUTINE classify: UserPromptSubmit → sentinel has routine_bypass=true, dispatch_count=0,
//       additionalContext contains "ROUTINE single-pass"
//   (b) GATE wiring: PreToolUse Agent on a routine sentinel that already dispatched ~30s ago
//       → soft mode: advisory nudge, exit 0, single_pass_nudged flips true
//       → enforce mode: deny JSON, exit 2
//   (c) FIRST dispatch passes; same-message sibling (in batch window) passes
//   (d) NOVEL (opus) classification → no single-pass directive in additionalContext, gate does not fire
//
// Harness: subprocess spawnSync, no internal imports, dep-free.
// Cleanup: all temp sentinel files are removed in finally{} blocks.
//
// Run: node tests/v3/state/test-prism-routine-single-pass-e2e.mjs

import {spawnSync}  from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync
} from 'node:fs';
import {tmpdir}      from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO      = join(__dirname, '..', '..', '..');
const UPS_DISP  = join(REPO, 'hooks', 'prism-userpromptsubmit-dispatcher.mjs');
const PTU_DISP  = join(REPO, 'hooks', 'prism-pretooluse-dispatcher.mjs');

// ── Helpers ──────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/**
 * Create an isolated temp HOME dir (with .claude/ inside).
 * Returns the path; caller must rmSync it in a finally{}.
 */
function makeFakeHome(label) {
  const h = mkdtempSync(join(tmpdir(), `prism-rsp-${label}-`));
  mkdirSync(join(h, '.claude'), {recursive: true});
  return h;
}

/** Compute the sentinel file path exactly as the hooks do. */
function sentinelPath(home, sessionId) {
  return join(home, '.claude', `.prism-turn-tier-${sessionId}.json`);
}

/**
 * Write a sentinel file directly (for pre-seeding GATE tests).
 */
function writeSentinel(home, sessionId, obj) {
  const p = sentinelPath(home, sessionId);
  mkdirSync(dirname(p), {recursive: true});
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

/**
 * Read the sentinel file (or null if absent/invalid).
 */
function readSentinel(home, sessionId) {
  const p = sentinelPath(home, sessionId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

/**
 * Invoke the UserPromptSubmit dispatcher as a subprocess.
 * Returns {status, stdout, stderr, sentinel}.
 */
function runUPS(fakeHome, sessionId, prompt, extraEnv = {}) {
  const payload = JSON.stringify({
    session_id: sessionId,
    prompt,
    cwd: REPO,
  });
  const r = spawnSync(process.execPath, [UPS_DISP], {
    input: payload,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      PRISM_PROMPT_ROUTER: 'hard',
      // Suppress noisy notices that are not under test
      PRISM_DISABLE_FRESHNESS_SWEEP: '1',
      PRISM_DISABLE_PARALLEL_REMINDER: '1',
      PRISM_DISABLE_CLAUDE_MEM_GUARD: '1',
      PRISM_DISABLE_KNOWLEDGE_DELTA: '1',
      PRISM_DISABLE_ACL_NOTIFY: '1',
      ...extraEnv,
    },
  });
  const sentinel = readSentinel(fakeHome, sessionId);
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', sentinel};
}

/**
 * Invoke the PreToolUse dispatcher as a subprocess for an Agent call.
 * Returns {status, stdout, stderr, sentinel}.
 *
 * Default env: PRISM_DISPATCH_GUARD=soft so the guard body RUNS (not off-early-exit),
 * PRISM_NESTED_DISPATCH_GUARD=off so the nested-dispatch guard doesn't interfere
 * (tests run in parent context without parent_tool_use_id), and
 * PRISM_ROUTINE_SINGLE_PASS=soft (overridden per test).
 */
function runPTU(fakeHome, sessionId, toolInput = {}, extraEnv = {}) {
  const payload = JSON.stringify({
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'general-purpose',
      model: 'haiku',
      prompt: 'do the task',
      ...toolInput,
    },
  });
  const r = spawnSync(process.execPath, [PTU_DISP], {
    input: payload,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // Keep PRISM_DISPATCH_GUARD=soft (not off) so the guard body executes and
      // the RSP gate is reachable. The sentinel already has dispatched=true for
      // re-dispatch tests, so the main routine-dispatch deny never fires — only
      // the RSP gate can emit. For the first-dispatch test the sentinel has
      // dispatched=false, so the guard would normally deny the Agent call; but the
      // sentinel is already pre-seeded and the guard flips dispatched=true, then
      // returns done(0) on the ALWAYS_ALLOW path.
      PRISM_DISPATCH_GUARD: 'soft',
      // Disable the nested-dispatch guard (it would fire because the test has no
      // parent_tool_use_id and CLAUDE_CODE_ENTRYPOINT is not set to 'subagent').
      // The nested guard is orthogonal to RSP and has its own test coverage.
      PRISM_NESTED_DISPATCH_GUARD: 'off',
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
      ...extraEnv,
    },
  });
  const sentinel = readSentinel(fakeHome, sessionId);
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', sentinel};
}

/**
 * Parse the additionalContext string from dispatcher stdout.
 * Returns the concatenated text (may contain multiple JSON blobs joined by \n).
 */
function extractAdditionalContext(raw) {
  // The dispatcher emits one JSON per hook, joined with '\n'.
  // Collect all additionalContext strings.
  const parts = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      const ctx =
        obj?.hookSpecificOutput?.additionalContext ||
        obj?.additionalContext;
      if (ctx) parts.push(ctx);
    } catch {}
  }
  return parts.join('\n');
}

/**
 * Parse permissionDecision from PTU dispatcher stdout.
 */
function extractDecision(raw) {
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      const pd = obj?.hookSpecificOutput?.permissionDecision;
      if (pd) return pd;
    } catch {}
  }
  return null;
}

// ── STEP LIST (printed at start per task requirements) ────────────────────────
process.stdout.write(`
PRISM 6.0.0 Routine Single-Pass — E2E Integration Test
=======================================================
Steps:
  (a) ROUTINE classify: UserPromptSubmit → sentinel.routine_bypass=true,
      dispatch_count=0, additionalContext contains "ROUTINE single-pass"
  (b) GATE wiring (soft): routine sentinel, already dispatched ~30s ago,
      single_pass_nudged unset → advisory emitted, exit 0, single_pass_nudged=true
      GATE wiring (enforce): same → deny JSON, exit 2
  (c) FIRST dispatch passes (no nudge); batch-window sibling passes (no nudge)
  (d) NOVEL (opus): additionalContext does NOT contain single-pass directive,
      gate does not fire
=======================================================

`);

// ── (a) ROUTINE classify via real UserPromptSubmit dispatcher ────────────────
{
  const SID  = `rsp-e2e-a-${Date.now()}`;
  const home = makeFakeHome('a');
  try {
    const prompt = 'rename the variable myVar to myVariable in foo.js';
    const r = runUPS(home, SID, prompt);

    test('(a) UPS dispatcher exits 0', () => {
      assert(r.status === 0, `exit=${r.status} stderr=${r.stderr.slice(0,300)}`);
    });

    test('(a) sentinel written', () => {
      assert(r.sentinel !== null, `no sentinel at ${sentinelPath(home, SID)}`);
    });

    test('(a) sentinel.routine_bypass === true (haiku or sonnet tier, no force_opus)', () => {
      const s = r.sentinel;
      assert(s !== null, 'sentinel is null');
      // routine_bypass = (tier==='haiku'||tier==='sonnet') && !force_opus
      assert(
        s.routine_bypass === true,
        `routine_bypass=${s.routine_bypass} tier=${s.tier} force_opus=${s.force_opus}`
      );
    });

    test('(a) sentinel.dispatch_count === 0 (reset on new turn)', () => {
      assert(r.sentinel !== null, 'sentinel is null');
      assert(
        r.sentinel.dispatch_count === 0,
        `dispatch_count=${r.sentinel.dispatch_count}`
      );
    });

    test('(a) sentinel.tier is haiku or sonnet (routine classification)', () => {
      const s = r.sentinel;
      assert(
        s.tier === 'haiku' || s.tier === 'sonnet',
        `expected haiku or sonnet, got tier=${s.tier}`
      );
    });

    test('(a) additionalContext contains "ROUTINE single-pass" directive', () => {
      const ctx = extractAdditionalContext(r.stdout);
      assert(
        ctx.includes('ROUTINE single-pass'),
        `additionalContext does not contain "ROUTINE single-pass".\nctx=${ctx.slice(0,500)}`
      );
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── (b) GATE wiring: soft mode ───────────────────────────────────────────────
{
  const SID  = `rsp-e2e-b-soft-${Date.now()}`;
  const home = makeFakeHome('b-soft');
  try {
    // Pre-seed sentinel: routine turn, already dispatched 30s ago, nudge not yet set.
    const pastTs = new Date(Date.now() - 30_000).toISOString();
    writeSentinel(home, SID, {
      ts: new Date().toISOString(),
      tier: 'haiku',
      score: 0, h: 0, s: 0, o: 0, compound: false,
      force_opus: false,
      force_gp: false,
      dispatched: true,
      dispatched_ts: pastTs,           // 30s ago — outside batch window (8s)
      single_pass_nudged: false,       // not yet nudged
      summon_panel: false,
      routine_bypass: true,
      dispatch_count: 0,
      rationale: 'test sentinel',
      source: 'keyword-floor',
    });

    const r = runPTU(home, SID, {}, {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });

    test('(b-soft) PTU dispatcher exits 0 in soft mode (no block)', () => {
      assert(r.status === 0, `exit=${r.status} stdout=${r.stdout.slice(0,300)} stderr=${r.stderr.slice(0,200)}`);
    });

    test('(b-soft) permissionDecision is NOT deny in soft mode', () => {
      const d = extractDecision(r.stdout);
      assert(d !== 'deny', `got permissionDecision=${d} stdout=${r.stdout.slice(0,300)}`);
    });

    test('(b-soft) advisory nudge text present in output', () => {
      const all = r.stdout + r.stderr;
      assert(
        all.includes('PRISM ROUTINE SINGLE-PASS') || all.includes('routine single-pass') || all.includes('ROUTINE SINGLE-PASS'),
        `nudge text not found. stdout=${r.stdout.slice(0,400)}`
      );
    });

    test('(b-soft) sentinel.single_pass_nudged flipped to true', () => {
      const s = readSentinel(home, SID);
      assert(s !== null, 'sentinel missing after PTU run');
      assert(
        s.single_pass_nudged === true,
        `single_pass_nudged=${s.single_pass_nudged}`
      );
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── (b) GATE wiring: enforce mode ────────────────────────────────────────────
{
  const SID  = `rsp-e2e-b-enf-${Date.now()}`;
  const home = makeFakeHome('b-enf');
  try {
    const pastTs = new Date(Date.now() - 30_000).toISOString();
    writeSentinel(home, SID, {
      ts: new Date().toISOString(),
      tier: 'sonnet',
      score: 0, h: 0, s: 0, o: 0, compound: false,
      force_opus: false,
      force_gp: false,
      dispatched: true,
      dispatched_ts: pastTs,
      single_pass_nudged: false,
      summon_panel: false,
      routine_bypass: true,
      dispatch_count: 0,
      rationale: 'test sentinel',
      source: 'keyword-floor',
    });

    const r = runPTU(home, SID, {}, {
      PRISM_ROUTINE_SINGLE_PASS: 'enforce',
    });

    test('(b-enforce) PTU dispatcher exits 2 (deny) in enforce mode', () => {
      assert(r.status === 2, `exit=${r.status} stdout=${r.stdout.slice(0,300)}`);
    });

    test('(b-enforce) permissionDecision is "deny"', () => {
      const d = extractDecision(r.stdout);
      assert(d === 'deny', `got permissionDecision=${d} stdout=${r.stdout.slice(0,400)}`);
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── (c) FIRST dispatch passes (no nudge) ─────────────────────────────────────
{
  const SID  = `rsp-e2e-c-first-${Date.now()}`;
  const home = makeFakeHome('c-first');
  try {
    // Sentinel: routine, NOT yet dispatched.
    writeSentinel(home, SID, {
      ts: new Date().toISOString(),
      tier: 'haiku',
      score: 0, h: 0, s: 0, o: 0, compound: false,
      force_opus: false,
      force_gp: false,
      dispatched: false,        // first dispatch has NOT happened yet
      dispatched_ts: null,
      single_pass_nudged: false,
      summon_panel: false,
      routine_bypass: true,
      dispatch_count: 0,
      rationale: 'test sentinel',
      source: 'keyword-floor',
    });

    const r = runPTU(home, SID, {}, {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });

    test('(c-first) first Agent dispatch exits 0 (passes)', () => {
      assert(r.status === 0, `exit=${r.status} stdout=${r.stdout.slice(0,300)}`);
    });

    test('(c-first) no deny on first dispatch', () => {
      const d = extractDecision(r.stdout);
      assert(d !== 'deny', `unexpected deny: stdout=${r.stdout.slice(0,300)}`);
    });

    test('(c-first) no RSP nudge on first dispatch', () => {
      const all = r.stdout + r.stderr;
      // The single-pass nudge must NOT fire on the very first dispatch
      assert(
        !all.includes('PRISM ROUTINE SINGLE-PASS'),
        `RSP nudge fired on first dispatch. stdout=${r.stdout.slice(0,400)}`
      );
    });

    test('(c-first) sentinel.dispatched set to true after first dispatch', () => {
      const s = readSentinel(home, SID);
      assert(s !== null, 'sentinel missing');
      assert(s.dispatched === true, `dispatched=${s.dispatched}`);
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── (c) Batch-window sibling passes (no nudge) ───────────────────────────────
{
  const SID  = `rsp-e2e-c-batch-${Date.now()}`;
  const home = makeFakeHome('c-batch');
  try {
    // Sentinel: dispatched just NOW (within batch window).
    const nowTs = new Date().toISOString();
    writeSentinel(home, SID, {
      ts: new Date().toISOString(),
      tier: 'sonnet',
      score: 0, h: 0, s: 0, o: 0, compound: false,
      force_opus: false,
      force_gp: false,
      dispatched: true,
      dispatched_ts: nowTs,      // dispatched RIGHT NOW → inside 8s batch window
      single_pass_nudged: false,
      summon_panel: false,
      routine_bypass: true,
      dispatch_count: 0,
      rationale: 'test sentinel',
      source: 'keyword-floor',
    });

    const r = runPTU(home, SID, {}, {
      PRISM_ROUTINE_SINGLE_PASS: 'soft',
    });

    test('(c-batch) same-message sibling (in batch window) exits 0', () => {
      assert(r.status === 0, `exit=${r.status} stdout=${r.stdout.slice(0,300)}`);
    });

    test('(c-batch) no RSP nudge inside batch window', () => {
      const all = r.stdout + r.stderr;
      assert(
        !all.includes('PRISM ROUTINE SINGLE-PASS'),
        `RSP nudge fired inside batch window (${nowTs}). stdout=${r.stdout.slice(0,400)}`
      );
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── (d) NOVEL (opus) tier: no single-pass directive; gate does not fire ───────
{
  const SID  = `rsp-e2e-d-${Date.now()}`;
  const home = makeFakeHome('d');
  try {
    // Use a panel-class prompt that forces opus tier. Pad to clear PANEL_MIN_WORDS (50).
    const opusPrompt = [
      'design a multi-region rate limiter with per-tenant fairness and dynamic backpressure,',
      'including a phased migration strategy, circuit-breaker integration, observability hooks,',
      'per-region quota enforcement, cross-region replication of limit state,',
      'and a detailed rollout and rollback plan for production deployment',
    ].join(' ');

    const r = runUPS(home, SID, opusPrompt);

    test('(d) UPS dispatcher exits 0 on opus prompt', () => {
      assert(r.status === 0, `exit=${r.status} stderr=${r.stderr.slice(0,300)}`);
    });

    test('(d) sentinel.tier is opus for novel prompt', () => {
      const s = r.sentinel;
      assert(s !== null, 'no sentinel written');
      assert(s.tier === 'opus', `expected tier=opus, got=${s.tier}`);
    });

    test('(d) sentinel.routine_bypass === false for opus tier', () => {
      const s = r.sentinel;
      assert(s !== null, 'no sentinel written');
      assert(
        s.routine_bypass === false,
        `routine_bypass=${s.routine_bypass} (should be false for opus)`
      );
    });

    test('(d) additionalContext does NOT contain "ROUTINE single-pass" on opus tier', () => {
      const ctx = extractAdditionalContext(r.stdout);
      assert(
        !ctx.includes('ROUTINE single-pass'),
        `"ROUTINE single-pass" found in opus additionalContext.\nctx=${ctx.slice(0,600)}`
      );
    });

    // Gate: seed an opus sentinel (dispatched, outside batch window) and verify
    // the RSP gate does NOT fire (routine_bypass=false guards it).
    {
      const pastTs = new Date(Date.now() - 30_000).toISOString();
      // Overwrite the sentinel with opus, dispatched.
      writeSentinel(home, SID, {
        ts: new Date().toISOString(),
        tier: 'opus',
        score: 0, h: 0, s: 0, o: 0, compound: false,
        force_opus: false,
        force_gp: false,
        dispatched: true,
        dispatched_ts: pastTs,
        single_pass_nudged: false,
        summon_panel: false,
        routine_bypass: false,   // ← key: opus tier → no RSP gate
        dispatch_count: 0,
        orchestrator_dispatched: true,  // so panel gate does not fire
        rationale: 'test opus sentinel',
        source: 'keyword-floor',
      });

      const r2 = runPTU(home, SID, {}, {
        PRISM_ROUTINE_SINGLE_PASS: 'soft',
      });

      test('(d) opus tier: re-dispatch Agent exits 0 (RSP gate does not fire)', () => {
        assert(r2.status === 0, `exit=${r2.status} stdout=${r2.stdout.slice(0,300)}`);
      });

      test('(d) opus tier: no RSP nudge in output', () => {
        const all = r2.stdout + r2.stderr;
        assert(
          !all.includes('PRISM ROUTINE SINGLE-PASS'),
          `RSP gate fired on opus tier. stdout=${r2.stdout.slice(0,400)}`
        );
      });
    }
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n${pass} passed, ${fail} failed (${pass + fail} total)\n`);
process.exit(fail > 0 ? 1 : 0);
