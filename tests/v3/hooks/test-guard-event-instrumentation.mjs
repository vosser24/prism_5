#!/usr/bin/env node
// Task #42: the 4 previously-uncensusable guards now emit event-keyed records
// into ~/.claude/.prism-routing.jsonl so an event-keyed guard census can see
// them. This test drives each guard's FIRE path and a clean ALLOW path with a
// hermetic fake HOME and asserts:
//   1. prism-agent-model-guard.mjs   → event 'agent_model_guard'   (action: kept)
//   2. prism-acl-rollback-guard.mjs  → event 'acl_rollback_guard'  (fire = real rollback)
//   3. prism-capture-evidence-guard.mjs → event 'capture_evidence_guard'
//      on BOTH deny (blocked:true) and allow (blocked:false) paths
//   4. prism-config-guard.mjs        → event 'config_guard' + the stale
//      "python prism-v2.py" remediation is replaced by the real installer cmd.
// Control-flow is unchanged: exit codes / deny decisions asserted identical to
// pre-instrumentation behavior.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log(`  ok  ${name}`); },
    e  => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `guard-evt-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}

function runGuard(hookFile, payload, home, extraEnv = {}) {
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30000,
    env: {...process.env, HOME: home, USERPROFILE: home, ...extraEnv},
  });
}

function logRecords(home, event) {
  const p = join(home, '.claude', '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.event === event);
}

// ─── 1. agent-model-guard → event: 'agent_model_guard' ───────────────────────

await test('agent-model-guard: fire path emits event agent_model_guard (action: key kept)', () => {
  const home = makeHome('amg');
  try {
    const r = runGuard('prism-agent-model-guard.mjs', {
      tool_name: 'Agent',
      session_id: 't42-amg',
      tool_input: {subagent_type: 'claude', description: 'review this component', prompt: 'review this React component for bugs'},
    }, home);
    assert(r.status === 0, `exited ${r.status}, stderr=${r.stderr}`);
    const recs = logRecords(home, 'agent_model_guard');
    assert(recs.length >= 1, 'no agent_model_guard record in routing log');
    assert(typeof recs[0].action === 'string' && recs[0].action.length, 'action: key was removed — must be KEPT alongside event:');
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('agent-model-guard: subagent-context passthrough also carries the event key', () => {
  const home = makeHome('amg2');
  try {
    const r = runGuard('prism-agent-model-guard.mjs', {
      tool_name: 'Agent',
      session_id: 't42-amg2',
      parent_tool_use_id: 'toolu_parent',
      tool_input: {subagent_type: 'claude', prompt: 'x'},
    }, home);
    assert(r.status === 0, `exited ${r.status}`);
    const recs = logRecords(home, 'agent_model_guard');
    assert(recs.length === 1 && recs[0].action === 'passthrough-subagent-context',
      `expected passthrough-subagent-context record, got ${JSON.stringify(recs)}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── 2. acl-rollback-guard → event: 'acl_rollback_guard' ─────────────────────

await test('acl-rollback-guard: real rollback fire path emits acl_rollback_guard (rolledback:true)', () => {
  const home = makeHome('acl');
  try {
    const agentDir = join(home, '.claude', 'agents', 'testcap');
    const livePath = join(agentDir, 'testcap.md');
    mkdirSync(join(agentDir, 'versions', '1'), {recursive: true});
    writeFileSync(livePath, 'v2 content');
    writeFileSync(join(agentDir, 'versions', '1', 'testcap.md'), 'v1 content');
    const refDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
    mkdirSync(refDir, {recursive: true});
    writeFileSync(join(refDir, 'roster.json'), JSON.stringify({
      agents: {testcap: {version: 2, last_upgraded_at: '2026-07-15T00:00:00Z', path: livePath}},
      skills: {},
    }));

    const r = runGuard('prism-acl-rollback-guard.mjs', {
      event: 'correction', type: 'correction', session_id: 't42-acl', cap_name: 'testcap',
    }, home);
    assert(r.status === 0, `exited ${r.status}, stderr=${r.stderr}`);
    assert(readFileSync(livePath, 'utf-8') === 'v1 content', 'live file was not rolled back to v1');
    const recs = logRecords(home, 'acl_rollback_guard');
    assert(recs.length === 1, `expected 1 record, got ${recs.length}`);
    assert(recs[0].rolledback === true && recs[0].from === 2 && recs[0].to === 1,
      `unexpected record: ${JSON.stringify(recs[0])}`);
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('acl-rollback-guard: non-correction payload passes through clean (no crash, no record)', () => {
  const home = makeHome('acl2');
  try {
    const r = runGuard('prism-acl-rollback-guard.mjs', {event: 'something-else', session_id: 't42'}, home);
    assert(r.status === 0, `exited ${r.status}, stderr=${r.stderr}`);
    assert(logRecords(home, 'acl_rollback_guard').length === 0, 'non-correction payload must not emit');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── 3. capture-evidence-guard → event: 'capture_evidence_guard' ─────────────

await test('capture-evidence-guard: DENY path emits blocked:true (control flow unchanged: exit 2)', () => {
  const home = makeHome('cap');
  try {
    const r = runGuard('prism-capture-evidence-guard.mjs', {
      tool_name: 'Write',
      session_id: 't42-cap',
      tool_input: {file_path: 'docs/prism/lessons/2026-07-16-test.md', content: '# L\n\nThe bug is fixed and confirmed.'},
    }, home, {PRISM_CAPTURE_EVIDENCE_GATE: 'hard'});
    assert(r.status === 2, `expected deny exit 2, got ${r.status}`);
    assert(r.stdout.includes('"permissionDecision":"deny"'), 'deny JSON missing from stdout');
    const recs = logRecords(home, 'capture_evidence_guard');
    assert(recs.length === 1 && recs[0].blocked === true && recs[0].outcome === 'deny',
      `unexpected record: ${JSON.stringify(recs)}`);
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('capture-evidence-guard: ALLOW path (evidence present) emits blocked:false, exit 0', () => {
  const home = makeHome('cap2');
  try {
    const r = runGuard('prism-capture-evidence-guard.mjs', {
      tool_name: 'Write',
      session_id: 't42-cap2',
      tool_input: {file_path: 'docs/prism/lessons/2026-07-16-test.md', content: '# L\n\n**Verified:** node test -> pass\n\nThe bug is fixed and confirmed.'},
    }, home, {PRISM_CAPTURE_EVIDENCE_GATE: 'hard'});
    assert(r.status === 0, `expected allow exit 0, got ${r.status}`);
    const recs = logRecords(home, 'capture_evidence_guard');
    assert(recs.length === 1 && recs[0].blocked === false && recs[0].outcome === 'evidence-present',
      `unexpected record: ${JSON.stringify(recs)}`);
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('capture-evidence-guard: out-of-scope write stays SILENT (no log flood)', () => {
  const home = makeHome('cap3');
  try {
    const r = runGuard('prism-capture-evidence-guard.mjs', {
      tool_name: 'Write',
      session_id: 't42-cap3',
      tool_input: {file_path: 'src/app.js', content: 'this is fixed and confirmed'},
    }, home, {PRISM_CAPTURE_EVIDENCE_GATE: 'hard'});
    assert(r.status === 0, `expected exit 0, got ${r.status}`);
    assert(logRecords(home, 'capture_evidence_guard').length === 0, 'out-of-scope write must not emit');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── 4. config-guard → event: 'config_guard' + fixed remediation text ────────

await test('config-guard: warning path emits config_guard warned:true with CURRENT installer cmd', () => {
  const home = makeHome('cfg');
  try {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# something else, no prism section');
    const r = runGuard('prism-config-guard.mjs', {session_id: 't42-cfg'}, home);
    assert(r.status === 0, `exited ${r.status}`);
    assert(r.stdout.includes('node tools/prism-installer.mjs install'),
      `remediation must point at the installer; stdout=${r.stdout}`);
    assert(!r.stdout.includes('prism-v2.py'), 'stale python prism-v2.py remediation still present');
    const recs = logRecords(home, 'config_guard');
    assert(recs.length === 1 && recs[0].warned === true, `unexpected record: ${JSON.stringify(recs)}`);
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('config-guard: clean path (## PRISM present) emits warned:false, no warning on stdout', () => {
  const home = makeHome('cfg2');
  try {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '## PRISM\nrules here');
    const r = runGuard('prism-config-guard.mjs', {session_id: 't42-cfg2'}, home);
    assert(r.status === 0, `exited ${r.status}`);
    assert(!r.stdout.includes('PRISM WARNING'), 'clean path must not warn');
    const recs = logRecords(home, 'config_guard');
    assert(recs.length === 1 && recs[0].warned === false, `unexpected record: ${JSON.stringify(recs)}`);
    console.log(`    [log] ${JSON.stringify(recs[0])}`);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
