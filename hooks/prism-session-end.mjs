#!/usr/bin/env node
// PRISM Stop hook — rich resume-summary writer (Gap 5)
//
// Writes: ~/.claude/.prism-sessions/<session_id>.md

import {readFileSync as r, writeFileSync as w, existsSync as e, mkdirSync as mk, statSync, openSync, readSync, closeSync, renameSync} from 'fs';
import {join as j} from 'path';
import {pathToFileURL} from 'url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {logAdvisory} from './lib/prism-advisory-log.mjs';
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';
// Slice 6 (Fix A): task-snapshot machinery extracted VERBATIM to the shared
// lib so tools/prism-repair-open-tasks.mjs runs the EXACT same extractor —
// tool/hook divergence is structurally impossible. Behavior unchanged.
import {extractTaskSnapshot, readTaskScanLines, mergeOpenTasks} from './lib/prism-task-snapshot.mjs';
import {probeTaskApiTranscript} from './lib/prism-task-api-probe.mjs';
import {prismHome} from './lib/prism-home.mjs';

// ATOMIC-WRITE-001: tempfile + renameSync with direct-write fallback.
// Matches hooks/prism-session-start.mjs:121-136 canonical pattern.
// Bounded retry (task #82/#88) absorbs the transient Windows AV/indexer
// EPERM/EACCES/EBUSY handle-contention window before falling back to a
// direct, non-atomic write — this helper is shared by the open-tasks
// pointer write, the sole on-disk source of full task descriptions when
// TaskGet is unavailable, so a real degraded write must be logged, not
// silent (D046).
function atomicWriteSync(path, content) {
  try {
    const tmp = path + '.tmp';
    w(tmp, content);
    renameWithRetry(renameSync, tmp, path);
  } catch (renameErr) {
    try {
      w(path, content);
      logAdvisory({hook: 'prism-session-end', event: 'atomic_write', path,
        status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
    } catch (fallbackErr) {
      logAdvisory({hook: 'prism-session-end', event: 'atomic_write', path,
        status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
    }
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

try {
  const input = JSON.parse(r(0, 'utf-8'));
  const sessionId = input.session_id || 'no-session';
  const transcriptPath = input.transcript_path || '';
  const cwd = input.cwd || process.cwd();
  const H = prismHome();
  const gitSha = getGitHeadSha(cwd); // SHA-STAMP-001 — stamped into every handoff artifact below

  // ── F7 Phase 3 (D072) — Stop-gated phase-0d OOB substance-review trigger ────
  // Fires the phase-0d reviewer off the Stop event (the observable latch-close
  // proxy) when a panel is in progress (latch live) AND the deterministic
  // structural panel.json has >=2 recorded seats. Per D072 phase-3, the >=2-seats
  // test is a QUALIFIER on the Stop/latch-close event, NOT a standalone early
  // trigger — so the reviewer sees a transcript that already contains the
  // challenge rounds (the whole reason we moved OFF the seat-recorder's dispatch
  // instant). Single-process, so no cross-process read-modify-write race. A STABLE
  // per-latch sha makes each turn-end fire OVERWRITE the same verdict with a
  // progressively richer review (final fire = post-challenge). Throttled to bound
  // cost over the 45-min latch TTL. Advisory only: the verdict surfaces via the
  // SessionStart REJECTED/ERROR pickup; this hook never blocks. Fully fail-open —
  // it must never disturb the resume-summary work below.
  //   Kill switch: PRISM_DISABLE_PANEL_STOP_TRIGGER=1 (also honors the global
  //   PRISM_DISABLE_OOB_REVIEW and the PRISM_PHASE_0D_OOB_PROCESS recursion guard).
  try {
    const oobDisabled = process.env.PRISM_DISABLE_OOB_REVIEW === '1'
      || process.env.PRISM_PHASE_0D_OOB_PROCESS === '1'
      || process.env.PRISM_DISABLE_PANEL_STOP_TRIGGER === '1';
    if (!oobDisabled && sessionId && sessionId !== 'no-session' && H) {
      const {isPanelLatchLive, readPanelLatch} = await import('./lib/prism-panel-latch.mjs');
      if (isPanelLatchLive(sessionId)) {
        // Resolve the EXACT structural panel.json path the seat-recorder writes
        // (shared single-source resolver — no drift).
        const {resolvePanelPath} = await import('./prism-panel-seat-recorder.mjs');
        const panelPath = resolvePanelPath(sessionId);
        let seatCount = 0;
        if (e(panelPath)) {
          try {
            const panel = JSON.parse(r(panelPath, 'utf-8'));
            seatCount = Array.isArray(panel.positions) ? panel.positions.length : 0;
          } catch { seatCount = 0; }
        }
        if (seatCount >= 2) {
          const latch = readPanelLatch(sessionId);
          const openedTs = (latch && latch.opened_ts) ? String(latch.opened_ts) : '';
          // Stable per-latch sha → each fire overwrites the same verdict file.
          const stableSha = createHash('sha256').update(sessionId + '|' + openedTs).digest('hex').slice(0, 16);
          const throttlePath = j(H, '.claude', `.prism-phase-0d-throttle-${stableSha}.json`);
          const THROTTLE_MS = (() => {
            const raw = parseInt(process.env.PRISM_PHASE_0D_THROTTLE_MS || '', 10);
            return Number.isFinite(raw) && raw >= 0 ? raw : 150_000; // ~2.5 min
          })();
          const now = Date.now();
          let lastFired = 0;
          try { lastFired = JSON.parse(r(throttlePath, 'utf-8')).last_fired_ms || 0; } catch {}
          if (now - lastFired < THROTTLE_MS) {
            logAdvisory({event: 'phase_0d_stop_trigger', action: 'throttled', session_id: sessionId,
              stable_sha: stableSha, seat_count: seatCount, since_last_ms: now - lastFired});
          } else {
            // S6: transcript_path is load-bearing — resolve via a fallback chain
            // and REFUSE to fire (log it) rather than silently degrade to '' when
            // genuinely absent.
            const transcript = (transcriptPath && e(transcriptPath)) ? transcriptPath
              : ((input.agent_transcript_path && e(input.agent_transcript_path)) ? input.agent_transcript_path : '');
            if (!transcript) {
              logAdvisory({event: 'phase_0d_stop_trigger', action: 'no_transcript_path', session_id: sessionId,
                stable_sha: stableSha, seat_count: seatCount});
            } else {
              // Stamp the throttle FIRST so a crash/timeout in the reviewer can't
              // spin-fire on the next turn.
              atomicWriteSync(throttlePath, JSON.stringify({last_fired_ms: now, stable_sha: stableSha, session_id: sessionId}));
              const oob = await import('./prism-phase-0d-oob.mjs');
              await oob.run({
                tool_name: 'Write',
                tool_input: {file_path: panelPath},
                transcript_path: transcript,
                session_id: sessionId,
                stable_sha: stableSha,
              });
              logAdvisory({event: 'phase_0d_stop_trigger', action: 'fire', session_id: sessionId,
                stable_sha: stableSha, seat_count: seatCount, panel_path: panelPath});
            }
          }
        }
      }
    }
  } catch (err) {
    try {
      logAdvisory({event: 'phase_0d_stop_trigger', action: 'error', session_id: sessionId,
        error: String((err && err.message) || err).slice(0, 300)});
    } catch {}
  }

  // ── F7 Phase 4 — 0-seats panel completion gate ──────────────────────────
  // THE GAP: the block above only acts when seatCount>=2 (and only while the
  // latch window is still LIVE — isPanelLatchLive() requires until_ts in the
  // future). There is no branch for a master that NARRATES a panel (arms the
  // latch) but never dispatches a single Agent() seat. Today that case falls
  // through silently on every Stop for the whole 45-min latch TTL — nothing
  // ever tells the master "you said panel, you dispatched nothing."
  //
  // Per the F7 Phase 1 design constraint (see prism-panel-latch.mjs's
  // "DELIBERATE DESIGN CHOICE" note), the latch has NO close event — it only
  // clears by TTL. So "window closed" is detected here the same way: reading
  // the latch record directly (NOT isPanelLatchLive(), which is true-while-
  // open) and checking `now >= until_ts`. Firing while the window is still
  // open would be premature — seats could still arrive — so this is
  // deliberately the mirror-image condition of the >=2-seats block above.
  //
  // Fires (once per latch — idempotent via a sha256(session_id+'|'+opened_ts)
  // marker, same keying pattern as the phase-0d throttle stamp above, new
  // distinct file prefix) when ALL of:
  //   (a) a latch record exists for this session,
  //   (b) the window is closed (now >= until_ts),
  //   (c) seatCount === 0, AND
  //   (d) no structural panel.json exists at all (resolvePanelPath() finds
  //       none — a panel.json with a malformed/empty positions array still
  //       counts as "instrumented" and does NOT fire this gate).
  // Advisory only — appends one routing-log event and drops a warning file
  // for SessionStart's [Prior turn] pickup (mirrors the phase-0d verdict
  // pickup pattern in prism-session-start.mjs). Never blocks; fully
  // fail-open, isolated in its own try/catch so it can never disturb the
  // resume-summary work below.
  try {
    if (sessionId && sessionId !== 'no-session' && H) {
      const {readPanelLatch} = await import('./lib/prism-panel-latch.mjs');
      const latch = readPanelLatch(sessionId);
      if (latch && latch.until_ts) {
        const untilMs = Date.parse(latch.until_ts);
        const nowMs = Date.now();
        if (Number.isFinite(untilMs) && nowMs >= untilMs) {
          const {resolvePanelPath} = await import('./prism-panel-seat-recorder.mjs');
          const panelPath = resolvePanelPath(sessionId);
          const panelExists = e(panelPath);
          let seatCount = 0;
          if (panelExists) {
            try {
              const panel = JSON.parse(r(panelPath, 'utf-8'));
              seatCount = Array.isArray(panel.positions) ? panel.positions.length : 0;
            } catch { seatCount = 0; }
          }
          if (!panelExists && seatCount === 0) {
            const openedTs = latch.opened_ts ? String(latch.opened_ts) : '';
            const gateSha = createHash('sha256').update(sessionId + '|' + openedTs).digest('hex').slice(0, 16);
            const gateMarkerPath = j(H, '.claude', `.prism-panel-completion-gate-${gateSha}.json`);
            if (!e(gateMarkerPath)) {
              // Stamp the marker FIRST (same crash-safety rationale as the
              // phase-0d throttle stamp above): a crash between here and the
              // warning-file write below must still leave this latch marked
              // fired, never a repeat on the next Stop.
              atomicWriteSync(gateMarkerPath, JSON.stringify({fired_ms: Date.now(), stable_sha: gateSha, session_id: sessionId}));
              const reason = 'panel narrated but never instrumented (0 seats, no panel.json)';
              logAdvisory({event: 'panel_completion_gate', action: 'warned', schema_version: 4,
                session_id: sessionId, active_master: latch.active_master || null, reason});
              const warningPath = j(H, '.claude', `.prism-panel-completion-warning-${sessionId}.json`);
              atomicWriteSync(warningPath, JSON.stringify({
                ts: new Date().toISOString(), session_id: sessionId,
                active_master: latch.active_master || null, message: reason,
              }));
            }
          }
        }
      }
    }
  } catch (err) {
    try {
      logAdvisory({event: 'panel_completion_gate', action: 'error', session_id: sessionId,
        error: String((err && err.message) || err).slice(0, 300)});
    } catch {}
  }

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
  let sessionTouchedIds = new Set(); // 1c — every id this session reconstructed (open OR closed); drives merge drop-logic
  if (process.env.PRISM_DISABLE_TASK_SNAPSHOT !== '1') {
    try {
      // 1b: task snapshot reads the FULL transcript (own capped pass), NOT the
      // 500KB summary tail — so Task events >500KB from EOF are no longer lost.
      const {lines: taskScanLines, tail_truncated} = readTaskScanLines(transcriptPath);
      // Slice 5 (panel-53 E1/F1): count how each Task tool_result was resolved.
      const counters = {structured_hits: 0, regex_fallbacks: 0, unmatched_task_results: 0};
      const allTasks = extractTaskSnapshot(taskScanLines, counters);
      const taskResultsSeen = counters.structured_hits + counters.regex_fallbacks + counters.unmatched_task_results;
      // degraded = the Finding-1 signature: Task results ran this session but
      // the structured reader recognized NONE of them (shape miss).
      const meta = {
        ...counters,
        tail_truncated,
        degraded: taskResultsSeen > 0 && counters.structured_hits === 0,
      };
      // LEDGER leg (E1 DETECT→LEDGER→SURFACE): one routing-log line per
      // snapshot when the extraction is degraded or the scan window was
      // truncated — fires even when zero tasks were reconstructed (the worst
      // miss must still be recorded). No stderr: SessionEnd is a dead channel.
      if (meta.degraded || tail_truncated) {
        logAdvisory({hook: 'prism-session-end', event: 'task_snapshot_integrity', session_id: sessionId, ...meta});
      }
      // DETECTION GAP (2026-07-21): the `degraded` flag above CANNOT see a
      // harness-level Task refusal ("No such tool available: TaskCreate.
      // TaskCreate exists but is not enabled in this context."), because the
      // refusal row's `toolUseResult` sibling is the error STRING — non-null,
      // so lib/prism-task-snapshot.mjs:176 counts it as a structured_hit and
      // degraded stays false. Measured on real transcripts, see
      // docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md §1b.
      // Separate, additive probe, same LEDGER leg (D046 DETECT->LEDGER->SURFACE).
      // Advisory only — blocks nothing.
      //
      // It deliberately re-reads the transcript through its OWN scan instead of
      // reusing `taskScanLines`: readTaskScanLines' prefilter (/Task|task/ AND
      // /tool_use|toolUseResult/) drops success rows whose payload lacks the
      // substring "task" while ALWAYS keeping refusal rows (their error text
      // names the tool), which biases the verdict toward "unavailable" — a
      // false positive in the dangerous direction. Same 20MB cap; bounded cost.
      //
      // BLAST-RADIUS ISOLATION (validation FINDING 1, 2026-07-21): its OWN
      // try/catch. The probe sits BEFORE the snapshot/pointer writes below and
      // inside the same outer try; without this, a throw here would skip every
      // remaining statement — destroying the task-carryover pointer and sidecar
      // SILENTLY (hook still exits 0, session .md still written). A probe built
      // to DETECT silent task loss must never CAUSE it. Regression:
      // tests/v3/state/test-prism-session-end-probe-isolation.mjs.
      try {
        const apiProbe = probeTaskApiTranscript(transcriptPath);
        if (apiProbe.status === 'unavailable' || apiProbe.status === 'mixed') {
          logAdvisory({hook: 'prism-session-end', event: 'task_api_unavailable', session_id: sessionId, ...apiProbe});
        }
      } catch {}
      sessionTouchedIds = new Set(allTasks.map(t => String(t.id)));
      if (allTasks.length) {
        // ROOT-CAUSE FIX (task #14): candidacy is now "not explicitly closed
        // this session" rather than "explicitly open this session". Before,
        // a rename-only/status-untouched TaskUpdate for a task whose
        // TaskCreate lay outside the scan window reconstructed with NO
        // `status` key at all (see upsert() in lib/prism-task-snapshot.mjs)
        // — `t.status === 'pending' || t.status === 'in_progress'` is false
        // for `undefined`, so that task silently vanished from open_tasks
        // entirely (excluded here, then ALSO excluded from mergeOpenTasks'
        // carry-forward step because sessionTouchedIds already marks it
        // touched). Passing status-unknown tasks through as candidates lets
        // mergeOpenTasks() resolve the true status from the prior pointer
        // instead of this hook guessing one.
        const openTasks = allTasks
          .filter(t => t.status === undefined || t.status === 'pending' || t.status === 'in_progress')
          .sort((a, b) => {
            const na = Number(a.id), nb = Number(b.id);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a.id).localeCompare(String(b.id));
          });

        if (openTasks.length) {
          md.push(`## Open tasks (carryover)`);
          for (const t of openTasks) {
            md.push(`- **#${t.id}** [${t.status || '?'}] ${t.subject || '(no subject)'}`);
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
          tail_truncated, // 1b — true iff transcript exceeded the 20MB task-scan cap (older Task events unseen)
          meta, // Slice 5 — extraction health stamp; SessionStart's TASK-RECALL derives its self-clearing integrity line from this
          // Root-cause fix (task #14): spread the task AS RECONSTRUCTED
          // instead of re-literal-izing every field. A literal
          // `{subject: t.subject, ...}` reconstruction would re-introduce an
          // explicit `subject: undefined` key even for a field this session
          // never observed (object literals keep an explicitly-assigned key
          // even when its value is `undefined`) — defeating the key-absence
          // signal upsert() now produces and mergeOpenTasks() depends on to
          // tell "unobserved" apart from "observed as empty/null". Spreading
          // preserves exactly the keys extractTaskSnapshot() actually set.
          open_tasks: openTasks.map(t => ({...t})),
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
    // Sidecar — this-session-only forensic/recovery record. NEVER merged (1c):
    // it must faithfully reflect what THIS session reconstructed.
    try {
      const tasksSidecarPath = j(outDir, `${sessionId}.tasks.json`);
      atomicWriteSync(tasksSidecarPath, JSON.stringify(taskSnapshotPayload, null, 2));
    } catch {}
    // Cross-session carryover pointer — MERGE with the existing pointer (1c) so
    // a prior-session task still open but untouched this session is not silently
    // dropped. Read defensively; fail-open to this session's snapshot.
    try {
      const projClaudeDir = j(cwd, '.claude');
      mk(projClaudeDir, {recursive: true});
      const pointerPath = j(projClaudeDir, '.prism-open-tasks.json');
      let existingPointer = null;
      try { if (e(pointerPath)) existingPointer = JSON.parse(r(pointerPath, 'utf-8')); } catch { existingPointer = null; }
      // Task #20 Defect B: pass the payload's meta (same ref persisted into the
      // pointer) so mergeOpenTasks can record any cross-session id collisions on
      // meta.id_collisions — SessionStart surfaces them as an ID-COLLISION line.
      const mergedOpen = mergeOpenTasks(existingPointer, taskSnapshotPayload.open_tasks, sessionTouchedIds, Date.now(), 14, taskSnapshotPayload.meta);
      const pointerPayload = {...taskSnapshotPayload, open_tasks: mergedOpen};
      atomicWriteSync(pointerPath, JSON.stringify(pointerPayload, null, 2));
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
