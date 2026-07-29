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
//     writeSentinel() in prism-parent-dispatch-guard.mjs (used here only for the
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
import {renameWithRetry} from '../tools/lib/atomic-fs.mjs';
import {join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {prismHome} from './lib/prism-home.mjs';

// Home-derived paths are resolved at CALL time (not captured at module load):
// (a) the in-process dispatcher imports this module once, so a frozen module-top
//     HOME would leak across sessions / defeat test isolation; and
// (b) prismHome() rejects the literal "undefined"/"null" env that produced the
//     stray `undefined/.claude/...` artifact.
const logPath = () => join(prismHome(), '.claude', '.prism-routing.jsonl');
const policyPath = () => join(prismHome(), '.claude', 'prism-policy.json');
const rosterPath = () => join(prismHome(), '.claude', 'skills', 'prism-plan', 'references', 'roster.json');

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
  return join(prismHome(), '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function flagCachePath(sessionId) {
  return join(prismHome(), '.claude', `.prism-panel-flag-${sessionId || 'anon'}.json`);
}

function readFlagCache(sessionId) {
  try {
    const p = flagCachePath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// Atomic tempfile + rename + catch-fallback — verbatim shape from
// writeSentinel() in hooks/prism-parent-dispatch-guard.mjs.
// Bounded retry (task #82/#88) absorbs the transient Windows AV/indexer
// handle-lock window before degrading; the degraded path is logged rather
// than silent (D046).
function writeFlagCache(sessionId, payload) {
  const p = flagCachePath(sessionId);
  const tmp = p + '.tmp';
  const body = JSON.stringify(payload, null, 2);
  try {
    writeFileSync(tmp, body);
    renameWithRetry(renameSync, tmp, p);
  } catch (renameErr) {
    try {
      writeFileSync(p, body);
      appendLog({event: 'panel_guard_flag_cache_write', session_id: sessionId,
        status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
    } catch (fallbackErr) {
      appendLog({event: 'panel_guard_flag_cache_write', session_id: sessionId,
        status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
    }
  }
}

function appendLog(obj) {
  try {
    const lp = logPath();
    mkdirSync(dirname(lp), {recursive: true});
    appendFileSync(lp, JSON.stringify(obj) + '\n');
  } catch {}
}

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

let _rosterCache = null;
function loadRoster() {
  if (_rosterCache !== null) return _rosterCache;
  try {
    const rpath = rosterPath();
    if (!existsSync(rpath)) { _rosterCache = {agents: {}, skills: {}, tools: {}}; return _rosterCache; }
    const r = JSON.parse(readFileSync(rpath, 'utf-8'));
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

// ─── D054 round-2: vertical-signal seat classifier ─────────────────────────
// Replaces the gameable part-wise ARCHETYPE_WHITELIST containment used by the
// provenance detector. `isKnownPersona` (above) stays UNCHANGED — it still
// serves the legacy persona-in-output path (line ~743). This classifier is the
// provenance path's ONLY archetype-vs-domain judge.
//
// Rule (hard-to-game, defensible):
//  1. A VERTICAL-SIGNAL word/phrase forces VERTICAL (provenance-required),
//     regardless of any archetype token also present. Closes the under-fire
//     "<domain> ... domain expert" escape — those titles carry `expert`/
//     `domain expert` and are now flagged when filled generic.
//  2. Otherwise the seat is archetype-EXEMPT iff it has NO vertical signal AND
//     every significant token is an archetype word or a generic role-filler.
//     A concrete domain noun with no vertical signal → treated as vertical
//     (safer default in the flagging direction).
// Bare archetype voices ("Security", "Skeptic", "Red-team", "Devil's advocate")
// filled general-purpose are LEGITIMATELY exempt — archetypes need no roster
// provenance; only seats asserting domain expertise require it.
const VERTICAL_SIGNAL_WORDS = new Set([
  'expert', 'specialist', 'engineer', 'analyst', 'strategist',
  'authority', 'director',
]);
// Cross-cutting adversarial/role archetypes — need NO roster provenance.
const ARCHETYPE_WORDS = new Set([
  // canonical PRISM panel archetypes (from prism-chat SKILL.md)
  'architect', 'security', 'performance', 'skeptic', 'domain',
  'data', 'database', 'db', 'devops', 'sre', 'cost', 'product',
  'ux', 'ml', 'ai', 'compliance', 'legal',
  // round-2 additions (fix the Red-team over-fire class)
  'red', 'team', 'redteam', 'devil', 'devils', 'advocate',
  'adversary', 'contrarian', 'optimist', 'pessimist',
  'integrator', 'generalist',
]);
// Generic role-fillers that carry no domain signal on their own.
const ARCHETYPE_FILLERS = new Set([
  'the', 'a', 'an', 'of', 'for', 'on', 'and', 'voice', 'seat', 'hawk',
  'lens', 'chair', 'role', 'perspective', 'position', 'panelist',
  'panellist', 'member', 'reviewer', 'critic', 'guardian', 'watchdog',
]);

// Returns true when a seat title asserts DOMAIN expertise (provenance-required),
// false when it is a bare cross-cutting archetype (provenance-exempt).
function seatRequiresProvenance(title) {
  const n = normaliseName(title);
  if (!n) return false; // empty title → treat as archetype (do not flag)
  // 1. Vertical-signal phrases + words force VERTICAL regardless of archetype tokens.
  if (/\bdomain expert\b/.test(n)) return true;
  if (/\barchitect of\b/.test(n)) return true;
  const tokens = n.split(/[\s/\-]+/).filter(Boolean);
  if (tokens.some((t) => VERTICAL_SIGNAL_WORDS.has(t))) return true;
  // 2. Archetype-exempt iff every significant token is archetype-or-filler.
  const significant = tokens.filter((t) => !ARCHETYPE_FILLERS.has(t));
  if (significant.length === 0) return false; // pure filler → archetype/quiet
  const allArchetype = significant.every((t) => ARCHETYPE_WORDS.has(t));
  return !allArchetype; // a concrete domain noun present → vertical
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
    const pp = policyPath();
    if (existsSync(pp)) {
      const policy = JSON.parse(readFileSync(pp, 'utf-8'));
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

// ─── Path B: PanelGuardExit sentinel ────────────────────────────────────────
// Used by runPostToolUse() to hoist process.exit() calls out of check* helpers
// so the function is a pure {exit, stdout, stderr} return. Only the CLI path
// (handleDroppedPositions / main) converts these back into process.exit().

class PanelGuardExit {
  constructor(code, stderr = '') { this.code = code; this.stderr = stderr; }
}

// ─── Path B helpers: SCOPE GUARD (T31) + alternatives-considered (T32) ──────

// T31 — D3 SCOPE GUARD: detect positions whose titles share no keywords with
// the declared panel scope. Heuristic: simple keyword-overlap.
//
// Advisory by default (exit 0): emits a stderr warning per out-of-scope
// position but does NOT block the write. The heuristic over-fires on
// realistic PRISM panel scopes (e.g. "ship v4.5 Phase 4 coverage/hygiene"
// paired with a position titled "D3 SCOPE GUARD enforcement test") because
// domain-specific vocabulary in position titles rarely overlaps word-for-word
// with the scope phrase.
//
// Strict mode (exit 2): set PRISM_SCOPE_GUARD=strict to restore the v4.4
// block-on-violation behavior. Suitable for narrow, well-scoped panels where
// hard enforcement is desired.
//
// Kill switch: PRISM_DISABLE_SCOPE_GUARD=1 (silences even the advisory).
function checkScope(panel) {
  if (process.env.PRISM_DISABLE_SCOPE_GUARD === '1') return;
  if (!panel.scope || typeof panel.scope !== 'string') return; // backwards-compat
  const stop = new Set(['the','a','an','of','for','to','in','on','and','or','with','from','by','at','is','as']);
  const tokenize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !stop.has(w));
  const scopeWords = new Set(tokenize(panel.scope).filter(w => w.length >= 4));
  if (scopeWords.size === 0) return; // scope too vague to enforce
  const strict = process.env.PRISM_SCOPE_GUARD === 'strict';
  for (const pos of (panel.positions || [])) {
    if (!pos.title || typeof pos.title !== 'string') continue;
    const titleWords = tokenize(pos.title).filter(w => w.length >= 4);
    const overlap = titleWords.some(w => scopeWords.has(w));
    if (!overlap) {
      const msg = `SCOPE GUARD: position "${pos.title}" appears outside panel scope "${panel.scope}"`;
      if (strict) {
        throw new PanelGuardExit(2, msg + '\n');
      } else {
        process.stderr.write(msg + ' (advisory; set PRISM_SCOPE_GUARD=strict to enforce)\n');
        // continue scanning — emit one stderr line per out-of-scope position
      }
    }
  }
}

// T32 — G2 alternatives-considered validation: if present, must be an array
// of {approach, why_not} objects. Absent = pass (additive, backwards-compat).
// Kill switch: PRISM_DISABLE_ALTERNATIVES_CHECK=1.
function checkAlternatives(panel) {
  if (process.env.PRISM_DISABLE_ALTERNATIVES_CHECK === '1') return;
  const alts = panel.rationale?.alternatives_considered;
  if (alts === undefined) return; // additive — absent is fine (pre-v4.5 panels)
  if (!Array.isArray(alts)) {
    throw new PanelGuardExit(2, '[panel-guard] rationale.alternatives_considered must be an array\n');
  }
  for (const alt of alts) {
    if (typeof alt !== 'object' || alt === null || Array.isArray(alt)) {
      throw new PanelGuardExit(2, '[panel-guard] each alternatives_considered entry must be a {approach, why_not} object\n');
    }
    if (typeof alt.approach !== 'string' || alt.approach.trim() === '' || typeof alt.why_not !== 'string' || alt.why_not.trim() === '') {
      throw new PanelGuardExit(2, '[panel-guard] each alternatives_considered entry must have non-empty approach + why_not strings\n');
    }
  }
}

// v5.x — DISPATCH-MODE guard (build step 2). The structural enforcement that
// would have caught the Round-12 role-play gap: when a panel declares
// dispatch_mode="dispatch", every position MUST carry a real, UNIQUE
// dispatched_agent_id (the agentId returned by a real per-seat Agent() call).
// A panel claiming dispatch mode with zero/partial/duplicate ids = role-play
// masquerading as dispatch → block (exit 2). dispatch_mode="roleplay" is the
// sanctioned opt-in fast mode (no ids required). Absent = legacy/additive.
// Kill switch: PRISM_DISABLE_DISPATCH_CHECK=1.
function checkDispatchMode(panel) {
  if (process.env.PRISM_DISABLE_DISPATCH_CHECK === '1') return;
  const mode = panel.dispatch_mode;
  if (mode === undefined) return; // additive — pre-v5.x panels are unenforced
  if (mode !== 'dispatch' && mode !== 'roleplay') {
    throw new PanelGuardExit(2, '[panel-guard] dispatch_mode must be "dispatch" or "roleplay"\n');
  }
  if (mode === 'roleplay') return; // sanctioned opt-in fast mode — no real dispatch required
  // mode === 'dispatch': every seat must be a distinct, real subagent dispatch.
  const positions = panel.positions ?? [];
  if (positions.length === 0) {
    throw new PanelGuardExit(2, '[panel-guard] dispatch_mode=dispatch but the panel has zero positions — a real dispatched panel needs at least one seat\n');
  }
  const ids = [];
  for (const p of positions) {
    const id = p.dispatched_agent_id;
    if (typeof id !== 'string' || id.trim() === '') {
      const who = p.title ?? p.expert_name ?? '(unnamed)';
      throw new PanelGuardExit(2, `[panel-guard] dispatch_mode=dispatch but position "${who}" has no dispatched_agent_id — a real per-seat Agent() dispatch is required (role-play masquerading as dispatch). Use dispatch_mode=roleplay for the opt-in fast mode.\n`);
    }
    ids.push(id.trim());
  }
  if (new Set(ids).size < ids.length) {
    throw new PanelGuardExit(2, '[panel-guard] dispatch_mode=dispatch but dispatched_agent_id values are not unique — each seat must be a distinct real subagent dispatch\n');
  }
}

// v5.x — FACTORY-FIRST seat-sourcing guard (Path B). Closes the
// "adjacency-is-not-fitness" gap (feedback 2026-06-04; D009): in a real
// dispatched panel, a seat needing top-class VERTICAL/domain expertise must be
// filled by a durable rostered specialist (created/upgraded via @agent-factory)
// — NOT a generic general-purpose subagent role-scoped as a persona, and not an
// adjacent agent bent to fit. Enforced ONLY on positions explicitly tagged
// `vertical: true`, so it is fully additive: legacy/untagged panels are
// unenforced (zero false positives). A tagged seat PASSES when its `agent_type`
// is not general-purpose AND (it declares `seat_source` ∈ {factory-created,
// rostered} OR its `specialist` resolves to a roster.agents entry). This guard
// enforces only the FLOOR — that a real durable specialist exists; the
// semantic "is it a STRONG fit vs merely adjacent" judgment stays with the
// orchestrator protocol (phase-0-team-assembly.md), which a hook cannot make.
//
// Mode follows the panel-guard mode: soft (default) = stderr advisory +
// continue; hard = exit 2 (block the panel write); off = skip. Only meaningful
// in dispatch_mode="dispatch" — roleplay is the sanctioned low-stakes escape.
// Kill switch: PRISM_DISABLE_FACTORY_FIRST=1.
function checkFactoryFirst(panel) {
  if (process.env.PRISM_DISABLE_FACTORY_FIRST === '1') return;
  if (panel.dispatch_mode !== 'dispatch') return; // roleplay/absent → not enforced here
  const mode = resolveMode();
  if (mode === 'off') return;

  const roster = loadRoster();
  const rosterKeys = new Set(Object.keys(roster.agents || {}).map(normaliseName));
  const resolvesToRoster = (specialist) => {
    if (typeof specialist !== 'string' || specialist.trim() === '') return false;
    return rosterKeys.has(normaliseName(specialist.replace(/^@/, '')));
  };

  const violations = [];
  for (const p of (panel.positions ?? [])) {
    if (p.vertical !== true) continue; // only explicitly-tagged vertical seats
    const who = p.title ?? p.expert_name ?? p.specialist ?? '(unnamed)';
    const agentType = normaliseName(p.agent_type);
    if (agentType === 'general-purpose' || agentType === 'generic') {
      violations.push(`"${who}" was filled by a generic ${p.agent_type} subagent — a generic subagent cannot be a durable vertical specialist`);
      continue;
    }
    const seatSource = normaliseName(p.seat_source);
    if (seatSource === 'factory-created' || seatSource === 'rostered') continue;
    if (resolvesToRoster(p.specialist)) continue;
    violations.push(`"${who}" (specialist ${p.specialist ? `"${p.specialist}"` : 'unset'}) does not resolve to any rostered agent`);
  }

  if (violations.length === 0) return;

  const notice = [
    `PRISM FACTORY-FIRST GUARD: a dispatched panel filled ${violations.length} vertical-expertise seat${violations.length === 1 ? '' : 's'} without a durable rostered specialist:`,
    ...violations.map(v => `  - ${v}`),
    `Adjacency is not fitness: a seat needing top-class vertical/domain expertise must go through @agent-factory to create (or --upgrade) a durable specialist that registers in roster.json.`,
    `Fix: spawn @agent-factory for each flagged seat, then re-dispatch with the new specialist's roster key in position.specialist (and seat_source:"factory-created"). The sanctioned low-stakes escape is dispatch_mode:"roleplay".`,
    `Disable: PRISM_PANEL_GUARD=off, or PRISM_DISABLE_FACTORY_FIRST=1.`,
  ].join('\n');

  appendLog({
    ts: new Date().toISOString(),
    event: 'panel_guard_factory_first',
    schema_version: 1,
    dispatch_mode: 'dispatch',
    violations: violations.length,
    action: mode === 'hard' ? 'deny' : 'nudge',
    mode,
  });

  if (mode === 'hard') {
    throw new PanelGuardExit(2, notice + '\n');
  }
  process.stderr.write(notice + '\n(advisory; set PRISM_PANEL_GUARD=hard to enforce)\n');
}

// v5.x (D054) — inference-based provenance detector. Unlike checkFactoryFirst it
// does NOT require the explicit vertical:true tag (it INFERS vertical) and does
// NOT require dispatch_mode==='dispatch' — closing the two silent-skip escapes.
// Instrument-first: default 'observe' logs only, so the ad-hoc-seat rate is
// measured before any hard flip. Own env gate PRISM_PANEL_PROVENANCE
// (off|observe|soft|hard, DEFAULT observe). Reuses isKnownPersona/normaliseName/
// loadRoster/appendLog/PanelGuardExit — no new imports.
const GENERIC_AGENT_TYPES = new Set(['general-purpose', 'generic', 'claude', 'unknown', '']);
function detectAdHocSeats(panel, panelPath) {
  const raw = String(process.env.PRISM_PANEL_PROVENANCE || 'observe').toLowerCase().trim();
  const mode = ['off', 'observe', 'soft', 'hard'].includes(raw) ? raw : 'observe';
  if (mode === 'off' || process.env.PRISM_DISABLE_FACTORY_FIRST === '1') return;

  const roster = loadRoster() || {agents: {}};
  const rosterKeys = new Set(Object.keys(roster.agents || {}).map(normaliseName));
  const resolvesToRoster = (s) =>
    typeof s === 'string' && s.trim() !== '' && rosterKeys.has(normaliseName(s.replace(/^@/, '')));

  const flagged = [];
  for (const p of (panel.positions ?? [])) {
    const who = p.title ?? p.expert_name ?? p.specialist ?? '(unnamed)';
    const agentType = normaliseName(p.agent_type);
    const seatSource = normaliseName(p.seat_source);
    // Infer vertical: an explicit tag, a declared seat_source/agent_type, or a
    // title that asserts domain expertise (seatRequiresProvenance — the
    // vertical-signal rule, D054 round-2) all mark a seat as domain-expertise.
    // A bare cross-cutting archetype (Architect/Skeptic/Red-team/Devil's
    // advocate) is provenance-exempt and skipped.
    const inferredVertical =
      p.vertical === true ||
      seatSource !== '' ||
      (agentType !== '' && !GENERIC_AGENT_TYPES.has(agentType)) ||
      seatRequiresProvenance(who);
    if (!inferredVertical) continue; // genuine archetype seat → not domain-expertise
    // Provenance OK when: real (non-generic) agent_type AND (declared factory/rostered
    // source OR specialist resolves to the roster).
    const hasRealType = agentType !== '' && !GENERIC_AGENT_TYPES.has(agentType);
    const hasSource = seatSource === 'factory-created' || seatSource === 'rostered';
    if (hasRealType && (hasSource || resolvesToRoster(p.specialist))) continue;
    flagged.push({
      seat: who,
      agent_type: p.agent_type ?? null,
      seat_source: p.seat_source ?? null,
      specialist: p.specialist ?? null,
      specialist_resolves: resolvesToRoster(p.specialist),
      inferred_vertical: true,
    });
  }
  if (flagged.length === 0) return;

  const ts = new Date().toISOString();
  const action = mode === 'hard' ? 'deny' : (mode === 'soft' ? 'nudge' : 'log');
  for (const f of flagged) {
    appendLog({
      ts, event: 'panel_provenance_adhoc_seat', schema_version: 1,
      panel_path: panelPath, task_id: panel.task_id ?? null,
      dispatch_mode: panel.dispatch_mode ?? null,
      mode, action, ...f,
    });
  }
  if (mode === 'soft' || mode === 'hard') {
    const lines = [
      `PRISM PANEL-PROVENANCE: ${flagged.length} panel seat(s) look ad-hoc (generic agent_type or unresolved specialist, no factory/rostered provenance):`,
      ...flagged.map(f => `  - "${f.seat}" (agent_type ${f.agent_type ?? 'unset'}, specialist ${f.specialist ?? 'unset'})`),
      `A vertical seat must resolve to a rostered specialist or be @agent-factory-created (seat_source:"factory-created"). Roleplay panels: set dispatch_mode:"roleplay".`,
    ].join('\n');
    if (mode === 'hard') throw new PanelGuardExit(2, lines + '\n');
    process.stderr.write(lines + '\n(advisory; PRISM_PANEL_PROVENANCE=hard to enforce)\n');
  }
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
//
// RB-07: bare cross-cutting archetype seats (Security/Skeptic/Architect/...)
// legitimately carry no `specialist` — the panel-summoning protocol
// (prism-prompt-tier-router.mjs panelSeatSourcingBlock step 4) explicitly
// instructs "Cross-cutting archetype seats ... stay untagged". Reuses
// seatRequiresProvenance — the SAME archetype-vs-domain judge already used by
// checkFactoryFirst/detectAdHocSeats in this file — rather than a new
// whitelist.
function classifyDropReason(position) {
  const challenges = position.challenges ?? [];
  if (challenges.length === 0) return 'insufficient_challenges';
  const who = position.title ?? position.expert_name ?? position.specialist ?? '';
  if (position.vertical !== true && !seatRequiresProvenance(who)) return null;
  // A specialist key is required for a position to be valid.
  if (!position.specialist) return 'specialist_unknown';
  return null;
}

// Atomic write — same shape as prism-phase-0d-oob.mjs atomicWrite.
function atomicWritePanel(filePath, obj) {
  const content = JSON.stringify(obj, null, 2);
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  // F33: bounded retry on transient Windows EPERM/EACCES/EBUSY.
  renameWithRetry(renameSync, tmp, filePath);
}

// Q2: classify a challenge's evidence into the 7-class taxonomy at panel-write.
// Cheap keyword/regex heuristic — single source of truth read by the A1 reviewer
// AND by prism-phase-0d-challenges.mjs telemetry (which reads c.evidence_class).
function classifyEvidenceClass(challenge) {
  const t = String(challenge?.text ?? challenge?.claim ?? challenge ?? '');
  if (/\b[a-f0-9]{7,40}\b|\.(mjs|js|ts|md|json):\d+|\bfile\b.*\bline\b/i.test(t)) return 'PRECEDENT';
  if (/\b(\d+(\.\d+)?\s*(ms|s|%|x|reqs?|ops?)|benchmark|measured|test (passed|result)|log line)\b/i.test(t)) return 'MEASUREMENT';
  if (/\b(spec|requirement|design (doc|constraint)|MUST|SHALL|per the (design|spec))\b/i.test(t)) return 'SPEC';
  if (/[""][^""]{8,}[""]|\bquot(e|ed)\b/i.test(t)) return 'QUOTE';
  if (/\b(demo|working (artifact|example)|reproduce|repro steps|see (the )?(branch|PR))\b/i.test(t)) return 'DEMO';
  if (/\b(theater|no evidence|hand-?wav|vague|unsubstantiated)\b/i.test(t)) return 'CHALLENGE-SUBSTANCE';
  return 'REASONED-INFERENCE'; // logically derived, no citation
}

// F24 — canonical 7-class evidence taxonomy, extracted from
// classifyEvidenceClass()'s own return set (single in-file source of truth;
// reused below rather than hardcoding a fourth copy — the reviewer.md and
// router.mjs copies are the other two, per the drift test in
// test-phase-0d-schema-parity.mjs). classifyEvidenceClass() returns ONLY
// these values.
export const EVIDENCE_CLASSES = Object.freeze([
  'PRECEDENT', 'MEASUREMENT', 'SPEC', 'QUOTE', 'DEMO',
  'REASONED-INFERENCE', 'CHALLENGE-SUBSTANCE',
]);
const EVIDENCE_CLASS_SET = new Set(EVIDENCE_CLASSES);

// F24 — RB-16 proved the chair can write an OUT-OF-TAXONOMY evidence_class
// ("CODE-GROUNDED", observed live 4x in .prism-routing.jsonl phase_0d_challenge
// events, task_sha widget-forge-group-commit-20260727) despite
// prism-prompt-tier-router.mjs:172 explicitly instructing "ONLY these 7
// values — never invent others". Instruction-only enforcement is
// insufficient for this field; it needs a structural check. The pre-fix gate
// here was `!c.evidence_class` — ABSENCE-ONLY — so a present-but-illegal
// value passed through untouched. Fixed gate: fill if absent OR value not in
// the canonical 7-set. On illegal, COERCE (so downstream consumers always
// get a legal value) AND emit an advisory telemetry record capturing the
// ORIGINAL illegal value (so the chair's disobedience stays visible instead
// of being silently lost — see task filing F24).
function classifyPanelEvidence(panel, panelPath) {
  let mutated = false;
  const illegal = [];
  for (const position of panel.positions ?? []) {
    for (const c of position.challenges ?? []) {
      if (!c || typeof c !== 'object') continue;
      const current = c.evidence_class;
      const isIllegal = !!current && !EVIDENCE_CLASS_SET.has(current);
      if (!current || isIllegal) {
        const coerced = classifyEvidenceClass(c);
        if (isIllegal) {
          illegal.push({
            title: position.title ?? position.name ?? '(unnamed)',
            illegal_value: current,
            coerced_to: coerced,
          });
        }
        c.evidence_class = coerced;
        mutated = true;
      }
    }
  }
  if (illegal.length > 0) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'panel_guard_evidence_class_illegal',
      schema_version: 1,
      panel_path: panelPath ?? null,
      task_id: panel.task_id ?? null,
      illegal_count: illegal.length,
      illegal,
    });
  }
  return mutated;
}

// Path B pure function — PostToolUse Write to panel.json.
// Returns {exit, stdout, stderr}. Never calls process.exit().
// Enforcement exits (exit 2) are surfaced via PanelGuardExit sentinel thrown
// by check* helpers; the CLI path (handleDroppedPositions) converts them back.
export function runPostToolUse(payload) {
  const input = payload || {};
  const sessionId = input.session_id ?? null;
  const panelPath = panelPathFromPayload(input);
  if (!panelPath) return { exit: 0, stdout: '', stderr: '' }; // R2: not a panel.json write

  // Kill switch.
  if (process.env.PRISM_DISABLE_DROPPED_LOG === '1') return { exit: 0, stdout: '', stderr: '' };

  try {
    let panel;
    try {
      panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
    } catch (e) {
      return { exit: 0, stdout: '', stderr: `[panel-guard/A3] cannot read panel.json: ${e.message}\n` };
    }

    // v5.x — DISPATCH-MODE guard (runs first; hard structural gate that catches
    // role-play masquerading as a real dispatched panel).
    checkDispatchMode(panel);

    // v5.x — FACTORY-FIRST seat-sourcing guard (adjacency-is-not-fitness, D009).
    // Runs after dispatch_mode is validated; enforces only vertical:true seats.
    checkFactoryFirst(panel);

    // D054 — inference-based, instrument-first provenance detector. Broader than
    // checkFactoryFirst (infers vertical, runs regardless of dispatch_mode);
    // default 'observe' logs only so the ad-hoc-seat rate is measured first.
    detectAdHocSeats(panel, panelPath);

    // T31 — D3 SCOPE GUARD (runs before A3 dropped-positions logging).
    checkScope(panel);

    // T32 — G2 alternatives-considered shape validation.
    checkAlternatives(panel);

    // Q2 — classify challenge evidence_class at panel-write (single source of truth).
    const evidenceMutated = classifyPanelEvidence(panel, panelPath);

    const ts = new Date().toISOString();
    const newDrops = [];
    // F8 — panel self-contradiction advisory candidates. classifyDropReason()
    // checks `challenges.length === 0` FIRST (→ 'insufficient_challenges'), so
    // 'specialist_unknown' is only ever reachable when challenges.length > 0
    // — meaning every specialist_unknown drop is BY CONSTRUCTION a seat that
    // still carries live challenges in positions[] (dropped_positions is an
    // append-only annotation log; positions are never removed — see the
    // classifyDropReason doc comment above). That's a chair-construction
    // inconsistency (bare general-purpose seat given a vertical-sounding
    // title) worth flagging as an ADVISORY, not a gate change.
    const consistencyCandidates = [];

    for (const position of (panel.positions ?? [])) {
      const reason = classifyDropReason(position);
      if (reason === null) continue;
      const title = position.title ?? position.name ?? '(unnamed)';
      newDrops.push({
        position: title,
        reason,
        dropped_at_phase: '0d',
        ts,
      });
      if (reason === 'specialist_unknown') {
        const challenges = position.challenges ?? [];
        if (challenges.length > 0) {
          consistencyCandidates.push({
            title,
            specialist: position.specialist ?? null,
            challenge_count: challenges.length,
          });
        }
      }
    }

    // Push dropped_positions only when there ARE drops (no spurious empty pushes).
    if (newDrops.length > 0) {
      if (!Array.isArray(panel.dropped_positions)) panel.dropped_positions = [];
      panel.dropped_positions.push(...newDrops);
    }

    // Write-back when drops occurred OR evidence_class was classified (Q2).
    if (newDrops.length > 0 || evidenceMutated) {
      try {
        atomicWritePanel(panelPath, panel);
      } catch (e) {
        // Fallback: direct write (mirrors prism-phase-0d-oob.mjs atomicWrite fallback).
        try { writeFileSync(panelPath, JSON.stringify(panel, null, 2), 'utf-8'); } catch {}
        process.stderr.write(`[panel-guard/A3] atomic write failed, used direct fallback: ${e.message}\n`);
      }
    }

    if (newDrops.length > 0) {
      appendLog({
        ts,
        event: 'panel_guard_dropped',
        schema_version: 4,
        panel_path: panelPath,
        dropped_count: newDrops.length,
        dropped_positions: newDrops.map(d => ({position: d.position, reason: d.reason})),
      });
    }

    // F8 — panel self-contradiction advisory (observe-only; never affects
    // exit/drop behavior). Fires when a seat sits in BOTH positions[] (with
    // live challenges from a dispatched agent) AND dropped_positions[]
    // (specialist_unknown) — the chair gave a bare general-purpose seat a
    // vertical-sounding title, which the provenance gate flagged, while the
    // seat's real challenges were left untouched in positions[].
    for (const c of consistencyCandidates) {
      appendLog({
        ts,
        event: 'panel_guard_consistency',
        schema_version: 4,
        session_id: sessionId,
        title: c.title,
        specialist: c.specialist,
        reason: 'seat present in both positions[] and dropped_positions[] (specialist_unknown) with live challenges',
        challenge_count: c.challenge_count,
      });
    }

    return { exit: 0, stdout: '', stderr: '' };
  } catch (e) {
    if (e instanceof PanelGuardExit) return { exit: e.code, stdout: '', stderr: e.stderr };
    return { exit: 0, stdout: '', stderr: '' };
  }
}

// Path B CLI entry point. Returns true if this payload was a panel.json write
// (and we handled it — calls process.exit). Returns false to fall through
// to Path A (SubagentStop).
function handleDroppedPositions(payload) {
  const panelPath = panelPathFromPayload(payload);
  if (!panelPath) return false;

  const res = runPostToolUse(payload);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.exit);
}

// ─── Path A: SubagentStop panel-hallucination guard ──────────────────────────

// Path A pure function — SubagentStop panel-hallucination check.
// Returns {exit, stdout, stderr}. Never calls process.exit().
export function runSubagentStop(payload) {
  const input = payload || {};

  const MODE = resolveMode();
  if (MODE === 'off') return { exit: 0, stdout: '', stderr: '' };

  // SubagentStop payload: subagent_type, output (or transcript), session_id.
  const subagentType = String(
    input.subagent_type ||
    input.tool_input?.subagent_type ||
    input.agent_type ||
    ''
  ).toLowerCase();
  if (!subagentType) return { exit: 0, stdout: '', stderr: '' };

  const matchesPanel = PANEL_SUBAGENT_HINTS.some(h => subagentType.includes(h));
  if (!matchesPanel) return { exit: 0, stdout: '', stderr: '' };

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
    return { exit: 0, stdout: '', stderr: '' };
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
    return { exit: 0, stdout: '', stderr: '' };
  }

  // Read subagent output. Field name varies across Claude Code builds.
  const output =
    input.output ||
    input.tool_response?.output ||
    input.tool_response?.content ||
    input.transcript ||
    input.result ||
    '';

  if (!output || typeof output !== 'string') return { exit: 0, stdout: '', stderr: '' };

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
    return { exit: 0, stdout: '', stderr: '' };
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
    return { exit: 0, stdout: '', stderr: '' };
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
    return { exit: 2, stdout: '', stderr: notice + '\n' };
  }

  return { exit: 0, stdout: notice, stderr: '' };
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  // Dispatch to Path B if this looks like a PostToolUse Write event.
  // handleDroppedPositions calls process.exit() when it handles the event.
  // It returns false (without exiting) only when the payload is NOT a
  // panel.json Write, allowing Path A (SubagentStop) to proceed.
  handleDroppedPositions(input);

  // Path A — SubagentStop
  const res = runSubagentStop(input);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.exit);
}

// Guard: only run main() when invoked as a hook, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-panel-guard.mjs';
if (invokedDirectly) {
  try { main(); } catch { process.exit(0); }
}
