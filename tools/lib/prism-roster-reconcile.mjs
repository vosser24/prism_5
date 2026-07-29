// prism-roster-reconcile.mjs — F11 (roster name-drift orphans, task #26).
//
// Diffs roster.json's `agents` block against the agent `.md` files actually
// on disk, in BOTH directions, REPORT-ONLY (no writes, no deletions — see
// "Automatic vs report-only" below). Two independent scopes are reconciled
// SEPARATELY and never cross-checked, by design:
//   - user-global: ~/.claude/skills/prism-plan/references/roster.json  vs
//                  ~/.claude/agents/**/*.md (recursive — Claude Code loads
//                  agents/ recursively; identity is the `name:` frontmatter,
//                  not the path — see D074).
//   - project:     <cwd>/.claude/agents/roster.json  vs
//                  <cwd>/.claude/agents/**/*.md (recursive).
// A project agent legitimately absent from the GLOBAL roster is NOT an
// orphan — that is the false-positive trap this module exists to avoid
// (conflating the two scopes would be exactly the alert-fatigue false
// positive this session spent F10/F14/F25 fixing). Each scope's disk files
// are diffed ONLY against that scope's own roster file.
//
// Findings, per scope:
//   orphanRosterEntries — roster key whose recorded agent_path (or, if that
//     field is absent, the conventional <agentsDir>/<key>.md) does not exist
//     on disk. The registered agent is gone.
//   orphanDiskFiles      — an agent .md file on disk with no corresponding
//     roster entry at all (by frontmatter `name:`, falling back to the
//     write-register hook's own identity rule — filename for flat files,
//     parent-dir name for nested `<name>/agent.md` — see
//     hooks/prism-agent-write-register.mjs's AGENT_RE / agentName(), which
//     this module deliberately mirrors rather than reinvents a new identity
//     rule).
//   renamedOrphans       — a roster entry whose agent_path DOES exist, but
//     the file's OWN frontmatter `name:` no longer matches the roster key
//     (the literal F11 shape: something renamed after registration).
//
// Extra, cheap-because-already-loaded finding (beyond the literal ask —
// flagged here rather than silently folded in): SHADOWED — a project-roster
// agent whose name ALSO exists in the global roster. Per
// hooks/lib/prism-roster-resolve.mjs's merge rule (`if (!(k in agents))`),
// the project entry is invisible to every resolver consumer (blueprint-prompt,
// master-orchestrator, panel assembly) even though the file exists — a
// silent-shadow, not a missing-file orphan. Report-only; no action taken.
//
// Automatic vs report-only: REPORT-ONLY. Deleting a roster entry or an agent
// file is destructive and not reversible from this tool (the file may be the
// only copy; the roster entry may carry accumulated task-tracking/ratchet
// state nobody has captured elsewhere). This mirrors /prism-validate-plugins
// ("Report-only ... --fix deferred") and the session's own repeated
// alert-fatigue-avoidance lesson (F10/F14/F25): a wrong auto-delete is worse
// than a manual one-line follow-up. --fix is NOT implemented here; wiring a
// destructive mode is a separate, explicitly-approved decision.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return { agents: {}, _exists: false };
    return { ...JSON.parse(readFileSync(path, 'utf-8')), _exists: true };
  } catch (e) {
    return { agents: {}, _exists: true, _unparseable: true, _error: e.message };
  }
}

// Minimal frontmatter `name:` reader — deliberately mirrors
// hooks/prism-agent-write-register.mjs's parseFrontmatter (name field only;
// reconcile doesn't need description). Not imported directly because that
// hook is outside this task's write-ownership lease; kept in sync by intent,
// not by shared import — a candidate follow-up is factoring both into one
// shared lib once both files are touched by the same task.
function frontmatterName(filePath) {
  try {
    const body = readFileSync(filePath, 'utf-8');
    if (!body.startsWith('---')) return null;
    const end = body.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = body.slice(3, end);
    const m = block.match(/^\s*name\s*:\s*(.+?)\s*$/m);
    if (!m) return null;
    let val = m[1];
    const q = val.match(/^(['"])([\s\S]*)\1$/);
    return q ? q[2] : val;
  } catch {
    return null;
  }
}

// Finds agent DEFINITION files only — NOT a general recursive .md walk.
// Per agent-factory.md:295-301, a factory-created agent's on-disk shape is:
//   <agentsDir>/<name>/agent.md          <- the definition (depth 1, exact filename)
//   <agentsDir>/<name>/references/*.md   <- support docs, NOT agent files
//   <agentsDir>/<name>/experience/*.md   <- support docs, NOT agent files
//   <agentsDir>/<name>/lessons/*.md      <- support docs, NOT agent files
// A naive recursive walk would misidentify every support doc as an orphaned
// agent (its immediate parent dir name — "references"/"experience"/"lessons"
// — read as the "agent name"). Only two shapes count as an agent definition:
//   <agentsDir>/<name>.md        (flat)
//   <agentsDir>/<name>/agent.md  (nested, exactly one level, exact filename)
function findAgentDefinitionFiles(agentsDir) {
  const out = [];
  if (!existsSync(agentsDir)) return out;
  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(agentsDir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(p); // flat: <agentsDir>/<name>.md
    } else if (e.isDirectory()) {
      const nested = join(p, 'agent.md');
      if (existsSync(nested)) out.push(nested); // nested: <agentsDir>/<name>/agent.md
    }
  }
  return out;
}

// Identity for an on-disk agent definition file, mirroring
// hooks/prism-agent-write-register.mjs's AGENT_RE/agentName(): a FLAT file
// directly under <agentsDir>/<name>.md is keyed by filename; a NESTED
// <agentsDir>/<name>/agent.md (the ACL-only shape per D074, and also the
// "dual-file requirement" shape agent-factory.md documents for every agent
// it creates — see task #39 Part B) is keyed by its parent directory name.
// Frontmatter `name:` is reported alongside for the renamed-orphan check but
// is NOT the roster-key identity (the write-register hook never used it as
// the key — path/filename is).
function diskIdentity(filePath, agentsDir) {
  const rel = filePath.slice(agentsDir.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) {
    // <agentsDir>/<name>.md
    return parts[0].replace(/\.md$/i, '');
  }
  // <agentsDir>/<name>/agent.md
  return parts[parts.length - 2];
}

function reconcileScope({ rosterPath, agentsDir, scopeLabel }) {
  const roster = readJsonSafe(rosterPath);
  const agents = roster.agents && typeof roster.agents === 'object' ? roster.agents : {};

  const orphanRosterEntries = [];
  const renamedOrphans = [];
  for (const [key, entry] of Object.entries(agents)) {
    const recordedPath = entry && typeof entry.agent_path === 'string' ? entry.agent_path : null;
    const conventionalFlat = join(agentsDir, `${key}.md`);
    const conventionalNested = join(agentsDir, key, 'agent.md');
    // Fallback checks BOTH conventional shapes (flat and nested) when
    // agent_path is absent — a roster entry with no recorded path could
    // legitimately be either shape (agent-factory writes nested+flat; the
    // write-register hook only auto-registers flat), so checking only one
    // would produce a false orphan for the other.
    const candidatePath = recordedPath
      || (existsSync(conventionalFlat) ? conventionalFlat : conventionalNested);
    if (!existsSync(candidatePath)) {
      orphanRosterEntries.push({
        scope: scopeLabel,
        roster_key: key,
        expected_path: candidatePath,
        reason: recordedPath
          ? 'recorded agent_path does not exist on disk'
          : 'no agent_path field; neither <agentsDir>/<key>.md nor <agentsDir>/<key>/agent.md exists',
      });
      continue;
    }
    const fmName = frontmatterName(candidatePath);
    if (fmName && fmName !== key) {
      renamedOrphans.push({
        scope: scopeLabel,
        roster_key: key,
        file_path: candidatePath,
        frontmatter_name: fmName,
        reason: `file exists but its own frontmatter name ("${fmName}") no longer matches the roster key ("${key}")`,
      });
    }
  }

  const diskFiles = findAgentDefinitionFiles(agentsDir).filter((p) => basename(p).toLowerCase() !== 'roster.json');
  const orphanDiskFiles = [];
  for (const p of diskFiles) {
    const identity = diskIdentity(p, agentsDir);
    if (!identity) continue;
    if (!(identity in agents)) {
      orphanDiskFiles.push({
        scope: scopeLabel,
        file_path: p,
        inferred_identity: identity,
        frontmatter_name: frontmatterName(p),
        reason: 'agent file on disk has no corresponding roster entry',
      });
    }
  }

  return { roster, orphanRosterEntries, renamedOrphans, orphanDiskFiles };
}

export function reconcileRoster({ home, cwd }) {
  const globalRosterPath = join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
  const globalAgentsDir = join(home, '.claude', 'agents');
  const projectRosterPath = join(cwd, '.claude', 'agents', 'roster.json');
  const projectAgentsDir = join(cwd, '.claude', 'agents');

  const global = reconcileScope({ rosterPath: globalRosterPath, agentsDir: globalAgentsDir, scopeLabel: 'user-global' });
  const project = reconcileScope({ rosterPath: projectRosterPath, agentsDir: projectAgentsDir, scopeLabel: 'project' });

  // Extra (beyond the literal ask, see file header): shadowed project agents.
  const shadowed = [];
  const globalAgents = global.roster.agents || {};
  const projectAgents = project.roster.agents || {};
  for (const key of Object.keys(projectAgents)) {
    if (key in globalAgents) {
      shadowed.push({
        name: key,
        project_path: projectAgents[key] && projectAgents[key].agent_path,
        global_path: globalAgents[key] && globalAgents[key].agent_path,
        reason: 'project roster entry shares a name with a global roster entry; per resolveRoster() merge rule ' +
          '("if (!(k in agents))") the project entry is invisible to every resolver consumer',
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    global_roster_unparseable: !!global.roster._unparseable,
    project_roster_unparseable: !!project.roster._unparseable,
    orphanRosterEntries: [...global.orphanRosterEntries, ...project.orphanRosterEntries],
    orphanDiskFiles: [...global.orphanDiskFiles, ...project.orphanDiskFiles],
    renamedOrphans: [...global.renamedOrphans, ...project.renamedOrphans],
    shadowed,
  };
}
