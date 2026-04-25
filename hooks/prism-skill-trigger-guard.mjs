#!/usr/bin/env node
// PRISM Skill-Trigger Guard (v3.1.0) — closes T13.4 in tests/v3/
//
// UserPromptSubmit hook. Reads the keyword→skill map at
// ~/.claude/skills/prism-plan/references/skill-triggers.md. When the
// user prompt matches a regex AND the corresponding skill is NOT
// auto-invoked within the next 2 turns (tracked via
// ~/.claude/.prism-skill-trigger-<session>.json — pending entries
// expire after 2 turns or are cleared by a future Stop hook), emit an
// advisory: "your prompt mentioned <UX>; consider invoking
// <ui-ux-pro-max> skill or running /prism-index if you didn't know it
// was available."
//
// Patterns copied (cite explicitly):
//   - Three-path subagent bypass (parent_tool_use_id /
//     CLAUDE_CODE_ENTRYPOINT / sentinel.dispatched): copied from
//     prism-mutation-guard.mjs:227-271 + agent-model-guard.mjs:97-124.
//     UserPromptSubmit fires in the parent context but we keep parity
//     so a subagent-spawned re-prompt (rare but possible) bypasses.
//   - force_opus sentinel honoring: prism-mutation-guard.mjs:281-311.
//   - Atomic tempfile + rename + catch-fallback for the pending-trigger
//     state file: prism-parent-dispatch-guard.mjs:90-107 (verbatim).
//   - Sentinel-aware mode + policy precedence: parity with the v3.1.0
//     parallel-guard and panel-guard hooks in this directory.
//
// Modes (v3.1.0):
//   soft (default): advisory on stdout, exit 0.
//   off:            silent passthrough.
// Hard mode is RESERVED for v3.2.0 once we measure false-positive rate
// on the regex map. Setting PRISM_SKILL_TRIGGER_GUARD=hard in v3.1.0
// is treated as soft + a one-line deprecation note in the routing log.
//
// Precedence chain:
//   1. ~/.claude/prism-policy.json `guards.skill_trigger` if present.
//   2. PRISM_SKILL_TRIGGER_GUARD env var.
//   3. default 'soft'.
// PRISM_POLICY_OVERRIDE=1 → env wins over policy.
//
// Latency: parse skill-triggers.md once per process (cached); regex
// match against the user prompt; one small JSON read + atomic write.
// Target <50ms.

import {readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const POLICY_PATH = join(H, '.claude', 'prism-policy.json');
const TRIGGERS_PATH = join(H, '.claude', 'skills', 'prism-plan', 'references', 'skill-triggers.md');
const PENDING_TTL_TURNS = 2;

function pendingPath(sessionId) {
  return join(H, '.claude', `.prism-skill-trigger-${sessionId || 'anon'}.json`);
}

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function readPending(sessionId) {
  try {
    const p = pendingPath(sessionId);
    if (!existsSync(p)) return {entries: [], turn_count: 0};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return {entries: [], turn_count: 0}; }
}

// Atomic write — verbatim shape from parent-dispatch-guard.mjs:90-107.
function writePending(sessionId, payload) {
  try {
    const p = pendingPath(sessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, p);
  } catch {
    try { writeFileSync(pendingPath(sessionId), JSON.stringify(payload, null, 2)); } catch {}
  }
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

let _triggersCache = null;
function loadTriggers() {
  if (_triggersCache !== null) return _triggersCache;
  _triggersCache = [];
  try {
    if (!existsSync(TRIGGERS_PATH)) return _triggersCache;
    const md = readFileSync(TRIGGERS_PATH, 'utf-8');
    // Parse markdown table rows: | `regex` | skill | severity |
    const rows = md.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---'));
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length < 3) continue;
      // Skip header row
      if (/pattern/i.test(cells[0]) && /skill/i.test(cells[1])) continue;
      const patternRaw = cells[0].replace(/^`|`$/g, '');
      const skill = cells[1].replace(/[`*]/g, '').trim();
      const severity = (cells[2] || 'nudge').toLowerCase();
      if (!patternRaw || !skill) continue;
      try {
        const re = new RegExp(patternRaw, 'i');
        _triggersCache.push({pattern: patternRaw, regex: re, skill, severity});
      } catch { /* skip malformed regex */ }
    }
  } catch {}
  return _triggersCache;
}

function resolveMode() {
  const envRaw = process.env.PRISM_SKILL_TRIGGER_GUARD;
  const envSet = typeof envRaw === 'string' && envRaw.length > 0;
  const override = process.env.PRISM_POLICY_OVERRIDE === '1';

  let policyMode = null;
  try {
    if (existsSync(POLICY_PATH)) {
      const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8'));
      if (policy && policy.guards && typeof policy.guards.skill_trigger === 'string') {
        policyMode = policy.guards.skill_trigger.toLowerCase();
      }
    }
  } catch {}

  let mode;
  if (override && envSet) mode = envRaw.toLowerCase();
  else if (policyMode) mode = policyMode;
  else if (envSet) mode = envRaw.toLowerCase();
  else mode = 'soft';

  // v3.1.0: hard mode reserved — coerce to soft + log.
  if (mode === 'hard') {
    appendLog({
      ts: new Date().toISOString(),
      event: 'skill_trigger_guard',
      action: 'hard-mode-coerced-to-soft',
      reason: 'hard reserved for v3.2.0',
    });
    mode = 'soft';
  }

  return ['soft', 'off'].includes(mode) ? mode : 'soft';
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  const MODE = resolveMode();
  if (MODE === 'off') process.exit(0);

  const sessionId = input.session_id || 'anon';
  const userPrompt = String(input.user_prompt || input.prompt || '');
  if (!userPrompt) process.exit(0);

  // Three-path subagent bypass (defensive parity).
  const isSubagentById = !!input.parent_tool_use_id;
  const isSubagentByEnv = String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  // sentinel.dispatched is meaningless on UserPromptSubmit (the sentinel
  // is *written* by tier-router on this same event). Do not check it
  // here — would always be false / would create a chicken-and-egg.
  if (isSubagentById || isSubagentByEnv) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'skill_trigger_guard',
      session_id: sessionId,
      action: 'passthrough-subagent-context',
      reason: isSubagentById ? 'parent_tool_use_id' : 'env',
      mode: MODE,
    });
    process.exit(0);
  }

  // force_opus passthrough — user explicitly bypassing all gates.
  // Note: sentinel may not exist YET if this hook fires before tier-router,
  // so detect prefix in the prompt directly as well.
  const sentinel = readSentinel(sessionId);
  if ((sentinel && sentinel.force_opus === true) || /!opus-force:/.test(userPrompt)) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'skill_trigger_guard',
      session_id: sessionId,
      action: 'passthrough-opus-force',
      mode: MODE,
    });
    process.exit(0);
  }

  const triggers = loadTriggers();
  if (triggers.length === 0) process.exit(0);

  // Match prompt against triggers.
  const matched = [];
  for (const t of triggers) {
    if (t.regex.test(userPrompt)) matched.push(t);
  }
  if (matched.length === 0) process.exit(0);

  // Read pending. Increment turn_count. Drop entries older than TTL.
  const pending = readPending(sessionId);
  const turnNow = (pending.turn_count || 0) + 1;
  const stillPending = (pending.entries || []).filter(e =>
    (turnNow - (e.turn_recorded || 0)) <= PENDING_TTL_TURNS
  );

  // Add this turn's matches as pending (Stop hook in v3.2 will resolve them
  // if the corresponding skill auto-invoked).
  for (const m of matched) {
    if (!stillPending.find(e => e.skill === m.skill && e.pattern === m.pattern)) {
      stillPending.push({
        skill: m.skill,
        pattern: m.pattern,
        severity: m.severity,
        turn_recorded: turnNow,
        ts: new Date().toISOString(),
      });
    }
  }

  writePending(sessionId, {entries: stillPending, turn_count: turnNow});

  // Build advisory. One line per matched skill, deduped.
  const seen = new Set();
  const lines = [];
  for (const m of matched) {
    if (seen.has(m.skill)) continue;
    seen.add(m.skill);
    const triggerWord = (userPrompt.match(m.regex) || [])[0] || m.pattern;
    lines.push(
      `PRISM SKILL-TRIGGER: prompt mentioned "${triggerWord}" — consider invoking the <${m.skill}> skill (or run /prism-index if you didn't know it was available).`
    );
  }

  appendLog({
    ts: new Date().toISOString(),
    event: 'skill_trigger_guard',
    session_id: sessionId,
    matched_skills: [...seen],
    turn: turnNow,
    action: 'advisory',
    mode: MODE,
    prompt_hash: sha256short(userPrompt),
  });

  if (lines.length) process.stdout.write(lines.join('\n'));
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
