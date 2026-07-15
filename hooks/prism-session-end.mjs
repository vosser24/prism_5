#!/usr/bin/env node
// PRISM Stop hook — rich resume-summary writer (Gap 5)
//
// Writes: ~/.claude/.prism-sessions/<session_id>.md

import {readFileSync as r, writeFileSync as w, existsSync as e, mkdirSync as mk, statSync, openSync, readSync, closeSync, renameSync} from 'fs';
import {join as j} from 'path';
import {pathToFileURL} from 'url';
import {spawnSync} from 'node:child_process';

// ATOMIC-WRITE-001: tempfile + renameSync with direct-write fallback.
// Matches hooks/prism-session-start.mjs:121-136 canonical pattern.
function atomicWriteSync(path, content) {
  try {
    const tmp = path + '.tmp';
    w(tmp, content);
    renameSync(tmp, path);
  } catch {
    try { w(path, content); } catch {}
  }
}

// ── SHA-STAMP-001 (recall-hardening v6.2.0, Task #2) ────────────────────────
// Every handoff artifact this hook writes (session .md, task-snapshot
// sidecar, project-local open-tasks pointer) gets the current git HEAD sha
// stamped in, so SessionStart can tell whether a resumed handoff is still
// current vs superseded by later commits (see hooks/prism-session-start.mjs's
// TASK-RECALL staleness check — the consumer of this stamp). Fail-open by
// construction: no git binary, cwd not a repo, detached HEAD, or a shallow
// clone all just yield null (`git rev-parse HEAD` still resolves fine in a
// detached/shallow state, so those aren't actually failure cases — only a
// genuinely missing/broken git is). `timeout` bounds the spawn so a hung git
// process can never block SessionEnd.
function getGitHeadSha(cwd) {
  try {
    const res = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {encoding: 'utf-8', timeout: 2000});
    if (res.status === 0 && res.stdout) {
      const sha = res.stdout.trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
    }
  } catch {}
  return null;
}

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
function extractTaskSnapshot(rawLines) {
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
      const tur = obj.tool_use_result || null; // sibling of `message`
      const resultText = typeof c.content === 'string' ? c.content : '';

      if (call.name === 'TaskCreate') {
        let id = (tur && tur.task && tur.task.id != null) ? tur.task.id : null;
        if (id === null) { const m = resultText.match(/Task #(\S+)/); if (m) id = m[1]; }
        if (id !== null) {
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
      pendingCalls.delete(c.tool_use_id);
    }
  }

  return Array.from(tasks.values());
}

try {
  const input = JSON.parse(r(0, 'utf-8'));
  const sessionId = input.session_id || 'no-session';
  const transcriptPath = input.transcript_path || '';
  const cwd = input.cwd || process.cwd();
  const H = process.env.HOME || process.env.USERPROFILE;
  const gitSha = getGitHeadSha(cwd); // SHA-STAMP-001 — stamped into every handoff artifact below

  if (!transcriptPath || !e(transcriptPath)) process.exit(0);

  const stats = statSync(transcriptPath);
  const maxBytes = 500 * 1024;
  const start = Math.max(0, stats.size - maxBytes);
  const fd = openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(stats.size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  const tail = buf.toString('utf-8');

  const lines = tail.split(/\r?\n/);
  const filesTouched = new Set();
  const modelsUsed = new Set();
  const subagents = {};
  let projects = new Set([cwd.split(/[/\\]/).pop() || 'unknown']);
  let totalTokens = 0;
  let totalCost = 0;
  let lastUserPrompt = '';
  let lastAssistantText = '';
  let firstTs = null, lastTs = null;

  const PRICE = {
    'opus-4': [15, 75, 18.75, 1.5],
    'opus-4-6': [15, 75, 18.75, 1.5],
    'opus-4-7': [15, 75, 18.75, 1.5],
    'sonnet-4': [3, 15, 3.75, 0.3],
    'sonnet-4-5': [3, 15, 3.75, 0.3],
    'sonnet-4-6': [3, 15, 3.75, 0.3],
    'haiku-4': [1, 5, 1.25, 0.1],
    'haiku-4-5': [1, 5, 1.25, 0.1],
  };
  const modelKey = (m) => {
    if (!m) return '';
    const parts = m.replace('claude-', '').split('-');
    if (parts.length && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();
    return parts.join('-');
  };
  const costFor = (m, u) => {
    const k = modelKey(m);
    if (!PRICE[k]) return 0;
    const [ip, op, cw, cr] = PRICE[k];
    return (
      (u.input_tokens || 0) * ip / 1e6 +
      (u.output_tokens || 0) * op / 1e6 +
      (u.cache_creation_input_tokens || 0) * cw / 1e6 +
      (u.cache_read_input_tokens || 0) * cr / 1e6
    );
  };

  const parentToType = {};

  // --- Phase 5.3 lesson extraction ---
  const lessons = []; // {ts, type, evidence}
  const ERROR_RE = /(?:^|\b)(?:TypeError|ValueError|SyntaxError|ReferenceError|AttributeError|ImportError|ModuleNotFoundError|KeyError|IndexError|PermissionError|FileNotFoundError|RuntimeError|AssertionError|Unhandled\s+\w+|Uncaught\s+\w+):\s*(.{10,200})/;
  const CORRECTION_RE = /^\s*(?:no|don'?t|stop|actually|wait|not\s+that|that'?s\s+wrong|incorrect|wrong)\b[,.\s:]/i;
  const CLAUDE_MD_RE = /(?:^|[/\\])CLAUDE(?:\.local)?\.md$/i;
  const seenErrors = new Set(); // dedupe within session

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.timestamp) { if (!firstTs) firstTs = obj.timestamp; lastTs = obj.timestamp; }
    if (obj.cwd) {
      const p = obj.cwd.split(/[/\\]/).pop(); if (p) projects.add(p);
    }

    if (obj.type === 'user' && typeof obj.message?.content === 'string') {
      const txt = obj.message.content.trim();
      if (txt && !txt.startsWith('<') && !txt.startsWith('[')) {
        lastUserPrompt = txt;
        if (CORRECTION_RE.test(txt)) {
          lessons.push({ts: obj.timestamp || null, type: 'user_correction', evidence: txt.slice(0, 300)});
        }
      }
    }

    // Tool results often contain errors — scan for novel error signatures.
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const scan = (t) => {
          const m = typeof t === 'string' ? t.match(ERROR_RE) : null;
          if (m && !seenErrors.has(m[0])) {
            seenErrors.add(m[0]);
            lessons.push({ts: obj.timestamp || null, type: 'error_seen', evidence: m[0].slice(0, 300)});
          }
        };
        if (c.type === 'tool_result' && typeof c.content === 'string') scan(c.content);
        else if (c.type === 'tool_result' && Array.isArray(c.content)) {
          for (const inner of c.content) if (inner.type === 'text') scan(inner.text);
        }
      }
    }

    const am = obj.message;
    if (am && am.role === 'assistant' && Array.isArray(am.content)) {
      if (am.model) modelsUsed.add(am.model);
      if (am.usage) {
        totalTokens += (am.usage.input_tokens || 0) + (am.usage.output_tokens || 0)
          + (am.usage.cache_creation_input_tokens || 0) + (am.usage.cache_read_input_tokens || 0);
        totalCost += costFor(am.model, am.usage);
      }
      for (const c of am.content) {
        if (c.type === 'text' && c.text) lastAssistantText = c.text;
        if (c.type === 'tool_use') {
          if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit') && c.input?.file_path) {
            filesTouched.add(c.input.file_path);
            if (CLAUDE_MD_RE.test(c.input.file_path)) {
              lessons.push({ts: obj.timestamp || null, type: 'claude_md_write', evidence: c.input.file_path});
            }
          }
          if (c.name === 'Agent' && c.id) {
            parentToType[c.id] = c.input?.subagent_type || c.input?.description || 'agent';
          }
        }
      }
    }

    if (obj.type === 'progress' && obj.data?.type === 'agent_progress') {
      const inner = obj.data.message || {};
      const deeper = inner.message || {};
      const model = inner.model || deeper.model;
      const usage = inner.usage || deeper.usage;
      const aid = obj.data.agentId;
      if (model && usage && aid) {
        subagents[aid] = subagents[aid] || { type: parentToType[obj.parentToolUseID] || 'agent', model, tokens: 0, cost: 0 };
        subagents[aid].tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        subagents[aid].cost += costFor(model, usage);
        modelsUsed.add(model);
      }
    }
  }

  const lastAssistantShort = lastAssistantText.slice(-2000);
  const questionMatches = (lastAssistantShort.match(/[^.!?\n]{5,200}\?/g) || []).slice(-5);

  const shortFiles = Array.from(filesTouched).slice(-15);
  const subArr = Object.values(subagents);
  const ts = (s) => s ? new Date(s).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '';

  const md = [];
  md.push(`# Session ${sessionId}`);
  md.push('');
  md.push(`- **Start:** ${ts(firstTs)}`);
  md.push(`- **End:**   ${ts(lastTs)}`);
  md.push(`- **Projects:** ${Array.from(projects).join(', ')}`);
  md.push(`- **Git HEAD:** ${gitSha || '(unknown — not a git repo or git unavailable)'}`);
  md.push(`- **Models used:** ${Array.from(modelsUsed).join(', ') || '(none detected)'}`);
  md.push(`- **Total tokens:** ${totalTokens.toLocaleString()}`);
  md.push(`- **Estimated cost:** $${totalCost.toFixed(4)}`);
  md.push('');
  md.push(`## Files touched (last 15)`);
  if (shortFiles.length) {
    for (const f of shortFiles) md.push(`- ${f}`);
  } else md.push('_(none)_');
  md.push('');
  md.push(`## Subagents spawned`);
  if (subArr.length) {
    for (const s of subArr) md.push(`- **${s.type}** (${s.model}) — ${s.tokens.toLocaleString()} tokens · $${s.cost.toFixed(4)}`);
  } else md.push('_(none)_');
  md.push('');
  md.push(`## Last user prompt`);
  md.push('```');
  md.push(lastUserPrompt.slice(0, 1000) || '(empty)');
  md.push('```');
  md.push('');
  md.push(`## Unresolved (questions in final assistant message)`);
  if (questionMatches.length) {
    for (const q of questionMatches) md.push(`- ${q.trim()}`);
  } else md.push('_(none detected)_');
  md.push('');

  // ── C5 (recall-hardening v6.2.0): Task API snapshot / carryover ──────────
  // Reconstructs final per-task state from the same `lines` array tokenized
  // above, appends a "## Open tasks (carryover)" section (non-completed
  // tasks only, FULL untruncated description), and writes the sidecar +
  // project-local pointer consumed by SessionStart's TASK-RECALL (C6).
  // Graceful no-op if no Task events occurred this session. Off-switch:
  // PRISM_DISABLE_TASK_SNAPSHOT=1. Fail-open — never breaks SessionEnd.
  let taskSnapshotPayload = null;
  if (process.env.PRISM_DISABLE_TASK_SNAPSHOT !== '1') {
    try {
      const allTasks = extractTaskSnapshot(lines);
      if (allTasks.length) {
        const openTasks = allTasks
          .filter(t => t.status === 'pending' || t.status === 'in_progress')
          .sort((a, b) => {
            const na = Number(a.id), nb = Number(b.id);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a.id).localeCompare(String(b.id));
          });

        if (openTasks.length) {
          md.push(`## Open tasks (carryover)`);
          for (const t of openTasks) {
            md.push(`- **#${t.id}** [${t.status}] ${t.subject || '(no subject)'}`);
            if (t.description) md.push(`  ${t.description}`);
            if (t.blockedBy) {
              const b = Array.isArray(t.blockedBy) ? t.blockedBy.join(', ') : t.blockedBy;
              md.push(`  _blockedBy: ${b}_`);
            }
          }
          md.push('');
        }

        taskSnapshotPayload = {
          session_id: sessionId,
          project: cwd,
          ts: new Date().toISOString(),
          git_sha: gitSha, // SHA-STAMP-001 — null when not resolvable; consumed by SessionStart's staleness check
          open_tasks: openTasks.map(t => ({
            id: t.id,
            subject: t.subject,
            description: t.description,
            activeForm: t.activeForm,
            status: t.status,
            blockedBy: t.blockedBy ?? null,
          })),
        };
      }
    } catch {}
  }

  md.push(`_Generated by prism-session-end.mjs at ${new Date().toISOString()}_`);

  const outDir = j(H, '.claude', '.prism-sessions');
  mk(outDir, {recursive: true});
  const mdPath = j(outDir, `${sessionId}.md`);
  atomicWriteSync(mdPath, md.join('\n'));

  // C5 (recall-hardening v6.2.0): write the task sidecar + project-local
  // pointer now that mdPath's directory is guaranteed to exist. Only fires
  // when this session actually touched the Task API (taskSnapshotPayload is
  // null otherwise — including when PRISM_DISABLE_TASK_SNAPSHOT=1). Written
  // unconditionally on Task-API activity (even when open_tasks is empty) so
  // a session that closes out all prior open tasks correctly clears the
  // carryover pointer instead of leaving a stale one for SessionStart to
  // re-surface. Both writes are independently fail-open.
  if (taskSnapshotPayload) {
    try {
      const tasksSidecarPath = j(outDir, `${sessionId}.tasks.json`);
      atomicWriteSync(tasksSidecarPath, JSON.stringify(taskSnapshotPayload, null, 2));
    } catch {}
    try {
      const projClaudeDir = j(cwd, '.claude');
      mk(projClaudeDir, {recursive: true});
      atomicWriteSync(j(projClaudeDir, '.prism-open-tasks.json'), JSON.stringify(taskSnapshotPayload, null, 2));
    } catch {}
  }

  // Phase 5.3: write lesson rows to ~/.claude/.prism-lessons.jsonl (append-only).
  try {
    if (lessons.length) {
      const {appendFileSync} = await import('fs');
      const lessonsPath = j(H, '.claude', '.prism-lessons.jsonl');
      const now = new Date().toISOString();
      const out = lessons.map(L => JSON.stringify({
        ts: L.ts || now,
        session_id: sessionId,
        type: L.type,
        evidence: L.evidence,
      })).join('\n') + '\n';
      appendFileSync(lessonsPath, out);
    }
  } catch {}

  // Phase 4 dual-write: mirror session digest into SQLite sessions table.
  try {
    const mod = await import(pathToFileURL(j(H, '.claude', 'tools', 'prism-db.mjs')).href);
    const db = mod.openDb();
    mod.upsertSession(db, {
      session_id: sessionId,
      start_ts: ts(firstTs) || null,
      end_ts: ts(lastTs) || null,
      projects: Array.from(projects).join(', '),
      models: Array.from(modelsUsed).join(', '),
      total_tokens: totalTokens,
      total_cost_usd: Number(totalCost.toFixed(6)),
      last_user_prompt: (lastUserPrompt || '').slice(0, 4000),
      md_path: mdPath,
      mtime: Date.now(),
    });
    mod.close(db);
  } catch {}

  // ── Phase 3c: drain the KB-dirty flag (detached background refresh) ──
  try {
    const dirtyFlag = j(H, '.claude', '.prism-kb-dirty');
    if (e(dirtyFlag)) {
      const paths = r(dirtyFlag, 'utf-8').split(/\r?\n/).filter(Boolean);
      if (paths.length) {
        const {spawn} = await import('child_process');
        const rebuildPath = j(H, '.claude', 'tools', 'prism-kb-rebuild.mjs');
        const child = spawn('node', [rebuildPath, '--sync', '--quiet'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      }
      try { (await import('fs')).unlinkSync(dirtyFlag); } catch {}
    }
  } catch {}

  // ── v5.0 F4: drain the KNOWLEDGE-dirty flag (detached cross-project rebuild) ──
  // Separate flag + separate rebuilder from the resource index above, so the two
  // never couple (design §5). The rebuilder reads the flag itself to derive the
  // changed project root(s); we only check presence + spawn it detached, then the
  // rebuilder clears the flag. We do NOT unlink here (the child owns the drain).
  try {
    const kDirtyFlag = j(H, '.claude', '.prism-kb-knowledge-dirty');
    if (e(kDirtyFlag)) {
      const kPaths = r(kDirtyFlag, 'utf-8').split(/\r?\n/).filter(Boolean);
      if (kPaths.length) {
        const {spawn} = await import('child_process');
        const kRebuildPath = j(H, '.claude', 'tools', 'prism-kb-knowledge-rebuild.mjs');
        const child = spawn('node', [kRebuildPath, '--sync', '--quiet'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } else {
        try { (await import('fs')).unlinkSync(kDirtyFlag); } catch {}
      }
    }
  } catch {}

  // ── v4.4 revival: deterministic SessionEnd consumer for the Phase 1.5
  // evidence-discipline ratchet (D040 — a durable signal must propagate
  // deterministically, never a manual step that can silently fail). Prior to
  // this, `--apply-ratchet` only ran under the manual /prism-clean path
  // (tools/prism-clean.mjs:288-300); a session that never runs /prism-clean
  // left ~/.claude/.prism-phase-1-5-verdicts.jsonl un-drained indefinitely.
  // Mirrors the detached-spawn pattern used by the KB-dirty drains above
  // exactly (spawn, detached:true/stdio:'ignore'/windowsHide:true, unref()).
  // Fail-open by construction: try/catch around the whole block, and the
  // ratchet tool itself is fail-open on a missing/empty verdict log.
  try {
    const verdictLog = j(H, '.claude', '.prism-phase-1-5-verdicts.jsonl');
    if (e(verdictLog) && process.env.PRISM_DISABLE_OOB_RATCHET !== '1') {
      const {spawn} = await import('child_process');
      const rosterToolPath = j(H, '.claude', 'tools', 'prism-roster.mjs');
      const child = spawn('node', [rosterToolPath, '--apply-ratchet'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
  } catch {}
} catch {}
process.exit(0);
