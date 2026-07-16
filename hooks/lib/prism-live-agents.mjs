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

// ── Task #19 (4a) — per-agent CURRENT-TASK summaries ─────────────────────────
// The ledger historically only knew WHO is running, not WHAT they are doing —
// so a live agent whose scope was expanded via SendMessage was invisible to any
// dedup comparison (the 2026-07-14 dispatch-dedup miss). These helpers add a
// `taskText` record type to the SAME session JSONL: appended at Agent() dispatch
// AND at scope-assigning SendMessage, accumulated per agent (not last-write-wins
// — an agent's current scope is the UNION of everything assigned to it).

const TASK_TEXT_MAX = 600;     // chars kept per task record
const TASK_TEXTS_PER_AGENT = 5; // most-recent task texts kept per agent

// Append a {agentId, taskText, taskTs} record. Deliberately carries NO status
// field so reconcile()'s {...prev, ...rec} merge never clobbers running/completed.
export function appendTaskSummary(home, sessionId, agentId, text) {
  const id = (typeof agentId === 'string' ? agentId : '').trim().replace(/^@/, '');
  const t = (typeof text === 'string' ? text : '').trim();
  if (!id || !t) return false;
  return appendRecord(home, sessionId, {
    agentId: id,
    taskText: t.slice(0, TASK_TEXT_MAX),
    taskTs: new Date().toISOString(),
  });
}

// Read the ledger and return Map<agentId, {status, texts:[..], lastTaskTs}> for
// agents considered LIVE: status==='running', or no status record yet (the
// PreToolUse task record lands before SubagentStart) with a task newer than
// ttlMs. Agents with status==='completed' are never live (SubagentStop clears).
export function collectLiveWork(home, sessionId, ttlMs = 15 * 60000, now = Date.now()) {
  const agents = new Map();
  try {
    if (!home || !sessionId) return new Map();
    const p = ledgerPath(home, sessionId);
    if (!existsSync(p)) return new Map();
    for (const line of readFileSync(p, 'utf-8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const id = typeof rec.agentId === 'string' ? rec.agentId.trim() : '';
      if (!id) continue;
      const a = agents.get(id) || { status: '', texts: [], lastTaskTs: 0 };
      if (typeof rec.status === 'string' && rec.status) a.status = rec.status;
      if (typeof rec.taskText === 'string' && rec.taskText) {
        a.texts.push(rec.taskText);
        if (a.texts.length > TASK_TEXTS_PER_AGENT) a.texts.shift();
        const t = Date.parse(rec.taskTs || '');
        if (!Number.isNaN(t) && t > a.lastTaskTs) a.lastTaskTs = t;
      }
      agents.set(id, a);
    }
  } catch {
    return new Map();
  }
  const live = new Map();
  for (const [id, a] of agents) {
    if (a.texts.length === 0) continue;
    const isLive = a.status === 'running'
      || (!a.status && a.lastTaskTs > 0 && (now - a.lastTaskTs) < ttlMs);
    if (isLive) live.set(id, a);
  }
  return live;
}

// Deterministic keyword extraction — lowercase alnum tokens ≥4 chars, minus a
// fixed stopword list of English glue + dispatch boilerplate. NO stemming, NO
// fuzz, NO embeddings (dep-free/deterministic convention; see D-diagnosis
// 2026-07-14 "Option rejected"). The dispatch-preamble footer is stripped first
// so its fixed clause text can't manufacture overlap between unrelated tasks.
const TASK_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'your', 'yours', 'have', 'will', 'been', 'being',
  'when', 'then', 'than', 'they', 'them', 'there', 'their', 'what', 'which',
  'while', 'where', 'also', 'only', 'into', 'onto', 'over', 'under', 'each',
  'every', 'some', 'same', 'such', 'does', 'done', 'doing', 'must', 'should',
  'would', 'could', 'here', 'these', 'those', 'after', 'before', 'about',
  'against', 'between', 'because', 'both', 'more', 'most', 'other', 'very',
  'just', 'like', 'make', 'made', 'need', 'needs', 'want', 'wants', 'please',
  'never', 'ever', 'always', 'first', 'second', 'third', 'task', 'tasks',
  'work', 'real', 'paste', 'output', 'result', 'results', 'return', 'report',
  'budget', 'tool', 'tools', 'call', 'calls', 'file', 'files', 'test', 'tests',
  'session', 'agent', 'agents', 'prism', 'claude', 'code', 'line', 'lines',
  'read', 'write', 'note', 'notes', 'step', 'steps', 'list', 'emit', 'show',
  'acceptance', 'deliverable', 'deliverables', 'worker', 'dispatch',
]);

export function keywordsOf(text) {
  const out = new Set();
  if (typeof text !== 'string' || !text) return out;
  const cut = text.split('[PRISM dispatch-preamble]')[0].toLowerCase();
  for (const tok of cut.split(/[^a-z0-9]+/)) {
    if (tok.length < 4) continue;
    if (/^\d+$/.test(tok)) continue;
    if (TASK_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

// Overlap coefficient between two keyword Sets: |A∩B| / min(|A|,|B|).
// Returns {shared: [tokens...], coefficient}. Deterministic, symmetric.
export function taskOverlap(aSet, bSet) {
  const shared = [];
  try {
    const [small, large] = (aSet.size <= bSet.size) ? [aSet, bSet] : [bSet, aSet];
    for (const t of small) if (large.has(t)) shared.push(t);
    const denom = Math.min(aSet.size, bSet.size);
    return { shared, coefficient: denom > 0 ? shared.length / denom : 0 };
  } catch {
    return { shared, coefficient: 0 };
  }
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
