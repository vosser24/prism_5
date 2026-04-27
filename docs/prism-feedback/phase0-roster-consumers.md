# Phase 0 — roster.json consumer audit
Generated: 2026-04-27
Branch: claude/audit-pending-pushes-Rg1p8

## Summary
- **Total roster.json read sites**: 3 code files (hooks and tools)
- **Agent-field reads**: 2 files (would break with schema change)
- **Skills/tools/mcps reads**: 1 file (no break — already objects)
- **Passthrough/safe**: 1 file (bootstrap only — preserve logic)

---

## Critical: would BREAK with `agents` schema change

| File | Lines | Pattern observed | Severity | Context |
|------|-------|------------------|----------|---------|
| `/home/user/PRISM/hooks/prism-subagent-stop.mjs` | 22–31 | `roster.agents[agentName]` accessed as object; `.total_tasks_completed`, `.last_used`, `.projects_worked` mutated as properties | HIGH | **Direct write path**: Increments agent counters post-subagent completion. If schema changes from `agents: {<name>: {…}}` to `agents: [{name, kind, …}]`, line 22 will fail (cannot index array by string) or mutate wrong structure. |
| `/home/user/PRISM/hooks/prism-panel-guard.mjs` | 175–190 | `Object.keys(roster.agents)` → iterate keys as agent names. `roster.agents[key]` accessed as object. `a.core_domains` read as array of strings. | HIGH | **Read + cross-reference path**: Loop assumes agents is a dict with string keys. `a.core_domains` is an array of domain tags (currently a string array; schema proposal does not break this field). If agents becomes array, `Object.keys(…)` returns numeric indices, not agent names — cross-reference logic fails. |

---

## Tolerant: would NOT break

| File | Lines | Pattern | Why safe |
|------|-------|---------|----------|
| `/home/user/PRISM/hooks/prism-session-start.mjs` | 64, 74, 108 | Roster file bootstrap only (copy-without-overwrite). Never mutates or reads agents field. | **Passthrough**: only copies `roster.json` if missing. Reads no schema, no field access — schema change irrelevant. |

---

## Details & Migration Path

### File 1: `prism-subagent-stop.mjs` (Line 18–33)
```javascript
const rp = j(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
if (e(rp) && agentName && !['master-orchestrator','agent-factory','prism-updater'].includes(agentName)) {
  try {
    const roster = JSON.parse(r(rp, 'utf-8'));
    if (roster.agents && roster.agents[agentName]) {
      const a = roster.agents[agentName];
      a.total_tasks_completed = (a.total_tasks_completed || 0) + 1;
      a.last_used = new Date().toISOString();
      // ... more property mutations on `a`
      w(rp, JSON.stringify(roster, null, 2));
    }
  } catch {}
}
```
**Breaks because**: Line 22 assumes `roster.agents` is a dict. New schema makes it an array, so `roster.agents[agentName]` → `undefined`.

**Migration v3.9.0 RFC-1 code**:
```javascript
// Backward-compat adapter
if (Array.isArray(roster.agents)) {
  const agent = roster.agents.find(a => a.name === agentName);
  if (agent) {
    agent.total_tasks_completed = (agent.total_tasks_completed || 0) + 1;
    agent.last_used = new Date().toISOString();
    // ... mutate agent
  }
} else {
  // old dict schema
  const a = roster.agents[agentName];
  // ... existing mutation code
}
```

---

### File 2: `prism-panel-guard.mjs` (Lines 175–190, 146)
```javascript
// Line 146: unpack agents into roster object
agents: r.agents || {},
// ...
// Lines 175–190: iterate agents keys, access by key
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
      if (normaliseName(d) === n || ...) return true;
    }
  }
}
```

**Breaks because**: `Object.keys(roster.agents)` on an array returns `['0', '1', ...]`. Agent names (a persona like "Security Architect") won't match numeric indices. Cross-reference fails.

**Migration v3.9.0 RFC-1 code**:
```javascript
// Backward-compat: normalize agents to a dict keyed by name
function normalizeAgents(agents) {
  if (Array.isArray(agents)) {
    const dict = {};
    for (const a of agents) {
      if (a.name) dict[a.name] = a;
    }
    return dict;
  }
  return agents || {};
}

const agentsDict = normalizeAgents(roster.agents);
for (const key of Object.keys(agentsDict)) {
  // ... existing logic using agentsDict[key]
}
```

---

### File 3: `prism-session-start.mjs` (Passthrough — safe)
No migration needed. This file only copies `roster.json` if missing; it never reads the schema.

---

## Recommendation

### Migration effort: **MEDIUM**
- **2 files** need adapter code (not large rewrites — ~15 lines each)
- **No breaking change to user data** — old dict schema can coexist with new array schema in a single file using a runtime type-check
- **Timeline**: Implement adapters in v3.9.0 RFC-1. Remove adapters in v3.10.0 (after 1 full release cycle).

### Action items for RFC-1 PR:
1. **`prism-subagent-stop.mjs`**: Wrap agent lookup in `Array.isArray()` check. Use `.find(a => a.name === name)` for new schema, dict access for old.
2. **`prism-panel-guard.mjs`**: Call `normalizeAgents()` on `roster.agents` before iteration. Handles both schemas transparently.
3. **Test**: Confirm both old (v3.1.0) dict schema and new array schema pass the same test suite.
4. **Documentation**: Add migration notice to v3.9.0 CHANGELOG recommending users upgrade their `/prism-index` / agent-factory to ensure roster uses new schema.

### Files that do NOT need changes:
- `prism-session-start.mjs` — passthrough logic
- `prism-prompt-tier-router.mjs` — never reads roster
- `prism-kb-domains.mjs` — never reads roster
- `prism-opus-classifier.mjs` — never reads roster

---

## Risk Assessment
- **Backward compatibility**: Medium risk. Old dict schema and new array schema are structurally incompatible for iteration. Dual-support via adapters is safe and proven in other PRISM transitions.
- **Test coverage**: Existing test harness in `tools/test-prism-gaps.mjs` does NOT currently exercise agent roster reads. Recommend adding test cases for both schema variants before merge.
- **Rollout**: Rolling update — users on v3.9.0 will generate mixed old/new rosters (depending on agent-factory version). Dual-support adapters ensure no breakage during the transition.

