// hooks/lib/prism-live-agents.mjs
// PRISM live-agents ledger — shared core for the SubagentStart / SubagentStop
// confabulation ledger (Package E).
//
// WHY: the model has no native readable "who is running" source, so it will
// confabulate agent names/ids/status when asked. This ledger synthesises a
// deterministic source of truth: SubagentStart appends a `running` record and
// SubagentStop appends a `completed` record to a session-scoped append-only
// JSONL file (append-only = crash-safe; last-write-wins on read). A
// UserPromptSubmit module reconciles + injects a one-line summary so the
// orchestrator reads reality instead of inventing it.
//
// Dep-free, side-effect-free on import. Every function fails soft (never throws
// on bad input); callers still wrap in try/catch and always exit 0.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Identity extraction — MUST match hooks/prism-subagent-stop.mjs's rawName
// resolution EXACTLY (agent_type → subagent_type → agent_name → agent, @-stripped
// and trimmed) so a SubagentStart record and its SubagentStop record key on the
// SAME id and reconcile together. Do not "improve" this in isolation.
export function extractAgentId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = (payload.agent_type || payload.subagent_type || payload.agent_name || payload.agent || '');
  return (typeof raw === 'string' ? raw : '').trim().replace(/^@/, '');
}

// Best-effort human-readable type label (agent_type canonical). Falls back to the
// resolved id so a rendered summary is never blank.
export function extractAgentType(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const t = (payload.agent_type || payload.subagent_type || payload.agent_name || payload.agent || '');
  return (typeof t === 'string' ? t : '').trim().replace(/^@/, '');
}

// Session-scoped ledger path: ~/.claude/.prism-live-agents-<session_id>.jsonl
export function ledgerPath(home, sessionId) {
  return join(home, '.claude', `.prism-live-agents-${sessionId}.jsonl`);
}

// Append one JSONL record (append-only for crash-safety). Ensures the .claude
// dir exists. Returns true on write, false on any missing input / I/O error.
export function appendRecord(home, sessionId, record) {
  if (!home || !sessionId || !record || typeof record !== 'object') return false;
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    appendFileSync(ledgerPath(home, sessionId), JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Read + reconcile the ledger to LAST-WRITE-WINS per agentId. Returns a
// Map<agentId, mergedRecord>. Merge (…prev, …rec) so a later `completed` record
// (which carries no agentType) keeps the agentType captured at `running` while
// overriding status/timestamps. Missing/malformed ledger → empty Map (no throw);
// individual malformed lines are skipped.
export function reconcile(home, sessionId) {
  const map = new Map();
  try {
    if (!home || !sessionId) return map;
    const p = ledgerPath(home, sessionId);
    if (!existsSync(p)) return map;
    const text = readFileSync(p, 'utf-8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const id = typeof rec.agentId === 'string' ? rec.agentId.trim() : '';
      if (!id) continue;
      const prev = map.get(id) || {};
      map.set(id, { ...prev, ...rec, agentId: id });
    }
  } catch {
    /* fail-open */
  }
  return map;
}

// Render the one-line summary from a reconciled Map. Empty / non-Map → ''.
// Format: `Live agents (session): N running [id:type,...], M completed [id:type,...].`
export function renderSummary(map) {
  try {
    if (!map || typeof map.values !== 'function') return '';
    const running = [];
    const completed = [];
    for (const rec of map.values()) {
      if (!rec || typeof rec !== 'object') continue;
      const id = rec.agentId || '';
      if (!id) continue;
      const type = (rec.agentType && String(rec.agentType).trim()) ? String(rec.agentType).trim() : id;
      const tag = `${id}:${type}`;
      if (rec.status === 'running') running.push(tag);
      else if (rec.status === 'completed') completed.push(tag);
    }
    if (running.length === 0 && completed.length === 0) return '';
    running.sort();
    completed.sort();
    return `Live agents (session): ${running.length} running [${running.join(',')}], ${completed.length} completed [${completed.join(',')}].`;
  } catch {
    return '';
  }
}
