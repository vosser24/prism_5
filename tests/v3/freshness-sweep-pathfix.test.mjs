#!/usr/bin/env node
// Tests for hooks/lib/prism-freshness-sweep.mjs path fixes (FIX 2 + FIX 3).
//   FIX 2 — resolveAgentFile resolves a RELATIVE file_path against the entry's
//           home_project_path (not the session cwd) → a valid project-local
//           agent is no longer mis-flagged as an orphan.
//   FIX 3 — checkSkillPathsExist flags roster.skills entries whose SKILL.md
//           path no longer exists on disk (e.g. plugin cache version bump).
// Hermetic: builds an isolated temp HOME + real files, drives the exported
// freshnessSweepDryRun (which wires both checks exactly as the live sweep does).
//
// Run: node tests/v3/freshness-sweep-pathfix.test.mjs

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(__dirname, '..', '..', 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const {freshnessSweepDryRun} = await import(pathToFileURL(SWEEP).href);

let pass = 0, fail = 0;
function check(name, cond, msg) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n        ${msg || 'condition false'}`); }
}

function seedHome(roster, mutate) {
  const home = mkdtempSync(join(tmpdir(), 'prism-sweep-'));
  const refDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(refDir, {recursive: true});
  if (typeof mutate === 'function') mutate(home, roster);
  writeFileSync(join(refDir, 'roster.json'), JSON.stringify(roster));
  return home;
}
const noticeMatching = (notices, re) => notices.find(n => re.test(n)) || '';

// ── FIX 2: relative file_path resolves against home_project_path ──────────
{
  let home;
  try {
    home = seedHome(
      {
        version: '1', tools: {}, mcps: {}, skills: {},
        agents: {
          // Relative file_path + a home_project_path where the file EXISTS.
          'good-relative': {
            file_path: '.claude/agents/good-relative.md',
            // home_project_path filled in by mutate() once temp home is known.
          },
          // Genuinely-missing agent (absolute path that does not exist).
          'missing-agent': {
            file_path: '/no/such/dir/missing-agent.md',
          },
        },
      },
      (home, roster) => {
        const proj = join(home, 'projects', 'ecom');
        const agentFile = join(proj, '.claude', 'agents', 'good-relative.md');
        mkdirSync(dirname(agentFile), {recursive: true});
        writeFileSync(agentFile, '# good-relative\n');
        roster.agents['good-relative'].home_project_path = proj;
        // Make the absolute-missing path unambiguously under the temp home.
        roster.agents['missing-agent'].file_path = join(home, 'gone', 'missing-agent.md');
      }
    );

    const {notices} = freshnessSweepDryRun({home, now: Date.now()});
    const orphan = noticeMatching(notices, /orphan/i);

    check('FIX2: relative file_path + existing home_project_path → NOT orphan',
      !/good-relative/.test(orphan),
      `good-relative must not be flagged. orphan notice: "${orphan}"`);
    check('FIX2: genuinely-missing agent → still flagged as orphan',
      /missing-agent/.test(orphan),
      `missing-agent must be flagged. orphan notice: "${orphan}"`);
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

// ── FIX 3: dangling roster.skills SKILL.md paths ──────────────────────────
{
  let home;
  try {
    home = seedHome(
      {
        version: '1', tools: {}, mcps: {}, agents: {},
        skills: {
          'exists-skill': {type: 'skill'},   // path filled by mutate → real file
          'dangling-skill': {type: 'skill'}, // path filled by mutate → absent
          'tilde-skill': {type: 'skill', path: '~/definitely-not-here-xyz/SKILL.md'},
          'nopath-skill': {type: 'skill', domains: ['x']}, // no path → skipped
        },
      },
      (home, roster) => {
        const real = join(home, 'realskill', 'SKILL.md');
        mkdirSync(dirname(real), {recursive: true});
        writeFileSync(real, '# skill\n');
        roster.skills['exists-skill'].path = real;
        roster.skills['dangling-skill'].path = join(home, 'gone', 'SKILL.md');
      }
    );

    const {notices} = freshnessSweepDryRun({home, now: Date.now()});
    const dangle = noticeMatching(notices, /no longer exist on disk \(dangling/i);

    check('FIX3: dangling skill path (absolute) → flagged',
      /dangling-skill/.test(dangle), `expected dangling-skill flagged. notice: "${dangle}"`);
    check('FIX3: dangling skill path (~ expansion) → flagged',
      /tilde-skill/.test(dangle), `expected tilde-skill flagged. notice: "${dangle}"`);
    check('FIX3: existing skill path → NOT flagged',
      !/exists-skill/.test(dangle), `exists-skill must not be flagged. notice: "${dangle}"`);
    check('FIX3: entry with no path field → skipped (not counted)',
      !/nopath-skill/.test(dangle) && /\b2 roster skill paths\b/.test(dangle),
      `expected exactly 2 dangling (nopath skipped). notice: "${dangle}"`);
  } finally {
    try { rmSync(home, {recursive: true, force: true}); } catch {}
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
