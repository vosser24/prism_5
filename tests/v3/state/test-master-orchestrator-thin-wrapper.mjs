#!/usr/bin/env node
// CI drift-guard for D004 risk-register #6:
//   "master-orchestrator skill vs agent file divergence
//    → Agent file body = `Load skill: master-orchestrator` one-liner only;
//      CI assert keeps them in sync"
//
// Reads agents/master-orchestrator.md, parses the YAML frontmatter / body
// boundary, asserts the body matches the canonical thin-wrapper string.
// Failure = someone re-inlined protocol content into the agent body.
//
// Run: node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = join(__dirname, '..', '..', '..', 'agents', 'master-orchestrator.md');

const CANONICAL_BODY = `Load skill: master-orchestrator
`;

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`expected:\n${JSON.stringify(b)}\ngot:\n${JSON.stringify(a)}${msg ? '\n— ' + msg : ''}`);
}

function parseBody(raw) {
  // Frontmatter is delimited by --- on its own line.
  const lines = raw.split('\n');
  assert(lines[0] === '---', 'agent file must start with --- frontmatter delimiter');
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break; }
  }
  assert(endIdx > 0, 'agent file must have closing --- frontmatter delimiter');
  // Body starts after the closing --- and a single blank line.
  const bodyLines = lines.slice(endIdx + 1);
  // Drop leading blank lines so the comparison is robust to one or two newlines.
  while (bodyLines.length && bodyLines[0] === '') bodyLines.shift();
  return bodyLines.join('\n');
}

test('agent file body is the canonical thin wrapper (no inlined protocol)', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  const body = parseBody(raw);
  assertEq(body, CANONICAL_BODY, 'agent body must be exactly "Load skill: master-orchestrator\\n" — see D004 §3 + risk-register #6');
});

test('agent file frontmatter preserves @-mention surface (name, description, tools)', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  assert(/^name:\s*master-orchestrator\s*$/m.test(raw), 'name: master-orchestrator required in frontmatter');
  assert(/^description:/m.test(raw), 'description: required so @master-orchestrator surfaces in completion');
  assert(/^tools:/m.test(raw), 'tools: list required so the agent is dispatchable');
});

test('no protocol-body leakage: STARTUP / PHASE 0 / PHASE 1 sections must NOT appear in agent file', () => {
  const raw = readFileSync(AGENT_FILE, 'utf8');
  assert(!/^## STARTUP\b/m.test(raw), 'STARTUP section leaked back into agent file');
  assert(!/^## PHASE 0\b/m.test(raw), 'PHASE 0 leaked back into agent file');
  assert(!/^## PHASE 1\b/m.test(raw), 'PHASE 1 leaked back into agent file');
  assert(!/^## PHASE 1\.5\b/m.test(raw), 'PHASE 1.5 leaked back into agent file');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
