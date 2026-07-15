#!/usr/bin/env node
// Scope-aware agent survival — pure decision logic (PRISM v5.2.0).
// Run: node tests/v3/state/test-prism-agent-scope.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Tests the PURE, side-effect-free core of the auto-archive feature (design:
// docs/prism/plans/2026-06-03-agent-scope-survival-design.md, [[D008]]): how a
// project-scoped agent's home-project status is classified, and which agents are
// selected for auto-archive. FS execution + the SMB guard's real probes are
// exercised separately via the freshness-sweep integration test.

import { projectStatus, evaluateSurvival } from '../../../tools/lib/prism-agent-scope.mjs';

const DAY = 86400000;
const NOW = 1000 * DAY;

let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// ── projectStatus classification ──────────────────────────────────────────────
check('no homePath → unknown',
  projectStatus({homePath: '', dirExists: false, parentExists: false, now: NOW, staleDays: 90}) === 'unknown');
check('dir exists + fresh → present',
  projectStatus({homePath: '/p', dirExists: true, parentExists: true, lastSyncMs: NOW - 10 * DAY, now: NOW, staleDays: 90}) === 'present');
check('dir exists + no lastSync → present (no false-stale)',
  projectStatus({homePath: '/p', dirExists: true, parentExists: true, lastSyncMs: null, now: NOW, staleDays: 90}) === 'present');
check('dir exists + stale lastSync → stale',
  projectStatus({homePath: '/p', dirExists: true, parentExists: true, lastSyncMs: NOW - 100 * DAY, now: NOW, staleDays: 90}) === 'stale');
check('dir gone + parent present → absent',
  projectStatus({homePath: '/p', dirExists: false, parentExists: true, now: NOW, staleDays: 90}) === 'absent');
check('dir gone + parent gone → unreachable (SMB guard)',
  projectStatus({homePath: '/p', dirExists: false, parentExists: false, now: NOW, staleDays: 90}) === 'unreachable');

// ── evaluateSurvival selection ────────────────────────────────────────────────
const roster = { agents: {
  'broad-one':   {scope: 'broad'},
  'proj-absent': {scope: 'project', home_project: 'gone'},
  'proj-fresh':  {scope: 'project', home_project: 'live'},
  'proj-unreach':{scope: 'project', home_project: 'offline'},
  'proj-stale':  {scope: 'project', home_project: 'dormant'},
  'noscope':     {},
  'already':     {scope: 'project', archived: true, home_project: 'gone'},
  '_schema_example_agent': {scope: 'project'},
}};
const statusByName = {
  'broad-one': 'absent',     // broad → must be ignored regardless of status
  'proj-absent': 'absent',
  'proj-fresh': 'present',
  'proj-unreach': 'unreachable',
  'proj-stale': 'stale',
  'noscope': 'absent',       // unscoped → treated broad → ignored
  'already': 'absent',       // already archived → skipped
};
const {archive} = evaluateSurvival(roster, (name) => statusByName[name] || 'unknown');
const names = archive.map(a => a.name).sort();

check('archives exactly project+absent and project+stale', JSON.stringify(names) === JSON.stringify(['proj-absent', 'proj-stale']));
check('broad agent never archived', !names.includes('broad-one'));
check('unreachable (SMB offline) never archived', !names.includes('proj-unreach'));
check('present/fresh project never archived', !names.includes('proj-fresh'));
check('unscoped agent never archived (safe default)', !names.includes('noscope'));
check('already-archived agent skipped', !names.includes('already'));
check('underscore schema-example skipped', !names.includes('_schema_example_agent'));
check('every archive target carries a non-empty reason', archive.every(a => typeof a.reason === 'string' && a.reason.length > 0));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
