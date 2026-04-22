#!/usr/bin/env node
// ATLAS Stop hook — rich resume-summary writer (Gap 5)
//
// Writes: ~/.claude/.prism-sessions/<session_id>.md

import {readFileSync as r, writeFileSync as w, existsSync as e, mkdirSync as mk, statSync, openSync, readSync, closeSync} from 'fs';
import {join as j} from 'path';
import {pathToFileURL} from 'url';

try {
  const input = JSON.parse(r(0, 'utf-8'));
  const sessionId = input.session_id || 'no-session';
  const transcriptPath = input.transcript_path || '';
  const cwd = input.cwd || process.cwd();
  const H = process.env.HOME || process.env.USERPROFILE;

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
  md.push(`_Generated by prism-session-end.mjs at ${new Date().toISOString()}_`);

  const outDir = j(H, '.claude', '.prism-sessions');
  mk(outDir, {recursive: true});
  const mdPath = j(outDir, `${sessionId}.md`);
  w(mdPath, md.join('\n'));

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
} catch {}
process.exit(0);
