#!/usr/bin/env node
// PRISM Panel-Hallucination Guard (v3.2.0) — closes DOCTRINE-DRIFT-001
//
// Dual-path hook — handles two event shapes:
//
// PATH A — SubagentStop: when a subagent of subagent_type containing
// "blueprint", "panel", or "orchestrator" returns, scan its output for
// expert-persona patterns and cross-reference against the indexed roster
// at ~/.claude/skills/prism-plan/references/roster.json (agents + skills
// + tools blocks). Names that don't match ANY indexed resource AND aren't
// in the §6 hardcoded fallback whitelist (Architect / Security /
// Performance / etc.) are flagged as "unindexed personas" — the doctrinal
// drift case where the subagent invents experts not actually available.
//
// PATH B — PostToolUse (Write to panel.json): v4.5 A3 DROPPED-positions
// logging. When a Write tool call targets a panel.json path, read the
// just-written panel.json, identify positions that have zero challenges
// (insufficient evidence — dropped/theater positions), and append
// {position, reason, dropped_at_phase, ts} entries to
// panel.dropped_positions[]. Writes panel.json back atomically.
// Fires ONLY when there are actual drops (non-empty dropped set).
// Kill switch: PRISM_DISABLE_DROPPED_LOG=1.
//
// Cross-reference logic (Path A):
//   1. Extract candidate names from output via persona patterns:
//        **[Name]**:                  (markdown bold colon)
//        **Name**:                    (no brackets)
//        *[Name] —*                   (italic em-dash)
//        - Name: <text>               (bullet w/ name)
//   2. Normalise (case-insensitive, strip punctuation/role suffixes).
//   3. Match against:
//        a. Hardcoded §6 whitelist of canonical archetypes.
//        b. roster.agents.<name> (any key).
//        c. roster.skills.<name> (any key).
//        d. roster.tools.<name> (any key).
//        e. Substring match within agent.core_domains entries.
//   4. Anything that matches NONE of those → flagged.
//
// Patterns copied (cite explicitly):
//   - SubagentStop targeting + early-exit on non-matching subagent_type:
//     prism-subagent-stop.mjs (existing pattern in repo).
//   - Sentinel-aware mode handling (soft / hard) and routing-log writes:
//     prism-agent-model-guard.mjs:200-238 (v2.9.1 split semantics shape).
//   - Atomic tempfile + rename + catch-fallback: copied verbatim from
//     prism-parent-dispatch-guard.mjs:90-107 (used here only for the
//     small "last-flag-summary" cache so the same panel doesn't re-flag
//     on every Stop event in a chained turn).
//   - Three-path subagent-bypass (parent_tool_use_id /
//     CLAUDE_CODE_ENTRYPOINT / sentinel.dispatched): prism-mutation-guard
//     v2.7.5 — used here defensively in case the SubagentStop event fires
//     under a runtime that propagates parent_tool_use_id.
//   - force_opus passthrough: prism-mutation-guard.mjs:281-311.
//   - PostToolUse panel.json path pattern + atomicWrite shape:
//     prism-phase-0d-challenges.mjs (Path B reuses same detection logic).
//
// Modes (Path A only):
//   soft (default): warn on stdout listing flagged names, exit 0
//   hard:           exit 2 with deny message asking to re-assemble panel
//                   from indexed resources
//   off:            silent passthrough
//
// Precedence: ~/.claude/prism-policy.json `guards.panel` →
// PRISM_PANEL_GUARD env → default soft. PRISM_POLICY_OVERRIDE=1 lets env
// win over policy.
//
// Latency target <50ms: roster JSON is read once, persona regex run once
// over the (typically <50KB) subagent output. No network, no heavy parse.

import {readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, renameSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const POLICY_PATH = join(H, '.claude', 'prism-policy.json');
const ROSTER_PATH = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');

// §6 Expert archetype roster from skills/prism-chat/SKILL.md. Hardcoded
// fallback whitelist — these names are always considered legitimate even
// if the indexed roster is empty/unscanned.
const ARCHETYPE_WHITELIST = new Set([
  'architect', 'security', 'performance', 'data', 'database', 'db',
  'devops', 'sre', 'cost', 'product', 'ux', 'ml', 'ai', 'compliance',
  'legal', 'skeptic', 'domain expert', 'domain', 'data/db', 'devops/sre',
  'product/ux', 'ml/ai', 'compliance/legal',
]);

// Subagent types that emit panel output. Case-insensitive substring match.
const PANEL_SUBAGENT_HINTS = ['blueprint', 'panel', 'orchestrator'];

// Persona patterns in subagent output. Each capture group must yield a
// candidate name. Order matters — more specific patterns first.
const PERSONA_PATTERNS = [
  // **[Name]**: rest
  /^\s*\*\*\[([^\]]+)\]\*\*\s*:/gm,
  // **Name**: rest
  /^\s*\*\*([A-Z][A-Za-z0-9 /\-]{1,40})\*\*\s*:/gm,
  // *[Name] —* rest   (italic em-dash header form)
  /^\s*\*\[([^\]]+)\]\s*[—-]\s*\*/gm,
  // *Name —* rest
  /^\s*\*([A-Z][A-Za-z0-9 /\-]{1,40})\s*[—-]\s*\*/gm,
];

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

function flagCachePath(sessionId) {
  return join(H, '.claude', `.prism-panel-flag-${sessionId || 'anon'}.json`);
}

function readFlagCache(sessionId) {
  try {
    const p = flagCachePath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// Atomic tempfile + rename + catch-fallback — verbatim shape from
// prism-parent-dispatch-guard.mjs:90-107.
function writeFlagCache(sessionId, payload) {
  try {
    const p = flagCachePath(sessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, p);
  } catch {
    try { writeFileSync(flagCachePath(sessionId), JSON.stringify(payload, null, 2)); } catch {}
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

let _rosterCache = null;
function loadRoster() {
  if (_rosterCache !== null) return _rosterCache;
  try {
    if (!existsSync(ROSTER_PATH)) { _rosterCache = {agents: {}, skills: {}, tools: {}}; return _rosterCache; }
    const r = JSON.parse(readFileSync(ROSTER_PATH, 'utf-8'));
    _rosterCache = {
      agents: r.agents || {},
      skills: r.skills || {},
      tools: r.tools || {},
    };
  } catch {
    _rosterCache = {agents: {}, skills: {}, tools: {}};
  }
  return _rosterCache;
}

function normaliseName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 /\-]/g, '')
    .trim();
}

// Returns true when `name` cross-references against ANY indexed resource
// or the hardcoded archetype whitelist.
function isKnownPersona(name, roster) {
  const n = normaliseName(name);
  if (!n) return true; // empty → don't flag
  if (ARCHETYPE_WHITELIST.has(n)) return true;
  // Compound names like "Security Architect" — split + check parts.
  const parts = n.split(/[\s/\-]+/).filter(Boolean);
  for (const p of parts) {
    if (ARCHETYPE_WHITELIST.has(p)) return true;
  }
  // Direct key lookups.
  for (const block of [roster.agents, roster.skills, roster.tools]) {
    if (!block) continue;
    for (const key of Object.keys(block)) {
      if (normaliseName(key) === n) return true;
    }
  }
  // Substring match within agent.core_domains.
  for (const key of Object.keys(roster.agents || {})) {
    const a = roster.agents[key];
    if (a && Array.isArray(a.core_domains)) {
      for (const d of a.core_domains) {
        if (normaliseName(d) === n || normaliseName(d).includes(n) || n.includes(normaliseName(d))) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractPersonas(output) {
  if (!output) return [];
  const found = new Set();
  for (const re of PERSONA_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(output)) !== null) {
      const name = (m[1] || '').trim();
      if (name && name.length <= 60) found.add(name);
    }
  }
  return [...found];
}

function resolveMode() {
  const envRaw = process.env.PRISM_PANEL_GUARD;
  const envSet = typeof envRaw === 'string' && envRaw.length > 0;
  const override = process.env.PRISM_POLICY_OVERRIDE === '1';

  let policyMode = null;
  try {
    if (existsSync(POLICY_PATH)) {
      const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf-8'));
      if (policy && policy.guards && typeof policy.guards.panel === 'string') {
        policyMode = policy.guards.panel.toLowerCase();
      }
    }
  } catch {}

  let mode;
  if (override && envSet) mode = envRaw.toLowerCase();
  else if (policyMode) mode = policyMode;
  else if (envSet) mode = envRaw.toLowerCase();
  else mode = 'soft';

  return ['soft', 'hard', 'off'].includes(mode) ? mode : 'soft';
}

// ─── Path B: PostToolUse dropped-positions logger (v4.5 A3) ─────────────────

// Returns the panel.json file path if the payload is a PostToolUse Write
// targeting a panel.json inside a .prism-task-<sha> directory. null otherwise.
function panelPathFromPayload(payload) {
  // Only act on Write tool completions.
  if (payload?.tool_name !== 'Write') return null;
  const fp = payload?.tool_input?.file_path;
  if (!fp) return null;
  if (!/\.prism-task-[^/\\]+[/\\]panel\.json$/.test(fp)) return null;
  return fp;
}

// Classify why a position was dropped.
// Returns a reason string, or null if the position should NOT be logged.
function classifyDropReason(position) {
  const challenges = position.challenges ?? [];
  if (challenges.length === 0) return 'insufficient_challenges';
  // A specialist key is required for a position to be valid.
  if (!position.specialist) return 'specialist_unknown';
  return null;
}

// Atomic write — same shape as prism-phase-0d-oob.mjs atomicWrite.
function atomicWritePanel(filePath, obj) {
  const content = JSON.stringify(obj, null, 2);
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

// Path B entry point. Returns true if this payload was a panel.json write
// (and we handled it — successfully or not). Returns false to fall through
// to Path A (SubagentStop).
function handleDroppedPositions(payload) {
  const panelPath = panelPathFromPayload(payload);
  if (!panelPath) return false;

  // Kill switch.
  if (process.env.PRISM_DISABLE_DROPPED_LOG === '1') process.exit(0);

  let panel;
  try {
    panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
  } catch (e) {
    process.stderr.write(`[panel-guard/A3] cannot read panel.json: ${e.message}\n`);
    process.exit(0);
  }

  const positions = panel.positions ?? [];
  const ts = new Date().toISOString();
  const newDrops = [];

  for (const position of positions) {
    const reason = classifyDropReason(position);
    if (reason === null) continue;
    newDrops.push({
      position: position.title ?? position.name ?? '(unnamed)',
      reason,
      dropped_at_phase: '0d',
      ts,
    });
  }

  // Write-back ONLY when there are actual drops (self-review: no spurious writes).
  if (newDrops.length > 0) {
    if (!Array.isArray(panel.dropped_positions)) panel.dropped_positions = [];
    panel.dropped_positions.push(...newDrops);

    try {
      atomicWritePanel(panelPath, panel);
    } catch (e) {
      // Fallback: direct write (mirrors prism-phase-0d-oob.mjs atomicWrite fallback).
      try { writeFileSync(panelPath, JSON.stringify(panel, null, 2), 'utf-8'); } catch {}
      process.stderr.write(`[panel-guard/A3] atomic write failed, used direct fallback: ${e.message}\n`);
    }

    appendLog({
      ts,
      event: 'panel_guard_dropped',
      schema_version: 3,
      panel_path: panelPath,
      dropped_count: newDrops.length,
      dropped_positions: newDrops.map(d => ({position: d.position, reason: d.reason})),
    });
  }

  process.exit(0);
}

// ─── Path A: SubagentStop panel-hallucination guard ──────────────────────────

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  // Dispatch to Path B if this looks like a PostToolUse Write event.
  // handleDroppedPositions calls process.exit(0) when it handles the event.
  // It returns false (without exiting) only when the payload is NOT a
  // panel.json Write, allowing Path A (SubagentStop) to proceed.
  handleDroppedPositions(input);

  const MODE = resolveMode();
  if (MODE === 'off') process.exit(0);

  // SubagentStop payload: subagent_type, output (or transcript), session_id.
  const subagentType = String(
    input.subagent_type ||
    input.tool_input?.subagent_type ||
    input.agent_type ||
    ''
  ).toLowerCase();
  if (!subagentType) process.exit(0);

  const matchesPanel = PANEL_SUBAGENT_HINTS.some(h => subagentType.includes(h));
  if (!matchesPanel) process.exit(0);

  const sessionId = input.session_id || 'anon';

  // Defensive three-path subagent-bypass — see header. SubagentStop
  // typically fires in parent context, but some runtimes propagate
  // parent_tool_use_id when the panel was nested-dispatched. We don't
  // gate nested panels (they're under a parent panel that already ran).
  const isSubagentById = !!input.parent_tool_use_id;
  const isSubagentByEnv = String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  const sentinel = readSentinel(sessionId);
  const isSubagentByDispatched = false; // SubagentStop always fires after dispatch; this signal would always be true. Skip.
  if (isSubagentById || isSubagentByEnv) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'panel_guard',
      session_id: sessionId,
      action: 'passthrough-nested-subagent',
      reason: isSubagentById ? 'parent_tool_use_id' : 'env',
      mode: MODE,
    });
    process.exit(0);
  }

  // force_opus passthrough.
  if (sentinel && sentinel.force_opus === true) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'panel_guard',
      session_id: sessionId,
      action: 'passthrough-opus-force',
      mode: MODE,
    });
    process.exit(0);
  }

  // Read subagent output. Field name varies across Claude Code builds.
  const output =
    input.output ||
    input.tool_response?.output ||
    input.tool_response?.content ||
    input.transcript ||
    input.result ||
    '';

  if (!output || typeof output !== 'string') process.exit(0);

  const candidates = extractPersonas(output);
  if (candidates.length === 0) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'panel_guard',
      session_id: sessionId,
      subagent_type: subagentType,
      action: 'passthrough-no-personas',
      output_hash: sha256short(output),
      mode: MODE,
    });
    process.exit(0);
  }

  const roster = loadRoster();
  const flagged = candidates.filter(c => !isKnownPersona(c, roster));

  // De-dupe: don't re-flag the same set in the same session within a
  // short window (chained Stop events would otherwise spam).
  const cache = readFlagCache(sessionId);
  const flaggedKey = flagged.slice().sort().join('|').toLowerCase();
  const now = Date.now();
  const recentSame = cache && cache.flagged_key === flaggedKey && (now - (cache.ts || 0)) < 30_000;

  if (flagged.length === 0 || recentSame) {
    if (flagged.length > 0) {
      appendLog({
        ts: new Date().toISOString(),
        event: 'panel_guard',
        session_id: sessionId,
        subagent_type: subagentType,
        action: 'passthrough-cached',
        flagged_count: flagged.length,
        mode: MODE,
      });
    } else {
      appendLog({
        ts: new Date().toISOString(),
        event: 'panel_guard',
        session_id: sessionId,
        subagent_type: subagentType,
        action: 'passthrough-all-known',
        candidate_count: candidates.length,
        mode: MODE,
      });
    }
    process.exit(0);
  }

  writeFlagCache(sessionId, {ts: now, flagged_key: flaggedKey, flagged});

  const notice = [
    `PRISM PANEL-GUARD: subagent '${subagentType}' returned a panel containing ${flagged.length} unindexed persona${flagged.length === 1 ? '' : 's'}: ${flagged.map(n => `"${n}"`).join(', ')}.`,
    `These names do not match any entry in roster.agents/skills/tools at ~/.claude/skills/prism-plan/references/roster.json AND are not in the §6 archetype whitelist (Architect, Security, Performance, Cost, Skeptic, etc.).`,
    `This usually means the panel was hallucinated from training-data archetypes rather than assembled from real, indexed expertise — the DOCTRINE-DRIFT-001 failure mode.`,
    `Fix: re-assemble the panel using only canonical §6 archetypes OR roster-indexed agents. If a needed expert is missing, run /prism-index to refresh, or invoke agent-factory to instantiate one.`,
    `Override for this turn: prefix the user prompt with !opus-force:. Disable: set PRISM_PANEL_GUARD=off.`,
  ].join('\n');

  appendLog({
    ts: new Date().toISOString(),
    event: 'panel_guard',
    session_id: sessionId,
    subagent_type: subagentType,
    flagged,
    candidate_count: candidates.length,
    action: MODE === 'hard' ? 'deny' : 'nudge',
    mode: MODE,
    output_hash: sha256short(output),
  });

  if (MODE === 'hard') {
    // SubagentStop hooks signal block via exit code 2 + stderr message.
    process.stderr.write(notice + '\n');
    process.exit(2);
  }

  process.stdout.write(notice);
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
