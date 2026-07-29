#!/usr/bin/env node
// PRISM Prompt Tier Router (v3.8.0) — UserPromptSubmit
//
// v3.8.0: continuation detection — short follow-up messages (<8 words) or
// explicit approval phrases ("ok", "yes", "go", "proceed") that follow an
// opus/sonnet sentinel <5min old now INHERIT the previous tier instead of
// re-classifying as haiku. Eliminates the per-turn dispatch ceremony.
// PRISM_CONVERSATION_MODE=1 forces always-inherit for development sessions.
//
// v3.2.0: API classifier path removed (see hooks/lib/prism-opus-classifier.mjs).
// Keyword-floor regex is the sole classification mechanism. To compensate for
// regex's bluntness on ambiguous prompts, this hook now emits a SELF-OVERRIDE
// PROTOCOL directive in its additionalContext: the conversation model can
// correct keyword-floor by writing a corrected sentinel as its first action
// of the turn, before any work tools fire.
//
// The sentinel on disk keeps its prior shape so prism-parent-dispatch-guard
// continues to read it unchanged. The legacy {h, s, o, score, compound}
// fields are retained as zeros for compatibility; downstream code that
// routes off them should migrate to `rationale` / `source`.
//
// Decision chain: force-opus prefix → slash-command allowlist → 24h cache →
// keyword floor. No network calls.
//
// Modes (PRISM_PROMPT_ROUTER env var, defaults to hard):
//   hard: sentinel + advice that mentions enforcement
//   soft: sentinel + advice only
//   off:  no-op

import {readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, existsSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {classifyPrompt, toSentinel} from './lib/prism-opus-classifier.mjs';
import {EXPLICIT_PANEL_RE} from '../tools/lib/prism-tier-classify.mjs';
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';
import {matchSpecialists, loadRoster as loadInstalledRoster} from './prism-specialist-routing-guard.mjs';
import {writePanelLatch} from './lib/prism-panel-latch.mjs';
import {prismHome} from './lib/prism-home.mjs';

const H = prismHome();
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = String(process.env.PRISM_PROMPT_ROUTER ?? 'hard').toLowerCase();

// v5.2.5: detect the active project-master from the project's settings.json
// `agent` field. When the active agent is a master-<slug> (which loads the
// master-orchestrator skill), a panel turn must be CHAIRED BY THAT MASTER in
// the main loop — NOT delegated to a nested @master-orchestrator subagent, which
// the sole-dispatcher rule would stop from spawning the panel (→ role-play).
function detectActiveMaster(cwd) {
  try {
    const root = cwd || process.cwd();
    for (const f of ['settings.json', 'settings.local.json']) {
      const p = join(root, '.claude', f);
      if (!existsSync(p)) continue;
      const agent = JSON.parse(readFileSync(p, 'utf-8')).agent;
      if (typeof agent === 'string' && /^master-/.test(agent)) return agent;
    }
  } catch {}
  return null;
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

// v3.8.0: continuation detection — short follow-up messages should inherit
// the previous turn's tier instead of re-classifying. Eliminates the
// "user types 'ok' → haiku → guards block everything" failure mode.
function shouldInheritPreviousTier(prompt, previousSentinel) {
  if (!previousSentinel || !previousSentinel.tier) return false;
  // PRISM_CONVERSATION_MODE=1: always inherit when a sentinel exists,
  // regardless of length / approval / age. Opt-in for dev sessions.
  if (String(process.env.PRISM_CONVERSATION_MODE || '') === '1') return true;
  if (previousSentinel.tier === 'haiku') return false; // already cheap, no need to inherit

  const trimmed = String(prompt || '').trim().toLowerCase();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  // Short messages (<8 words) AND previous turn was opus/sonnet AND sentinel
  // is recent (<5min old) → inherit.
  const APPROVAL_PHRASES = /\b(ok|okay|yes|yep|yeah|go|proceed|ship|approve|approved|continue|next|fine|good|sure|do it|let's go|run it|execute)\b/i;
  const isApproval = APPROVAL_PHRASES.test(trimmed);
  const isShort = wordCount < 8;
  const ageMs = previousSentinel.ts ? (Date.now() - new Date(previousSentinel.ts).getTime()) : Infinity;
  const isFresh = ageMs < 5 * 60 * 1000; // 5 min

  // FIX-A (v5.x): an empty/whitespace prompt is a notification / non-user turn,
  // not a real continuation — never inherit (would otherwise re-lock a panel
  // turn on a turn the user never typed). v5.0 stress-test finding.
  if (wordCount === 0) return false;

  return (isShort || isApproval) && isFresh;
}

function gitSnapshot(cwd) {
  // Best-effort git context for the classifier. Each call is bounded to
  // 800ms; failure is non-fatal — classifier still runs with empty context.
  const out = {branch: '', headSha: '', dirty: false, recentCommits: [], stagedFiles: []};
  if (!cwd) return out;
  const run = (args) => {
    try {
      const r = spawnSync('git', args, {cwd, encoding: 'utf-8', timeout: 800, windowsHide: true});
      return r.status === 0 ? (r.stdout || '').trim() : '';
    } catch { return ''; }
  };
  out.branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  out.headSha = run(['rev-parse', '--short', 'HEAD']);
  const status = run(['--no-optional-locks', 'status', '--porcelain']);
  out.dirty = !!status;
  const log = run(['log', '-5', '--oneline']);
  out.recentCommits = log ? log.split('\n').filter(Boolean) : [];
  const staged = run(['diff', '--cached', '--name-only']);
  out.stagedFiles = staged ? staged.split('\n').filter(Boolean) : [];

  // F17 fix (task #25): git resolution FAILURE (non-repo cwd, git binary
  // unavailable, or a fresh zero-commit repo — all three collapse both
  // rev-parse calls to a non-zero exit) leaves branch==='' AND headSha===''
  // regardless of WHICH project failed. hooks/lib/prism-opus-classifier.mjs's
  // cacheKey(prompt, branch, headSha) has no other scoping dimension, and the
  // tier cache is a SINGLE GLOBAL file (~/.claude/.prism-tier-cache.json —
  // never scoped per cwd/project), so two DIFFERENT projects that both fail
  // git resolution and submit the same prompt text collide on the IDENTICAL
  // cache key — confirmed by direct probe (task #25 report): two unrelated
  // scratch dirs both produced {branch:'', headSha:''} and cacheKey() computed
  // the SAME sha256 for both. Distinguish "git resolved" from "git could not
  // be resolved": on failure, fall back to a cwd-derived pseudo-headSha so the
  // eventual cache key stays scoped to THIS project even when git itself is
  // unavailable. Never fires when git resolves normally — real branch+headSha
  // already scope the key correctly in that (overwhelmingly common) case.
  if (!out.branch && !out.headSha) {
    out.headSha = `nogit:${createHash('sha256').update(String(cwd)).digest('hex').slice(0, 12)}`;
  }
  return out;
}

// D087 (#44, v6.5.0) — chair/teammate BINARY. There is no per-actor identity
// available to a hook (verified from a live teammate's own env: session_id is
// SHARED, entrypoint is 'cli', no name/id field anywhere), but
// CLAUDE_CODE_CHILD_SESSION=1 does distinguish a dispatched teammate from the
// chair. Used ONLY to suppress the override directive below: the dispatch-guard
// now DENIES a teammate's sentinel write (D087), and broadcasting an instruction
// we then deny is worse than either alone.
// FAIL-OPEN, matching the guard: absent / non-'1' / unreadable / switch off →
// treat as CHAIR, i.e. prior behavior, unchanged.
function isTeammateTurn() {
  try {
    if (String(process.env.PRISM_SENTINEL_CHAIR_ONLY ?? 'on').toLowerCase() === 'off') return false;
    return String(process.env.CLAUDE_CODE_CHILD_SESSION ?? '') === '1';
  } catch { return false; }
}

function buildOverrideDirective(tier, summonPanel, sessionId) {
  // v3.2.0 self-override protocol: emitted only when keyword-floor produced
  // the classification (the bluntest path). The conversation model gets a
  // chance to correct an obviously-wrong tier by READING then writing a
  // corrected sentinel as its FIRST action, before any work tools fire.
  // Skipped on allowlist/force-opus where intent is explicit.
  const sid = String(sessionId || 'anon');
  const sentinelName = sentinelPath(sid);
  return [
    '',
    'PRISM TIER OVERRIDE PROTOCOL (v3.2.0):',
    `keyword-floor classified this prompt as ${tier}. If you (the conversation model) believe this is wrong for the actual task complexity, correct it as your FIRST action of this turn: Read \`${sentinelName}\` first (it already exists — the router rewrites it every turn, so the Write tool refuses without a prior Read), THEN Write or Edit it with corrected fields {"tier":"<correct>","summon_panel":<bool>,"source":"conversation-model-override","rationale":"<why>"}. Otherwise, proceed normally and the keyword-floor classification stands.`,
    `CONSTRAINT (owner policy): You MAY correct \`tier\` (haiku/sonnet/opus) and \`summon_panel\` to fix a misclassification. You may NOT self-set \`force_opus:true\` — that flag is the full dispatch-guard bypass (the equivalent of the user's \`!opus-force:\` prefix) and is reserved for the USER. If you believe a one-shot bypass of the dispatch/panel gates is genuinely warranted, do NOT write force_opus yourself: state the reason in one line and ASK the user to approve (they can prefix \`!opus-force:\`). Self-granting force_opus is a policy violation and is now logged.`,
  ].join('\n');
}

// D051 Part A: the phase-0d machinery (prism-phase-0d-oob.mjs,
// prism-phase-0d-challenges.mjs, prism-panel-guard.mjs Path B) all fire on a
// Write to a `.prism-task-<sha>/panel.json` path and are fully wired — but a
// live panel never writes that file (it's an LLM-authored artifact, no
// deterministic producer exists), so those hooks have never fired. The same
// instruction already lives in
// skills/master-orchestrator/references/phase-0d-adversarial.md but a
// doc-only instruction has 0/14 real-world compliance (F4 finding); a clause
// injected directly into the turn's additionalContext is the channel proven
// to land. PRESENT_RE-style idempotency guard: only appended if the advice
// doesn't already carry it (defensive — formatAdvice runs once per turn, so
// this is belt-and-suspenders, not load-bearing).
//
// D051 Part A precision fix (no-author validator finding): the phase-0d
// consumers ONLY fire on a PostToolUse Write event to a path matching
// /\.prism-task-[^/\\]+[/\\]panel\.json$/. The doc this clause used to point
// to ("for the full schema") teaches an ATOMIC tempfile+rename recipe
// (bash heredoc → panel.json.tmp → mv) — following it writes via Bash (no
// PostToolUse Write event) or to a .tmp path (fails the panel\.json$ regex),
// so all three consumers would silently never fire. The clause below now
// mandates the one delivery mechanism that actually trips the hooks: a
// single direct Write tool call to the final panel.json path.
const PANEL_JSON_WRITE_CLAUSE =
  '\n  5. WRITE the panel to JSON at ~/.claude/.prism-task-<task-id>/panel.json BEFORE synthesis, using ONE direct Write tool call to that exact final path — ' +
  'NOT a tempfile+rename, NOT a Bash/PowerShell heredoc, NOT a .tmp path (those bypass the PostToolUse Write event and the Phase 0d reviewer silently never fires). ' +
  '<task-id> MUST be freshly generated for THIS panel\'s topic — never reuse an id minted for an earlier or declined panel in the same session (reusing silently aliases the wrong workspace). ' +
  'Schema: {"dispatch_mode":"dispatch","positions":[{"specialist":"<roster key>","title":"...","vertical":true,"seat_source":"rostered"|"factory-created","agent_type":"<subagent_type>","dispatched_agent_id":"...","challenges":[{"text":"...","evidence_class":"PRECEDENT"|"MEASUREMENT"|"SPEC"|"QUOTE"|"DEMO"|"REASONED-INFERENCE"|"CHALLENGE-SUBSTANCE" (ONLY these 7 values — never invent others like "code-evidence" or "reasoning")}]}],"rationale":{"alternatives_considered":[{"approach":"...","why_not":"..."}]}}.';

// Compact seat-sourcing discipline, force-injected on every panel-summon turn.
// fitLine is the deterministic pre-match result (Fix 1b) or '' when none.
function panelSeatSourcingBlock(fitLine) {
  return (
    `\n  1. READ the roster (~/.claude/skills/prism-plan/references/roster.json) and match EACH seat to a rostered specialist by core_domains — a STRONG fit on the seat's SPECIFIC sub-domain, not mere adjacency.` +
    `\n  2. For any seat with NO strong-fit specialist, spawn @agent-factory (compose-first: check tools-registry first) to CREATE/UPGRADE a durable specialist. A bare general-purpose/persona subagent is NEVER a valid fill for a vertical/domain seat.` +
    `\n  3. Dispatch the seats — 3–5, distinct opposed biases — as INDEPENDENT parallel subagents (one Agent() block each), dispatched WITHOUT a "name:" field — a named call becomes an Agent-Teams teammate whose position does NOT return as your tool result (only a payload-free idle_notification, D062); if a seat's position never returns as your Agent() result, that seat was never really consulted — do NOT author its challenges yourself.` +
    `\n  4. Tag each vertical/domain seat in panel.json: "vertical":true, "seat_source":"rostered"|"factory-created" (ONLY these two values — never invent others like "archetype" or "generic"), "agent_type":"<real subagent_type>", "specialist":"<roster key>". Cross-cutting archetype seats (Architect/Skeptic/Security/Performance) stay untagged — omit seat_source entirely, do not set it to "archetype". A title combining a concrete domain noun with an archetype suffix (e.g. "Concurrency & Crash-Recovery", "Migration & Reversibility skeptic") is VERTICAL — tag it vertical:true with a real seat_source/agent_type; the provenance gate infers vertical on these regardless, so leaving it false only produces a logged mismatch, never an exemption.` +
    `\n  5. Chair adversarial review (≥2 substantive challenges per position), then synthesize the verdict yourself.` +
    (fitLine ? `\n  ${fitLine}` : '')
  );
}

function formatAdvice(tier, rationale, mode, summonPanel, source, sessionId, activeMaster, panelDisabled, panelFitLine = '') {
  // New format — intentionally simpler than v2.1.3 so LLMs don't need to
  // parse h=/s=/o= tokens. The old score fields are preserved in the
  // sentinel file for debugging but not echoed to the model context.
  //
  // v2.5.0: when summon_panel=true on opus tier, the advice becomes a hard
  // directive to spawn @master-orchestrator. Parent-dispatch-guard enforces
  // this by denying work tools until orchestrator_dispatched=true.
  // v2.7.2: Windows BOM note appended to every dispatch advice — subagents
  // should use Edit/Write (not Bash/PowerShell) to avoid the default
  // UTF-8-with-BOM from Set-Content/Out-File/`>` redirect.
  //
  // v5.13.x: panelDisabled — set when PRISM_PANEL_DISABLED=1|true. The
  // panel-summoning directive is suppressed entirely; tier/orchestrator/
  // dispatch preamble remain intact. Arm B isolation experiment support.
  const isWin = process.platform === 'win32';
  let advice = `PRISM TIER ROUTER: ${tier}. ${rationale || '(no rationale)'}`;
  let emittedDispatchAdvice = false;
  // When PRISM_PANEL_DISABLED is active, treat opus turns as plain parent
  // work (no panel directive). The single-pass (haiku/sonnet) branches below
  // are unaffected because they already do not summon a panel.
  const effectiveSummonPanel = panelDisabled ? false : summonPanel;
  // v5.3.1: on every everyday dispatch turn, remind the main loop to BATCH
  // independent subtasks. Only the main loop can fan out (dispatched workers
  // have no Agent tool), and it only parallelises Agent() calls that arrive in
  // ONE message — so the default "one dispatch per turn" silently serialises
  // parallelisable work. This closes the everyday-path gap (the rich
  // dispatch-shapes.md guidance only loads under a formal plan/orchestrator).
  const parallelBatchNote = `\nPARALLEL: if this splits into 2+ INDEPENDENT subtasks (different files/targets, no shared output), dispatch them as MULTIPLE Agent() tool_use blocks in ONE message — they run concurrently (wall-clock = max(each), not sum). Don't dispatch one-at-a-time across turns. Cap 4 per batch (PRISM_PARALLEL_CAP).`;
  if (tier === 'haiku') {
    advice += `\nROUTINE single-pass: dispatch at most ONCE to a cheap worker, then synthesize and return. Do NOT enter a plan→review→re-dispatch loop, do NOT summon the panel, do NOT pull full project recall — a routine relay needs almost no project model. (Override for genuine multi-step: !opus-force:.)`;
    advice += `\nDispatch via Agent({subagent_type:'general-purpose', model:'haiku', prompt:'<task>'}) instead of running tools directly in parent Opus.`;
    if (mode === 'hard') advice += ` Parent tools will be DENIED until you dispatch. Override: prefix user prompt with !opus-force:.`;
    advice += parallelBatchNote;
    emittedDispatchAdvice = true;
  } else if (tier === 'sonnet') {
    advice += `\nROUTINE single-pass: dispatch at most ONCE to a cheap worker, then synthesize and return. Do NOT enter a plan→review→re-dispatch loop, do NOT summon the panel, do NOT pull full project recall — a routine relay needs almost no project model. (Override for genuine multi-step: !opus-force:.)`;
    advice += `\nDispatch implementation via Agent({subagent_type:'general-purpose', model:'sonnet'}).`;
    if (mode === 'hard') advice += ` Parent non-dispatch tools will be DENIED until you dispatch or call TaskCreate. Override: !opus-force:.`;
    advice += parallelBatchNote;
    emittedDispatchAdvice = true;
  } else if (tier === 'opus' && effectiveSummonPanel && activeMaster) {
    // v5.2.5: the active agent IS a project-master with the orchestrator skill.
    // It chairs the panel itself in the main loop (where it CAN dispatch real,
    // independent panel members) instead of nesting a @master-orchestrator
    // subagent that the sole-dispatcher rule would reduce to role-play.
    advice += `\n\nPANEL-SUMMONING TURN. You are the active project-master (${activeMaster}) and you load the master-orchestrator skill — so YOU chair this panel directly in the main loop. Do NOT dispatch a nested @master-orchestrator (it would run as a subagent and PRISM's sole-dispatcher rule would stop it spawning the panel → role-play). Instead:`;
    advice += panelSeatSourcingBlock(panelFitLine);
    // Idempotency guard keys on the CLAUSE's own marker, not the bare
    // "panel.json" string — the seat-sourcing block references panel.json (step
    // 4), which would otherwise suppress the load-bearing write clause (D051).
    if (!/WRITE the panel to JSON/i.test(advice)) advice += PANEL_JSON_WRITE_CLAUSE;
    if (mode === 'hard') advice += `\nParent Write/Edit/Bash stay blocked until you have dispatched at least one panel member (so a real panel happens, not role-play). Override: !opus-force:.`;
    emittedDispatchAdvice = true;
  } else if (tier === 'opus' && effectiveSummonPanel) {
    advice += `\n\nPANEL-SUMMONING TURN. This is a novel architectural request. Spawn @master-orchestrator as your NEXT action — do NOT synthesize the plan yourself in parent context. The orchestrator will:`;
    advice += `\n  1. Assemble the panel with STRICT seat-sourcing (below); do NOT synthesize the plan in parent context.`;
    advice += panelSeatSourcingBlock(panelFitLine);
    advice += `\n  3. Chair adversarial review (≥2 substantive challenges per position).`;
    advice += `\n  4. Return a synthesized phased plan with explicit exclusions for you to relay.`;
    // Idempotency guard keys on the CLAUSE's own marker, not the bare
    // "panel.json" string — the seat-sourcing block references panel.json (step
    // 4), which would otherwise suppress the load-bearing write clause (D051).
    if (!/WRITE the panel to JSON/i.test(advice)) advice += PANEL_JSON_WRITE_CLAUSE;
    advice += `\nUse: Agent({subagent_type:'master-orchestrator', model:'opus', prompt:'<original user request, verbatim>'})`;
    if (mode === 'hard') advice += `\nParent Write/Edit/Bash DENIED until orchestrator is dispatched. Override: !opus-force: (single-model Opus) or PRISM_DISPATCH_GUARD=off.`;
    emittedDispatchAdvice = true;
  }
  // v2.7.2 Windows note — only emit on turns where we're actually telling the
  // model to dispatch (not on plain opus parent-work turns).
  if (isWin && emittedDispatchAdvice) {
    advice += `\n\nWINDOWS NOTE: inside subagent prompts, instruct them to use the Edit/Write/MultiEdit tools for file changes — NOT Bash/PowerShell. PowerShell's Set-Content, Out-File, and \`>\` redirection default to UTF-8 with BOM, which mangles files and breaks downstream tools. The Edit/Write tools produce clean UTF-8 (no BOM). If Bash is genuinely needed for a write, append \`-Encoding UTF8NoBOM\` to Set-Content/Out-File.`;
  }
  // opus-tier without summon_panel: no dispatch advice needed. Direct parent work allowed.

  // v3.2.0: append self-override directive when keyword-floor classified this
  // prompt and the tier is not allowlist/force-opus (those are explicit intent
  // and should not be overrideable by the conversation model).
  //
  // v5.0.x: do NOT append it on hard-mode PANEL turns. On those turns the
  // parent-dispatch-guard denies the very Write the protocol instructs (Write is
  // not in the guard's ALWAYS_ALLOW set), so the sentinel-write self-override is
  // unfollowable there — and panels are deliberately human-gated. The panel
  // branch above already gives the correct escape (spawn @master-orchestrator,
  // or the human prefixes !opus-force: / sets PRISM_DISPATCH_GUARD=off), so the
  // v3.2.0 text would only contradict it. Suppressing it removes the
  // advertise-an-escape-the-guard-forbids contradiction.
  //
  // Item 2c, D025: extend to source='cache', but ONLY for panel cache hits.
  // A cached classification is NOT explicit user intent (unlike allowlist/
  // force-opus) — the cache may be stale or may have been written for a
  // differently-worded prior prompt. The model must be able to correct it.
  // panelHardBlocked still gates it: if the cache says summon_panel and we
  // are in hard mode, the same guard applies and the Write would be
  // unfollowable anyway. Only non-hard-blocked cache-panel hits get the
  // escape valve, matching the reasoning for keyword-floor.
  // Scoped to panel cache hits — non-panel cache turns (sonnet/haiku routine)
  // must NOT receive the override directive (context noise, needless sentinel
  // Read+Write on the fast path).
  const panelHardBlocked = mode === 'hard' && tier === 'opus' && effectiveSummonPanel;
  // D087 (#44): !isTeammateTurn() — a dispatched teammate is now DENIED the
  // sentinel write this directive asks for, so it must not be instructed to
  // attempt it. Fail-open (see isTeammateTurn): the chair path is unchanged.
  if ((source === 'keyword-floor' || (source === 'cache' && effectiveSummonPanel)) && !panelHardBlocked && !isTeammateTurn()) {
    advice += '\n' + buildOverrideDirective(tier, summonPanel, sessionId);
  }
  return advice;
}

// Exported for unit testing (pure function, no I/O).
export {formatAdvice, buildOverrideDirective, gitSnapshot};

export async function run(payload) {
  try {
    if (MODE === 'off') return {exit: 0, stdout: '', stderr: ''};

    const input = payload || {};
    const prompt = String(input.prompt || '');
    const sessionId = input.session_id || 'anon';
    const cwd = input.cwd || process.cwd();

    // D075: a background task-notification turn is NOT genuine user input. Its
    // `prompt` is the harness <task-notification> body and can carry leaked
    // IDE-selected context (e.g. a "run the panel" line) that must never
    // re-classify into a panel summon. hook_event_name is 'UserPromptSubmit'
    // on both real prompts and notifications, so key off the body sentinel.
    const isTaskNotification = /^\s*<task-notification>/.test(prompt);

    // v3.8.0: continuation detection — short/approval follow-ups inherit prev tier.
    const prevSentinel = readSentinel(sessionId);

    // option (c) tier-override telemetry (additive, fail-open). BEFORE this turn
    // overwrites the sentinel, record the OUTCOME of the previous turn's tier —
    // specifically whether the conversation model overrode last turn (the
    // self-override protocol writes source:'conversation-model-override'). This
    // makes the override RATE measurable: the reducer pairs was_override:true
    // counts against the keyword-floor turns that offered the override. Pure
    // observation — this MUST NEVER throw or affect routing (appendLog already
    // swallows its own errors; the extra try/catch is belt-and-suspenders).
    if (prevSentinel && prevSentinel.tier) {
      try {
        appendLog({
          schema_version: 4,
          event: 'tier_override_outcome',
          ts: new Date().toISOString(),
          session_id: sessionId,
          prev_tier: prevSentinel.tier,
          prev_source: prevSentinel.source,
          was_override: prevSentinel.source === 'conversation-model-override',
        });
      } catch {}
    }

    // D075: task-notification turns inherit the prior tier and NEVER re-summon a
    // panel. Unconditional for notifications (not genuine user input regardless
    // of length), unlike the length-gated continuation-inherit below.
    if (isTaskNotification && prevSentinel && prevSentinel.tier) {
      const inheritedTier = prevSentinel.tier;
      const inheritedForceOpus = !!prevSentinel.force_opus;
      const inheritedSentinel = {
        ...prevSentinel,
        ts: new Date().toISOString(),
        source: 'task-notification-inherit',
        rationale: `task-notification turn (not user input); inherited ${prevSentinel.tier}, panel suppressed (D075)`,
        dispatched: false,
        summon_panel: false,
        orchestrator_dispatched: false,
        dispatch_count: 0,
        routine_bypass: (inheritedTier === 'haiku' || inheritedTier === 'sonnet') && !inheritedForceOpus,
      };
      try {
        const p = sentinelPath(sessionId);
        mkdirSync(dirname(p), {recursive: true});
        const tmp = p + '.tmp';
        writeFileSync(tmp, JSON.stringify(inheritedSentinel, null, 2));
        renameWithRetry(renameSync, tmp, p);
      } catch (renameErr) {
        try {
          const p = sentinelPath(sessionId);
          writeFileSync(p, JSON.stringify(inheritedSentinel, null, 2));
          appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
            status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
        } catch (fallbackErr) {
          appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
            status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
        }
      }
      appendLog({
        schema_version: 4,
        event: 'prompt_tier_router',
        ts: inheritedSentinel.ts,
        session_id: sessionId,
        tier: inheritedSentinel.tier,
        source: 'task-notification-inherit',
        rationale: inheritedSentinel.rationale,
        summon_panel: false,
        force_opus: !!inheritedSentinel.force_opus,
        mode: MODE,
        phase_1_5: null,
      });
      const advice = `PRISM TIER ROUTER: ${inheritedSentinel.tier} (task-notification-inherit; not user input, panel suppressed). Source: task-notification-inherit`;
      return {exit: 0, stdout: JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: advice}}), stderr: ''};
    }

    // D034 (2026-06-25): explicit-only panel contract — an explicit panel request
    // on a follow-up turn MUST NOT be zeroed by continuation-inherit's
    // summon_panel:false. If the current prompt is an explicit panel request,
    // skip the inherit path entirely and let the full classification run.
    // This preserves the original FIX-A guarantee (approval "ok"/"yes" turns never
    // re-summon the panel) while honoring deliberate panel requests on follow-ups.
    const isExplicitPanelRequest = !isTaskNotification && EXPLICIT_PANEL_RE.test(prompt);
    if (!isExplicitPanelRequest && shouldInheritPreviousTier(prompt, prevSentinel)) {
      // v6.0.0 routine turn-collapse: per-turn counters must reset on every
      // continuation, even though we inherit the tier.  A stale dispatch_count
      // from a prior turn would silently bypass the future gate on every
      // continuation — the bug this reset prevents.
      // routine_bypass is recomputed from the INHERITED tier + force_opus flag
      // (not carried from the prior sentinel) so it always reflects current state.
      const inheritedTier = prevSentinel.tier;
      const inheritedForceOpus = !!prevSentinel.force_opus;
      const inheritedSentinel = {
        ...prevSentinel,
        ts: new Date().toISOString(),
        source: 'continuation-inherit',
        rationale: `inherited from previous turn (${prevSentinel.tier}); short or approval-phrase`,
        dispatched: false, // reset dispatch flag for new turn
        // FIX-A (v5.x): inherit the (expensive) TIER to keep work going, but
        // NEVER re-summon a panel — the panel already fired on the original
        // turn; carrying it forward deadlocks approval/continuation turns.
        summon_panel: false,
        orchestrator_dispatched: false,
        // v6.0.0: reset per-turn counters — never carry stale state forward.
        dispatch_count: 0,
        routine_bypass: (inheritedTier === 'haiku' || inheritedTier === 'sonnet') && !inheritedForceOpus,
      };
      try {
        const p = sentinelPath(sessionId);
        mkdirSync(dirname(p), {recursive: true});
        const tmp = p + '.tmp';
        writeFileSync(tmp, JSON.stringify(inheritedSentinel, null, 2));
        renameWithRetry(renameSync, tmp, p);
      } catch (renameErr) {
        try {
          const p = sentinelPath(sessionId);
          writeFileSync(p, JSON.stringify(inheritedSentinel, null, 2));
          appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
            status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
        } catch (fallbackErr) {
          appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
            status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
        }
      }
      appendLog({
        schema_version: 4,
        event: 'prompt_tier_router',
        ts: inheritedSentinel.ts,
        session_id: sessionId,
        tier: inheritedSentinel.tier,
        source: 'continuation-inherit',
        rationale: inheritedSentinel.rationale,
        summon_panel: !!inheritedSentinel.summon_panel,
        force_opus: !!inheritedSentinel.force_opus,
        mode: MODE,
        phase_1_5: null,  // v4.4: extended by hooks/prism-phase-1-5-oob.mjs with {fired, variant, verdict_pre, verdict_post, agreement_rate}
      });
      const advice = `PRISM TIER ROUTER: ${inheritedSentinel.tier} (continuation-inherit from previous turn). Source: continuation-inherit`;
      const out = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: advice,
        },
      };
      return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
    }

    const git = gitSnapshot(cwd);
    const classification = await classifyPrompt({
      prompt,
      cwd,
      branch: git.branch,
      headSha: git.headSha,
      dirty: git.dirty,
      recentCommits: git.recentCommits,
      stagedFiles: git.stagedFiles,
    });

    const sentinel = toSentinel(classification, {
      session_id: sessionId,
      mode: MODE,
    });

    // D075: no-prior-sentinel edge — a task-notification that falls through to
    // classification must still never summon a panel.
    if (isTaskNotification && sentinel.summon_panel) {
      sentinel.summon_panel = false;
      sentinel.panel_suppressed_task_notification = true;
    }

    // v5.13.x: PRISM_PANEL_DISABLED — Arm B experiment switch. When truthy
    // ('1' or 'true', case-insensitive), suppress the expert panel while
    // keeping all other PRISM machinery (tier routing, orchestrator preamble,
    // dispatch guards, single-pass logic) fully intact.
    //
    // F18 fix (task #25): this block MUST run BEFORE the self_chair check
    // below — self_chair must never be set on a turn where the panel was
    // suppressed by EITHER this switch OR D075 above.
    const _panelDisabledRaw = String(process.env.PRISM_PANEL_DISABLED || '').toLowerCase().trim();
    const panelDisabled = _panelDisabledRaw === '1' || _panelDisabledRaw === 'true';
    if (panelDisabled && sentinel.summon_panel) {
      sentinel.summon_panel = false;
      sentinel.panel_disabled = true;
    }

    // v5.2.5: if a project-master is the active agent, a panel turn is self-chaired.
    // F18 fix (task #25): read the POST-suppression sentinel.summon_panel, not
    // the raw pre-suppression classification.summon_panel — self_chair must
    // never be set on a turn where D075 (task-notification, above) or
    // PRISM_PANEL_DISABLED (above) already suppressed the panel, or the
    // on-disk sentinel records a self-contradictory state (self_chair:true
    // alongside summon_panel:false). Reproduced pre-fix: a task-notification
    // turn with explicit panel-summoning language leaked into its body, with
    // an active project-master configured, set self_chair:true while
    // summon_panel was correctly false — confirmed by direct probe (task #25
    // report). This ordering fix requires the two suppression blocks above to
    // run first, which is why this check now sits after both of them.
    const activeMaster = detectActiveMaster(cwd);
    if (activeMaster && sentinel.summon_panel && sentinel.tier === 'opus') {
      sentinel.self_chair = true;
      sentinel.active_master = activeMaster;
    }

    try {
      // v2.8.0: atomic write via tempfile + rename. Prevents truncated
      // sentinel JSON if the hook is killed mid-write. Readers
      // (dispatch-guard, mutation-guard, agent-model-guard, task-tier-advisor)
      // never see a partial file.
      const p = sentinelPath(sessionId);
      mkdirSync(dirname(p), {recursive: true});
      const tmp = p + '.tmp';
      writeFileSync(tmp, JSON.stringify(sentinel, null, 2));
      renameWithRetry(renameSync, tmp, p);
    } catch (renameErr) {
      // Fallback: direct write if rename fails (e.g., tempdir on different
      // filesystem from sentinel — shouldn't happen since they're siblings,
      // but defensive).
      try {
        const p = sentinelPath(sessionId);
        writeFileSync(p, JSON.stringify(sentinel, null, 2));
        appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
          status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
      } catch (fallbackErr) {
        appendLog({event: 'prompt_tier_router_sentinel_write', session_id: sessionId,
          status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
      }
    }

    // F7 Phase 1: arm the panel-active latch on a self-chaired panel-summon
    // turn. The latch is a SEPARATE sidecar file that persists across turns
    // (the per-turn sentinel above resets summon_panel to false on the
    // post-approval turn, line ~354, and a fresh non-panel re-classification
    // does too — that reset is exactly why prism-panel-name-guard.mjs never
    // fired in prod). While the latch is live the name-guard fires on the seat
    // dispatch that actually happens on that later turn. Scoped to self_chair
    // (project-master active) so raw Agent-Teams usage without a PRISM master
    // never arms it; gated on the POST-suppression summon_panel so a disabled
    // panel (PRISM_PANEL_DISABLED) never arms. Re-armed (TTL refreshed) on every
    // subsequent summon turn. Fail-open — a latch-write error never breaks the
    // turn. TTL is the only deterministic clear (see prism-panel-latch.mjs).
    if (sentinel.self_chair && sentinel.tier === 'opus' && sentinel.summon_panel === true) {
      try { writePanelLatch(sessionId, {active_master: sentinel.active_master || null}); } catch {}
    }

    // v4.6: additive event types phase_0d_challenge + dispatch_cap (actual_parallel, queue_depth).
    // schema_version is the writer's version; readers must ignore unknown fields.
    appendLog({
      schema_version: 4,
      event: 'prompt_tier_router',
      ts: sentinel.ts,
      session_id: sessionId,
      tier: sentinel.tier,
      source: classification.source,
      rationale: classification.rationale,
      summon_panel: sentinel.summon_panel,   // post-suppression value
      panel_disabled: panelDisabled || undefined,  // v5.13.x: Arm B marker (omitted when false)
      force_opus: sentinel.force_opus,
      cache_key: classification.cache_key,
      mode: MODE,
      phase_1_5: null,  // v4.4: extended by hooks/prism-phase-1-5-oob.mjs with {fired, variant, verdict_pre, verdict_post, agreement_rate}
    });

    // Fix 1b: deterministic "rostered specialists that fit" pre-injection.
    // Computed ONLY on an explicit-panel opus turn (cost paid only on rare panel
    // turns), then threaded into the seat-sourcing block via formatAdvice.
    let panelFitLine = '';
    if (sentinel.tier === 'opus' && sentinel.summon_panel === true) {
      try {
        const fits = matchSpecialists(prompt, loadInstalledRoster());
        panelFitLine = fits.length
          ? `Rostered specialists that fit THIS request: ${fits.map(f => f.name).join(', ')}. Reuse a strong fit; @agent-factory every gap.`
          : `No rostered specialist strongly matches this request — expect to @agent-factory-create the vertical seats.`;
      } catch { panelFitLine = ''; }
    }

    const advice = formatAdvice(sentinel.tier, classification.rationale, MODE, sentinel.summon_panel, classification.source, sessionId, sentinel.self_chair ? sentinel.active_master : null, panelDisabled, panelFitLine);
    const out = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: advice,
      },
    };
    return {exit: 0, stdout: JSON.stringify(out), stderr: ''};
  } catch (e) {
    appendLog({event: 'prompt_tier_router', error: String(e && e.message || e), phase_1_5: null});
    return {exit: 0, stdout: '', stderr: ''};
  }
}

import {basename as _basename} from 'node:path';
const invokedDirectly = process.argv[1] && _basename(process.argv[1]) === 'prism-prompt-tier-router.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch {}
    const res = await run(payload);
    if (res.stdout) process.stdout.write(res.stdout);
    process.exit(res.exit || 0);
  })();
}
