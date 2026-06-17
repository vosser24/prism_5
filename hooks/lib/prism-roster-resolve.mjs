// Single source of truth resolver (F10): GLOBAL roster is primary
// (~/.claude/skills/prism-plan/references/roster.json — what the orchestrator
// reads per SKILL.md:36). If a PROJECT roster exists at
// <cwd>/.claude/agents/roster.json (where prism-agent-write-register.mjs:74-76
// routes project-scoped writes), merge its agents in WITHOUT overriding global
// entries of the same name. Returns the unified agents map + provenance.
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

export function resolveRoster(home, cwd = process.cwd()) {
  const read = (p) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null; } catch { return null; } };
  const global = read(join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json')) || {agents: {}};
  const project = read(join(cwd, '.claude', 'agents', 'roster.json'));
  const agents = {...(global.agents || {})};
  const project_only = [];
  if (project && project.agents) for (const [k, v] of Object.entries(project.agents)) {
    if (!(k in agents)) { agents[k] = {...v, _scope: 'project'}; project_only.push(k); }
  }
  return {agents, skills: global.skills || {}, tools: global.tools || {}, mcps: global.mcps || {}, project_only};
}
