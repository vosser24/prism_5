#!/usr/bin/env node
// WS-B (v5.7.4) — soft factory-hire HINT, piggybacking the parallel-guard trace.
//
// Detects a "domain-research flood on throwaway agents": when ≥threshold (default
// 3) same-turn dispatches are domain-research-on-a-generic-agent (generic
// subagent_type + research-token prompt), the guard appends a SOFT advisory
// suggesting @agent-factory for a durable specialist. It NEVER denies (heuristic
// → soft, even in hard mode), is disable-able (PRISM_FACTORY_HINT=off) and
// tunable (PRISM_FACTORY_HINT_THRESHOLD). A named rostered specialist is never
// generic → never hinted. Runs the guard as a SUBPROCESS with an isolated HOME.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', '..', 'hooks', 'prism-parallel-guard.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const SESSION = 'fhgm';
const HINT_RE = /agent-factory|durable specialist/i;

// Isolated HOME with `priorDr` trace entries marked dr:true (in-window, same turn).
function makeHome(priorDr) {
  const home = mkdtempSync(join(tmpdir(), 'prism-fh-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < priorDr; i++) {
    entries.push({ts: now - i * 100, pgroup: null, subagent_type: 'general-purpose', turn_id: 't1', dr: true});
  }
  writeFileSync(join(home, '.claude', `.prism-parallel-trace-${SESSION}.json`),
    JSON.stringify({entries}, null, 2));
  writeFileSync(join(home, '.claude', `.prism-turn-tier-${SESSION}.json`),
    JSON.stringify({turn_id: 't1'}, null, 2));
  return home;
}

function runGuard(home, {subagentType = 'general-purpose', prompt = 'research best practices for X',
  hint, threshold} = {}) {
  const env = {...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_ENTRYPOINT: 'cli',
    PRISM_PARALLEL_GUARD: 'soft', PRISM_POLICY_OVERRIDE: '1'};
  delete env.PRISM_PARALLEL_CAP; delete env.PRISM_FACTORY_HINT; delete env.PRISM_FACTORY_HINT_THRESHOLD;
  if (hint != null) env.PRISM_FACTORY_HINT = hint;
  if (threshold != null) env.PRISM_FACTORY_HINT_THRESHOLD = String(threshold);
  const payload = {tool_name: 'Agent', session_id: SESSION, tool_input: {subagent_type: subagentType, prompt}};
  const r = spawnSync(process.execPath, [GUARD], {input: JSON.stringify(payload), encoding: 'utf8', env});
  return {exit: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

// 2 prior dr + current dr = 3 ≥ default threshold 3 → hint, soft exit 0.
test('3rd domain-research general-purpose dispatch → factory hint (exit 0)', () => {
  const home = makeHome(2);
  try {
    const r = runGuard(home);
    assert(r.exit === 0, 'soft exit 0, got ' + r.exit);
    assert(HINT_RE.test(r.stdout), 'hint present, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// 1 prior dr + current dr = 2 < 3 → no hint.
test('2nd domain-research dispatch → no hint (below threshold)', () => {
  const home = makeHome(1);
  try {
    const r = runGuard(home);
    assert(r.exit === 0, 'exit 0');
    assert(!HINT_RE.test(r.stdout), 'no hint below threshold, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// Current dispatch is NON-research → not dr → no hint even with 2 prior dr.
test('non-research prompt → not counted, no hint', () => {
  const home = makeHome(2);
  try {
    const r = runGuard(home, {prompt: 'fix the typo in the README header'});
    assert(r.exit === 0, 'exit 0');
    assert(!HINT_RE.test(r.stdout), 'no hint for non-research prompt, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// Named specialist (not generic) with research prompt → never hinted.
test('named specialist subagent_type → never hinted', () => {
  const home = makeHome(2);
  try {
    const r = runGuard(home, {subagentType: 'cv-architect', prompt: 'research best practices for CV typography'});
    assert(r.exit === 0, 'exit 0');
    assert(!HINT_RE.test(r.stdout), 'named specialist never hinted, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// Kill switch.
test('PRISM_FACTORY_HINT=off → no hint at/over threshold', () => {
  const home = makeHome(2);
  try {
    const r = runGuard(home, {hint: 'off'});
    assert(r.exit === 0, 'exit 0');
    assert(!HINT_RE.test(r.stdout), 'disabled → no hint, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// Tunable threshold.
test('PRISM_FACTORY_HINT_THRESHOLD=2 → 2nd dispatch hints', () => {
  const home = makeHome(1);
  try {
    const r = runGuard(home, {threshold: 2});
    assert(r.exit === 0, 'exit 0');
    assert(HINT_RE.test(r.stdout), 'hint at tuned threshold, got: ' + JSON.stringify(r.stdout));
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
