#!/usr/bin/env node
// PRISM Parent Dispatch Guard (v2.5.0) — PreToolUse
//
// v2.5.0: NOVEL-tier orchestrator enforcement. When the classifier marks
// a turn with summon_panel=true, the parent is REQUIRED to dispatch to
// @master-orchestrator before touching work tools. A Haiku dispatch for
// file I/O no longer unlocks the turn. Rationale: panel-summoning turns
// are architecture/strategy work — they need adversarial review, not a
// single-model synthesis in parent Opus.
//
// v2.2.1: hardened subagent pass-through. Three independent bypass paths
// for subagent-spawned tool calls, any of which passes cleanly:
//   1. input.parent_tool_use_id is set (original v2.2.0 check).
//   2. CLAUDE_CODE_ENTRYPOINT === 'subagent' (env-var signal from runtime).
//   3. sentinel.dispatched === true (parent already dispatched THIS turn,
//      so any downstream tool call — parent or child — is allowed).
// Also adds a defense-in-depth allowlist for /prism-* orchestration
// commands whose rationale is already on the sentinel from the
// orchestration-command allowlist in prism-opus-classifier.mjs.
//
// v2.2.0: classifier source changed (Opus-backed context scoring), sentinel
// shape preserved — this guard still reads {tier, force_opus, dispatched,
// summon_panel, orchestrator_dispatched} and is unaffected by the new
// classifier internals. The deny message now surfaces the classifier's
// `rationale` when present for better debugging.
//
// Reads the per-session sentinel written by prism-prompt-tier-router.mjs.
// Gating logic (in order):
//   - If tier === 'opus' AND summon_panel AND !orchestrator_dispatched:
//       DENY work tools; require Agent(subagent_type='master-orchestrator').
//   - If tier === 'opus' (no summon_panel) OR force_opus: allow.
//   - If tier ∈ {haiku, sonnet} AND parent context AND no dispatch yet:
//       DENY and tell Opus to dispatch first.
//   - Otherwise: allow.
//
// Dispatch tools (Agent, TaskCreate) are ALWAYS allowed and flip sentinel
// .dispatched=true, unlocking subsequent parent-context tool calls for
// the same turn. An Agent() call whose subagent_type is
// 'master-orchestrator' ALSO flips sentinel.orchestrator_dispatched=true,
// unlocking panel-summoning turns specifically.
//
// Subagent-context calls (input.parent_tool_use_id present, OR
// CLAUDE_CODE_ENTRYPOINT=subagent) always pass.
//
// Modes (PRISM_DISPATCH_GUARD env var, defaults to hard):
//   hard: deny blocked tools; exit 2 with deny JSON.
//   soft: emit NOTICE only; exit 0.
//   off:  pass-through.

import {readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = String(process.env.PRISM_DISPATCH_GUARD ?? 'hard').toLowerCase();

const ALWAYS_ALLOW = new Set([
  'Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'SendMessage', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  'ToolSearch', 'Skill', 'ScheduleWakeup', 'PushNotification',
  'EnterWorktree', 'ExitWorktree', 'Monitor', 'TeamCreate', 'TeamDelete',
  'CronCreate', 'CronDelete', 'CronList', 'TodoWrite',
  // v5.2.4 — read-only tools always pass. Reading is how the parent PLANS (which
  // file to inspect, what the orchestrator prompt should say). Gating these
  // forced a throwaway subagent dispatch just to read one file and created the
  // override catch-22 (live-repro 2026-06-04). Mutations (Edit/Write/Bash)
  // remain gated — this only frees up inspection, not work.
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead',
]);

const DISPATCH_MARKERS = new Set(['Agent', 'TaskCreate']);

// v5.3.3 — read-only tools never need this guard (they're in ALWAYS_ALLOW and
// only ever exit 0). The shipped matcher excludes them so the hook does not
// spawn; this set powers a top-of-guard early-exit as belt-and-suspenders for
// any pre-upgrade install still carrying the old all-tools ("") matcher.
const RO_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

// ── v5.3.2 — Read-only quick-check fast path (D-review w/ claude-master) ──────
// A 30-second diagnostic ("is this run done? why isn't X showing?") shouldn't be
// forced into a throwaway subagent. Let the PARENT run PROVABLY read-only Bash/
// PowerShell probes directly. FAIL-CLOSED: anything not provably read-only falls
// through to the normal dispatch logic (gets the usual nag/deny). This only
// removes the dispatch nag — the mutation-guard and safety hooks are SEPARATE
// PreToolUse hooks that fire regardless (most-restrictive wins), so a write or
// dangerous command is still blocked. The allowlist is the real fence (mutation-
// guard is positive-match-only and non-exhaustive — do not lean on it).
// Kill switch: PRISM_RO_BASH_FASTPATH=off.
const RO_FASTPATH = String(process.env.PRISM_RO_BASH_FASTPATH ?? 'on').toLowerCase() !== 'off';

// Leading tokens that are read-only BY CONSTRUCTION (any segment must lead with
// one of these, or with `git` + a read-only subcommand).
const RO_LEADING = new Set([
  // POSIX / Git Bash
  'ls','cat','head','tail','wc','grep','egrep','fgrep','rg','file','stat','du','df',
  'pwd','echo','printf','cut','basename','dirname','realpath','readlink',
  'date','whoami','hostname','uname','which','tree','column','nl','tac','comm','diff','jq',
  // NOTE: `sort` (-o FILE) and `uniq` (positional OUTPUT file) are deliberately
  // NOT here — both can WRITE despite a read-only-looking leading token. Piping
  // INTO them (`… | sort`) just costs a dispatch; safety wins.
  // Windows native
  'type','dir','findstr','tasklist','where','systeminfo','ver',
  // PowerShell cmdlets + common aliases (lowercased; the guard sees raw text)
  'get-content','gc','get-childitem','gci','get-item','get-itemproperty','select-string','sls',
  'get-process','gps','ps','get-service','get-location','gl','measure-object','select-object','select',
  'where-object','sort-object','format-list','format-table','ft','fl','test-path','resolve-path',
  'get-date','get-computerinfo','get-command','gcm','get-member','gm','get-history','write-output','write-host',
]);
// git read-only subcommands (the 2nd token). Anything else after `git` → refuse.
const GIT_READ = new Set([
  'status','log','diff','show','rev-parse','describe','blame','shortlog','ls-files','ls-tree',
  'cat-file','reflog','whatchanged','name-rev','merge-base','for-each-ref','count-objects','grep',
]);
// Injection / redirection / scriptblock vectors. If ANY appears → refuse (these
// can run arbitrary code or write files past the leading-token check):
//   > >>   redirection      |tee Tee-Object   write-to
//   `...`  $(...)  ${...}  <(...)   command substitution
//   {      PowerShell/awk scriptblock (e.g. `gci | ? { Remove-Item }`)
const INJECT_RE = /(>>?|\|\s*tee\b|tee-object|`|\$\(|\$\{|<\(|\{|--output\b|-outfile\b)/i;

function isReadOnlyBash(cmd) {
  if (!RO_FASTPATH) return false;
  if (typeof cmd !== 'string') return false;
  const c = cmd.trim();
  if (!c) return false;
  if (INJECT_RE.test(c)) return false;
  // env mutation (bash `export X=` / cmd `set X=` / PowerShell `$env:X =`)
  if (/(^|[\s;&|])(export|set)\s+[A-Za-z_]\w*=/.test(c)) return false;
  if (/\$env:[A-Za-z_]\w*\s*=/.test(c)) return false;
  // Per-segment leading-token validation (compound chains: every segment must
  // independently be read-only).
  const segments = c.split(/;|&&|\|\||\||&|\n/).map(s => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  for (const seg of segments) {
    const parts = seg.split(/\s+/);
    const tok = (parts[0] || '').toLowerCase();
    if (!tok) return false;
    if (tok === 'git') {
      const sub = (parts[1] || '').toLowerCase();
      if (!GIT_READ.has(sub)) return false;  // git WRITE subcommands refused here
      continue;
    }
    if (!RO_LEADING.has(tok)) return false;
  }
  return true;
}

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// v2.8.0: atomic write — tempfile + rename. Prevents truncated sentinel JSON
// from crashes mid-write (disk-full, antivirus interference, or node process
// kill). Readers downstream (other guards, weekly rollup) never see a
// partially-written file.
function writeSentinel(sessionId, sentinel) {
  try {
    const p = sentinelPath(sessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(sentinel, null, 2));
    // renameSync is atomic on POSIX + Windows (same filesystem). If the
    // rename fails mid-operation, either the old file remains (reader gets
    // stale but valid JSON) or the new file is in place — never both nor
    // neither.
    renameSync(tmp, p);
  } catch {
    // Fallback: direct write. On catastrophic failure (disk full mid-write),
    // this could truncate — but readers have try/catch JSON.parse guards,
    // so worst case is a null sentinel on the next read and one
    // classifier-floor routing decision. Acceptable degradation.
    try { writeFileSync(sentinelPath(sessionId), JSON.stringify(sentinel, null, 2)); } catch {}
  }
}

function markDispatched(sessionId, sentinel) {
  sentinel.dispatched = true;
  sentinel.dispatched_ts = new Date().toISOString();
  writeSentinel(sessionId, sentinel);
}

function markOrchestratorDispatched(sessionId, sentinel) {
  sentinel.orchestrator_dispatched = true;
  sentinel.orchestrator_dispatched_ts = new Date().toISOString();
  writeSentinel(sessionId, sentinel);
}

try {
  if (MODE === 'off') process.exit(0);

  const raw = readFileSync(0, 'utf-8');
  const input = JSON.parse(raw || '{}');
  const toolName = input.tool_name || '';
  const isSubagent = !!input.parent_tool_use_id;
  const sessionId = input.session_id || 'anon';

  // v5.3.3 — read-only fast exit (see RO_TOOLS): these are always allowed; skip
  // all work (sentinel read, logging) so a stray spawn is microseconds of JS.
  if (RO_TOOLS.has(toolName)) process.exit(0);

  // --- v2.2.1: subagent bypass paths (any one passes cleanly) ---
  if (isSubagent) process.exit(0);
  if (String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent') {
    process.exit(0);
  }
  // ----------------------------------------------------------------

  // FIX-A (v5.x): the conversation-model tier-override file is the documented
  // in-session escape from a (possibly false-positive) panel/dispatch block.
  // It MUST stay writable even when work tools are denied — otherwise the
  // override is unreachable and the turn deadlocks (v5.0 stress-test finding).
  // FIX-A2 (v5.x): Read MUST be included — the Write tool requires a prior Read
  // when the override file already exists (it does; the router writes it every
  // turn), so omitting Read re-deadlocks the documented escape. (finding #1, live-repro 2026-06-02)
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const fp = String(input.tool_input?.file_path || '');
    if (/[/\\]\.prism-turn-tier-[^/\\]*\.json$/.test(fp)) process.exit(0);
  }

  // v5.3.2 — read-only quick-check fast path: a provably non-mutating Bash/
  // PowerShell probe runs in the parent without a forced dispatch. Fail-closed
  // (non-read-only → falls through to the normal dispatch logic below).
  // mutation-guard + safety fire independently and still block writes.
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = input.tool_input?.command || input.tool_input?.cmd || '';
    if (isReadOnlyBash(cmd)) {
      appendLog({ts: new Date().toISOString(), event: 'dispatch_guard_ro_bash', session_id: sessionId, tool: toolName, mode: MODE});
      process.exit(0);
    }
  }

  if (ALWAYS_ALLOW.has(toolName)) {
    if (DISPATCH_MARKERS.has(toolName)) {
      const sentinel = readSentinel(sessionId);
      if (sentinel) {
        if (!sentinel.dispatched) markDispatched(sessionId, sentinel);
        // v2.5.0: detect master-orchestrator dispatch specifically.
        const target = String(
          input.tool_input?.subagent_type ||
          input.tool_input?.agent_type ||
          ''
        ).toLowerCase();
        if (target === 'master-orchestrator' && !sentinel.orchestrator_dispatched) {
          markOrchestratorDispatched(sessionId, readSentinel(sessionId) || sentinel);
        }
      }
    }
    process.exit(0);
  }

  const sentinel = readSentinel(sessionId);
  if (!sentinel) process.exit(0);
  if (sentinel.force_opus) process.exit(0);

  // v2.5.0: NOVEL-tier orchestrator gate.
  // Opus tier with summon_panel requires @master-orchestrator dispatch first.
  // Haiku dispatches for file I/O do NOT satisfy this — only master-orchestrator does.
  const isPanelTurn = sentinel.tier === 'opus' && sentinel.summon_panel === true;
  // v5.2.5: when a project-master is the active agent (self_chair), the master
  // chairs the panel itself in the main loop — its OWN expert dispatch
  // (dispatched=true) opens the gate, and it must NOT nest a @master-orchestrator.
  // Generic turns (no project-master) still require an @master-orchestrator dispatch.
  const panelGateOpen = sentinel.orchestrator_dispatched || (sentinel.self_chair && sentinel.dispatched);
  if (isPanelTurn && !panelGateOpen) {
    const why = sentinel.rationale ? ` Reason: ${sentinel.rationale}` : '';
    const panelNotice = (sentinel.self_chair ? [
      `PRISM DISPATCH-GUARD: ${toolName} denied — PANEL-SUMMONING turn and you (${sentinel.active_master || 'the project-master'}) have not yet dispatched a panel member.${why}`,
      `You ARE the orchestrator (you load the master-orchestrator skill). Chair the panel yourself: dispatch your expert panel members directly as independent, parallel subagents, then synthesize. Do NOT dispatch a nested @master-orchestrator — as a subagent it cannot spawn the panel and would only role-play.`,
      `Parent Write/Edit/Bash unblock once you have dispatched at least one panel member. Override: prefix the user prompt with !opus-force: or set PRISM_DISPATCH_GUARD=off.`,
    ] : [
      `PRISM DISPATCH-GUARD: ${toolName} denied — this is a PANEL-SUMMONING turn (opus tier, summon_panel=true).${why}`,
      `You MUST spawn @master-orchestrator as your next action. The orchestrator will assemble an expert panel, chair adversarial review, and return a synthesized plan for you to relay.`,
      `Use: Agent({subagent_type:'master-orchestrator', model:'opus', prompt:'<original user request, verbatim>'})`,
      `Direct Write/Edit/Bash work in parent context is blocked on panel turns until the orchestrator has been invoked. Override: prefix the user prompt with !opus-force: (skips panel, uses direct Opus) or set PRISM_DISPATCH_GUARD=off.`,
    ]).join('\n');

    appendLog({
      event: 'dispatch_guard_panel',
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: toolName,
      tier: sentinel.tier,
      summon_panel: true,
      orchestrator_dispatched: !!sentinel.orchestrator_dispatched,
      blocked: MODE === 'hard',
      mode: MODE,
    });

    if (MODE === 'hard') {
      const deny = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: panelNotice,
        },
      };
      process.stdout.write(JSON.stringify(deny));
      process.exit(2);
    }
    process.stdout.write(panelNotice);
    process.exit(0);
  }

  // Opus tier without panel signal: parent can act directly.
  if (sentinel.tier === 'opus') process.exit(0);

  // v2.2.1 Path 3: haiku/sonnet tier + already dispatched → pass.
  if (sentinel.dispatched) process.exit(0);

  // Defense-in-depth: orchestration-command allowlist match → pass.
  if (typeof sentinel.rationale === 'string' &&
      /orchestration command \/prism-/i.test(sentinel.rationale)) {
    process.exit(0);
  }

  // Haiku/Sonnet tier, parent context, no dispatch yet → deny.
  const why = sentinel.rationale ? ` Reason: ${sentinel.rationale}` : '';
  const notice = [
    `PRISM DISPATCH-GUARD: ${toolName} denied in parent context — this turn routed to ${sentinel.tier}-tier.${why}`,
    `Dispatch the work first via Agent({subagent_type:'general-purpose', model:'${sentinel.tier}', prompt:'<task>'}) or TaskCreate/plan.`,
    `After one dispatch, subsequent parent tools are allowed. Override: prefix the user prompt with !opus-force: (or set PRISM_DISPATCH_GUARD=off).`,
  ].join('\n');

  appendLog({
    event: 'dispatch_guard',
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
    tier: sentinel.tier,
    score: sentinel.score,
    blocked: MODE === 'hard',
    mode: MODE,
  });

  if (MODE === 'hard') {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: notice,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(2);
  }

  process.stdout.write(notice);
  process.exit(0);
} catch {
  process.exit(0);
}
