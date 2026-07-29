// PRISM SessionStart daily freshness sweep (v4.1 Phase B; extended v4.7,
// v5.0, and the v5.1 command-consolidation).
//
// Runs all checks in one throttled (24h) pass. Detection-only checks emit a
// NOTICE; the lone EXECUTION check (A5 index rebuild) runs inline when — and
// only when — the index is genuinely stale out-of-band (rare). Original set:
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
// v4.7/v5.0 additions:
//   C3  — installed-version lag    → nudge installer update when the cwd
//                                    PRISM clone ships a newer version
//   E1  — KB index staleness       → A5: auto-REBUILD the per-project KB
//                                    index inline when source docs are
//                                    newer than its source_mtime_max
//                                    (manual-nudge fallback if the tool is
//                                    absent / a rebuild is already locked)
//   E2  — registry ↔ roster sync   → nudge /prism-index when the registry
//                                    changed after the last index run
//   F4  — knowledge index stale    → A5: auto-REBUILD the cross-project
//                                    knowledge index inline (same fallback)
// v5.1 command-consolidation additions (all detection-only, nudge):
//   A1  — hook integrity           → fs wiring sanity (settings refs exist)
//                                    + empty-file check, ALWAYS; plus a
//                                    CHANGE-GATED node --check of only the
//                                    hooks newer than the last sweep (node
//                                    cold-start is ~2-3s on Windows, so the
//                                    steady state spawns nothing) → nudge
//                                    /prism-doctor for the deep pass
//   A2  — roster orphans           → roster entries with no agent file on
//                                    disk → nudge /prism-bootstrap reconcile
//   A3  — audit staleness          → /prism-audit marker > 30d → nudge
// F23 addition (report-only; see checkTurnTierSentinelPrune for full rationale):
//   G2  — turn-tier sentinel prune  → .prism-turn-tier-*.json older than
//                                    PRISM_TURN_TIER_PRUNE_DAYS (default 7d,
//                                    24h hard floor) → nudge the manual
//                                    `--prune-turn-tier [--apply]` CLI path;
//                                    never deletes from the automatic sweep
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

import {readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, rmSync, mkdirSync, unlinkSync} from 'fs';
import {join, basename, dirname, isAbsolute} from 'path';
import {spawnSync} from 'child_process';
import {projectStatus, evaluateSurvival} from '../../tools/lib/prism-agent-scope.mjs';
import {renameWithRetry} from '../../tools/lib/atomic-fs.mjs';
import {prismHome} from './prism-home.mjs';
import {logAdvisory} from './prism-advisory-log.mjs';

const STALE_AGENT_DAYS = 90;
const UPDATE_LOG_AGE_DAYS = 15;
const CLAUDE_MD_AGE_DAYS = 60;
const AUDIT_AGE_DAYS = 30;
// F23: turn-tier sentinel prune thresholds (see checkTurnTierSentinelPrune below).
const TURN_TIER_PRUNE_DAYS_DEFAULT = 7;
const TURN_TIER_SAFETY_FLOOR_MS = 24 * 60 * 60 * 1000;  // hard floor — never touch anything <24h old
const TURN_TIER_PRUNE_BUDGET = 5000;  // cap on directory entries scanned per call

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
const AUDIT_MARKER_REL = ['.claude', '.prism-audit-last.json'];
const AGENTS_DIR_REL = ['.claude', 'agents'];
const HOOKS_DIR_REL = ['.claude', 'hooks'];
const SETTINGS_REL = ['.claude', 'settings.json'];
const HOOK_CHECK_BUDGET_MS = 8000;     // overall cap on the node --check sweep
const HOOK_CHECK_TIMEOUT_MS = 3000;    // per-hook spawn timeout
// A5: index auto-rebuild plumbing.
const KB_REBUILD_TOOL_REL = ['.claude', 'tools', 'prism-kb-rebuild.mjs'];
const KNOWLEDGE_REBUILD_TOOL_REL = ['.claude', 'tools', 'prism-kb-knowledge-rebuild.mjs'];
const KB_REBUILD_LOCK_REL = ['.claude', '.prism-kb-rebuild.lock'];
const KNOWLEDGE_REBUILD_LOCK_REL = ['.claude', '.prism-kb-knowledge-rebuild.lock'];
const REBUILD_TIMEOUT_MS = 60000;        // hard ceiling on a single rebuild
const REBUILD_LOCK_STALE_MS = 10 * 60 * 1000;  // a lock older than this is abandoned
const KB_MTIME_TOLERANCE_SEC = 2;  // absorb same-second rebuild/write quantization

// Writes roster.json (line 261) and the freshness-sweep snapshot (line 990).
// Bounded retry (task #82/#88) absorbs the transient Windows AV/indexer
// handle-lock window before degrading; the degraded path is logged rather
// than silent (D046) — roster.json is shared, concurrently-read state.
function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameWithRetry(renameSync, tmp, path);
  } catch (renameErr) {
    try {
      writeFileSync(path, content);
      logAdvisory({event: 'freshness_sweep_atomic_write', path,
        status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
    } catch (fallbackErr) {
      logAdvisory({event: 'freshness_sweep_atomic_write', path,
        status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
    }
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

// ── v5.2.0: scope-aware agent survival (the ONLY mutating sweep check, [[D008]])
// scope:"project" agents whose home project is gone (absent) or dormant (stale)
// are MOVED to agents/retired/ and marked archived in the roster — reversible,
// SMB-guarded (offline mount → keep), broad-protected (only explicit project
// scope is eligible). apply=false (dry-run) → decision-only notice, no mutation.
function checkProjectScopedSurvival(home, now, apply) {
  const rosterPath = join(home, ...ROSTER_REL);
  const roster = readJsonSafe(rosterPath);
  if (!roster || !roster.agents || typeof roster.agents !== 'object') return null;
  const parsed = parseInt(process.env.PRISM_AGENT_PROJECT_STALE_DAYS || '', 10);
  const staleDays = (Number.isFinite(parsed) && parsed > 0) ? parsed : 90;
  const statusFn = (name, agent) => {
    let hp = typeof agent.home_project_path === 'string' ? agent.home_project_path.trim() : '';
    if (!hp) return 'unknown';
    hp = hp.replace(/^~(?=$|[/\\])/, home);
    const dirExists = existsSync(hp);
    const parentExists = existsSync(dirname(hp));
    let lastSyncMs = null;
    if (dirExists) {
      const st = readJsonSafe(join(hp, '.claude', '.prism-state.json'));
      if (st && st.last_sync_at) {
        const t = new Date(st.last_sync_at).getTime();
        if (t && !Number.isNaN(t)) lastSyncMs = t;
      }
    }
    return projectStatus({homePath: hp, dirExists, parentExists, lastSyncMs, now, staleDays});
  };
  const {archive} = evaluateSurvival(roster, statusFn);
  if (!archive.length) return null;
  if (!apply) {
    const top = archive.slice(0, 3).map((a) => `@${a.name}`).join(', ');
    const more = archive.length > 3 ? ` (+${archive.length - 3} more)` : '';
    return `PRISM SURVIVAL (dry-run): ${archive.length} project-scoped agent(s) WOULD be auto-archived (home project gone/stale): ${top}${more}.`;
  }
  const retiredDir = join(home, ...AGENTS_DIR_REL, 'retired');
  const done = [];
  for (const {name, reason} of archive) {
    try {
      mkdirSync(retiredDir, {recursive: true});
      const src = resolveAgentFile(home, name, roster.agents[name]);
      if (existsSync(src)) renameSync(src, join(retiredDir, `${name}.md`));
      roster.agents[name].archived = true;
      roster.agents[name].archived_at = new Date(now).toISOString();
      roster.agents[name].archived_reason = reason;
      done.push(name);
    } catch { /* fail-open: skip this one, continue */ }
  }
  if (!done.length) return null;
  atomicWrite(rosterPath, JSON.stringify(roster, null, 2));
  const top = done.slice(0, 3).map((n) => `@${n}`).join(', ');
  const more = done.length > 3 ? ` (+${done.length - 3} more)` : '';
  return `PRISM SURVIVAL: auto-archived ${done.length} project-scoped agent(s) whose project is gone/stale: ${top}${more}. Files moved to ~/.claude/agents/retired/ (reversible — restore by moving the file back and clearing "archived" in roster.json).`;
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

// A5: a single rebuild invocation, guarded by a lockfile so two near-
// simultaneous sessions don't both spawn the indexer. spawnSync (the
// rebuild is the one ≤1×/24h step the user accepted as inline). Returns
// {ok} on success, {ok:false, reason} otherwise so the caller can pick the
// right notice (rebuilt / locked / fall-back-nudge).
function spawnRebuild(home, toolRel, lockRel) {
  const tool = join(home, ...toolRel);
  if (!existsSync(tool)) return {ok: false, reason: 'tool-missing'};
  const lock = join(home, ...lockRel);
  const lockMtime = safeMtime(lock);
  if (lockMtime !== null && (Date.now() - lockMtime) < REBUILD_LOCK_STALE_MS) {
    return {ok: false, reason: 'locked'};  // another session is mid-rebuild
  }
  try { writeFileSync(lock, String(Date.now())); } catch {}
  let status = 1;
  try {
    const r = spawnSync(process.execPath, [tool, '--sync'], {
      timeout: REBUILD_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
      env: {...process.env, HOME: home, USERPROFILE: home},
    });
    status = r && typeof r.status === 'number' ? r.status : 1;
  } catch { status = 1; }
  try { rmSync(lock, {force: true}); } catch {}
  return status === 0 ? {ok: true} : {ok: false, reason: 'failed'};
}

function defaultRebuildKb(home) { return spawnRebuild(home, KB_REBUILD_TOOL_REL, KB_REBUILD_LOCK_REL); }
function defaultRebuildKnowledge(home) { return spawnRebuild(home, KNOWLEDGE_REBUILD_TOOL_REL, KNOWLEDGE_REBUILD_LOCK_REL); }
// Non-mutating stand-in for the --preview dry run (never rebuilds).
const noopRebuild = () => ({ok: false, reason: 'dry-run'});

function checkKbIndexStale(home, rebuild = defaultRebuildKb) {
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
  if (newest <= index.source_mtime_max + KB_MTIME_TOLERANCE_SEC) return null;
  // A rebuild is already pending/in-flight → stay silent, let it finish.
  const lock = join(home, ...KB_REBUILD_LOCK_REL);
  const lm = safeMtime(lock);
  if (lm !== null && (Date.now() - lm) < REBUILD_LOCK_STALE_MS) return null;
  // A5: stale → rebuild inline (≤1×/24h via the sweep throttle + lockfile).
  const res = rebuild(home);
  if (res && res.ok) {
    return 'PRISM FRESHNESS: KB index was behind its source docs — rebuilt automatically. Semantic recall (/prism-recall) is current.';
  }
  if (res && res.reason === 'locked') return null;  // another session is handling it
  // tool missing / rebuild failed → degrade to a manual nudge.
  return 'PRISM FRESHNESS: KB index is behind its source docs (a skill/agent/command/rule changed since the last build) and auto-rebuild did not run. Run `node ~/.claude/tools/prism-kb-rebuild.mjs --sync` to refresh semantic recall (/prism-recall).';
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

export function checkKnowledgeIndexStale(home, rebuild = defaultRebuildKnowledge) {
  const index = readJsonSafe(join(home, ...KNOWLEDGE_INDEX_REL));
  if (!index || typeof index.source_mtime_max !== 'number') return null;  // no index ⇒ feature unused
  const newest = knowledgeCorpusNewestSec(index, home);
  if (newest <= index.source_mtime_max) return null;
  // A5: stale → rebuild inline (≤1×/24h via the sweep throttle + lockfile).
  const res = rebuild(home);
  if (res && res.ok) {
    return 'PRISM FRESHNESS: cross-project knowledge index was behind its source docs — rebuilt automatically. /prism-recall --cross-project is current.';
  }
  if (res && res.reason === 'locked') return null;  // another session is handling it
  // tool missing / rebuild failed → degrade to a manual nudge.
  return 'PRISM FRESHNESS: cross-project knowledge index is behind its source docs (a shared adjudication/lesson/plan/panel or a verdict log changed since the last build) and auto-rebuild did not run. Run `node ~/.claude/tools/prism-kb-knowledge-rebuild.mjs --sync` to refresh /prism-recall --cross-project.';
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

// ── Check A2: roster-orphan detection ─────────────────────────────────
// A roster entry whose agent .md file no longer exists on disk is an
// "orphan" — the roster claims an agent the filesystem can't back. Prefer
// the entry's explicit file_path (with ~ expansion); fall back to the
// canonical ~/.claude/agents/<name>.md location. Silent when there's no
// roster (bootstrap owns first-time population) and when nothing is
// orphaned. Pure fs — no spawn, no network.
function resolveAgentFile(home, name, agent) {
  const fp = agent && typeof agent.file_path === 'string' ? agent.file_path.trim() : '';
  if (fp) {
    // Expand a leading ~ (optionally ~/.) to the home dir.
    const expanded = fp.replace(/^~(?=$|[/\\])/, home);
    if (isAbsolute(expanded)) return expanded;
    // Relative file_path (e.g. ".claude/agents/x.md") — resolve against the
    // entry's OWN home_project_path, NOT the current session cwd. Resolving a
    // repo-relative path against cwd (the old bug) mis-flagged a valid
    // project-local agent as an orphan whenever the sweep ran from another
    // project. Fall back: absolute agent_path (points at the same file), then
    // the roster directory.
    let hp = agent && typeof agent.home_project_path === 'string' ? agent.home_project_path.trim() : '';
    if (hp) {
      hp = hp.replace(/^~(?=$|[/\\])/, home);
      if (isAbsolute(hp)) return join(hp, expanded);
    }
    let ap = agent && typeof agent.agent_path === 'string' ? agent.agent_path.trim() : '';
    if (ap) {
      ap = ap.replace(/^~(?=$|[/\\])/, home);
      if (isAbsolute(ap)) return ap;
    }
    return join(dirname(join(home, ...ROSTER_REL)), expanded);
  }
  return join(home, ...AGENTS_DIR_REL, `${name}.md`);
}

function checkRosterOrphans(home) {
  const roster = readJsonSafe(join(home, ...ROSTER_REL));
  if (!roster || !roster.agents || typeof roster.agents !== 'object') return null;
  const orphans = [];
  for (const [name, agent] of Object.entries(roster.agents)) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    const fp = resolveAgentFile(home, name, agent);
    if (!existsSync(fp)) orphans.push(name);
  }
  if (!orphans.length) return null;
  const top = orphans.slice(0, 3).map((n) => `@${n}`).join(', ');
  const more = orphans.length > 3 ? ` (+${orphans.length - 3} more)` : '';
  return `PRISM FRESHNESS: ${orphans.length} roster agent${orphans.length === 1 ? '' : 's'} have no agent file on disk (orphan${orphans.length === 1 ? '' : 's'}): ${top}${more}. Run /prism-bootstrap (roster phase) or /prism-roster --reconcile to resolve.`;
}

// ── Check A2b: dangling-skill-path detection ──────────────────────────
// Sibling to A2 (roster orphans), but for roster.skills. Each skill entry
// records the on-disk path to its SKILL.md (field `path`, occasionally
// `skill_path`). Plugin cache version bumps (e.g. superpowers 5.1.0 → 6.1.1)
// delete the old versioned dir, leaving many roster.skills entries pointing at
// a path that no longer exists — a silent drift nothing else catches. Resolve
// `~`, verify existsSync, list up to a few dangling names. Defensive: entries
// with no path field are skipped; never throws. Silent when nothing dangles.
const SKILL_DANGLING_SAMPLE = 3;

function resolveSkillPath(home, entry) {
  let raw = '';
  if (entry && typeof entry.path === 'string') raw = entry.path.trim();
  else if (entry && typeof entry.skill_path === 'string') raw = entry.skill_path.trim();
  if (!raw) return null;
  return raw.replace(/^~(?=$|[/\\])/, home);
}

function checkSkillPathsExist(home) {
  const roster = readJsonSafe(join(home, ...ROSTER_REL));
  if (!roster || !roster.skills || typeof roster.skills !== 'object') return null;
  const dangling = [];
  for (const [name, entry] of Object.entries(roster.skills)) {
    if (!entry || typeof entry !== 'object' || name.startsWith('_')) continue;
    const p = resolveSkillPath(home, entry);
    if (!p) continue;                 // no resolvable path field → skip
    if (!existsSync(p)) dangling.push(name);
  }
  if (!dangling.length) return null;
  const top = dangling.slice(0, SKILL_DANGLING_SAMPLE).join(', ');
  const more = dangling.length > SKILL_DANGLING_SAMPLE ? ` (+${dangling.length - SKILL_DANGLING_SAMPLE} more)` : '';
  return `PRISM FRESHNESS: ${dangling.length} roster skill path${dangling.length === 1 ? '' : 's'} no longer exist on disk (dangling — likely a plugin cache version bump): ${top}${more}. Run /prism-index to re-resolve skill paths.`;
}

// ── Check A3: audit-staleness reminder ────────────────────────────────
// /prism-audit stamps ~/.claude/.prism-audit-last.json {ts} on completion.
// If that stamp is older than AUDIT_AGE_DAYS, nudge a re-run. Silent when
// the marker is absent (never audited — bootstrap/first-run owns the
// initial scan; nagging a fresh install would be noise).
function checkAuditStaleness(home, now) {
  const marker = readJsonSafe(join(home, ...AUDIT_MARKER_REL));
  if (!marker) return null;
  const tsRaw = marker.ts || marker.last_audit;
  if (!tsRaw) return null;
  let ms;
  try { ms = typeof tsRaw === 'number' ? tsRaw : new Date(tsRaw).getTime(); } catch { return null; }
  if (!ms || Number.isNaN(ms)) return null;
  const days = daysSince(ms, now);
  if (days === null || days < AUDIT_AGE_DAYS) return null;
  return `PRISM FRESHNESS: last /prism-audit was ${days}d ago (>${AUDIT_AGE_DAYS}d threshold). Run /prism-audit for a hygiene scan of PRISM's configuration surface.`;
}

// ── Check G2: bounded prune of stale turn-tier sentinels (F23) ─────────
// hooks/prism-prompt-tier-router.mjs writes ~/.claude/.prism-turn-tier-<session
// id>.json on every turn (sentinelPath()) and hooks/prism-parent-dispatch-guard.mjs
// reads it — but NEITHER file, nor anything else in the codebase, ever deletes
// one. Confirmed by grep before writing this: no `*prune*` file references
// "turn-tier"; the only TTL comments in prism-prompt-tier-router.mjs (~line
// 519-521) describe the SEPARATE prism-panel-latch.mjs sidecar, not this file.
// Measured 2026-07-27: 382 files under ~/.claude matching this pattern, 167KB,
// oldest mtime 2026-06-03 (~54 days) — some are real session state, ~42 are
// synthetic test-fixture session_ids (e.g. `audit-CLF-001`, `anon`, `smoke-test`)
// written into the REAL ~/.claude by tools/prism-audit-runner.mjs, which spawns
// hooks with `env: process.env` (no HOME isolation) using session_ids from
// tests/v3/audit-scenarios.json. That creation site is out of this file's scope
// (tools/prism-audit* is owned elsewhere this session) — flagged in the report,
// not fixed here. This prune is name-agnostic by design (see below), so it
// reclaims both classes of stale file identically without needing to tell them
// apart.
//
// POLICY: age-based (mtime), not count-based keep-last-N. Rationale: with N
// concurrent sessions, "keep the N most-recently-modified" is a moving target —
// a burst of unrelated sessions touching their sentinels can shove a merely-
// quiet-for-a-few-minutes session out of the "keep" set. Pure mtime-age doesn't
// have that failure mode: a live session's sentinel is REWRITTEN by the tier
// router on every turn, so it can never look old to begin with, no matter how
// many other sessions exist. This mirrors the codebase's one working precedent
// for this class of file — `.prism-routing.jsonl` rotates on a time/size basis
// (`.bak`, `.bak-2026-07-23.gz` are on disk right now) rather than a count.
// (Unlike the routing log — which prism-telemetry-aggregate.mjs and
// prism-rollup-weekly.mjs read historically and therefore gzip-archive — a
// stale turn-tier sentinel has no downstream reader once its session is gone,
// so straight deletion, not archival, is the right disposal for this file
// class.)
//
// CONCURRENCY / LIVENESS SAFETY — read this before touching the threshold:
//   - Liveness is decided ONLY from stat() mtime, never file contents. This
//     avoids a TOCTOU window: mtime is the one signal that can't be raced
//     between "list" and "unlink" in a way that corrupts anything — if a
//     session writes its sentinel AFTER our stat() but BEFORE our unlink(),
//     the file just gets deleted then rewritten fresh on the session's very
//     next turn. The tier router's own readSentinel() already fail-opens on a
//     missing file (treats it as "no prior turn"), so this is self-healing,
//     not data loss.
//   - TURN_TIER_SAFETY_FLOOR_MS (24h) is a hard floor independent of the
//     configurable age threshold (PRISM_TURN_TIER_PRUNE_DAYS / default 7d) —
//     even a misconfigured threshold below 1 day cannot make same-day session
//     state eligible.
//   - Two sessions sweeping simultaneously: both compute the same stale set
//     from the same on-disk mtimes (nothing recent is ever in it) and both
//     call unlinkSync on the same paths; the loser's unlinkSync throws ENOENT
//     on an already-removed file, which is caught per-file and skipped. No
//     file can be "live" in one sweep's view and "stale" in the other's,
//     because both read the same filesystem truth.
//   - This function only ever DELETES; it never rewrites a sentinel. The tier
//     router owns 100% of writes, so there is no read-delete-rewrite
//     interleaving between this prune and the router to reason about.
//
// D008 note: the freshness sweep already has one mutating check (scope-aware
// agent survival) and is explicit that mutation there is justified by
// reversibility (agent files are MOVED to retired/, never deleted) — future
// mutating checks are NOT presumed to inherit that exception by default.
// Deleting a turn-tier sentinel is genuinely irreversible (there is nothing to
// "restore" — it's disposable per-turn routing scratch, not user content — but
// irreversible is irreversible). So this check stays REPORT-ONLY in the
// automatic daily sweep (both runFreshnessSweep and freshnessSweepDryRun call
// it with apply:false) — it never deletes anything unless a human explicitly
// invokes `node hooks/lib/prism-freshness-sweep.mjs --prune-turn-tier --apply`.
// That CLI entry point is fully implemented and unit-tested (apply:true path),
// per the task's explicit instruction not to prune the real directory as part
// of this change — the owner decides when to pull the trigger.
const TURN_TIER_RE = /^\.prism-turn-tier-.*\.json$/;

function turnTierPruneDays() {
  // parseFloat (not parseInt) — a fractional override (e.g. "0.5") is legal so
  // the 24h TURN_TIER_SAFETY_FLOOR_MS below has something real to clamp
  // against; a misconfigured sub-day value can never bypass the floor.
  const parsed = parseFloat(process.env.PRISM_TURN_TIER_PRUNE_DAYS || '');
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : TURN_TIER_PRUNE_DAYS_DEFAULT;
}

// Pure read: lists turn-tier sentinels older than the effective cutoff
// (max(configured age, 24h safety floor)). Never touches the filesystem.
export function listStaleTurnTierSentinels(home, now, {dir} = {}) {
  const scanDir = dir || join(home, '.claude');
  let entries;
  try { entries = readdirSync(scanDir, {withFileTypes: true}); } catch { return {scanned: 0, stale: []}; }
  const cutoffMs = Math.max(turnTierPruneDays() * 24 * 60 * 60 * 1000, TURN_TIER_SAFETY_FLOOR_MS);
  const stale = [];
  let scanned = 0;
  for (const e of entries) {
    if (scanned >= TURN_TIER_PRUNE_BUDGET) break;
    if (!e.isFile || !e.isFile()) continue;
    if (!TURN_TIER_RE.test(e.name)) continue;
    scanned++;
    const full = join(scanDir, e.name);
    const m = safeMtime(full);
    if (m === null) continue;              // can't stat → leave it alone (fail-safe)
    const ageMs = now - m;
    if (ageMs < cutoffMs) continue;        // within the safe window → leave it alone
    stale.push({name: e.name, path: full, mtime: m, ageMs});
  }
  return {scanned, stale};
}

// apply=false (default): report-only, zero mutation — safe to call from the
// automatic sweep or a dry-run preview. apply=true: unlinkSync every stale
// candidate, per-file try/catch (a race with another sweep, or the file
// vanishing between list and unlink, just gets skipped — never throws).
export function pruneTurnTierSentinels(home, now, {apply = false, dir} = {}) {
  const {scanned, stale} = listStaleTurnTierSentinels(home, now, {dir});
  if (!apply) return {scanned, candidates: stale, deleted: []};
  const deleted = [];
  for (const c of stale) {
    try { unlinkSync(c.path); deleted.push(c.name); } catch { /* already gone / transient — skip, never retry */ }
  }
  return {scanned, candidates: stale, deleted};
}

export function checkTurnTierSentinelPrune(home, now) {
  const {candidates} = pruneTurnTierSentinels(home, now, {apply: false});
  if (!candidates.length) return null;
  const days = turnTierPruneDays();
  const oldestDays = Math.max(...candidates.map((c) => Math.floor(c.ageMs / (24 * 60 * 60 * 1000))));
  return `PRISM FRESHNESS: ${candidates.length} stale turn-tier sentinel(s) (.prism-turn-tier-*.json, >${days}d untouched, oldest ${oldestDays}d) found under ~/.claude — report-only (deletion is irreversible, so this stays manual). Run \`node ~/.claude/hooks/lib/prism-freshness-sweep.mjs --prune-turn-tier\` to preview, add --apply to delete.`;
}

// ── Check A1: hook-integrity + settings-wiring ────────────────────────
// Mirrors the routine structural part of /prism-doctor so the daily sweep
// catches a broken hook before it silently no-ops a whole session. Three
// deterministic checks, ordered cheapest-first:
//   (1) wiring sanity (fs) — every prism-*.mjs filename referenced in
//       settings.json's hooks block must resolve to a real file under
//       hooks/ or hooks/lib/; a dangling reference (partial upgrade,
//       renamed hook) is flagged. ALWAYS runs (pure fs, no spawn).
//   (2) empty-file (fs) — a present prism hook that is 0 bytes (a botched
//       / truncated write). ALWAYS runs.
//   (3) syntax (node --check) — flags syntax errors. CHANGE-GATED: each
//       `node --check` is a process cold-start (~2-3s on Windows under
//       AV/AppLocker), so we only syntax-check hooks whose mtime is newer
//       than the last sweep's recorded `hooks_mtime_max`. First sweep (no
//       prior mark) records the mtime and skips the spawn entirely;
//       steady state (no hook changed) = ZERO spawns. After an edit/
//       upgrade only the changed files are checked, bounded by
//       HOOK_CHECK_BUDGET_MS. The deep, exhaustive node --check stays
//       /prism-doctor's on-demand job (where the nudge points).
// Returns {notice, hooks_mtime_max} so the caller can persist the mark.
function listPrismHookFiles(hooksDir) {
  const files = [];
  const stack = [hooksDir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, {withFileTypes: true}); } catch { continue; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (/^prism-[\w-]+\.mjs$/.test(e.name)) files.push(full);
    }
  }
  return files;
}

// Pull every prism-*.mjs filename referenced anywhere inside the settings
// hooks block (format-agnostic — works for ~/.claude paths, prism-exec
// wrappers, ${CLAUDE_PLUGIN_ROOT}, etc.).
function referencedHookFilenames(settings) {
  if (!settings || !settings.hooks) return [];
  let blob;
  try { blob = JSON.stringify(settings.hooks); } catch { return []; }
  const out = new Set();
  const re = /prism-[\w-]+\.mjs/g;
  let m;
  while ((m = re.exec(blob)) !== null) out.add(m[0]);
  return [...out];
}

function checkHookIntegrity(home, snapshot) {
  const hooksDir = join(home, ...HOOKS_DIR_REL);
  if (!existsSync(hooksDir)) return {notice: null, hooks_mtime_max: null};
  const files = listPrismHookFiles(hooksDir);

  // Newest hook mtime drives the change-gate for the syntax pass.
  let newest = 0;
  const empty = [];
  for (const f of files) {
    const m = safeMtime(f);
    if (m !== null && m > newest) newest = m;
    try { if (statSync(f).size === 0) empty.push(basename(f)); } catch {}
  }

  // (1) wiring — referenced prism hooks must exist on disk (top-level or lib/).
  const present = new Set(files.map((f) => basename(f)));
  const libDir = join(hooksDir, 'lib');
  const missing = [];
  const settings = readJsonSafe(join(home, ...SETTINGS_REL));
  for (const fn of referencedHookFilenames(settings)) {
    if (present.has(fn)) continue;
    if (existsSync(join(hooksDir, fn)) || existsSync(join(libDir, fn))) continue;
    missing.push(fn);
  }

  // (3) syntax — only for hooks changed since the last sweep. First run
  // (prev === null) just records the mark; nothing changed → skip spawns.
  const prev = snapshot && typeof snapshot.hooks_mtime_max === 'number' ? snapshot.hooks_mtime_max : null;
  const broken = [];
  if (prev !== null && newest > prev) {
    const changed = files.filter((f) => { const m = safeMtime(f); return m !== null && m > prev; });
    const start = Date.now();
    for (const f of changed) {
      if (Date.now() - start > HOOK_CHECK_BUDGET_MS) break;
      try {
        const r = spawnSync(process.execPath, ['--check', f], {
          timeout: HOOK_CHECK_TIMEOUT_MS,
          encoding: 'utf-8',
          windowsHide: true,
        });
        if (r.status !== 0) broken.push(basename(f));
      } catch {}
    }
  }

  if (!broken.length && !missing.length && !empty.length) {
    return {notice: null, hooks_mtime_max: newest};
  }
  const parts = [];
  if (broken.length) parts.push(`${broken.length} hook(s) fail node --check (${broken.slice(0, 3).join(', ')}${broken.length > 3 ? '…' : ''})`);
  if (empty.length) parts.push(`${empty.length} hook file(s) empty (${empty.slice(0, 3).join(', ')}${empty.length > 3 ? '…' : ''})`);
  if (missing.length) parts.push(`${missing.length} wired hook(s) missing on disk (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''})`);
  return {
    notice: `PRISM FRESHNESS: hook integrity issue — ${parts.join('; ')}. Run /prism-doctor to diagnose, or re-run the installer (\`node tools/prism-installer.mjs install\`).`,
    hooks_mtime_max: newest,
  };
}

// ── Check M1: MEMORY.md recall behind the docs/prism/ corpus (C4 backstop) ──
// tools/lib/memory-heal.mjs now heals MEMORY.md's D### pointers + Standing
// rules block every SessionStart (C6, TASKS workstream), so in the steady
// state this check should be silent. It exists as a BACKSTOP for the cases
// heal can't cover by construction: PRISM_DISABLE_MEMORY_HEAL=1 set, a
// project whose SessionStart hook wiring predates the heal step, or a
// MEMORY.md that was hand-edited out of sync between sweeps. Soft/telemetry
// only — never throws, never mutates. Silent when cwd isn't a docs/prism/
// project (mirrors checkVersionLag's "silent unless cwd is genuinely a
// PRISM-style repo" guard) or MEMORY.md doesn't exist yet.
//
// "Behind corpus" = a D### adjudication file exists in docs/prism/
// adjudications/ but its ref appears NOWHERE in MEMORY.md — neither as a
// `[[D###]]` Recent-decisions pointer nor as a `**D###:**` Standing-rules
// line. Either form counts as "recalled" so this stays a cheap regex
// presence-check, not a re-implementation of the heal/regen ordering logic.
export function checkMemoryRecallStale(cwd) {
  if (!cwd) return null;
  const adjDir = join(cwd, 'docs', 'prism', 'adjudications');
  const memoryPath = join(cwd, '.claude', 'agents', 'MEMORY.md');
  if (!existsSync(adjDir) || !existsSync(memoryPath)) return null;

  let names;
  try { names = readdirSync(adjDir); } catch { return null; }
  const dRefs = [];
  for (const name of names) {
    const m = name.match(/^D(\d{3,})-.+\.md$/);
    if (m) dRefs.push('D' + m[1].padStart(3, '0'));
  }
  if (!dRefs.length) return null;

  const memoryBody = safeRead(memoryPath);
  if (memoryBody === null) return null;
  const recalled = new Set();
  for (const m of memoryBody.matchAll(/\[\[D(\d{3,})\]\]/g)) recalled.add('D' + m[1].padStart(3, '0'));
  for (const m of memoryBody.matchAll(/\*\*D(\d{3,}):\*\*/g)) recalled.add('D' + m[1].padStart(3, '0'));

  const behind = dRefs.filter((ref) => !recalled.has(ref));
  if (!behind.length) return null;
  return `PRISM FRESHNESS: MEMORY.md recall ${behind.length} item(s) behind corpus — auto-heal refreshes on SessionStart (or run /prism-clean).`;
}

// ── Main entry point ───────────────────────────────────────────────────
export function runFreshnessSweep({home, throttleHours = 24, now = Date.now(), force = false, cwd = undefined, rebuildKb = defaultRebuildKb, rebuildKnowledge = defaultRebuildKnowledge} = {}) {
  if (!home) return {notices: [], snapshot: null, skipped: true};

  const snapshotPath = join(home, ...SNAPSHOT_REL);
  const prior = readJsonSafe(snapshotPath);
  const throttleMs = throttleHours * 60 * 60 * 1000;

  if (!force && prior && typeof prior.ts === 'number' && (now - prior.ts) < throttleMs) {
    return {notices: [], snapshot: prior, skipped: true};
  }

  const notices = [];
  const newSnapshot = {ts: now, plugin_dirs: [], tools_registry_mtime: null, hooks_mtime_max: null};

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

  // v5.2.0 — scope-aware agent survival (the one MUTATING check; [[D008]])
  try {
    const n = checkProjectScopedSurvival(home, now, true);
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

  // E1 — KB index staleness (A5: auto-rebuilds inline when behind)
  try {
    const n = checkKbIndexStale(home, rebuildKb);
    if (n) notices.push(n);
  } catch {}

  // F4 — cross-project knowledge index staleness (A5: auto-rebuilds inline)
  try {
    const n = checkKnowledgeIndexStale(home, rebuildKnowledge);
    if (n) notices.push(n);
  } catch {}

  // E2 — tools-registry ↔ roster index sync
  try {
    const n = checkToolsRegistrySync(home);
    if (n) notices.push(n);
  } catch {}

  // A2 — roster-orphan detection
  try {
    const n = checkRosterOrphans(home);
    if (n) notices.push(n);
  } catch {}

  // A2b — dangling roster.skills SKILL.md paths (plugin cache version bumps)
  try {
    const n = checkSkillPathsExist(home);
    if (n) notices.push(n);
  } catch {}

  // A3 — audit-staleness reminder
  try {
    const n = checkAuditStaleness(home, now);
    if (n) notices.push(n);
  } catch {}

  // G2 — stale turn-tier sentinel prune (F23) — report-only, never mutates here
  try {
    const n = checkTurnTierSentinelPrune(home, now);
    if (n) notices.push(n);
  } catch {}

  // A1 — hook-integrity + settings-wiring (change-gated syntax pass)
  try {
    const r = checkHookIntegrity(home, prior);
    newSnapshot.hooks_mtime_max = r.hooks_mtime_max;
    if (r.notice) notices.push(r.notice);
  } catch {}

  // M1 — MEMORY.md recall behind docs/prism/ corpus (backstop; heal runs at SessionStart)
  try {
    const n = checkMemoryRecallStale(cwd);
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
  // Survival preview is non-mutating: apply=false → decision-only notice.
  try { const n = checkProjectScopedSurvival(home, now, false); if (n) notices.push(n); } catch {}
  try {
    const r = checkToolsRegistryRotations(home, prior);
    if (r.notice) notices.push(r.notice);
  } catch {}
  try { const n = checkVersionLag(home, cwd); if (n) notices.push(n); } catch {}
  // Preview is non-mutating: pass noopRebuild so --preview never triggers a rebuild.
  try { const n = checkKbIndexStale(home, noopRebuild); if (n) notices.push(n); } catch {}
  try { const n = checkKnowledgeIndexStale(home, noopRebuild); if (n) notices.push(n); } catch {}
  try { const n = checkToolsRegistrySync(home); if (n) notices.push(n); } catch {}
  try { const n = checkRosterOrphans(home); if (n) notices.push(n); } catch {}
  try { const n = checkSkillPathsExist(home); if (n) notices.push(n); } catch {}
  try { const n = checkAuditStaleness(home, now); if (n) notices.push(n); } catch {}
  try { const n = checkTurnTierSentinelPrune(home, now); if (n) notices.push(n); } catch {}
  try { const r = checkHookIntegrity(home, prior); if (r.notice) notices.push(r.notice); } catch {}
  try { const n = checkMemoryRecallStale(cwd); if (n) notices.push(n); } catch {}

  return {notices, snapshot: prior};
}

export const THRESHOLDS = {STALE_AGENT_DAYS, UPDATE_LOG_AGE_DAYS, CLAUDE_MD_AGE_DAYS};

// ── G1: on-demand staleness preview (CLI) ──────────────────────────────
// `node ~/.claude/hooks/lib/prism-freshness-sweep.mjs --preview` prints the
// CURRENT staleness signals without touching the 24h throttle snapshot, so
// the orchestrator can run a pre-PROPOSAL check mid-session (the daily
// SessionStart sweep may have already consumed today's throttle window).
// Uses the dry-run path: all checks, no snapshot write. Importing this module
// (session-start does) never triggers this block — argv[1] isn't this file.
//
// basename equality, NOT .endsWith(): a plain suffix check false-positives on
// any caller whose OWN script path happens to end in this filename — e.g.
// tests/v3/state/test-prism-freshness-sweep.mjs ends with "prism-freshness-
// sweep.mjs" as a literal substring. That false match was firing this whole
// preview block (a live, real-HOME read) on every dynamic `import()` of this
// module from inside that test process — harmless (preview never mutates,
// and apply requires an explicit --apply argv flag no test passes) but noisy
// and reads outside the test's isolated tmp HOME for no reason. Found via the
// F23 turn-tier-prune work when a new preview notice line made the spam
// visible in that test's output.
const invokedDirectly =
  import.meta.url === `file://${(process.argv[1] || '').replace(/\\/g, '/')}` ||
  basename(process.argv[1] || '') === 'prism-freshness-sweep.mjs';

if (invokedDirectly) {
  const HOME = prismHome();
  const argv = process.argv.slice(2);
  if (argv.includes('--prune-turn-tier')) {
    // F23: manual trigger for the turn-tier sentinel prune. Without --apply
    // this is a pure dry-run report (identical to the automatic sweep's
    // notice, just verbose); --apply actually unlinks the stale candidates.
    const apply = argv.includes('--apply');
    const {scanned, candidates, deleted} = pruneTurnTierSentinels(HOME, Date.now(), {apply});
    if (apply) {
      process.stdout.write(`PRISM turn-tier prune: scanned ${scanned} sentinel(s) under ~/.claude, deleted ${deleted.length}.\n`);
      for (const n of deleted) process.stdout.write(`  - ${n}\n`);
    } else {
      process.stdout.write(`PRISM turn-tier prune (dry run — no files touched): scanned ${scanned} sentinel(s) under ~/.claude, ${candidates.length} would be deleted.\n`);
      for (const c of candidates) process.stdout.write(`  - ${c.name} (age ${Math.floor(c.ageMs / (24 * 60 * 60 * 1000))}d)\n`);
      if (candidates.length) process.stdout.write('Re-run with --apply to actually delete these.\n');
    }
  } else {
    const {notices} = freshnessSweepDryRun({home: HOME, cwd: process.cwd()});
    if (notices.length) {
      process.stdout.write(`PRISM staleness preview — ${notices.length} signal(s):\n`);
      for (const n of notices) process.stdout.write(`  • ${n}\n`);
    } else {
      process.stdout.write('PRISM staleness preview: no staleness signals — sources, registry, KB index, and installed version look current.\n');
    }
  }
}
