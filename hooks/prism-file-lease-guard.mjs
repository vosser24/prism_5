#!/usr/bin/env node
// PRISM File-Ownership Lease (v1.0.0) — PreToolUse:Agent + PreToolUse:SendMessage
//                                        + SubagentStop (lease clear)
//
// PROBLEM (docs/prism/2026-07-14-dispatch-dedup-diagnosis.md, SECOND HALF): two
// concurrent agents editing the same file collide silently. Per-caller identity
// is NOT in the tool payload (the runtime withholds it), so edits cannot be
// attributed at Edit-time. The lease supplies identity by DECLARATION instead:
// the dispatching text (Agent() prompt or SendMessage assignment) carries a
// structured line naming the agent and the files it owns:
//
//     PRISM-LEASE: agent=<agentId> files=<path>[,<path>...]
//
// HARD CONSTRAINTS (from the feasibility review — non-negotiable):
//   • Ownership is EXPLICITLY DECLARED, never inferred from first-touch —
//     inferred ownership wrongly blocks a legitimate later agent.
//   • The advisory fires ONLY when the live-agents ledger shows genuinely >1
//     concurrent agent. A solo session must NEVER see it (the lease is still
//     RECORDED — truthful ledger — but no advisory is emitted).
//   • TTL-bounded: a crashed agent cannot permanently lock a file (a stuck
//     lock is work-stoppage — strictly worse than the wasted-work problem).
//     Default 15 min; PRISM_FILE_LEASE_TTL_MS (30s..1h). SubagentStop clears
//     the stopping agent's leases eagerly; the TTL is the backstop.
//   • ADVISORY-ONLY (exit 0, additionalContext). NO deny path exists in this
//     file. Promote to hard only on measured false-positive evidence.
//
// LEDGER: ~/.claude/.prism-file-leases-<session>.json — array of
// {file, agent, ts}. Locked read-modify-write via withRosterLock + TTL sweep
// on read + SubagentStop clear — the exact proven pattern of
// hooks/prism-dispatch-dedup-guard.mjs.
//
// COLLISION POLICY: a declaration for a file already leased to a DIFFERENT
// agent does NOT overwrite the standing lease (the incumbent keeps it; the
// advisory names them). Same-agent re-declaration refreshes the TTL.
//
// FAIL-OPEN: every path swallows errors → exit 0, no output.
//
// Kill-switch: PRISM_FILE_LEASE=off (default on). Read per call.

import {
  readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';
import { extractAgentId, reconcile } from './lib/prism-live-agents.mjs';
import { withRosterLock } from '../tools/lib/prism-roster-lock.mjs';
import { classifyBuildVsRead } from './prism-specialist-routing-guard.mjs';
import { renameWithRetry } from '../tools/lib/atomic-fs.mjs';

// Declaration line. agent= is the DECLARED identity (the agent writes its own
// agentId); files= is a comma-separated path list terminated by end-of-line.
const LEASE_RE = /PRISM-LEASE:\s*agent=([^\s]+)\s+files=([^\r\n]+)/gi;

function ttlMs(env = process.env) {
  const raw = env.PRISM_FILE_LEASE_TTL_MS;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (n >= 30000 && n <= 3600000) return n;
  }
  return 15 * 60000;
}

function enabled(env = process.env) {
  return String(env.PRISM_FILE_LEASE ?? 'on').toLowerCase() !== 'off';
}

function leasePath(sessionId) {
  return join(prismHome(), '.claude', `.prism-file-leases-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// MIGRATE-LOW-PRIORITY (task #88 census): this ledger is documented
// ADVISORY-ONLY / FAIL-OPEN with TTL self-heal (see header above) — a lost
// write here is not the "control disarmed" risk it can look like at a
// glance, only a missed advisory nudge that self-corrects on the next TTL
// sweep. Migrated for consistency with the rest of the sweep, not urgency.
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
        appendLog({event: 'file_lease_guard_ledger_write', status: 'atomic_failed_fallback_ok',
          error_code: (renameErr && renameErr.code) || null});
      } catch (fallbackErr) {
        appendLog({event: 'file_lease_guard_ledger_write', status: 'write_failed',
          error_code: (fallbackErr && fallbackErr.code) || null});
      }
    }
  } catch { /* fail-open */ }
}

// Path normalization for lease keying: forward slashes, no leading ./,
// lowercase (Windows-first project — case-insensitive filesystems).
export function normFile(p) {
  if (typeof p !== 'string') return '';
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function normAgent(a) {
  return String(a || '').trim().replace(/^@/, '').toLowerCase();
}

// Parse every PRISM-LEASE declaration out of a text blob.
// Returns [{agent, files: [normalized...]}].
export function parseLeases(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const m of text.matchAll(LEASE_RE)) {
    const agent = normAgent(m[1]);
    const files = m[2].split(',').map(normFile).filter(Boolean);
    if (agent && files.length) out.push({ agent, files });
  }
  return out;
}

function readLeases(sessionId, now, env) {
  const p = leasePath(sessionId);
  let entries = [];
  try {
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch { return []; }
  const ttl = ttlMs(env);
  const kept = entries.filter(e => {
    if (!e || typeof e.ts !== 'string' || !e.file || !e.agent) return false;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return false;
    return (now - t) < ttl; // TTL sweep — a crashed agent's lease self-expires
  });
  if (kept.length !== entries.length) atomicWrite(p, kept);
  return kept;
}

// Count genuinely concurrent agents: live-agents records with status==='running',
// plus the agent this very Agent() dispatch is about to spawn (it is not in the
// ledger yet at PreToolUse time, but it IS about to be concurrent).
function concurrentCount(sessionId, isAgentDispatch) {
  let running = 0;
  try {
    for (const rec of reconcile(prismHome(), sessionId).values()) {
      if (rec && rec.status === 'running') running++;
    }
  } catch { /* fail-open → 0 */ }
  return running + (isAgentDispatch ? 1 : 0);
}

export async function run(payload, env = process.env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  try {
    if (!enabled(env)) return quiet;
    const tool = payload && payload.tool_name;
    if (tool !== 'Agent' && tool !== 'SendMessage') return quiet;

    const ti = (payload && payload.tool_input) || {};
    const text = tool === 'Agent'
      ? `${String(ti.description || '')}\n${String(ti.prompt || '')}`
      : (typeof ti.message === 'string' ? ti.message : '');
    const sessionId = (payload && payload.session_id) || 'anon';
    const declared = parseLeases(text);
    if (!declared.length) {
      // No lease declared. Observe the MISS (F4) so a fan-out that declares
      // nothing is distinguishable from the hook not running at all — the
      // original early-return left zero trace here. NO inference of ownership,
      // NO deny path. Gate on ≥2 genuinely concurrent agents so solo sessions
      // produce no log spam.
      const concurrent = concurrentCount(sessionId, tool === 'Agent');
      if (concurrent >= 2) {
        appendLog({
          event: 'file_lease_guard',
          ts: new Date().toISOString(),
          session_id: sessionId,
          tool_name: tool,
          declared: 0,
          concurrent,
          advised: false,
          no_declaration: true,
        });
        // Producer nudge: only when this write-capable (build-class) dispatch
        // could actually clobber. Advisory only — exit 0, additionalContext.
        if (classifyBuildVsRead(text).isBuild) {
          const notice =
            'PRISM FILE-LEASE: ≥2 concurrent agents and this write-capable dispatch declares no file ownership. '
            + 'Add `PRISM-LEASE: agent=<id> files=<paths>` to the dispatch prompt (see master-orchestrator SKILL.md).';
          return {
            exit: 0,
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
            }),
            stderr: '',
          };
        }
      }
      return quiet;
    }

    const now = Date.now();
    const p = leasePath(sessionId);
    const collisions = [];

    try {
      await withRosterLock(p, async () => {
        const entries = readLeases(sessionId, now, env);
        for (const { agent, files } of declared) {
          for (const file of files) {
            const existing = entries.find(e => e.file === file);
            if (existing && normAgent(existing.agent) !== agent) {
              // Incumbent keeps the lease; advisory names them below.
              collisions.push({
                file,
                holder: existing.agent,
                claimant: agent,
                ageS: Math.max(0, Math.round((now - Date.parse(existing.ts)) / 1000)),
              });
            } else if (existing) {
              existing.ts = new Date(now).toISOString(); // same-agent refresh
            } else {
              entries.push({ file, agent, ts: new Date(now).toISOString() });
            }
          }
        }
        atomicWrite(p, entries);
      });
    } catch { /* fail-open: declarations not recorded this call */ }

    // Solo-session gate: without ≥2 genuinely concurrent agents there is no one
    // to collide WITH — record silently, never advise.
    const concurrent = concurrentCount(sessionId, tool === 'Agent');
    const advised = collisions.length > 0 && concurrent >= 2;

    appendLog({
      event: 'file_lease_guard',
      ts: new Date(now).toISOString(),
      session_id: sessionId,
      tool_name: tool,
      declared: declared.reduce((n, d) => n + d.files.length, 0),
      collisions: collisions.map(c => c.file),
      concurrent,
      advised,
    });

    if (!advised) return quiet;

    const lines = collisions.slice(0, 5).map(c =>
      `  • ${c.file} — leased to ${c.holder} (${c.ageS}s ago); ${c.claimant} is now declaring it too`);
    const notice = [
      `PRISM FILE-LEASE (advisory): declared file ownership collides with a live lease:`,
      ...lines,
      `Two concurrent agents writing the same file will silently clobber each other.`,
      `Consider: narrow the new agent's scope, or SendMessage the lease holder to hand the`,
      `file off explicitly (a fresh PRISM-LEASE line after they finish re-declares it).`,
      `Leases expire after ${Math.round(ttlMs(env) / 60000)} min or at the holder's SubagentStop.`,
      `Proceeding is allowed — this is advisory only. Kill-switch: PRISM_FILE_LEASE=off.`,
    ].join('\n');

    return {
      exit: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
      }),
      stderr: '',
    };
  } catch {
    return quiet; // FAIL OPEN
  }
}

// ── SubagentStop — clear the stopping agent's leases ──────────────────────────
export async function runSubagentStop(payload, env = process.env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  try {
    if (!enabled(env)) return quiet;
    const sessionId = (payload && payload.session_id) || 'anon';
    const agent = normAgent(extractAgentId(payload));
    if (!agent) return quiet;
    const p = leasePath(sessionId);
    let cleared = 0;
    try {
      await withRosterLock(p, async () => {
        const entries = readLeases(sessionId, Date.now(), env);
        const kept = entries.filter(e => normAgent(e.agent) !== agent);
        cleared = entries.length - kept.length;
        if (cleared > 0) atomicWrite(p, kept);
      });
    } catch { /* fail-open */ }
    if (cleared > 0) {
      appendLog({
        event: 'file_lease_clear',
        ts: new Date().toISOString(),
        session_id: sessionId,
        agent,
        cleared,
      });
    }
    return quiet;
  } catch {
    return quiet;
  }
}

// Standalone shim (parity with sibling guards).
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-file-lease-guard.mjs';
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
