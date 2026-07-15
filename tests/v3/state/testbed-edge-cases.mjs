#!/usr/bin/env node
// Testbed-driven end-to-end edge-case exercise for prism-state.mjs.
//
// Exercises the module against a real on-disk project under
// /tmp/prism-testbed-django/ (the Phase-1 throwaway testbed), simulating:
//   1. Fresh project (no state)
//   2. Detect-and-adopt (v3.8.9-style filesystem, no state file)
//   3. Corrupted state (invalid JSON, schema violation, checksum mismatch)
//   4. Partial-init resume (some phases done, others not)
//   5. Crash mid-write (stray .tmp files; rename interruption)
//
// Does NOT touch any user state outside the testbed root.
//
// Run: node tests/v3/state/testbed-edge-cases.mjs [<testbed-root>]
//      (defaults to /tmp/prism-testbed-django on POSIX, C:\temp\prism-testbed on Win)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {platform} from 'node:os';

import {
  PHASES,
  computeChecksum,
  createInitialState,
  getStatePath,
  isPhaseCompleted,
  markPhaseCompleted,
  readState,
  synthesizeFromFilesystem,
  writeStateAtomic,
} from '../../../tools/lib/prism-state.mjs';

const argRoot = process.argv[2];
const TESTBED =
  argRoot ||
  (platform() === 'win32' ? 'C:\\temp\\prism-testbed' : '/tmp/prism-testbed-django');

if (!existsSync(TESTBED)) {
  process.stderr.write(`Testbed not found: ${TESTBED}\n` +
    `Create it first: mkdir -p "${TESTBED}" && (cd "${TESTBED}" && git init)\n`);
  process.exit(2);
}
if (!existsSync(join(TESTBED, '.git'))) {
  process.stderr.write(`Refusing to operate on ${TESTBED}: not a git directory.\n` +
    `Phase 1 testbed must be a throwaway project with a .git/ directory.\n`);
  process.exit(2);
}

let pass = 0, fail = 0;
function step(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    fail++;
    process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`);
  }
}

function reset() {
  // Remove anything PRISM-ish from prior runs but keep .git intact.
  const claude = join(TESTBED, '.claude');
  if (existsSync(claude)) rmSync(claude, {recursive: true, force: true});
  const claudeMd = join(TESTBED, 'CLAUDE.md');
  if (existsSync(claudeMd)) rmSync(claudeMd);
}

process.stdout.write(`testbed: ${TESTBED}\n\n`);

// ---------- Case 1: fresh project ----------
step('1. fresh project — no state file present', () => {
  reset();
  const r = readState(TESTBED);
  if (r.status !== 'missing') throw new Error(`expected missing, got ${r.status}`);
});

step('1b. fresh project — initialize state and read back', () => {
  const s = createInitialState('prism-testbed');
  writeStateAtomic(TESTBED, s);
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status} (${r.errors.join(';')})`);
  if (r.state.project_name !== 'prism-testbed') throw new Error('project_name not preserved');
});

// ---------- Case 2: detect-and-adopt ----------
step('2. detect-and-adopt — synthesize state from v3.8.9-style tree', () => {
  reset();
  // Simulate v3.8.9 filesystem
  writeFileSync(join(TESTBED, 'CLAUDE.md'), '# Testbed\n');
  mkdirSync(join(TESTBED, '.claude', 'references'), {recursive: true});
  writeFileSync(join(TESTBED, '.claude', 'references', 'codebase.md'), '# refs\n');
  mkdirSync(join(TESTBED, '.claude', 'agents'), {recursive: true});
  writeFileSync(join(TESTBED, '.claude', 'agents', 'roster.json'), '[]');

  const synthesized = synthesizeFromFilesystem(TESTBED);
  if (!synthesized.phases.identity.completed_at) throw new Error('identity not synthesized');
  if (!synthesized.phases.discovery.completed_at) throw new Error('discovery not synthesized');
  if (!synthesized.phases.roster.completed_at) throw new Error('roster not synthesized');
  if (synthesized.phases.health.completed_at) throw new Error('health should NOT be synthesized');
  // Persist and re-read
  writeStateAtomic(TESTBED, synthesized);
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`re-read after synth: ${r.status}`);
  for (const p of ['identity', 'discovery', 'roster']) {
    if (!isPhaseCompleted(r.state, p)) throw new Error(`${p} not completed`);
    if (r.state.phases[p].synthesized !== true) throw new Error(`${p}.synthesized flag missing`);
  }
});

// ---------- Case 3: corruption ----------
step('3a. corruption — invalid JSON detected', () => {
  reset();
  mkdirSync(join(TESTBED, '.claude'), {recursive: true});
  writeFileSync(getStatePath(TESTBED), '{this is not json');
  const r = readState(TESTBED);
  if (r.status !== 'invalid_json') throw new Error(`expected invalid_json, got ${r.status}`);
});

step('3b. corruption — schema violation detected', () => {
  reset();
  mkdirSync(join(TESTBED, '.claude'), {recursive: true});
  writeFileSync(getStatePath(TESTBED), JSON.stringify({foo: 'bar', schema_version: 'string-not-int'}));
  const r = readState(TESTBED);
  if (r.status !== 'invalid_schema') throw new Error(`expected invalid_schema, got ${r.status}`);
});

step('3c. corruption — checksum mismatch detected', () => {
  reset();
  const s = createInitialState('cs-test');
  writeStateAtomic(TESTBED, s);
  const path = getStatePath(TESTBED);
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  obj.project_name = 'tampered-without-rechecksum';
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  const r = readState(TESTBED);
  if (r.status !== 'checksum_mismatch') throw new Error(`expected checksum_mismatch, got ${r.status}`);
});

step('3d. corruption recovery — overwrite with valid state restores ok', () => {
  // Picks up where 3c left off — file exists but is corrupt.
  let s = createInitialState('recovered');
  writeStateAtomic(TESTBED, s);
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`recovery failed: ${r.status}`);
  if (r.state.project_name !== 'recovered') throw new Error('recovery payload wrong');
});

// ---------- Case 4: partial-init detection ----------
step('4. partial-init — phases identity+structure done, others pending', () => {
  reset();
  let s = createInitialState('partial');
  s = markPhaseCompleted(s, 'identity', {claude_md_lines: 180});
  s = markPhaseCompleted(s, 'structure');
  writeStateAtomic(TESTBED, s);
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`status ${r.status}`);
  if (!isPhaseCompleted(r.state, 'identity')) throw new Error('identity should be done');
  if (!isPhaseCompleted(r.state, 'structure')) throw new Error('structure should be done');
  // Derive the still-pending phases from PHASES (not a hardcoded list) so this
  // test stays correct as the schema grows. v5.x added plugin-validate +
  // project-master; the old hardcoded ['discovery','roster','health'] left those
  // two never-completed, then the `for (const p of PHASES)` resume check below
  // failed on plugin-validate. Deriving keeps it in lockstep with the schema.
  const remaining = PHASES.filter((p) => p !== 'identity' && p !== 'structure');
  for (const p of remaining) {
    if (isPhaseCompleted(r.state, p)) throw new Error(`${p} should NOT be done`);
  }
  // Resume: complete remaining phases idempotently
  let s2 = r.state;
  for (const p of remaining) {
    s2 = markPhaseCompleted(s2, p);
    writeStateAtomic(TESTBED, s2);
  }
  const r2 = readState(TESTBED);
  for (const p of PHASES) {
    if (!isPhaseCompleted(r2.state, p)) throw new Error(`${p} not completed after resume`);
  }
  // Specifically: identity metadata preserved through resume
  if (r2.state.phases.identity.claude_md_lines !== 180) throw new Error('identity metadata lost');
});

// ---------- Case 5: crash mid-write ----------
step('5a. crash mid-write — stray .tmp file does not corrupt read', () => {
  reset();
  let s = createInitialState('crashy');
  writeStateAtomic(TESTBED, s);
  const baseline = readFileSync(getStatePath(TESTBED));
  // Drop a stray temp file in .claude/ as if a previous process crashed mid-write
  const stray = getStatePath(TESTBED) + '.tmp.66666.deadbeef';
  writeFileSync(stray, 'corrupt partial garbage that was never renamed');
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`expected ok despite stray tmp, got ${r.status}`);
  // Verify original bytes are unchanged
  const after = readFileSync(getStatePath(TESTBED));
  if (!after.equals(baseline)) throw new Error('original state file modified by stray tmp');
});

step('5b. crash mid-write — next successful write proceeds and stray persists', () => {
  // Stray from 5a is still there; we just verify it doesn't break the next write.
  let s = readState(TESTBED).state;
  s = markPhaseCompleted(s, 'identity');
  writeStateAtomic(TESTBED, s);
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`status ${r.status}`);
  if (!isPhaseCompleted(r.state, 'identity')) throw new Error('phase not marked');
});

step('5c. cleanup — remove any stray .tmp files', () => {
  const dir = join(TESTBED, '.claude');
  for (const f of readdirSync(dir)) {
    if (f.includes('.tmp.')) rmSync(join(dir, f));
  }
  // Verify state still loads
  const r = readState(TESTBED);
  if (r.status !== 'ok') throw new Error(`status after cleanup: ${r.status}`);
});

// ---------- Case 6: bytes inspection ----------
step('6. on-disk bytes — UTF-8, no BOM, LF, valid checksum', () => {
  reset();
  const s = createInitialState('byte-check');
  writeStateAtomic(TESTBED, s);
  const buf = readFileSync(getStatePath(TESTBED));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) throw new Error('UTF-8 BOM present');
  if (buf.includes(0x0d)) throw new Error('CR byte present (CRLF)');
  if (buf[buf.length - 1] !== 0x0a) throw new Error('missing trailing LF');
  // Checksum field is non-null and 64 hex chars
  const obj = JSON.parse(buf.toString('utf8'));
  if (typeof obj.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(obj.checksum)) {
    throw new Error('checksum field invalid: ' + obj.checksum);
  }
});

// ---------- final cleanup ----------
reset();
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
