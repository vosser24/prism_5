#!/usr/bin/env node
// PRISM Parent Dispatch Guard (v2.7.0) — PreToolUse
//
// v2.7.0 (D043, agent-teams topology): the `dispatched` flag is a session-global
// boolean with no caller dimension, so under agent-teams (teammates sharing one
// session_id) it cannot gate per-caller — producing loud false-DENIES and SILENT
// false-ALLOWS. Three changes, all gated behind PRISM_DISPATCH_GUARD_TEAMS
// (advisory=default | hard) and fail-safe to prior behavior when the teams marker
// (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) is absent: (1) in teams+advisory the
// dispatched-gated hard-deny downgrades to an advisory (closes the false-deny);
// (2) every borrowed unlock (dispatched=true allow in teams) is logged
// (`borrowed_unlock`) + flagged in-band (makes the silent false-allow visible);
// (3) the deny's single-actor remediation text now carries the shared-session
// caveat. See the TEAMS_MODE block below and docs/prism/adjudications/D043.
//
// v2.6.0 (Package F): fix the dispatch-guard dead-end false-positive that blocked
// legitimately-dispatched research subagents. Root cause (live-repro 2026-07-06):
// a dispatched specialist's WebFetch/WebSearch (and some Bash) were HARD-DENIED
// with PARENT rules because all THREE subagent signals evaluated false for that
// subagent's payload — parent_tool_use_id absent, CLAUDE_CODE_ENTRYPOINT not set
// on the hook process, and sentinel.dispatched only checked AFTER the panel/tier
// deny fires (unreachable for WebFetch/WebSearch, which are not in ALWAYS_ALLOW).
// Worse, the deny's remediation told the caller to "dispatch via Agent(...)" —
// IMPOSSIBLE from a subagent (Agent is denied by the nested-dispatch guard / not
// exposed at depth 5). Two-layer fix:
//   (i)  DEFENSE-IN-DEPTH: read-only research/inspection tools (Read, Grep, Glob,
//        LS, NotebookRead, WebFetch, WebSearch) are ALWAYS allowed in ANY context
//        via a top-of-guard fast-exit (RO_EXEMPT). Detection-independent: even if
//        every subagent signal fails, read-only work never dead-ends. Mutating
//        tools (Bash/Edit/Write/MultiEdit/NotebookEdit) stay gated.
//   (ii) remediation messages no longer instruct an impossible Agent() call from
//        subagent context — they branch on parent vs subagent and point subagents
//        at the read-only tools + return-to-main-loop, plus the env override.
// NOTE: the same 3-signal subagent detection is duplicated across sibling guards
// (prism-mutation-guard, prism-agent-model-guard, prism-parallel-guard,
// prism-task-tier-advisor, prism-dispatch-dedup-guard, prism-specialist-routing-
// guard). Package F does NOT touch them — a shared inSubagentContext() helper is
// a follow-up refactor.
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
// v5.7.6 — nested-dispatch guard mode (hard|soft|off). Independent kill switch;
// the master PRISM_DISPATCH_GUARD=off disables this too (early-return below).
const NESTED_MODE = String(process.env.PRISM_NESTED_DISPATCH_GUARD ?? 'hard').toLowerCase();

// v6.4.0 (D043) — AGENT-TEAMS TOPOLOGY HANDLING.
// Under agent-teams every teammate is a top-level CLI session sharing ONE
// session_id, so `sentinel.dispatched` (a session-global boolean with no caller
// dimension) cannot gate per-caller: any teammate's Agent/TaskCreate unlocks
// EVERY teammate, and any teammate's next message re-locks all of them. This
// single root cause produces BOTH a loud false-DENY (a legit worker blocked
// because the shared flag was just reset) AND a SILENT false-ALLOW (a teammate
// mutates freely because an unrelated teammate dispatched moments earlier). The
// false-allow is invisible by construction — no log line, no advisory (D043,
// docs/prism/deviations/2026-07-14-guard-forensics-shared-sentinel-latch.md).
//
// PRISM_DISPATCH_GUARD_TEAMS: advisory (default) | hard
//   advisory → in teams topology the `dispatched`-gated HARD-DENY DOWNGRADES to
//              an advisory (exit 0 + additionalContext) — a coin-flip deny that
//              cannot distinguish a legit dispatched worker from a false positive
//              should not block work; AND every borrowed unlock (a dispatched=true
//              allow) is LOGGED (`borrowed_unlock`) + flagged in-band, so the
//              structurally-invisible false-allow becomes visible + measurable.
//   hard     → restore the prior single-actor hard-deny even under teams (opt-in
//              for an operator who wants the old behavior wholesale).
// FAIL-SAFE (D039): the teams marker ABSENT or unreadable → prior HARD behavior,
// UNCHANGED — zero regression for a genuine single-actor parent. The master
// switch PRISM_DISPATCH_GUARD=off still disables the whole guard (early-return).
const TEAMS_MODE = String(process.env.PRISM_DISPATCH_GUARD_TEAMS ?? 'advisory').toLowerCase();
const IN_AGENT_TEAMS = String(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS || '') === '1';

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

// v5.3.3 / Package F (v2.6.0) — read-only research + inspection tools are ALWAYS
// allowed, in ANY context (parent OR subagent), independent of tier or subagent
// detection. Rationale (Package F root cause, live-repro 2026-07-06): a
// genuinely-dispatched research specialist whose payload carried NONE of the
// three subagent signals hit a PARENT-context deny on WebFetch/WebSearch — and
// the deny's remediation ("spawn @master-orchestrator via Agent(...)") is
// IMPOSSIBLE from inside a subagent (Agent is denied by the nested-dispatch guard
// / not exposed at depth 5 -> "No such tool available"). That is a dead-end
// false-positive. These tools carry NO mutation risk, so exempting them can never
// weaken the guard's purpose; it only stops read-only work from dead-ending —
// even when detection fails (defense-in-depth). This set also powers a
// top-of-guard early-exit as belt-and-suspenders for any pre-upgrade install
// still carrying the old all-tools ("") matcher.
// Bash/Edit/Write/MultiEdit/NotebookEdit are DELIBERATELY excluded — they can
// mutate and must stay gated in parent context.
const RO_EXEMPT = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);

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
  // v5.7.8: `cd <path>` is read-only by construction (it mutates no files; `cd $(…)`
  // is already blocked by INJECT_RE). Including it lets the ubiquitous
  // `cd dir && git status` verification pattern run in-parent instead of being
  // force-dispatched just because segment 1 led with `cd`.
  'cd',
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
  let c = cmd.trim();
  if (!c) return false;
  // v5.7.9: neutralize harmless sink/merge redirects (they write NO file) before
  // the redirect/inject check, so read-only probes like `git status 2>/dev/null`
  // and `... 2>&1 | head` run in-parent instead of being force-dispatched. Only
  // redirects whose target is another fd (`2>&1`) or the null device
  // (`/dev/null`, `NUL`) are matched; real file redirects (`> f`, `2> err.log`)
  // are NOT matched and remain blocked by INJECT_RE below.
  c = c.replace(/(?:[0-9]*>&\s*[0-9]+)|(?:(?:[0-9]*|&)>{1,2}\s*(?:\/dev\/null|nul)\b)/gi, ' ').replace(/\s+/g, ' ').trim();
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

// v5.7: dual-mode. run(input) returns {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the original
// wire behavior (byte-identical, verified by golden-master).
export function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});
  try {
  if (MODE === 'off') return done(0);

  const toolName = input.tool_name || '';
  const isSubagent = !!input.parent_tool_use_id;
  const sessionId = input.session_id || 'anon';

  // v5.3.3 / Package F — read-only exempt fast exit (see RO_EXEMPT): always
  // allowed in ANY context; skip all work (sentinel read, logging) so a stray
  // spawn is microseconds of JS. Package F adds WebFetch/WebSearch so a
  // dispatched research specialist can never dead-end on the web.
  if (RO_EXEMPT.has(toolName)) return done(0);

  // v6.2.0 — dispatch-signal diagnostic (opt-in). Logs which subagent-detection
  // signals are present on each Agent() call so a nested-chain incident can be
  // diagnosed empirically (does parent_tool_use_id propagate at depth on THIS
  // build?). Off by default. Env PRISM_DISPATCH_DIAG=on.
  if (toolName === 'Agent' && String(process.env.PRISM_DISPATCH_DIAG || 'off').toLowerCase() === 'on') {
    appendLog({
      event: 'dispatch_signal_diag',
      ts: new Date().toISOString(),
      session_id: sessionId,
      has_parent_tool_use_id: !!input.parent_tool_use_id,
      entrypoint: String(process.env.CLAUDE_CODE_ENTRYPOINT || ''),
      target: String(input.tool_input?.subagent_type || input.tool_input?.agent_type || ''),
    });
  }

  // v6.2.0 — nested-CLI spawn guard: shelling out to a non-interactive
  // `claude -p` / `--print` launches an out-of-band nested agent session that
  // never presents as an Agent tool_use, so the nested-dispatch guard below
  // never sees it (evasion path #2, 2026-07-10 analysis). Warn (default) or deny.
  // Env PRISM_NESTED_CLI_GUARD = warn (default) | hard | off.
  const NESTED_CLI_MODE = String(process.env.PRISM_NESTED_CLI_GUARD ?? 'warn').toLowerCase();
  if ((toolName === 'Bash' || toolName === 'PowerShell') && NESTED_CLI_MODE !== 'off') {
    const cliCmd = String(input.tool_input?.command || input.tool_input?.cmd || '');
    if (/(?:^|[\s;&|(`$])claude\b[^\n]*?(?:\s-p\b|\s--print\b|\s-p$)/i.test(cliCmd)) {
      appendLog({event: 'nested_cli_guard', ts: new Date().toISOString(), session_id: sessionId, mode: NESTED_CLI_MODE, blocked: NESTED_CLI_MODE === 'hard'});
      const cliMsg = [
        'PRISM NESTED-CLI GUARD: launching a non-interactive `claude -p`/`--print` session spawns an out-of-band nested agent — dispatch is MAIN-LOOP-ONLY and this bypasses the nested-dispatch guard.',
        'Do the work inline, or return a dispatch plan to the main loop and let it fan out. Override: PRISM_NESTED_CLI_GUARD=off.',
      ].join('\n');
      if (NESTED_CLI_MODE === 'hard') {
        write(JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: cliMsg}}));
        return done(2);
      }
      write(cliMsg);
      return done(0);
    }
  }

  // --- v5.7.6: NESTED-DISPATCH GUARD (must run BEFORE the subagent bypass) ---
  // Root cause (live-repro 2026-06-16): the runtime PRISM was built against
  // (a) stripped the Agent tool from subagents and (b) did NOT fire hooks inside
  // subagents — so "dispatch is main-loop-only" held for free. The updated
  // runtime no longer does either: a dispatched worker CAN spawn a sub-subagent,
  // and that nested Agent() call now REACHES this hook. An unsanctioned nested
  // spawn stalls the tree (98-min throttled/near-zero hang). Doctrine is
  // unchanged — NO subagent dispatches (even @master-orchestrator-as-subagent
  // only role-plays; see the panel deny below) — so denying Agent() from
  // subagent context breaks nothing sanctioned. Detection reuses the SAME two
  // signals the bypass trusts. Only `Agent` (the spawn tool) is gated; subagents
  // keep full use of Edit/Bash/TaskCreate/etc. (they fall through to the bypass).
  const inSubagentCtx = isSubagent
    || String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  if (inSubagentCtx && toolName === 'Agent' && NESTED_MODE !== 'off') {
    appendLog({
      event: 'nested_dispatch_guard',
      ts: new Date().toISOString(),
      session_id: sessionId,
      tool: toolName,
      target: String(input.tool_input?.subagent_type || input.tool_input?.agent_type || ''),
      signal: isSubagent ? 'parent_tool_use_id' : 'entrypoint_env',
      blocked: NESTED_MODE === 'hard',
      mode: NESTED_MODE,
    });
    const nestedNotice = [
      `PRISM NESTED-DISPATCH GUARD: nested Agent() call detected — you look like a dispatched subagent. PRISM dispatch SHOULD be main-loop-only: a worker that spawns its own sub-agents risks stalling the tree (throttled / near-zero spawns; live-repro 98-minute hang). Note this detection is best-effort, not a reliable hard block (D043) — treat the doctrine as the rule, not this guard.`,
      `Strongly prefer doing the work INLINE here (Read / Grep / Edit / Bash directly). If you genuinely need parallel help, return your findings or a dispatch plan to the main loop and let IT fan out — teammates coordinate via SendMessage, they do not spawn.`,
      `Override: set PRISM_NESTED_DISPATCH_GUARD=off (or PRISM_DISPATCH_GUARD=off).`,
    ].join('\n');
    if (NESTED_MODE === 'hard') {
      write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: nestedNotice,
        },
      }));
      return done(2);
    }
    write(nestedNotice);
    return done(0);
  }
  // ----------------------------------------------------------------

  // --- v2.2.1: subagent bypass paths (any one passes cleanly) ---
  if (isSubagent) return done(0);
  if (String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent') {
    return done(0);
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
    if (/[/\\]\.prism-turn-tier-[^/\\]*\.json$/.test(fp)) return done(0);
  }

  // v5.3.2 — read-only quick-check fast path: a provably non-mutating Bash/
  // PowerShell probe runs in the parent without a forced dispatch. Fail-closed
  // (non-read-only → falls through to the normal dispatch logic below).
  // mutation-guard + safety fire independently and still block writes.
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = input.tool_input?.command || input.tool_input?.cmd || '';
    if (isReadOnlyBash(cmd)) {
      appendLog({ts: new Date().toISOString(), event: 'dispatch_guard_ro_bash', session_id: sessionId, tool: toolName, mode: MODE});
      return done(0);
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

        // v6.1.0: ROUTINE SINGLE-PASS GATE
        // Detects a genuinely-later sequential re-dispatch on a routine turn that
        // already dispatched once. Does NOT use a read-modify-write counter
        // (lost-update race + first-dispatch deadlock). Gates on the existing
        // monotonic `dispatched` boolean + a batch-window check + a once-per-turn flag.
        //
        // ROUTINE_MODE: off | soft (default) | enforce
        //   soft    → advisory additionalContext, exit 0 (never blocks)
        //   enforce → deny JSON, exit 2
        //   off     → gate disabled entirely
        const ROUTINE_MODE = (process.env.PRISM_ROUTINE_SINGLE_PASS ?? 'soft').toLowerCase();
        const routineBypass   = sentinel.routine_bypass === true;
        const alreadyDispatched = sentinel.dispatched === true;  // markDispatched() just ran if it was false
        // batch-window: same-message parallel siblings arrive within a few seconds of the
        // first dispatch → must PASS. dispatched_ts is ISO string; convert to ms.
        const BATCH_WINDOW_MS = Number(process.env.PRISM_ROUTINE_BATCH_WINDOW_MS) || 8000;
        const dispatchedTsMs = sentinel.dispatched_ts ? new Date(sentinel.dispatched_ts).getTime() : 0;
        const inBatchWindow = dispatchedTsMs > 0 && (Date.now() - dispatchedTsMs) < BATCH_WINDOW_MS;

        const isRedispatch =
          routineBypass &&
          alreadyDispatched &&
          !inBatchWindow &&                        // genuinely LATER round, not a same-message sibling
          !sentinel.single_pass_nudged &&           // nudge/deny at most ONCE per user-prompt
          toolName === 'Agent' &&                  // narrow to worker dispatch; TaskCreate is scaffolding, excluded
          ROUTINE_MODE !== 'off';

        if (isRedispatch) {
          // Write-only, monotonic, race-tolerant side effects.
          // Re-read the sentinel atomically before mutating, in case markDispatched()
          // already wrote a fresh copy above — use that fresh copy or fall back.
          const freshSentinel = readSentinel(sessionId) || sentinel;
          freshSentinel.single_pass_nudged = true;
          freshSentinel.dispatch_count = (freshSentinel.dispatch_count | 0) + 1;  // telemetry ONLY
          writeSentinel(sessionId, freshSentinel);
          appendLog({
            event: 'routine_single_pass',
            ts: new Date().toISOString(),
            session_id: sessionId,
            mode: ROUTINE_MODE,
            dispatch_count: freshSentinel.dispatch_count,
          });
          const rspMsg = [
            'PRISM ROUTINE SINGLE-PASS: this routine turn already dispatched once — synthesize from the first worker\'s result instead of re-dispatching.',
            'If it genuinely needs a second sequential pass, prefix the prompt with !opus-force:.',
            '(one-time nudge)',
          ].join(' ');
          if (ROUTINE_MODE === 'enforce') {
            write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: rspMsg,
              },
            }));
            return done(2);
          }
          // SOFT: advisory additionalContext, exit 0 — never blocks.
          write(rspMsg);
          return done(0);
        }
        // else: fall through to existing pass logic UNCHANGED.
      }
    }
    return done(0);
  }

  const sentinel = readSentinel(sessionId);
  if (!sentinel) return done(0);
  if (sentinel.force_opus) return done(0);

  // v2.5.0: NOVEL-tier orchestrator gate.
  // Opus tier with summon_panel requires @master-orchestrator dispatch first.
  // Haiku dispatches for file I/O do NOT satisfy this — only master-orchestrator does.
  //
  // D034 (2026-06-25): explicit-only panel contract. summon_panel is now only true
  // when the user explicitly requested the panel (EXPLICIT_PANEL_RE). This guard
  // is UNCHANGED — it reads summon_panel and enforces the panel-first gate exactly
  // as before. The change is upstream: the classifier now sets summon_panel=true
  // only on explicit requests. No behavioral change here.
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
      `A real panel is 3–5 seats each resolving to a rostered specialist or an @agent-factory-created one — NOT one generic general-purpose dispatch. Provenance is checked when you write panel.json.`,
      `Parent Write/Edit/Bash unblock once you have dispatched at least one panel member. Override: prefix the user prompt with !opus-force: or set PRISM_DISPATCH_GUARD=off.`,
    ] : [
      `PRISM DISPATCH-GUARD: ${toolName} denied — this is a PANEL-SUMMONING turn (opus tier, summon_panel=true).${why}`,
      `If you are the PARENT (main loop): spawn @master-orchestrator as your next action — Agent({subagent_type:'master-orchestrator', model:'opus', prompt:'<original user request, verbatim>'}). It assembles the expert panel, chairs adversarial review, and returns a synthesized plan for you to relay. Direct Write/Edit/Bash in parent context stays blocked on panel turns until the orchestrator has been invoked.`,
      `If you are a DISPATCHED SUBAGENT: you cannot call Agent (dispatch is main-loop-only — it is denied / not exposed to you), so do NOT try to spawn the orchestrator. Read-only tools (Read/Grep/Glob/WebFetch/WebSearch) are already allowed for you — use them, or a provably read-only Bash probe, and return your findings or a dispatch plan to the main loop for any mutation.`,
      `Override: prefix the user prompt with !opus-force: (skips panel, uses direct Opus) or set PRISM_DISPATCH_GUARD=off.`,
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
      write(JSON.stringify(deny));
      return done(2);
    }
    write(panelNotice);
    return done(0);
  }

  // Opus tier without panel signal: parent can act directly.
  if (sentinel.tier === 'opus') return done(0);

  // v2.2.1 Path 3: haiku/sonnet tier + already dispatched → pass.
  // v6.4.0 (D043) — BORROWED-UNLOCK VISIBILITY. In the single-actor case (no
  // teams marker) this stays a silent pass, byte-identical to before. Under
  // agent-teams, `dispatched` is shared across every teammate, so this "allow"
  // may be BORROWED from an unrelated teammate's Agent/TaskCreate — this caller
  // may never have been individually gated at all. In advisory teams-mode we LOG
  // the borrowed unlock (so the structurally-invisible false-allow becomes
  // measurable — the rate that later gates whether a hard per-caller lease is
  // ever justified) and attach an in-band advisory. Still exit 0 (allow): a hard
  // block here without per-caller identity would just re-create the false-DENY
  // lottery from the other side (D043 — the guard cannot tell a borrower from a
  // legitimately-dispatched worker; only session_id + parent_tool_use_id exist).
  if (sentinel.dispatched) {
    if (IN_AGENT_TEAMS && TEAMS_MODE === 'advisory') {
      appendLog({
        event: 'borrowed_unlock',
        ts: new Date().toISOString(),
        session_id: sessionId,
        tool: toolName,
        tier: sentinel.tier,
        teams_mode: TEAMS_MODE,
      });
      write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: [
            `PRISM DISPATCH-GUARD (agent-teams / D043): allowing ${toolName} on a BORROWED unlock.`,
            `sentinel.dispatched=true, but under agent-teams that flag is session-global with no caller dimension — it may have been set by an UNRELATED teammate's Agent/TaskCreate, not by any dispatch of YOURS. Dispatch-gating cannot distinguish callers here, so this allow is not evidence you were individually dispatched.`,
            `Confirm YOU own the file/scope you are about to mutate (the orchestrator assigns per-agent ownership). This event is logged as borrowed_unlock for false-allow rate measurement (D043). To restore the prior single-actor hard-deny set PRISM_DISPATCH_GUARD_TEAMS=hard.`,
          ].join('\n'),
        },
      }));
      return done(0);
    }
    return done(0);
  }

  // Defense-in-depth: orchestration-command allowlist match → pass.
  if (typeof sentinel.rationale === 'string' &&
      /orchestration command \/prism-/i.test(sentinel.rationale)) {
    return done(0);
  }

  // Haiku/Sonnet tier, parent context, no dispatch yet → deny.
  // v6.4.0 (D043) — teams advisory-downgrade: under agent-teams the shared
  // `dispatched` flag makes this deny a coin-flip w.r.t. THIS caller's legitimacy
  // (as likely a false positive — a legit worker whose shared flag was just reset
  // by an unrelated teammate's message — as a real block), so in advisory
  // teams-mode we DOWNGRADE it to an advisory instead of hard-denying. Fail-safe:
  // no teams marker (or PRISM_DISPATCH_GUARD_TEAMS=hard) → prior hard-deny intact.
  const teamsAdvisoryDowngrade = IN_AGENT_TEAMS && TEAMS_MODE === 'advisory';
  const why = sentinel.rationale ? ` Reason: ${sentinel.rationale}` : '';
  // CHANGE 3 (D043): the old middle line ("After one dispatch, subsequent parent
  // tools are allowed") asserted a SINGLE-ACTOR guarantee that is false under
  // agent-teams' shared-session_id topology. Made honest with the teams caveat.
  const notice = [
    `PRISM DISPATCH-GUARD: ${toolName} denied in parent context — this turn routed to ${sentinel.tier}-tier.${why}`,
    `If you are the PARENT (main loop): dispatch the work first via Agent({subagent_type:'general-purpose', model:'${sentinel.tier}', prompt:'<task>'}) or TaskCreate/plan. After one dispatch, subsequent parent tools are allowed for THIS session. CAVEAT (D043): "dispatched" is a session-global flag with no caller dimension — under agent-teams (teammates sharing one session_id) ANY teammate's dispatch unlocks all of them and ANY teammate's next message re-locks all of them, so this is NOT a per-actor guarantee.`,
    `If you are a DISPATCHED SUBAGENT: you cannot call Agent (dispatch is main-loop-only — it is denied / not exposed to you). Read-only tools (Read/Grep/Glob/WebFetch/WebSearch) are already allowed for you — use them, or a provably read-only Bash probe, and return findings to the main loop for any mutation.`,
    `Override: prefix the user prompt with !opus-force: (or set PRISM_DISPATCH_GUARD=off).`,
  ].join('\n');

  appendLog({
    event: 'dispatch_guard',
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
    tier: sentinel.tier,
    score: sentinel.score,
    blocked: MODE === 'hard' && !teamsAdvisoryDowngrade,
    mode: MODE,
    teams_mode: IN_AGENT_TEAMS ? TEAMS_MODE : null,
    teams_downgrade: teamsAdvisoryDowngrade || undefined,
  });

  // CHANGE 1 (D043): teams advisory-downgrade — allow with an in-band advisory
  // (exit 0 + additionalContext) instead of the hard deny. Closes the loud
  // false-DENY without pretending the gate is sound (it explains why it cannot
  // gate concurrent actors here).
  if (teamsAdvisoryDowngrade) {
    const teamsNotice = [
      `PRISM DISPATCH-GUARD (agent-teams / D043): ADVISORY, not a block — allowing ${toolName}.`,
      `This turn routed to ${sentinel.tier}-tier with no dispatch recorded, but you appear to be in an agent-teams session (shared session_id). Dispatch-gating cannot gate concurrent actors here: the \`dispatched\` flag has no caller dimension, so a hard deny would be a coin-flip unrelated to whether YOU were legitimately dispatched. Proceeding.`,
      `If you are the ORCHESTRATOR/parent: prefer dispatching the work to a teammate anyway (that is still the cheaper-model discipline). If you are a dispatched teammate doing assigned work: confirm YOU own the file/scope you are mutating.`,
      `To restore the hard block set PRISM_DISPATCH_GUARD_TEAMS=hard. Full override: !opus-force: or PRISM_DISPATCH_GUARD=off.`,
    ].join('\n');
    write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: teamsNotice,
      },
    }));
    return done(0);
  }

  if (MODE === 'hard') {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: notice,
      },
    };
    write(JSON.stringify(deny));
    return done(2);
  }

  write(notice);
  return done(0);
  } catch {
    return done(0);
  }
}

// Standalone shim — preserves original wire behavior + parse-error fail-open.
import {basename} from 'node:path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-parent-dispatch-guard.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  try {
    const r = run(input);
    if (r.stdout) process.stdout.write(r.stdout);
    process.exit(r.exit || 0);
  } catch { process.exit(0); }
}
