#!/usr/bin/env node
// WS1+WS2+WS4 (v5.7.3) — always-read DISPATCH CONTRACT prose presence.
//
// These workstreams are parent-side DOCTRINE: no mechanism can force the
// orchestrator to decompose, recall lessons, or validate a near-zero spawn
// (hooks don't fire in subagents; dispatch is main-loop-only). The lever is
// always-read prose in SKILL.md (read in full every session) + the on-demand
// PHASE references. This test pins that the contract text is present so a
// future edit can't silently drop it.

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0, fail = 0;
function check(name, hay, needle) {
  const ok = hay.includes(needle);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        missing: ${JSON.stringify(needle)}`); }
}

const SKILL = read('skills/master-orchestrator/SKILL.md');
const P1 = read('skills/master-orchestrator/references/phase-1-execution.md');
const P2 = read('skills/master-orchestrator/references/phase-2-completion.md');
const P0 = read('skills/master-orchestrator/references/phase-0-team-assembly.md');

// ── WS1: decomposition ──
check('SKILL: DISPATCH CONTRACT header', SKILL, 'DISPATCH CONTRACT');
check('SKILL: decompose-before-dispatch', SKILL, 'Decompose-before-dispatch');
check('SKILL: 3-5 bounded slices', SKILL, '3-5 bounded');
check('SKILL: per-slice tool-call budget', SKILL, 'tool-call budget');
check('P1: build-slice budget distinct from diagnosis', P1, 'build-slice budget');

// ── WS2: reuse-first + memory loop ──
check('SKILL: reuse-first gate', SKILL, 'Reuse-first');
check('SKILL: recall MEMORY.md', SKILL, 'MEMORY.md');
check('SKILL: cloud recall gated to --no-rerank', SKILL, '--no-rerank');
check('SKILL: inject top 1-3 lessons', SKILL, 'top 1-3');
check('SKILL: seed-if-absent', SKILL, 'seed-if-absent');
check('P1: inject recalled lessons at dispatch', P1, 'recalled lessons');
check('P2: capture-on-abandon', P2, 'capture-on-abandon');
check('P2: leading-tag convention example', P2, '[stall]');

// ── WS4: failed/throttled-spawn validation doctrine ──
check('SKILL: near-zero result signal', SKILL, 'near-zero result');
check('SKILL: back off + retry', SKILL, 'back off');
check('SKILL: verify partial state before re-run', SKILL, 'verify partial state');
check('P1: validate gate names the failed-spawn signal', P1, 'near-zero');

// ── WS-A (v5.7.4): factory-hire doctrine fork for PHASE-1 workers ──
check('SKILL: factory-hire fork named', SKILL, 'Factory-hire fork');
check('SKILL: recurring-surface test question', SKILL, 'recurring surface');
check('SKILL: routes to @agent-factory', SKILL, '@agent-factory');
check('SKILL: ad-hoc carve-out for one-offs', SKILL, 'ad-hoc is fine');
check('P0: factory-hire test extends to PHASE-1 workers', P0, 'factory-hire test');
check('P0: names PHASE-1 execution workers', P0, 'PHASE-1');

// ── v5.8: task-list-at-execution-start + master self-invokes superpowers ──
check('P1: TaskCreate task list at execution start (v5.8)', P1, 'surface the task list');
check('P1: master invokes superpowers itself via Skill (v5.8)', P1, 'bind YOUR OWN work');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
