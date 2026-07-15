// PRISM scope-aware agent survival — PURE decision core (v5.2.0).
//
// Design: docs/prism/plans/2026-06-03-agent-scope-survival-design.md
// Adjudication: docs/prism/adjudications/D008-sweep-mutating-autoarchive.md
//
// No filesystem side effects here — all FS probing is injected, so this logic is
// fully unit-testable. The freshness sweep supplies a real statusFn (existsSync +
// .prism-state.json read) and performs the reversible archive itself.
//
// An agent's `scope`:
//   "broad"   → reusable; NEVER auto-archived (protected).
//   "project" → targeted; auto-archived (reversibly) when its home project is
//               gone (absent) or dormant (stale).
//   absent/unknown → treated as "broad" (safe default; unknown never archives).

const DAY_MS = 86400000;

// Classify a project-scoped agent's home-project status from injected probes.
//   unknown     — no recorded home path (cannot judge → keep)
//   present     — dir exists and is fresh
//   stale       — dir exists but last_sync_at older than staleDays
//   absent      — dir gone BUT parent path reachable (genuine removal → archive)
//   unreachable — dir gone AND parent/mount also gone (SMB/offline → keep, guard)
export function projectStatus({homePath, dirExists, parentExists, lastSyncMs = null, now, staleDays = 90}) {
  if (!homePath) return 'unknown';
  if (dirExists) {
    if (lastSyncMs && (now - lastSyncMs) >= staleDays * DAY_MS) return 'stale';
    return 'present';
  }
  // dir is gone — distinguish genuine removal from an offline mount.
  return parentExists ? 'absent' : 'unreachable';
}

// Select project-scoped agents to auto-archive. `statusFn(name, agent)` returns
// one of the projectStatus() strings. Returns {archive: [{name, reason}]}.
// Only scope:"project", non-archived, non-underscore entries are eligible; only
// 'absent' and 'stale' trigger archive. Everything else is kept.
export function evaluateSurvival(roster, statusFn) {
  const archive = [];
  const agents = (roster && roster.agents) || {};
  for (const [name, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object' || name.startsWith('_')) continue;
    if (agent.archived) continue;            // already archived
    if (agent.scope !== 'project') continue; // broad / unscoped → protected
    const st = statusFn(name, agent);
    if (st === 'absent') archive.push({name, reason: `home project '${agent.home_project || '?'}' absent`});
    else if (st === 'stale') archive.push({name, reason: `home project '${agent.home_project || '?'}' stale`});
    // present / unreachable / unknown → keep
  }
  return {archive};
}
