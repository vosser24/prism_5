#!/usr/bin/env node
// PRISM Dispatch Dedup Guard (v1.0.0) — PreToolUse:Agent + SubagentStop
//
// PROBLEM: dispatching the SAME task while a previous IDENTICAL dispatch is still
// in-flight burns budget and confuses the tree (the "double-burn" pattern where a
// confused orchestrator re-queues work that is already running). This guard BLOCKS
// an EXACT-signature duplicate (same subagent_type + description + first ~400 chars
// of prompt) that is still OPEN. It is deliberately narrow: genuine near-duplicate
// scope (different wording, overlapping intent) is out of scope here — this fence
// is exact-re-dispatch only.
//
// TOPOLOGY — composes via the in-process dispatchers, NO new settings.json entry:
//   • PreToolUse:Agent  → run(payload):
//       Compute a task signature. If an OPEN, non-expired entry with the same
//       signature exists → DENY (exit 2) naming the in-flight task. Else append
//       {signature, subagent_type, description, ts, status:'open'} and exit 0.
//       Added to the dispatcher's Agent ROUTE (most-restrictive-wins merge).
//   • SubagentStop      → runSubagentStop(payload):
//       Mark the matching OPEN entry status:'done'. SubagentStop carries
//       agent_name/agent (the subagent_type) and session_id but NOT the
//       description/prompt/signature (verified against the live routing log and
//       prism-subagent-stop.mjs), so we can only correlate by subagent_type +
//       FIFO (oldest open entry of that type). Added to the SubagentStop
//       dispatcher set.
//
// COMPLETION-EVENT REALITY (verified):
//   The Agent tool returns IMMEDIATELY ("Async agent launched") for async agents,
//   so PostToolUse:Agent is NOT true completion. SubagentStop DOES fire at real
//   completion (it carries session_id + the subagent identity), but the payload
//   lacks the dispatch signature, so the clear is FIFO-by-type and IMPERFECT.
//   Therefore the TTL SAFETY-NET is load-bearing: any OPEN entry auto-expires
//   after 12 minutes (longer than the planned 10-min watchdog window) so a missed
//   clear can NEVER permanently wedge dispatch.
//
// THE #1 INVARIANT — FAIL OPEN. Every path swallows its own errors and returns
// exit 0 (allow) on any failure. Only an exact, OPEN, non-expired signature match
// in hard mode returns exit 2.
//
// MODE (PRISM_DISPATCH_DEDUP env var, default hard):
//   hard (default) — exact in-flight duplicate is DENIED (exit 2).
//   soft           — advisory additionalContext only; exit 0 (still bookkeeps).
//   off            — pass-through, but still records the dispatch so the ledger
//                    stays truthful for re-enable.

import {
  readFileSync, writeFileSync, existsSync, renameSync, mkdirSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { renameWithRetry } from '../tools/lib/atomic-fs.mjs';
import { createHash } from 'node:crypto';
import { prismHome } from './lib/prism-home.mjs';
import { withRosterLock } from '../tools/lib/prism-roster-lock.mjs';

// 12 min — deliberately LONGER than the planned 10-min external watchdog window
// so a missed SubagentStop clear self-heals before it can wedge a real dispatch,
// yet a genuinely-stuck duplicate is caught while still relevant.
// Override: PRISM_DISPATCH_DEDUP_TTL_MS (integer ms, clamped 30s..1h).
function ttlMs(env = process.env) {
  const raw = env.PRISM_DISPATCH_DEDUP_TTL_MS;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (n >= 30000 && n <= 3600000) return n;
  }
  return 12 * 60000;
}

function mode(env = process.env) {
  return String(env.PRISM_DISPATCH_DEDUP ?? 'hard').toLowerCase();
}

function ledgerPath(sessionId) {
  return join(prismHome(), '.claude', `.prism-inflight-dispatches-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

function atomicWrite(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    const body = JSON.stringify(obj, null, 2);
    writeFileSync(tmp, body);
    try {
      renameWithRetry(renameSync, tmp, path);
    } catch (renameErr) {
      try {
        writeFileSync(path, body);
        appendLog({event: 'dispatch_dedup_ledger_write', status: 'atomic_failed_fallback_ok',
          error_code: (renameErr && renameErr.code) || null});
      } catch (fallbackErr) {
        appendLog({event: 'dispatch_dedup_ledger_write', status: 'write_failed',
          error_code: (fallbackErr && fallbackErr.code) || null});
      }
    }
  } catch { /* fail-open */ }
}

// Normalize a string for stable signature hashing: lowercase, collapse
// whitespace, trim. Stable across trivial rephrasings of whitespace/quoting but
// NOT across genuine wording changes (that's intentional — this guard targets
// EXACT re-dispatch).
function norm(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// signature = sha1(subagent_type | description | first 400 chars of prompt).
export function signatureOf(target, description, prompt) {
  const t = norm(target || 'general-purpose');
  const d = norm(description || '');
  const p = norm(prompt || '').slice(0, 400);
  return createHash('sha1').update(`${t} ${d} ${p}`).digest('hex').slice(0, 16);
}

function extract(payload) {
  const ti = (payload && payload.tool_input) || {};
  const target = String(ti.subagent_type || ti.agent_type || 'general-purpose');
  const description = String(ti.description || '');
  const prompt = String(ti.prompt || '');
  return { target, description, prompt };
}

function inSubagentContext(payload, env = process.env) {
  if (payload && payload.parent_tool_use_id) return true;
  if (String(env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent') return true;
  return false;
}

// Read the ledger, TTL-sweeping expired/done entries on every read. An entry is
// "live" (counts as in-flight) only if status==='open' AND not past TTL. Stale
// open entries (missed SubagentStop) are demoted out so they cannot block.
// Self-heals: if the sweep changed anything, the pruned ledger is written back.
function readLedger(sessionId, now, env) {
  const p = ledgerPath(sessionId);
  let entries = [];
  try {
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch { return []; }
  const ttl = ttlMs(env);
  // Keep an entry in the file only if it's a fresh, still-relevant record.
  // Drop: malformed, or older than TTL (whether open or done — done entries are
  // historical noise after TTL). This keeps the file bounded.
  const kept = entries.filter(e => {
    if (!e || typeof e.ts !== 'string' || !e.signature) return false;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return false;
    return (now - t) < ttl;
  });
  if (kept.length !== entries.length) atomicWrite(p, kept);
  return kept;
}

function openMatch(entries, signature, now, env) {
  const ttl = ttlMs(env);
  return entries.find(e =>
    e.signature === signature &&
    e.status === 'open' &&
    !Number.isNaN(Date.parse(e.ts)) &&
    (now - Date.parse(e.ts)) < ttl
  ) || null;
}

// ── PreToolUse:Agent — dedup check + record ──────────────────────────────────
export async function run(payload, env = process.env) {
  const done = (exit, stdout = '', stderr = '') => ({ exit, stdout, stderr });
  try {
    if (payload && payload.tool_name && payload.tool_name !== 'Agent') return done(0);
    // A dispatch from inside a subagent is governed by the nested-dispatch guard.
    if (inSubagentContext(payload, env)) return done(0);

    const m = mode(env);
    const sessionId = (payload && payload.session_id) || 'anon';
    const { target, description, prompt } = extract(payload);
    const signature = signatureOf(target, description, prompt);
    const now = Date.now();
    const p = ledgerPath(sessionId);

    let existing = null;
    // Locked read-modify-write so a concurrent SubagentStop clear can't race the
    // add and leave a ghost (or double-record).
    try {
      await withRosterLock(p, async () => {
        const entries = readLedger(sessionId, now, env);
        existing = openMatch(entries, signature, now, env);
        if (existing && m !== 'off') {
          // Do NOT add a second record — leave the in-flight entry as the sole
          // open record. (In off mode we fall through to record below.)
          return;
        }
        // Record this dispatch as open. In off mode this still runs (truthful
        // ledger for re-enable), but `existing` is also recorded so we don't
        // block.
        entries.push({
          signature,
          subagent_type: target,
          description: (description || prompt).slice(0, 240),
          ts: new Date(now).toISOString(),
          status: 'open',
        });
        atomicWrite(p, entries);
      });
    } catch { /* fail-open: no tracking for this dispatch */ }

    const isDuplicate = !!existing && m !== 'off';

    appendLog({
      event: 'dispatch_dedup_guard',
      ts: new Date(now).toISOString(),
      session_id: sessionId,
      target,
      signature,
      duplicate: isDuplicate,
      blocked: !!(isDuplicate && m === 'hard'),
      mode: m,
    });

    if (!isDuplicate) return done(0);

    const ageS = Math.round((now - Date.parse(existing.ts)) / 1000);
    const liveDesc = String(existing.description || '').slice(0, 160);
    const notice = [
      `PRISM DISPATCH-DEDUP: an IDENTICAL dispatch is still IN-FLIGHT`,
      `  • in-flight: subagent_type=${existing.subagent_type} age=${ageS}s`,
      `  • in-flight task: "${liveDesc}${liveDesc.length >= 160 ? '…' : ''}"`,
      `  • your new dispatch has the SAME task signature.`,
      ``,
      `Do NOT re-dispatch identical work. Either:`,
      `  1. WAIT for the in-flight agent to finish (it clears at SubagentStop).`,
      `  2. SendMessage the live agent to check status / steer it.`,
      `  3. If you have CONFIRMED it is genuinely done/stuck, the entry auto-expires`,
      `     after the TTL (12 min) and you may re-dispatch then.`,
      `Override: PRISM_DISPATCH_DEDUP=soft (advisory) or =off (pass-through).`,
    ].join('\n');

    if (m === 'hard') {
      return done(2, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: notice,
        },
      }), notice);
    }
    // soft mode: advisory only.
    return done(0, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
    }));
  } catch {
    return done(0); // FAIL OPEN.
  }
}

// ── SubagentStop — mark the matching OPEN entry done ──────────────────────────
// SubagentStop lacks the signature, so we close the OLDEST open entry whose
// subagent_type matches. Imperfect by design; the TTL sweep is the real backstop.
export async function runSubagentStop(payload, env = process.env) {
  const done = (exit = 0, stdout = '', stderr = '') => ({ exit, stdout, stderr });
  try {
    const sessionId = (payload && payload.session_id) || 'anon';
    const target = norm(String(
      (payload && (payload.agent_name || payload.agent || payload.subagent_type)) || ''
    ).replace(/^@/, '') || 'general-purpose');
    const p = ledgerPath(sessionId);
    let closedSig = null;
    try {
      await withRosterLock(p, async () => {
        const entries = readLedger(sessionId, Date.now(), env);
        // oldest open entry of this type
        const open = entries
          .filter(e => e.status === 'open' && norm(e.subagent_type) === target)
          .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const victim = open[0];
        if (victim) {
          victim.status = 'done';
          victim.closed_ts = new Date().toISOString();
          closedSig = victim.signature;
          atomicWrite(p, entries);
        }
      });
    } catch { /* fail-open */ }
    appendLog({
      event: 'dispatch_dedup_close',
      ts: new Date().toISOString(),
      session_id: sessionId,
      target,
      closed_signature: closedSig,
    });
    return done(0);
  } catch {
    return done(0);
  }
}

// Standalone shim (parity with sibling guards; lets the file run directly for tests).
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-dispatch-dedup-guard.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
    try {
      const isStop = (payload.hook_event_name === 'SubagentStop');
      const r = isStop ? await runSubagentStop(payload) : await run(payload);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.exit || 0);
    } catch { process.exit(0); }
  })();
}
