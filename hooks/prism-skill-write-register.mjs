#!/usr/bin/env node
// PRISM Skill-Write Registrar (v5.8.1) — PostToolUse
//
// Auto-registers a newly-WRITTEN skill into the appropriate roster.json
// `skills` block — the symmetric counterpart to prism-agent-write-register.mjs.
// Closes the "authored skill is orphaned until a manual /prism-index" leak:
// an expert/skill-creator that writes `<root>/.claude/skills/<name>/SKILL.md`
// mid-session now becomes immediately VISIBLE to roster-first matching and the
// panel-guard, instead of waiting for a human to run /prism-index.
//
// Trigger: PostToolUse for {Write, Edit, MultiEdit} where a target path matches
// `.../.claude/skills/<name>/SKILL.md` (<name> = the skill directory).
//
// Routing (mirrors the agent registrar's scope model):
//   ~/.claude/skills/<name>/SKILL.md          → global roster at
//                                               ~/.claude/skills/prism-plan/references/roster.json
//   <root>/.claude/skills/<name>/SKILL.md      → project roster at
//                                               <root>/.claude/agents/roster.json
//
// Schema: a minimal stub per roster.json `_schema_example_skill` (type/source/
// path/description + empty domains/keywords/trigger_phrases). `/prism-index`
// later overwrites with the full enriched entry. This hook only makes the skill
// DISCOVERABLE immediately. NOTE: installer file copies use Node cpSync, not the
// Write tool, so PRISM's own bundled skills do NOT trigger this — only a skill
// authored via the Claude Write/Edit tool mid-session does.
//
// Complementary, not duplicative: prism-kb-autosync.mjs also fires on skill
// writes, but it only flags the SEMANTIC-recall index dirty — a different
// pipeline. This hook owns the roster (discovery) index.
//
// Idempotent: re-firing on a skill already in the roster is a no-op.
// Off-switch: PRISM_DISABLE_SKILL_WRITE_HOOK=1
// Cost: ~50ms when a SKILL.md write fires; ~0ms otherwise (early path exit).

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync} from 'node:fs';
import {join, dirname, sep, basename} from 'node:path';
import { withRosterLock } from '../tools/lib/prism-roster-lock.mjs';
import { prismHome } from './lib/prism-home.mjs';
import { renameWithRetry } from '../tools/lib/atomic-fs.mjs';
import { logAdvisory } from './lib/prism-advisory-log.mjs';

// Matches `.../.claude/skills/<name>/SKILL.md`. <name> = the skill directory.
const SKILL_RE = /[/\\]\.claude[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;
// The `.claude/skills/` segment, used to derive the project root for scope.
const SKILLS_SEG = sep + '.claude' + sep + 'skills' + sep;

// ---------- helpers ----------

function collectPaths(ti) {
  const out = new Set();
  if (!ti) return [...out];
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.file_path === 'string') out.add(e.file_path);
    }
  }
  return [...out];
}

function isSkillPath(p) {
  if (!p || typeof p !== 'string') return false;
  return SKILL_RE.test(p);
}

function skillName(p) {
  const m = p.match(SKILL_RE);
  return m ? m[1] : null;
}

// Returns {roster_path, scope}. 'global' when the skill lives under
// ~/.claude/skills/; otherwise 'project' and the roster is the project's
// <root>/.claude/agents/roster.json (same project roster the agent registrar uses).
function locateRoster(skillPath, H, GLOBAL_ROSTER) {
  const normalised = skillPath.split(/[\\/]/).join(sep);
  const expectedGlobal = join(H, '.claude', 'skills') + sep;
  if (normalised.startsWith(expectedGlobal)) {
    return {roster_path: GLOBAL_ROSTER, scope: 'global'};
  }
  const idx = normalised.indexOf(SKILLS_SEG);
  if (idx !== -1) {
    const root = normalised.slice(0, idx);
    return {roster_path: join(root, '.claude', 'agents', 'roster.json'), scope: 'project'};
  }
  return {roster_path: GLOBAL_ROSTER, scope: 'global'};
}

function freshRosterSkeleton() {
  return {
    version: '3.1.0',
    schema_version: '3.1.0',
    agents: {},
    skills: {},
    tools: {},
    mcps: {},
  };
}

function readRoster(path) {
  if (!existsSync(path)) return freshRosterSkeleton();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed.skills || typeof parsed.skills !== 'object') parsed.skills = {};
    return parsed;
  } catch {
    // Corrupt JSON: fresh skeleton. Never hard-fail a user tool call from a hook.
    return freshRosterSkeleton();
  }
}

// Atomic write via tempfile + rename (same pattern as the agent registrar).
// This writes the SHARED roster.json — bounded retry (task #82/#88) absorbs
// the transient Windows AV/indexer handle-lock window before degrading, and
// the degraded path is logged rather than silent (D046).
function writeRosterAtomic(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = path + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 10);
  const body = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(tmp, body);
  try { renameWithRetry(renameSync, tmp, path); }
  catch (renameErr) {
    try {
      writeFileSync(path, body);
      logAdvisory({event: 'skill_write_register_roster_write', path,
        status: 'atomic_failed_fallback_ok', error_code: (renameErr && renameErr.code) || null});
    } catch (fallbackErr) {
      logAdvisory({event: 'skill_write_register_roster_write', path,
        status: 'write_failed', error_code: (fallbackErr && fallbackErr.code) || null});
    }
  }
}

// Minimal frontmatter reader for `description` (handles block scalars + quotes).
function parseFrontmatter(body) {
  const out = {name: '', description: ''};
  if (!body.startsWith('---')) return out;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return out;
  const lines = body.slice(3, end).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(name|description)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    let val = m[3];
    const blk = val.match(/^([>|])[0-9]*[+-]?\s*$/);
    if (blk) {
      const folded = blk[1] === '>';
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() === '') { collected.push(''); continue; }
        const clIndent = lines[j].match(/^(\s*)/)[1].length;
        if (clIndent <= indent) break;
        collected.push(lines[j].trim());
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      val = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n');
      i = j - 1;
    } else {
      const q = val.match(/^(['"])([\s\S]*)\1$/);
      if (q) val = q[2];
    }
    out[m[2]] = val;
  }
  return out;
}

async function registerSkill(skillPath, H, GLOBAL_ROSTER) {
  const name = skillName(skillPath);
  if (!name) return {registered: false};

  const {roster_path, scope} = locateRoster(skillPath, H, GLOBAL_ROSTER);

  return await withRosterLock(roster_path, async () => {
    const roster = readRoster(roster_path);
    if (!roster.skills || typeof roster.skills !== 'object') roster.skills = {};

    if (roster.skills[name]) {
      return {registered: false, alreadyKnown: true, name, roster_label: scope};
    }

    let description = '';
    let mtime = new Date().toISOString();
    try {
      if (existsSync(skillPath)) {
        const fm = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
        description = (fm.description || '').slice(0, 200);
        try { mtime = statSync(skillPath).mtime.toISOString(); } catch { /* keep now */ }
      }
    } catch { /* ignore */ }

    roster.skills[name] = {
      type: 'skill',
      source: 'user',                 // /prism-index reclassifies prism-*/plugin on full scan
      path: skillPath,
      description,
      domains: [],                    // empty stub — /prism-index enriches (mirrors agent core_domains)
      keywords: [],
      trigger_phrases: [],
      last_indexed: new Date().toISOString(),
      frontmatter_mtime: mtime,
      auto_registered: true,
    };

    writeRosterAtomic(roster_path, roster);
    return {registered: true, name, roster_label: scope};
  });
}

// ---------- exported run() ----------

export async function run(payload) {
  const H = prismHome();
  const GLOBAL_ROSTER = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');

  if (process.env.PRISM_DISABLE_SKILL_WRITE_HOOK === '1') {
    return {exit: 0, stdout: '', stderr: ''};
  }
  if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) {
    return {exit: 0, stdout: '', stderr: ''};
  }

  const paths = collectPaths(payload.tool_input);
  const skillWrites = paths.filter(isSkillPath);
  if (!skillWrites.length) return {exit: 0, stdout: '', stderr: ''};

  const messages = [];
  for (const skillPath of skillWrites) {
    const result = await registerSkill(skillPath, H, GLOBAL_ROSTER);
    if (result.registered) {
      messages.push(`PRISM: registered skill ${result.name} → ${result.roster_label} roster`);
    } else if (result.alreadyKnown) {
      messages.push(`PRISM: skill ${result.name} already registered`);
    }
  }
  return {exit: 0, stdout: messages.join('\n'), stderr: ''};
}

// ---------- CLI entry point ----------

async function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }
  const {exit: code, stdout} = await run(input);
  if (stdout) process.stdout.write(stdout);
  process.exit(code);
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-skill-write-register.mjs';
if (invokedDirectly) main().catch(e => { process.stderr.write(String(e) + '\n'); process.exit(0); });
