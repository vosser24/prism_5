#!/usr/bin/env node
// v5.8.1 — hooks/prism-skill-write-register.mjs
// An authored SKILL.md (via the Write/Edit/MultiEdit tool) must auto-register
// into roster.skills (global or project), idempotently, never blocking the tool
// call, and ignoring non-SKILL / non-write paths. Symmetric with the agent hook.
//
// Run: node tests/v3/state/test-prism-skill-write-register.mjs

import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-skill-write-register.mjs');
const { run } = await import(pathToFileURL(HOOK).href);

let pass = 0, total = 0;
const check = (l, c) => { total++; if (c) pass++; else console.log('FAIL: ' + l); };

const globalRoster = (home) => join(home, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const readJSON = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null);

function writeSkillFile(path, desc) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `---\nname: \ndescription: ${desc}\n---\n\nbody\n`);
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'prism-skillreg-'));
  const oldH = process.env.HOME, oldU = process.env.USERPROFILE, oldD = process.env.PRISM_DISABLE_SKILL_WRITE_HOOK;
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.PRISM_DISABLE_SKILL_WRITE_HOOK;
  try { await fn(home); }
  finally {
    process.env.HOME = oldH; process.env.USERPROFILE = oldU;
    if (oldD === undefined) delete process.env.PRISM_DISABLE_SKILL_WRITE_HOOK; else process.env.PRISM_DISABLE_SKILL_WRITE_HOOK = oldD;
    rmSync(home, {recursive: true, force: true});
  }
}

// 1. Global skill write → registered into global roster.skills
await withHome(async (home) => {
  const sp = join(home, '.claude', 'skills', 'my-skill', 'SKILL.md');
  writeSkillFile(sp, 'A test skill for X.');
  const r = await run({tool_name: 'Write', tool_input: {file_path: sp}});
  check('global: exit 0 (never blocks)', r.exit === 0);
  check('global: stdout reports registration', /registered skill my-skill → global/.test(r.stdout));
  const e = readJSON(globalRoster(home))?.skills?.['my-skill'];
  check('global: entry exists', !!e);
  check('global: type=skill', e && e.type === 'skill');
  check('global: auto_registered=true', e && e.auto_registered === true);
  check('global: description captured', e && e.description === 'A test skill for X.');
  check('global: domains empty stub', e && Array.isArray(e.domains) && e.domains.length === 0);
  check('global: path recorded', e && e.path === sp);
});

// 2. Idempotent — second fire is a no-op, no duplicate
await withHome(async (home) => {
  const sp = join(home, '.claude', 'skills', 'dup', 'SKILL.md');
  writeSkillFile(sp, 'd');
  await run({tool_name: 'Write', tool_input: {file_path: sp}});
  const r2 = await run({tool_name: 'Edit', tool_input: {file_path: sp}});
  check('idempotent: reports already registered', /already registered/.test(r2.stdout));
  check('idempotent: still exactly one entry', Object.keys(readJSON(globalRoster(home)).skills).length === 1);
});

// 3. Non-SKILL.md path under skills/ is ignored
await withHome(async (home) => {
  const p = join(home, '.claude', 'skills', 'foo', 'README.md');
  mkdirSync(dirname(p), {recursive: true}); writeFileSync(p, 'x');
  const r = await run({tool_name: 'Write', tool_input: {file_path: p}});
  check('non-SKILL: empty stdout', r.stdout === '');
  check('non-SKILL: no roster written', !existsSync(globalRoster(home)));
});

// 4. Unrelated path ignored
await withHome(async (home) => {
  const r = await run({tool_name: 'Write', tool_input: {file_path: join(home, 'notes.md')}});
  check('unrelated path: ignored', r.stdout === '' && !existsSync(globalRoster(home)));
});

// 5. Non-write tool ignored
await withHome(async (home) => {
  const sp = join(home, '.claude', 'skills', 'x', 'SKILL.md'); writeSkillFile(sp, 'd');
  const r = await run({tool_name: 'Read', tool_input: {file_path: sp}});
  check('Read tool: ignored', r.stdout === '' && !existsSync(globalRoster(home)));
});

// 6. Project-local skill → project roster (<root>/.claude/agents/roster.json), not global
await withHome(async (home) => {
  const root = join(home, 'proj');
  const sp = join(root, '.claude', 'skills', 'proj-skill', 'SKILL.md');
  writeSkillFile(sp, 'project skill');
  const r = await run({tool_name: 'Write', tool_input: {file_path: sp}});
  check('project: reports project roster', /registered skill proj-skill → project/.test(r.stdout));
  check('project: entry in project roster', !!readJSON(join(root, '.claude', 'agents', 'roster.json'))?.skills?.['proj-skill']);
  check('project: global roster NOT created', !existsSync(globalRoster(home)));
});

// 7. Off-switch
await withHome(async (home) => {
  process.env.PRISM_DISABLE_SKILL_WRITE_HOOK = '1';
  const sp = join(home, '.claude', 'skills', 'off', 'SKILL.md'); writeSkillFile(sp, 'd');
  const r = await run({tool_name: 'Write', tool_input: {file_path: sp}});
  check('off-switch: no registration', r.stdout === '' && !existsSync(globalRoster(home)));
});

// 8. description truncated to 200 chars
await withHome(async (home) => {
  const sp = join(home, '.claude', 'skills', 'long', 'SKILL.md');
  writeSkillFile(sp, 'A'.repeat(500));
  await run({tool_name: 'Write', tool_input: {file_path: sp}});
  check('description truncated to 200', readJSON(globalRoster(home)).skills['long'].description.length === 200);
});

// 9. MultiEdit (edits array) registers
await withHome(async (home) => {
  const sp = join(home, '.claude', 'skills', 'multi', 'SKILL.md'); writeSkillFile(sp, 'd');
  const r = await run({tool_name: 'MultiEdit', tool_input: {file_path: sp, edits: [{file_path: sp}]}});
  check('MultiEdit: registers', /registered skill multi/.test(r.stdout));
});

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
