#!/usr/bin/env node
// Tests for tools/prism-retire.mjs --project flag (R3 F7 / UAT #43).
//
// A project-scoped agent lives at <cwd>/.claude/agents/<name>.md with its own
// roster.json at <cwd>/.claude/agents/roster.json (archived to
// <cwd>/.claude/agents-archive/). Without --project, prism-retire.mjs only
// ever looked at the GLOBAL paths under --home/HOME, so a project agent was
// invisible to it (exit 3 "not found") even though it plainly existed. This
// suite proves:
//   (FIRE)  --project --dry-run reports without mutating, then --project
//           actually archives the PROJECT agent + roster entry, and leaves
//           the GLOBAL roster (under an isolated --home) byte-identical.
//   (QUIET) Without --project on a project-only agent, the tool exits 3 with
//           a hint pointing at --project, and nothing is moved anywhere.
//
// Real-subprocess harness: isolated --home sandbox (mirrors
// tests/v3/state/test-prism-retire.mjs) PLUS a separate temp cwd fixture
// standing in for the project root (<cwd>/.claude/agents/...).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL = join(__dirname, '..', '..', '..', 'tools', 'prism-retire.mjs');
let pass = 0, total = 0;
const check = (label, cond) => { total++; if (cond) { pass++; } else { console.log(`FAIL: ${label}`); } };

const GLOBAL_REF = ['.claude', 'skills', 'prism-plan', 'references'];

// ── fixture builders ──────────────────────────────────────────────────────
function makeGlobalHome(agents) {
  const h = mkdtempSync(join(tmpdir(), 'prism-retire-global-'));
  mkdirSync(join(h, ...GLOBAL_REF), { recursive: true });
  mkdirSync(join(h, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(h, ...GLOBAL_REF, 'roster.json'), JSON.stringify({ version: '3.1.0', agents }, null, 2));
  return h;
}

function makeProjectCwd(agents) {
  const c = mkdtempSync(join(tmpdir(), 'prism-retire-project-'));
  mkdirSync(join(c, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(c, '.claude', 'agents', 'roster.json'), JSON.stringify({ version: '3.1.0', agents }, null, 2));
  return c;
}

const projectRosterPath = (c) => join(c, '.claude', 'agents', 'roster.json');
const projectAgentMd = (c, n) => join(c, '.claude', 'agents', n + '.md');
const projectArchiveMd = (c, n) => join(c, '.claude', 'agents-archive', n + '.md');
const globalRosterPath = (h) => join(h, ...GLOBAL_REF, 'roster.json');

function mkProjectFlat(c, n) {
  writeFileSync(projectAgentMd(c, n), '# ' + n);
}

function run(cwd, home, args) {
  const r = spawnSync('node', [TOOL, ...args, '--home', home], { encoding: 'utf8', timeout: 20000, cwd });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const readRoster = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readRaw = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// ── FIRE: --project --dry-run then --project archives, global untouched ──
{
  const GLOBAL_AGENTS = { 'other-global-agent': { installed_via: 'manual', status: 'available' } };
  const home = makeGlobalHome(GLOBAL_AGENTS);
  const cwd = makeProjectCwd({ 'proj-agent': { installed_via: 'manual', status: 'available' } });
  mkProjectFlat(cwd, 'proj-agent');

  const globalRosterBefore = readRaw(globalRosterPath(home));

  // dry-run: reports, mutates nothing
  const dry = run(cwd, home, ['--project', '--dry-run', 'proj-agent']);
  check('FIRE dry-run exit 0', dry.status === 0);
  check('FIRE dry-run names the agent', /proj-agent/.test(dry.out));
  check('FIRE dry-run mutated nothing (project .md still present)', existsSync(projectAgentMd(cwd, 'proj-agent')));
  check('FIRE dry-run mutated nothing (project roster entry still present)',
    !!readRoster(projectRosterPath(cwd))?.agents?.['proj-agent']);
  check('FIRE dry-run mutated nothing (no archive dir yet)', !existsSync(projectArchiveMd(cwd, 'proj-agent')));
  check('FIRE dry-run left global roster byte-identical', readRaw(globalRosterPath(home)) === globalRosterBefore);

  // real fire
  const fire = run(cwd, home, ['--project', 'proj-agent']);
  check('FIRE real-run exit 0', fire.status === 0);
  check('FIRE project .md moved out of .claude/agents/', !existsSync(projectAgentMd(cwd, 'proj-agent')));
  check('FIRE project .md archived to .claude/agents-archive/', existsSync(projectArchiveMd(cwd, 'proj-agent')));
  const projectRosterAfter = readRoster(projectRosterPath(cwd));
  check('FIRE project roster entry removed', !!projectRosterAfter && !projectRosterAfter.agents['proj-agent']);

  // global roster untouched by the whole sequence
  check('FIRE global roster byte-identical after real fire', readRaw(globalRosterPath(home)) === globalRosterBefore);
  check('FIRE global roster JSON structurally untouched',
    JSON.stringify(readRoster(globalRosterPath(home))) === JSON.stringify({ version: '3.1.0', agents: GLOBAL_AGENTS }));

  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

// ── QUIET/SAFE: no --project on a project-only agent -> exit 3 + hint, nothing moved ──
{
  const GLOBAL_AGENTS = { 'other-global-agent': { installed_via: 'manual', status: 'available' } };
  const home = makeGlobalHome(GLOBAL_AGENTS);
  const cwd = makeProjectCwd({ 'proj-only-agent': { installed_via: 'manual', status: 'available' } });
  mkProjectFlat(cwd, 'proj-only-agent');

  const globalRosterBefore = readRaw(globalRosterPath(home));
  const projectRosterBefore = readRaw(projectRosterPath(cwd));

  const r = run(cwd, home, ['proj-only-agent']); // no --project
  check('QUIET no --project -> exit 3', r.status === 3);
  check('QUIET stderr hints at --project', /--project/.test(r.err));
  check('QUIET stderr mentions PROJECT roster', /PROJECT roster/i.test(r.err));
  check('QUIET project .md still present (nothing moved)', existsSync(projectAgentMd(cwd, 'proj-only-agent')));
  check('QUIET no archive dir created', !existsSync(projectArchiveMd(cwd, 'proj-only-agent')));
  check('QUIET project roster unchanged', readRaw(projectRosterPath(cwd)) === projectRosterBefore);
  check('QUIET global roster unchanged', readRaw(globalRosterPath(home)) === globalRosterBefore);

  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

// ── sanity: --project on a name absent from BOTH scopes still gets plain miss message ──
{
  const home = makeGlobalHome({});
  const cwd = makeProjectCwd({});
  const r = run(cwd, home, ['--project', 'nowhere-agent']);
  check('sanity project-miss (absent everywhere) -> exit 3', r.status === 3);
  check('sanity project-miss message does not hint at --project (already used)', !/re-run with --project/.test(r.err));
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
