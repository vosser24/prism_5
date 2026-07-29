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
// D048 (6.5.2): the optional `createdIds` out-param, when passed (a Set), is
// populated ONLY from the TaskCreate branch below — direct provenance for
// "did THIS scan actually create this id" (vs. merely touch it via
// TaskUpdate/TaskList/TaskGet), letting a caller distinguish a genuine
// per-session id-reuse (independently TaskCreate'd in two scans) from an
// ordinary cross-session rename (TaskUpdate only) without proxying through
// mergeOpenTasks' carried_from dormancy signal. Opt-in and additive — no
// existing caller passes it, so this changes no existing behavior.
// ── Residue detector (F40 forensics / F47 follow-up) — DETECT, NEVER REPAIR ─
// Forensic finding (2026-07-28, task #57-adjacent investigation): a
// platform-side tool-call boundary bug can leak literal wire-format markup
// (`</parameter>`, `</invoke>`, `<parameter name="...">`) into a
// TaskCreate/TaskUpdate `description` string when it sits next to another
// large multi-line parameter in the same call. Verified NOT a defect in this
// file: extractTaskSnapshot() reads `input.description` verbatim off an
// already-JSON.parse'd object (TaskCreate below, TaskUpdate below) — there is
// no regex/substring extraction to over-capture. The corruption is already
// present in the raw transcript's tool_use.input before this file ever sees
// it. This detector cannot fix that (nothing here can — it is upstream of
// PRISM), so it only makes the miss LOUD (D046): flag, never alter/reject.
//
// FALSE-POSITIVE SAFETY — this is the load-bearing design constraint. A
// legitimate lesson or task description ABOUT this very finding (this file's
// own doc comments, for instance) will contain the literal substrings
// `</parameter>`, `</invoke>`, `<parameter name=`. A bare substring-anywhere
// check would misfire on every such reference. Narrowed instead to the two
// shapes actually OBSERVED across the 6 known-corrupted records, each
// ANCHORED AT THE LITERAL END of the string and requiring an UNPAIRED tag:
//   Pattern A: a closing `</parameter></invoke>` pair with nothing after it —
//     an orphaned close, no matching opener in this trailing span.
//   Pattern B: an opening `<parameter name="...">` tag immediately following
//     a `</description>` close, with NO closing tag before the string ends —
//     an orphaned opener, the swallowed next-parameter's name+value.
// A sentence that mentions, and then properly closes or quotes, these tags
// mid-string will not match (the `$` anchor requires literal end-of-string,
// and Pattern B additionally requires nothing containing `<` after the
// opener). TRADEOFF, stated plainly: a description whose genuinely-final
// content happens to be an intentionally-unclosed quotation of one of these
// two exact shapes could still false-positive. That residual risk is
// accepted because the detector is advisory-only (see callers below) — even
// a false positive changes nothing about the captured record, it only adds a
// flag a human can dismiss on sight.
const RESIDUE_PATTERNS = [
  /<\/parameter>\s*<\/invoke>\s*$/i,
  /<\/description>\s*<parameter\s+name="[^"]*">[^<]*$/i,
];

function detectDescriptionResidue(text) {
  if (typeof text !== 'string' || !text) return false;
  try {
    return RESIDUE_PATTERNS.some((re) => re.test(text));
  } catch { return false; } // fail-open — detection must never break extraction
}

function extractTaskSnapshot(rawLines, counters = null, createdIds = null) {
  // Baseline the new counter alongside its siblings (structured_hits etc.) so
  // it is ALWAYS present at 0 rather than appearing only once residue is
  // first seen — matches the caller's own {structured_hits:0, ...} seeding
  // convention (hooks/prism-session-end.mjs) for a consistent meta shape.
  // DENOMINATOR WARNING (do not "reconcile" this against structured_hits):
  // structured_hits/regex_fallbacks/unmatched_task_results count EVERY
  // resolved Task-tool-result ROW seen this scan. residue_detected counts
  // only the SUBSET of those rows that additionally carried an observed
  // `description` value matching a residue pattern — a row that touched only
  // `status`/`subject`/etc. contributes to the former but never to this one.
  // The two counters are not meant to sum to the same total.
  if (counters && counters.residue_detected === undefined) counters.residue_detected = 0;
  const tasks = new Map(); // id (string) -> {id, subject, description, activeForm, status, blockedBy}
  const pendingCalls = new Map(); // tool_use_id -> {name, input}
  const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

  // ROOT-CAUSE FIX (task #14, D047 vacuous-signal class): the old fallback
  // object here — `{subject:'', description:'', activeForm:'', status:'pending',
  // blockedBy:null}` — FABRICATED a concrete value for every field this id
  // had never actually been seen carrying, the instant an update arrived for
  // an id whose TaskCreate lies outside the scanned window (the common
  // trigger: a status-only or rename-only TaskUpdate for a task created in
  // an earlier session/transcript). A fabricated 'pending' is then
  // structurally indistinguishable from a genuinely-observed 'pending' —
  // exactly D047's class, expressed as a defaulting object instead of a
  // boolean. FALLBACK_FIELDS in mergeOpenTasks() below patched over this by
  // enumerating which two fields to protect; that enumeration is itself the
  // defect (the next field added silently isn't on the list).
  //
  // The fix: `prev` starts with ONLY `{id}` — no invented fields. A field
  // this id has never appeared in a `patch` for (across every upsert() call
  // for this id within this scan) is simply ABSENT as a key on the returned
  // object, not present-with-a-guessed-value. Absence IS the UNKNOWN state,
  // representable directly, checkable with `'field' in task` by any
  // consumer — no field list required. TaskCreate's patch already always
  // supplies all five keys (see the TaskCreate branch below), so a task
  // whose creation WAS observed this scan is unaffected; only the
  // window-boundary case changes shape (from wrong-value to absent-key).
  function upsert(id, patch) {
    if (id === null || id === undefined || id === '') return;
    const key = String(id);
    const prev = tasks.get(key) || {id: key};
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
          if (createdIds) createdIds.add(String(id));
          const description = call.input.description || '';
          if (counters && detectDescriptionResidue(description)) counters.residue_detected++;
          upsert(id, {
            subject: call.input.subject || (tur && tur.task && tur.task.subject) || '',
            description,
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
          if (call.input.description !== undefined) {
            patch.description = call.input.description;
            if (counters && detectDescriptionResidue(patch.description)) counters.residue_detected++;
          }
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
          if (t.description !== undefined) {
            patch.description = t.description;
            if (counters && detectDescriptionResidue(patch.description)) counters.residue_detected++;
          }
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
            if (t.description !== undefined) {
              patch.description = t.description;
              if (counters && detectDescriptionResidue(patch.description)) counters.residue_detected++;
            }
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

  // Final per-task flag, checked against the FULLY MERGED description (later
  // upserts may have replaced the value an earlier per-row check saw) — this
  // is what actually gets persisted, so it's the one worth flagging. ADVISORY
  // ONLY: adds a boolean key, never touches `description` itself. Omitted
  // (not set to false) when clean, matching this file's existing "absence IS
  // the unknown/not-applicable state" convention (see upsert()'s doc comment
  // above) — a consumer checks `'description_residue_detected' in task`.
  // Wrapped defensively so a detector bug can never break extraction itself
  // (this function's own contract, stated at the top: "never throws").
  try {
    for (const t of tasks.values()) {
      if ('description' in t && detectDescriptionResidue(t.description)) {
        t.description_residue_detected = true;
      }
    }
  } catch { /* fail-open — a flagging bug must never break the snapshot */ }

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
// FIELD-WISE fallback, root-cause version (task #14 — supersedes the
// FALLBACK_FIELDS list this comment used to describe). "Session touched this
// id" only means the session is authoritative about the fields it actually
// OBSERVED this run. It is NOT authoritative about a field it never saw —
// that happens whenever this task's TaskCreate (or a prior TaskUpdate) lies
// outside the scanned transcript window (a status-only or rename-only
// TaskUpdate is the common trigger, but any long-lived task whose creation
// scrolled out of the window hits it). Before this fix, extractTaskSnapshot()
// FABRICATED a concrete default for every such field (status:'pending',
// activeForm:'', blockedBy:null, subject/description:''), and this function
// protected exactly the two fields (`subject`, `description`) someone had
// noticed going missing — FALLBACK_FIELDS was itself the vacuous-signal
// defect (D047) expressed as a list: it enumerated what to protect instead
// of fixing why anything needed protecting, and rotted the moment a THIRD
// field (status/activeForm/blockedBy) needed the same protection.
//
// Root-cause fix: extractTaskSnapshot()'s upsert() (this file, above) no
// longer fabricates — an unobserved field is simply ABSENT as a key on the
// session's task object. So the question "which fields need protecting"
// disappears: EVERY field is merged the same way, generically, off the UNION
// of keys in either source rather than an allowlist (task #14 F2) —
//   - key present on the session's record => session observed it => wins;
//   - key absent + prior record has it    => fall back to the prior value
//     (tagged carried_from, since a real field was sourced from there);
//   - key absent + prior doesn't have it either => truly never observed
//     anywhere => last-resort hard default for the DISPLAY fields only.
// The fallback loop walks Object.keys(prior), so a prior field with a name no
// list anticipated (a schema addition) is carried too — the allowlist cannot
// rot because there is no allowlist.
//
// STATUS is the one field with NO hard default (task #14 F1). Its three-way
// treatment is: observed-this-session => wins; unobserved but prior has it =>
// fall back to prior (so a rename-only touch preserves a real prior status,
// and a terminal prior status is carried into step 3 which then drops it);
// unobserved AND prior-absent => stays UNKNOWN (undefined), which step 3's
// isOpenStatus() excludes. That last branch is the reachable zombie PROBE H
// exposed: fabricating 'pending' there asserted open-ness from zero evidence
// and resurrected prior-session-completed tasks. UNKNOWN is not open.
// ── Task #20 additions (carry-forward honesty), both minimal + additive ─────
// DEFECT A (SURFACE, not drop): a prior-pointer open task the session did NOT
// touch is CORRECTLY carried forward — it can be legitimately open across many
// sessions without being touched in any one (the live #44/#53/#55/#56 case,
// independently verified as real open work; dropping them would be a HIGH
// data-loss regression). The defect is that a carried row survives
// INDISTINGUISHABLY from a re-observed one, and the SHA-STAMP [CURRENT] tag
// (git-position only) then hides it — D047's vacuous-signal class ([CURRENT]
// collapsing "repo verified fresh" and "rows never re-checked" into one green).
// `carried_from` cannot be that signal: it is itself conflated (step 1 sets it
// on an untouched carry; step 2 sets it on a re-observed row that merely
// back-filled ONE field from prior). So a NEW explicit key `carried_unverified:
// true` is set ONLY on the step-1 carry path (never re-observed this session),
// and MUST be cleared on re-observation (the step-2 back-fill loop skips it).
// "Since when" already lives in carried_from.ts (sticky first-carry stamp).
//
// DEFECT B (DETECT + FLAG, not namespace): task ids are per-session-scoped and
// two sessions can reuse one id for different tasks (measured live: id "19").
// Namespacing the key (session_id,id) across the whole pipeline is a schema
// migration for a harm that has only ever been survived by age-out timing, and
// would not even resolve the core ambiguity (a genuine cross-session rename is
// DATA-INDISTINGUISHABLE from a reuse, so namespacing produces a duplicate
// zombie on a rename). The regression-free move is: DETECT the reuse signal and
// FLAG it on an optional `meta.id_collisions` out-param WITHOUT changing the
// merge (so #14's rename back-fill stays intact — suppressing it would regress
// #14). The signal: a prior CARRIED cross-session row whose subject CONFLICTS
// with the session's OWN observed subject for the same id. Mirrors the repair
// tool's existing collidedIds/E3 detect-and-flag pattern.
const FOLD_SKIP_KEYS = new Set(['id', 'carried_from', 'carried_unverified']);
// Field-wise fold of two records for the SAME task id. `next` (later
// observation) wins every field it actually OBSERVED (key PRESENT — even
// empty-string, since the extractor only emits a key a tool_use observed);
// a field `next` did NOT observe (key ABSENT) falls back to `prev`. Generic
// over the key UNION — no allowlist (that is the FOLD_FALLBACK_FIELDS defect
// this replaces). SINGLE OWNER of the field-wise carry rule: both
// mergeOpenTasks step 2 and the repair tool's N-way transcript fold call it,
// so they cannot diverge (D046 #4).
function foldTaskRecords(prev, next) {
  const merged = {...next};
  let sourcedFromPrior = false;
  for (const f of Object.keys(prev)) {
    if (FOLD_SKIP_KEYS.has(f)) continue;
    if (f in merged) continue;      // next observed it → next wins
    merged[f] = prev[f];            // next never observed it → carry prev
    sourcedFromPrior = true;
  }
  return {merged, sourcedFromPrior};
}

function mergeOpenTasks(existingPayload, sessionOpenTasks, sessionTouchedIds, nowMs, maxAgeDays = 14, meta = null) {
  // Narrow schema hard-defaults for the DISPLAY fields only. STATUS is
  // deliberately NOT in this set (task #14 F1): a task whose status was never
  // observed this session AND has no prior record to source it from is
  // UNKNOWN — fabricating 'pending' from zero evidence is D047's vacuous
  // signal and resurrects a prior-session-completed task (verifier PROBE H:
  // session A completes #99 → pointer omits it → session B rename-only touch
  // → no prior record → 'pending' fabricated → #99 back from the dead).
  // Leaving status absent lets step 3's isOpenStatus(undefined)===false
  // exclude it. subject/description/activeForm/blockedBy DO get a concrete
  // last-resort default: '' / null render identically to "unknown" for every
  // downstream consumer and make no false claim about openness, so the
  // schema-stability win (the persisted pointer has always carried these four
  // keys concrete) is worth the narrow, justified allowlist.
  const HARD_DEFAULTS = {subject: '', description: '', activeForm: '', blockedBy: null};
  const isOpenStatus = (s) => s === 'pending' || s === 'in_progress';

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
    // Task #20 Defect A: tag the untouched carry as carried_unverified — this
    // row was NOT re-observed this session (it is not in sessionTouchedIds), so
    // its status is last-known, not confirmed. Distinct from carried_from
    // (field-provenance, conflated); cleared on re-observation by step 2.
    merged.set(id, {...t, carried_from: origin, carried_unverified: true});
  }
  // 2. this session's open tasks WIN for every field it actually observed —
  // generic key-presence merge, NO field allowlist (task #14 F2).
  for (const t of sessionOpenTasks) {
    if (!t || t.id == null) continue;
    const id = String(t.id);
    const {carried_from, carried_unverified, ...clean} = t;
    const prior = priorById.get(id);
    let sourcedFromPrior = false;
    // Task #20 Defect B: cross-session id-reuse detection, evaluated on the
    // session's OWN observed subject BEFORE the back-fill below can overwrite
    // an absent one. Fire only when the prior record is a CARRIED cross-session
    // row (prior.carried_from) AND the session observed its own, non-empty,
    // CONFLICTING subject for the same id — the "two different tasks under one
    // id" shape. Flag only; the merge is deliberately NOT suppressed (that
    // would regress #14's rename back-fill, since a genuine rename is
    // data-indistinguishable from a reuse). Skipped entirely when no `meta`
    // out-param is passed (unit callers).
    if (meta && prior && prior.carried_from && prior.carried_from.session) {
      const priorSubj = String(prior.subject || '').trim();
      const sessSubj = ('subject' in clean) ? String(clean.subject || '').trim() : '';
      if (priorSubj && sessSubj && priorSubj !== sessSubj) {
        (meta.id_collisions || (meta.id_collisions = [])).push({
          id,
          prior_session: prior.carried_from.session,
          prior_subject: prior.subject,
          session_subject: clean.subject,
        });
      }
    }
    // Generic prior-fallback: iterate the UNION of keys — every field the
    // prior record carries that the session did NOT observe this run is
    // carried over verbatim, whatever its name. An allowlist (the old
    // FALLBACK_FIELDS/ALL_FIELDS) silently drops any prior field not on the
    // list and rots the moment a new field is added (PROBE I); this does not.
    if (prior) {
      const folded = foldTaskRecords(prior, clean);
      Object.assign(clean, folded.merged);
      if (folded.sourcedFromPrior) sourcedFromPrior = true;
    }
    // Last-resort hard defaults for the DISPLAY fields only (status excluded —
    // see HARD_DEFAULTS note: an unobserved+prior-absent status stays UNKNOWN
    // so step 3 drops it rather than fabricating an open one).
    for (const f of Object.keys(HARD_DEFAULTS)) {
      if (!(f in clean)) clean[f] = HARD_DEFAULTS[f];
    }
    // Tag carried_from only when at least one field was actually sourced
    // from the prior record — a task the session fully observed gets no tag.
    if (sourcedFromPrior) {
      clean.carried_from = prior.carried_from || {session: existingPayload.session_id || null, ts: existingPayload.ts || null};
    }
    merged.set(id, clean);
  }
  // 3. Final candidacy filter over the WHOLE merged set. A row survives only
  // with a POSITIVELY-OPEN status ('pending' | 'in_progress'). Three shapes
  // are excluded here, and the third is the one the earlier "zombie guard"
  // comment wrongly claimed to cover but did not (task #14 F1):
  //   (a) a hand-edited / schema-migrated / foreign-tool prior pointer whose
  //       open_tasks still lists a terminal task — step 1 carried it, step 3
  //       drops it (defense-in-depth).
  //   (b) step 2 falling an unobserved status back to a prior record that was
  //       genuinely terminal — dropped.
  //   (c) THE REACHABLE ZOMBIE (PROBE H): a task with NO prior record and NO
  //       status observed this session. Step 2 no longer fabricates 'pending'
  //       for it (status is not in HARD_DEFAULTS), so its status is UNDEFINED
  //       and isOpenStatus(undefined) is false → excluded. UNKNOWN is not
  //       open; asserting open from zero evidence is exactly the D047 defect.
  //       (A louder surface — advisory-logging each such exclusion — could be
  //       layered on top later; exclusion is what stops the resurrection, and
  //       is kept minimal here.)
  return Array.from(merged.values()).filter(t => isOpenStatus(t.status));
}

export {extractTaskSnapshot, readTaskScanLines, mergeOpenTasks, foldTaskRecords, detectDescriptionResidue};
