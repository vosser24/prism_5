// PRISM shared task-snapshot machinery (Fix A slice 6).
//
// Extracted VERBATIM from hooks/prism-session-end.mjs (which imports it back)
// so tools/prism-repair-open-tasks.mjs runs the EXACT extractor the SessionEnd
// hook runs — tool/hook divergence is structurally impossible. Behavior is
// byte-identical to the pre-extraction in-hook copies; the doc comments below
// are the originals and still reference the hook's write-side wiring.

import {statSync, openSync, readSync, closeSync} from 'fs';

// ── C5 (recall-hardening v6.2.0): Task API snapshot / carryover ────────────
// Reconstructs final per-task state from TaskCreate/TaskUpdate/TaskList/
// TaskGet tool_use + tool_result events found in the transcript tail (the
// same `lines` array the rest of this hook already tokenizes for lesson/
// error extraction — see the main try block below).
//
// Real wire schema (verified against a captured transcript —
// tests/v3/bench/item6/results/A/rep1/sess4/stream.jsonl:61-71):
//   TaskCreate  tool_use.input   = {subject, description, activeForm, blockedBy?}
//   TaskCreate  tool_use_result  = {task: {id, subject}}          (id is a string)
//   TaskUpdate  tool_use.input   = {taskId, status?, subject?, description?,
//                                   activeForm?, blockedBy?}
//   TaskUpdate  tool_use_result  = {success, taskId, updatedFields,
//                                   statusChange: {from, to}}
// TaskList/TaskGet result shapes were not exercised in any captured
// transcript; they are handled defensively (tool_use_result.tasks[] /
// .task) so a real payload, if one ever appears, still merges in transcript
// order like everything else. `tool_use_result` sits as a top-level sibling
// of `message` on the `type:"user"` tool_result row, NOT nested inside
// `message.content` — matches the pattern already relied on elsewhere in
// this file (e.g. no equivalent lookup existed before; this is new).
//
// Fail-open: a malformed line is skipped (existing per-line try/catch
// pattern in the main loop); this function itself never throws — worst
// case it returns whatever it managed to reconstruct so far.
//
// Slice 5 (panel-53 E1/F1 — fail-loud counting): the optional `counters`
// out-param, when passed, is mutated with how each matched Task tool_result
// row was resolved: `structured_hits` (the toolUseResult/tool_use_result
// sibling was present), `regex_fallbacks` (resolved WITHOUT a structured
// result — regex on the result text or the call input's taskId), and
// `unmatched_task_results` (a Task tool_result that yielded nothing). The
// return stays a plain array so existing extraction-based tests/callers are
// unaffected. seen>0 && structured==0 is the Finding-1 shape-miss signature.
function extractTaskSnapshot(rawLines, counters = null) {
  const tasks = new Map(); // id (string) -> {id, subject, description, activeForm, status, blockedBy}
  const pendingCalls = new Map(); // tool_use_id -> {name, input}
  const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

  function upsert(id, patch) {
    if (id === null || id === undefined || id === '') return;
    const key = String(id);
    const prev = tasks.get(key) || {id: key, subject: '', description: '', activeForm: '', status: 'pending', blockedBy: null};
    tasks.set(key, {...prev, ...patch, id: key});
  }

  for (const line of rawLines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Track TaskCreate/TaskUpdate/TaskList/TaskGet tool_use calls issued by
    // the assistant, keyed by tool_use id, so the matching tool_result row
    // (below) can be resolved back to the call that produced it.
    const am = obj.message;
    if (am && am.role === 'assistant' && Array.isArray(am.content)) {
      for (const c of am.content) {
        if (c && c.type === 'tool_use' && c.id && TASK_TOOL_NAMES.has(c.name)) {
          pendingCalls.set(c.id, {name: c.name, input: c.input || {}});
        }
      }
    }

    // Match tool_result rows (type:"user" messages carrying a tool_result
    // content block) back to the pending call via tool_use_id.
    const um = obj.message;
    const content = um && Array.isArray(um.content) ? um.content : null;
    if (!content) continue;

    for (const c of content) {
      if (!c || c.type !== 'tool_result' || !c.tool_use_id) continue;
      const call = pendingCalls.get(c.tool_use_id);
      if (!call) continue;
      const tur = obj.toolUseResult ?? obj.tool_use_result ?? null; // sibling of `message` (camelCase in session transcripts; snake_case in headless stream-json)
      const resultText = typeof c.content === 'string' ? c.content : '';
      let resolved = false; // Slice 5 — did this row yield anything (structurally or by fallback)?

      if (call.name === 'TaskCreate') {
        let id = (tur && tur.task && tur.task.id != null) ? tur.task.id : null;
        if (id === null) { const m = resultText.match(/Task #(\S+)/); if (m) id = m[1]; }
        if (id !== null) {
          resolved = true;
          upsert(id, {
            subject: call.input.subject || (tur && tur.task && tur.task.subject) || '',
            description: call.input.description || '',
            activeForm: call.input.activeForm || '',
            status: 'pending',
            blockedBy: call.input.blockedBy ?? null,
          });
        }
      } else if (call.name === 'TaskUpdate') {
        let id = (call.input.taskId != null) ? call.input.taskId : ((tur && tur.taskId != null) ? tur.taskId : null);
        if (id === null) { const m = resultText.match(/task #(\S+)/i); if (m) id = m[1]; }
        if (id !== null) {
          resolved = true;
          const patch = {};
          if (call.input.subject !== undefined) patch.subject = call.input.subject;
          if (call.input.description !== undefined) patch.description = call.input.description;
          if (call.input.activeForm !== undefined) patch.activeForm = call.input.activeForm;
          if (call.input.blockedBy !== undefined) patch.blockedBy = call.input.blockedBy;
          if (call.input.status !== undefined) patch.status = call.input.status;
          if (tur && tur.statusChange && tur.statusChange.to) patch.status = tur.statusChange.to; // most authoritative
          upsert(id, patch);
        }
      } else if (call.name === 'TaskGet') {
        const t = tur && tur.task ? tur.task : null;
        if (t && t.id != null) {
          resolved = true;
          const patch = {};
          if (t.subject !== undefined) patch.subject = t.subject;
          if (t.description !== undefined) patch.description = t.description;
          if (t.activeForm !== undefined) patch.activeForm = t.activeForm;
          if (t.status !== undefined) patch.status = t.status;
          if (t.blockedBy !== undefined) patch.blockedBy = t.blockedBy;
          upsert(t.id, patch);
        }
      } else if (call.name === 'TaskList') {
        const arr = (tur && Array.isArray(tur.tasks)) ? tur.tasks : null;
        if (arr) {
          resolved = true;
          for (const t of arr) {
            if (!t || t.id == null) continue;
            const patch = {};
            if (t.subject !== undefined) patch.subject = t.subject;
            if (t.description !== undefined) patch.description = t.description;
            if (t.activeForm !== undefined) patch.activeForm = t.activeForm;
            if (t.status !== undefined) patch.status = t.status;
            if (t.blockedBy !== undefined) patch.blockedBy = t.blockedBy;
            upsert(t.id, patch);
          }
        }
      }
      // Slice 5 — count how this Task tool_result was resolved.
      if (counters) {
        if (tur !== null) counters.structured_hits++;
        else if (resolved) counters.regex_fallbacks++;
        else counters.unmatched_task_results++;
      }
      pendingCalls.delete(c.tool_use_id);
    }
  }

  return Array.from(tasks.values());
}

// ── 1b (recall-hardening): full-file Task-event scan (was: 500KB tail only) ──
// The 500KB tail read in the main body still feeds the session-summary
// scanners (files/models/cost/tokens/lessons); the Task snapshot instead needs
// COMPLETENESS, so it gets its OWN pass over the whole transcript, capped at
// PRISM_TASKSCAN_MAXBYTES (default 20MB) read from EOF. Because this hook runs
// on every Stop (every turn), a cheap substring prefilter keeps only lines that
// could carry a Task tool_use/tool_result BEFORE the relatively expensive
// JSON.parse inside extractTaskSnapshot — the prefilter only affects which
// lines get parsed, never correctness (extractTaskSnapshot still filters by
// tool name + pendingCalls). tail_truncated=true iff the file exceeded the cap
// (older Task events beyond the window are unseen — surfacing that is a later
// slice; here we only compute + carry the flag). Fail-open: any read error
// yields {lines:[], tail_truncated:false}.
function readTaskScanLines(transcriptPath) {
  try {
    const capRaw = Number(process.env.PRISM_TASKSCAN_MAXBYTES);
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 20 * 1024 * 1024;
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - cap);
    const tail_truncated = start > 0;
    const fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const text = buf.toString('utf-8');
    const lines = [];
    for (const l of text.split(/\r?\n/)) {
      if ((l.includes('Task') || l.includes('task')) &&
          (l.includes('tool_use') || l.includes('toolUseResult'))) lines.push(l);
    }
    return {lines, tail_truncated};
  } catch {
    return {lines: [], tail_truncated: false};
  }
}

// ── 1c (recall-hardening): merge-not-overwrite for the carryover pointer ─────
// The project-local .prism-open-tasks.json is a CROSS-SESSION pointer: a task
// that is genuinely open but untouched THIS session must survive, not be
// silently dropped by a wholesale overwrite (BUG-5). Merge keyed by task id:
//   - this session's open tasks WIN on id conflict (freshest state; carried_from
//     stripped — except where field-wise fallback re-applies it, see step 2);
//   - a prior-session open task the session did NOT touch is CARRIED FORWARD,
//     tagged carried_from = {session, ts} (sticky: preserved verbatim across
//     repeated carries so the age cap measures from first-carry, not now);
//   - AGE CAP: drop a carried task whose carried_from.ts is > maxAgeDays old
//     (bounds zombie risk — loud-stale-beats-silent-gone, capped);
//   - a task the session reconstructed (touched) but did NOT leave open is
//     dropped (it was completed/removed this session — sessionTouchedIds).
// Pure + fail-open by construction: existingPayload null/garbage => priorOpen
// empty => result == this session's open tasks (never worse than the overwrite).
//
// FIELD-WISE fallback (fixes a data-loss bug found post-1c): "session touched
// this id" only means the session is authoritative about what it actually
// OBSERVED — typically status, via a TaskUpdate. It is NOT authoritative about
// a subject/description it never saw. That happens whenever this task's
// TaskCreate lies outside the scanned transcript window (a status-only
// TaskUpdate is the common trigger, but any long-lived task whose creation
// scrolled out of the window hits it) — extractTaskSnapshot() then
// default-initializes subject/description to '' for an id it never saw
// created. Without this fallback, step 2's "session wins" wholesale-overwrites
// a populated prior subject/description with those unobserved empty strings,
// which is exactly the data capture-conventions.md's anti-brevity rule says
// must survive a session boundary. So step 2 merges subject/description
// field-wise: keep the session's value if it observed one (non-empty), else
// fall back to the prior pointer's value. Never let an unobserved empty field
// overwrite a populated prior one.
function mergeOpenTasks(existingPayload, sessionOpenTasks, sessionTouchedIds, nowMs, maxAgeDays = 14) {
  const merged = new Map();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const priorOpen = (existingPayload && Array.isArray(existingPayload.open_tasks)) ? existingPayload.open_tasks : [];
  const priorById = new Map();
  for (const t of priorOpen) {
    if (t && t.id != null) priorById.set(String(t.id), t);
  }
  // 1. carry prior-session open tasks the session didn't touch, within age cap.
  for (const t of priorOpen) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    if (sessionTouchedIds.has(id)) continue; // session has authoritative fresher state
    const origin = t.carried_from || {session: existingPayload.session_id || null, ts: existingPayload.ts || null};
    const originTs = (origin && origin.ts) ? Date.parse(origin.ts) : NaN;
    if (Number.isFinite(originTs) && (nowMs - originTs) > maxAgeMs) continue; // age cap → drop zombie
    merged.set(id, {...t, carried_from: origin});
  }
  // 2. this session's open tasks WIN (fresh state) — field-wise for
  // subject/description (see comment above); everything else (status,
  // activeForm, blockedBy) is taken as-is from the session's reconstruction.
  const FALLBACK_FIELDS = ['subject', 'description'];
  for (const t of sessionOpenTasks) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    const {carried_from, ...clean} = t;
    const prior = priorById.get(id);
    if (prior) {
      let sourcedFromPrior = false;
      for (const f of FALLBACK_FIELDS) {
        if (!clean[f] && prior[f]) {
          clean[f] = prior[f];
          sourcedFromPrior = true;
        }
      }
      // Tag carried_from only when at least one field was actually sourced
      // from the prior record — a task the session fully observed gets no tag.
      if (sourcedFromPrior) {
        clean.carried_from = prior.carried_from || {session: existingPayload.session_id || null, ts: existingPayload.ts || null};
      }
    }
    merged.set(id, clean);
  }
  return Array.from(merged.values());
}

export {extractTaskSnapshot, readTaskScanLines, mergeOpenTasks};
