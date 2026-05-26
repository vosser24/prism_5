// PRISM SessionStart daily freshness sweep (v4.1 Phase B).
//
// Closes 6 audit questions in one throttled (24h) pass:
//   Q1  — plugin coverage drift   → nudge /prism-index when plugin
//                                    cache dirs change since last sweep
//   Q5  — stale agents             → list roster.json agents whose
//                                    last_used/last_upgraded > 90d as
//                                    /prism-retire candidates
//   Q6a — update-log age           → nudge /prism-update when
//                                    update-log.json.last_check > 15d
//   Q6b — CLAUDE.md staleness      → nudge /prism-discover
//                                    --check-claude-chain when
//                                    ~/.claude/CLAUDE.md mtime > 60d
//   Q11 — tools-registry rotations → surface newly-promoted tools when
//                                    tools-registry.md mtime advanced
//                                    since last sweep
//
// Q7 (factory writes globally / only master-<slug> is project-local) is
// closed by a README + /prism-help prose addition, not a runtime check.
// Q9 (domain_groups in roster.json + /prism-roster --by-domain) is
// closed by /prism-index + /prism-roster command-protocol additions.
//
// API:
//   runFreshnessSweep({home, throttleHours = 24, now = Date.now(), force = false})
//     → {notices: string[], snapshot: object, skipped: boolean}
//   - Reads ~/.claude/.prism-freshness-last.json
//   - If now - snapshot.ts < throttleHours and !force → returns {skipped:true}
//   - Otherwise: runs all checks, persists new snapshot, returns notices
//
// Atomic write, fail-open on every read. Never throws — callers can
// `try { ... } catch {}` safely; the helper does too.

import {readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync} from 'fs';
import {join} from 'path';

const STALE_AGENT_DAYS = 90;
const UPDATE_LOG_AGE_DAYS = 15;
const CLAUDE_MD_AGE_DAYS = 60;

const SNAPSHOT_REL = ['.claude', '.prism-freshness-last.json'];
const PLUGINS_REL = ['.claude', 'plugins'];
const UPDATE_LOG_REL = ['.claude', 'skills', 'prism-plan', 'references', 'update-log.json'];
const CLAUDE_MD_REL = ['.claude', 'CLAUDE.md'];
const TOOLS_REGISTRY_REL = ['.claude', 'skills', 'prism-plan', 'references', 'tools-registry.md'];
const ROSTER_REL = ['.claude', 'skills', 'prism-plan', 'references', 'roster.json'];

function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, content); } catch {}
  }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function safeMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function daysSince(ms, now) {
  if (!ms) return null;
  return Math.floor((now - ms) / (1000 * 60 * 60 * 24));
}

function listPluginDirs(pluginsPath) {
  try {
    return readdirSync(pluginsPath, {withFileTypes: true})
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readJsonSafe(path) {
  const raw = safeRead(path);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Check Q1: plugin drift ─────────────────────────────────────────────
function checkPluginDrift(home, snapshot) {
  const current = listPluginDirs(join(home, ...PLUGINS_REL));
  const previous = (snapshot && Array.isArray(snapshot.plugin_dirs)) ? snapshot.plugin_dirs : null;
  if (previous === null) return {notice: null, plugin_dirs: current};
  const added = current.filter((d) => !previous.includes(d));
  const removed = previous.filter((d) => !current.includes(d));
  if (!added.length && !removed.length) return {notice: null, plugin_dirs: current};
  const parts = [];
  if (added.length) parts.push(`+${added.length} new (${added.slice(0, 3).join(', ')}${added.length > 3 ? '…' : ''})`);
  if (removed.length) parts.push(`-${removed.length} removed (${removed.slice(0, 3).join(', ')}${removed.length > 3 ? '…' : ''})`);
  return {
    notice: `PRISM FRESHNESS: plugin set changed since last sweep — ${parts.join(', ')}. Run /prism-index to refresh the resource-index so the orchestrator + blueprint-prompt can see new skills.`,
    plugin_dirs: current,
  };
}

// ── Check Q6a: update-log age ──────────────────────────────────────────
function checkUpdateLogAge(home, now) {
  const log = readJsonSafe(join(home, ...UPDATE_LOG_REL));
  if (!log) return null;
  const lastCheckStr = log.last_check || (log.cycle && log.cycle.last_check);
  if (!lastCheckStr) return null;
  let lastCheckMs;
  try { lastCheckMs = new Date(lastCheckStr).getTime(); } catch { return null; }
  if (!lastCheckMs || Number.isNaN(lastCheckMs)) return null;
  const days = daysSince(lastCheckMs, now);
  if (days === null || days < UPDATE_LOG_AGE_DAYS) return null;
  return `PRISM FRESHNESS: PRISM update-log last_check is ${days}d old (>${UPDATE_LOG_AGE_DAYS}d threshold). Run /prism-update to refresh skill + agent knowledge.`;
}

// ── Check Q6b: CLAUDE.md mtime ─────────────────────────────────────────
function checkClaudeMdMtime(home, now) {
  const mtime = safeMtime(join(home, ...CLAUDE_MD_REL));
  if (!mtime) return null;
  const days = daysSince(mtime, now);
  if (days === null || days < CLAUDE_MD_AGE_DAYS) return null;
  return `PRISM FRESHNESS: ~/.claude/CLAUDE.md unchanged for ${days}d (>${CLAUDE_MD_AGE_DAYS}d threshold). Consider /prism-discover --check-claude-chain to sweep for project-identity drift across recently-touched projects.`;
}

// ── Check Q5: stale agents ─────────────────────────────────────────────
function checkStaleAgents(home, now) {
  const roster = readJsonSafe(join(home, ...ROSTER_REL));
  if (!roster || !roster.agents || typeof roster.agents !== 'object') return null;
  const stale = [];
  for (const [name, agent] of Object.entries(roster.agents)) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    // Prefer last_used (set by /prism-roster display), fall back to last_upgraded.
    const dateStr = agent.last_used || agent.last_upgraded || agent.created;
    if (!dateStr) continue;
    let ms;
    try { ms = new Date(dateStr).getTime(); } catch { continue; }
    if (!ms || Number.isNaN(ms)) continue;
    const days = daysSince(ms, now);
    if (days !== null && days >= STALE_AGENT_DAYS) stale.push({name, days});
  }
  if (!stale.length) return null;
  stale.sort((a, b) => b.days - a.days);
  const top = stale.slice(0, 3).map((s) => `@${s.name} (${s.days}d)`).join(', ');
  const more = stale.length > 3 ? ` (+${stale.length - 3} more)` : '';
  return `PRISM FRESHNESS: ${stale.length} agent${stale.length === 1 ? '' : 's'} unused ≥${STALE_AGENT_DAYS}d: ${top}${more}. Review with /prism-roster, retire with /prism-retire @<name> if no longer needed.`;
}

// ── Check Q11: tools-registry rotations ────────────────────────────────
function checkToolsRegistryRotations(home, snapshot) {
  const mtime = safeMtime(join(home, ...TOOLS_REGISTRY_REL));
  if (mtime === null) return {notice: null, tools_registry_mtime: null};
  const previous = snapshot && typeof snapshot.tools_registry_mtime === 'number'
    ? snapshot.tools_registry_mtime : null;
  if (previous === null) return {notice: null, tools_registry_mtime: mtime};
  if (mtime <= previous) return {notice: null, tools_registry_mtime: mtime};
  return {
    notice: 'PRISM FRESHNESS: tools-registry.md changed since last sweep. Review with /prism-recommend or check CHANGELOG for newly-promoted Tier 1/2 tools.',
    tools_registry_mtime: mtime,
  };
}

// ── Main entry point ───────────────────────────────────────────────────
export function runFreshnessSweep({home, throttleHours = 24, now = Date.now(), force = false} = {}) {
  if (!home) return {notices: [], snapshot: null, skipped: true};

  const snapshotPath = join(home, ...SNAPSHOT_REL);
  const prior = readJsonSafe(snapshotPath);
  const throttleMs = throttleHours * 60 * 60 * 1000;

  if (!force && prior && typeof prior.ts === 'number' && (now - prior.ts) < throttleMs) {
    return {notices: [], snapshot: prior, skipped: true};
  }

  const notices = [];
  const newSnapshot = {ts: now, plugin_dirs: [], tools_registry_mtime: null};

  // Q1
  try {
    const r = checkPluginDrift(home, prior);
    newSnapshot.plugin_dirs = r.plugin_dirs;
    if (r.notice) notices.push(r.notice);
  } catch {}

  // Q6a
  try {
    const n = checkUpdateLogAge(home, now);
    if (n) notices.push(n);
  } catch {}

  // Q6b
  try {
    const n = checkClaudeMdMtime(home, now);
    if (n) notices.push(n);
  } catch {}

  // Q5
  try {
    const n = checkStaleAgents(home, now);
    if (n) notices.push(n);
  } catch {}

  // Q11
  try {
    const r = checkToolsRegistryRotations(home, prior);
    newSnapshot.tools_registry_mtime = r.tools_registry_mtime;
    if (r.notice) notices.push(r.notice);
  } catch {}

  atomicWrite(snapshotPath, JSON.stringify(newSnapshot));
  return {notices, snapshot: newSnapshot, skipped: false};
}

// Dry-run alias for tests / introspection — runs all checks, returns
// notices, does NOT write the snapshot file.
export function freshnessSweepDryRun({home, now = Date.now()} = {}) {
  if (!home) return {notices: [], snapshot: null};
  const snapshotPath = join(home, ...SNAPSHOT_REL);
  const prior = readJsonSafe(snapshotPath);
  const notices = [];

  try {
    const r = checkPluginDrift(home, prior);
    if (r.notice) notices.push(r.notice);
  } catch {}
  try { const n = checkUpdateLogAge(home, now); if (n) notices.push(n); } catch {}
  try { const n = checkClaudeMdMtime(home, now); if (n) notices.push(n); } catch {}
  try { const n = checkStaleAgents(home, now); if (n) notices.push(n); } catch {}
  try {
    const r = checkToolsRegistryRotations(home, prior);
    if (r.notice) notices.push(r.notice);
  } catch {}

  return {notices, snapshot: prior};
}

export const THRESHOLDS = {STALE_AGENT_DAYS, UPDATE_LOG_AGE_DAYS, CLAUDE_MD_AGE_DAYS};
