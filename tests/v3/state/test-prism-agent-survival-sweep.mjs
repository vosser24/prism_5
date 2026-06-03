#!/usr/bin/env node
// Scope-aware agent survival — freshness-sweep INTEGRATION (PRISM v5.2.0, [[D008]]).
// Run: node tests/v3/state/test-prism-agent-survival-sweep.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Exercises the REAL mutating path: runFreshnessSweep auto-archives project-scoped
// agents whose home project is absent/stale, while protecting broad agents, fresh
// projects, and offline mounts (SMB guard). Verifies reversibility (file moved to
// retired/, roster entry retained + flagged) and that the dry-run path NEVER mutates.

import {mkdirSync, writeFileSync, existsSync, rmSync, readFileSync} from 'fs';
import {join, dirname} from 'path';
import {tmpdir} from 'os';
import {fileURLToPath, pathToFileURL} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const {runFreshnessSweep, freshnessSweepDryRun} = await import(pathToFileURL(SWEEP).href);

const DAY = 86400000;
const NOW = Date.now();
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const ROOT = join(tmpdir(), `prism-survival-test-${process.pid}`);
const HOME = join(ROOT, 'home');
const PROJ = join(ROOT, 'projects');          // reachable parent for "absent" projects
const ROSTER = join(HOME, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const AGENTS = join(HOME, '.claude', 'agents');

function writeJson(p, o) { mkdirSync(dirname(p), {recursive: true}); writeFileSync(p, JSON.stringify(o, null, 2)); }
function agentFile(name) { return join(AGENTS, `${name}.md`); }
function seed() {
  rmSync(ROOT, {recursive: true, force: true});
  mkdirSync(AGENTS, {recursive: true});
  mkdirSync(PROJ, {recursive: true});
  // A live project (dir exists, fresh state) for proj-live.
  const live = join(PROJ, 'live');
  writeJson(join(live, '.claude', '.prism-state.json'), {last_sync_at: new Date(NOW - 1 * DAY).toISOString()});
  // Agent files on disk.
  for (const n of ['broad-x', 'proj-gone', 'proj-live', 'proj-offline']) writeFileSync(agentFile(n), `# ${n}\n`);
  // Roster.
  writeJson(ROSTER, {agents: {
    'broad-x':      {scope: 'broad'},
    'proj-gone':    {scope: 'project', home_project: 'gone',    home_project_path: join(PROJ, 'gone')},               // parent PROJ exists, dir missing → absent
    'proj-live':    {scope: 'project', home_project: 'live',    home_project_path: live},                              // present + fresh → keep
    'proj-offline': {scope: 'project', home_project: 'offline', home_project_path: join(ROOT, 'no-mount', 'proj')},    // parent 'no-mount' absent → unreachable (SMB guard) → keep
  }});
}

// ── Dry-run must NOT mutate ────────────────────────────────────────────────────
seed();
const dry = freshnessSweepDryRun({home: HOME, now: NOW});
check('dry-run surfaces a "would archive" survival notice', dry.notices.some(n => /SURVIVAL \(dry-run\)/.test(n) && n.includes('proj-gone')));
check('dry-run does NOT move the absent-project agent file', existsSync(agentFile('proj-gone')));
check('dry-run does NOT create retired/', !existsSync(join(AGENTS, 'retired')));
check('dry-run does NOT set archived in roster', !JSON.parse(readFileSync(ROSTER, 'utf8')).agents['proj-gone'].archived);

// ── Real sweep MUST archive only the orphaned project agent ────────────────────
seed();
const res = runFreshnessSweep({home: HOME, now: NOW, force: true});
const roster = JSON.parse(readFileSync(ROSTER, 'utf8'));

check('sweep emits a SURVIVAL notice naming the archived agent', res.notices.some(n => /^PRISM SURVIVAL:/.test(n) && n.includes('proj-gone')));
// proj-gone: archived (file MOVED, entry retained+flagged)
check('proj-gone file moved OUT of agents/', !existsSync(agentFile('proj-gone')));
check('proj-gone file moved INTO agents/retired/ (reversible)', existsSync(join(AGENTS, 'retired', 'proj-gone.md')));
check('proj-gone roster entry retained + archived=true', roster.agents['proj-gone'] && roster.agents['proj-gone'].archived === true);
check('proj-gone has archived_reason + archived_at', !!roster.agents['proj-gone'].archived_reason && !!roster.agents['proj-gone'].archived_at);
// broad-x: protected
check('broad-x NOT archived (protected)', existsSync(agentFile('broad-x')) && !roster.agents['broad-x'].archived);
// proj-live: present/fresh → kept
check('proj-live NOT archived (project present + fresh)', existsSync(agentFile('proj-live')) && !roster.agents['proj-live'].archived);
// proj-offline: unreachable → SMB guard keeps it
check('proj-offline NOT archived (SMB guard — parent/mount offline)', existsSync(agentFile('proj-offline')) && !roster.agents['proj-offline'].archived);

rmSync(ROOT, {recursive: true, force: true});
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
