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
const VERSION_MARKER_REL = ['.claude', '.prism-version'];
const KB_INDEX_REL = ['.claude', '.prism-kb-index.json'];
// F4 cross-project knowledge index lives under ~/.prism-kb/ (NOT ~/.claude/) —
// matches tools/prism-kb-knowledge-indexer.mjs KNOWLEDGE_INDEX_REL.
const KNOWLEDGE_INDEX_REL = ['.prism-kb', 'knowledge-index.json'];
// KB source roots under ~/.claude. plugins/cache is deliberately excluded —
// plugin churn is already surfaced by Q1 (plugin drift), and walking the
// plugin cache would dominate the sweep's cost.
const KB_SOURCE_DIRS = ['agents', 'commands', 'skills', 'rules'];
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

// ── Check C3: installed-version lag vs a PRISM clone (cwd) ─────────────
// Compares the installed marker (~/.claude/.prism-version) against the
// prism_version in the clone's tools/install-manifest.json. When the clone
// ships a NEWER version than what's installed (the classic "git pull, forgot
// to re-run the installer" case), surface the one command that fixes it.
// No network: the "available" version is whatever the current working
// directory's clone declares. Silent unless cwd is genuinely a PRISM repo.
function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function checkVersionLag(home, cwd) {
  if (!cwd) return null;
  const installedRaw = safeRead(join(home, ...VERSION_MARKER_REL));
  const installed = parseVersion(installedRaw);
  if (!installed) return null;  // not installed / unreadable marker → silent
  const manifest = readJsonSafe(join(cwd, 'tools', 'install-manifest.json'));
  if (!manifest || !manifest.prism_version) return null;  // cwd isn't a PRISM clone
  const available = parseVersion(manifest.prism_version);
  if (!available) return null;
  if (compareVersions(installed, available) >= 0) return null;  // parity or dev-ahead
  const inS = installedRaw.trim();
  const avS = String(manifest.prism_version).trim();
  return `PRISM FRESHNESS: installed PRISM is v${inS} but this clone ships v${avS}. Run \`node tools/prism-installer.mjs update\` to upgrade your ~/.claude install.`;
}

// ── Check E1: KB index staleness vs PRISM source docs ─────────────────
// The KB autosync hook handles in-session edits (dirty-flag → Stop rebuild),
// but OUT-OF-BAND changes (git pull bringing new agents/skills, a Stop that
// didn't drain) leave the index behind. The index records source_mtime_max
// (seconds) at build time; if any source .md is now newer, recall is stale.
// Silent when no index exists (KB simply not in use). Bounded walk.
function walkMdMaxMtimeSec(root, budget) {
  let max = 0;
  const stack = [root];
  while (stack.length && budget.n > 0) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (budget.n <= 0) break;
      const full = join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      budget.n--;
      try { const m = Math.floor(statSync(full).mtimeMs / 1000); if (m > max) max = m; } catch {}
    }
  }
  return max;
}

function checkKbIndexStale(home) {
  const index = readJsonSafe(join(home, ...KB_INDEX_REL));
  if (!index || typeof index.source_mtime_max !== 'number') return null;  // no index / pre-v2 schema
  const budget = {n: 4000};  // hard ceiling on files walked per sweep
  let newest = 0;
  for (const sub of KB_SOURCE_DIRS) {
    const root = join(home, '.claude', sub);
    if (!existsSync(root)) continue;
    const m = walkMdMaxMtimeSec(root, budget);
    if (m > newest) newest = m;
  }
  if (newest <= index.source_mtime_max) return null;
  return 'PRISM FRESHNESS: KB index is behind its source docs (a skill/agent/command/rule changed since the last build). Run `node ~/.claude/tools/prism-kb-rebuild.mjs --sync` to refresh semantic recall (/prism-recall).';
}

// ── Check F4: cross-project KNOWLEDGE index staleness ─────────────────
// Sibling to E1 (checkKbIndexStale), but for the F4 knowledge corpus. The
// autosync knowledge-dirty flag + Stop-drain handle in-session edits, but
// OUT-OF-BAND changes (git pull bringing new lessons/plans into a shared
// project, a Stop that didn't drain, a new verdict log) leave the knowledge
// index behind. The index records source_mtime_max (seconds) at build time;
// if any shared-corpus .md / panel.json / verdict file is now newer, recall
// (--cross-project) is stale. Silent when no knowledge index exists (feature
// not in use) and when nothing is shared + no verdicts (newest stays 0).
// Absorbs the v4.6-deferred cross-project index-freshness item (design §5).
function walkPanelMaxMtimeSec(workspaceRoot, budget, maxDepth = 6) {
  let max = 0;
  if (!existsSync(workspaceRoot)) return 0;
  const stack = [[workspaceRoot, 0]];
  while (stack.length && budget.n > 0) {
    const [d, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = readdirSync(d, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      if (budget.n <= 0) break;
      const full = join(d, e.name);
      if (e.isDirectory()) { stack.push([full, depth + 1]); continue; }
      if (e.name !== 'panel.json') continue;
      budget.n--;
      try { const m = Math.floor(statSync(full).mtimeMs / 1000); if (m > max) max = m; } catch {}
    }
  }
  return max;
}

function verdictNewestMtimeSec(home) {
  let max = 0;
  const jsonl = join(home, '.prism-phase-1-5-verdicts.jsonl');
  const m1 = safeMtime(jsonl);
  if (m1 !== null) max = Math.max(max, Math.floor(m1 / 1000));
  let entries;
  try { entries = readdirSync(home, {withFileTypes: true}); } catch { entries = []; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^\.prism-phase-.*-verdicts-.*\.json$/.test(e.name)) continue;
    const m = safeMtime(join(home, e.name));
    if (m !== null) max = Math.max(max, Math.floor(m / 1000));
  }
  return max;
}

function knowledgeCorpusNewestSec(index, home) {
  const budget = {n: 8000};
  let newest = 0;
  const projects = (index && index.projects && typeof index.projects === 'object') ? index.projects : {};
  for (const pid of Object.keys(projects)) {
    const p = projects[pid];
    if (!p || typeof p.root !== 'string' || !Array.isArray(p.shared_types)) continue;
    const t = new Set(p.shared_types);
    if (t.has('adjudication')) newest = Math.max(newest, walkMdMaxMtimeSec(join(p.root, 'docs', 'prism', 'adjudications'), budget));
    if (t.has('lesson')) newest = Math.max(newest, walkMdMaxMtimeSec(join(p.root, 'docs', 'prism', 'lessons'), budget));
    if (t.has('plan')) newest = Math.max(newest, walkMdMaxMtimeSec(join(p.root, 'docs', 'prism', 'plans'), budget));
    if (t.has('panel-rationale')) newest = Math.max(newest, walkPanelMaxMtimeSec(join(p.root, 'tasks', 'workspace'), budget));
  }
  // Always-on home-global verdicts (exempt from the share marker).
  newest = Math.max(newest, verdictNewestMtimeSec(home));
  return newest;
}

export function checkKnowledgeIndexStale(home) {
  const index = readJsonSafe(join(home, ...KNOWLEDGE_INDEX_REL));
  if (!index || typeof index.source_mtime_max !== 'number') return null;  // no index ⇒ feature unused
  const newest = knowledgeCorpusNewestSec(index, home);
  if (newest <= index.source_mtime_max) return null;
  return 'PRISM FRESHNESS: cross-project knowledge index is behind its source docs (a shared adjudication/lesson/plan/panel or a verdict log changed since the last build). Run `node ~/.claude/tools/prism-kb-knowledge-rebuild.mjs --sync` to refresh /prism-recall --cross-project.';
}

// ── Check E2: tools-registry.md ↔ roster index-sync ───────────────────
// Q11 catches "registry changed since the last SWEEP". E2 catches the
// stickier gap: registry changed after the last actual /prism-index run, so
// roster.tools is behind regardless of how recently the sweep looked. Silent
// when the roster was never indexed (bootstrap/init owns first-time indexing).
function checkToolsRegistrySync(home) {
  const roster = readJsonSafe(join(home, ...ROSTER_REL));
  if (!roster) return null;
  const lastIndexed = roster.index_meta && roster.index_meta.last_indexed;
  if (!lastIndexed) return null;
  let indexedMs;
  try { indexedMs = new Date(lastIndexed).getTime(); } catch { return null; }
  if (!indexedMs || Number.isNaN(indexedMs)) return null;
  const regMtime = safeMtime(join(home, ...TOOLS_REGISTRY_REL));
  if (regMtime === null) return null;
  if (regMtime <= indexedMs) return null;
  return 'PRISM FRESHNESS: tools-registry.md changed after the last /prism-index — roster.tools may be out of sync. Run /prism-index to resolve registry changes into the roster.';
}

// ── Main entry point ───────────────────────────────────────────────────
export function runFreshnessSweep({home, throttleHours = 24, now = Date.now(), force = false, cwd = undefined} = {}) {
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

  // C3 — version lag (only when cwd is a PRISM clone)
  try {
    const n = checkVersionLag(home, cwd);
    if (n) notices.push(n);
  } catch {}

  // E1 — KB index staleness
  try {
    const n = checkKbIndexStale(home);
    if (n) notices.push(n);
  } catch {}

  // F4 — cross-project knowledge index staleness
  try {
    const n = checkKnowledgeIndexStale(home);
    if (n) notices.push(n);
  } catch {}

  // E2 — tools-registry ↔ roster index sync
  try {
    const n = checkToolsRegistrySync(home);
    if (n) notices.push(n);
  } catch {}

  atomicWrite(snapshotPath, JSON.stringify(newSnapshot));
  return {notices, snapshot: newSnapshot, skipped: false};
}

// Dry-run alias for tests / introspection — runs all checks, returns
// notices, does NOT write the snapshot file.
export function freshnessSweepDryRun({home, now = Date.now(), cwd = undefined} = {}) {
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
  try { const n = checkVersionLag(home, cwd); if (n) notices.push(n); } catch {}
  try { const n = checkKbIndexStale(home); if (n) notices.push(n); } catch {}
  try { const n = checkKnowledgeIndexStale(home); if (n) notices.push(n); } catch {}
  try { const n = checkToolsRegistrySync(home); if (n) notices.push(n); } catch {}

  return {notices, snapshot: prior};
}

export const THRESHOLDS = {STALE_AGENT_DAYS, UPDATE_LOG_AGE_DAYS, CLAUDE_MD_AGE_DAYS};

// ── G1: on-demand staleness preview (CLI) ──────────────────────────────
// `node ~/.claude/hooks/lib/prism-freshness-sweep.mjs --preview` prints the
// CURRENT staleness signals without touching the 24h throttle snapshot, so
// the orchestrator can run a pre-PROPOSAL check mid-session (the daily
// SessionStart sweep may have already consumed today's throttle window).
// Uses the dry-run path: all checks, no snapshot write. Importing this module
// (session-start does) never triggers this block — argv[1] won't end with
// this filename.
const invokedDirectly =
  import.meta.url === `file://${(process.argv[1] || '').replace(/\\/g, '/')}` ||
  (process.argv[1] || '').endsWith('prism-freshness-sweep.mjs');

if (invokedDirectly) {
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const {notices} = freshnessSweepDryRun({home: HOME, cwd: process.cwd()});
  if (notices.length) {
    process.stdout.write(`PRISM staleness preview — ${notices.length} signal(s):\n`);
    for (const n of notices) process.stdout.write(`  • ${n}\n`);
  } else {
    process.stdout.write('PRISM staleness preview: no staleness signals — sources, registry, KB index, and installed version look current.\n');
  }
}
