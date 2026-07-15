#!/usr/bin/env node
// MEMORY-INJECT-001 — tests for prism-session-start.mjs project-master
// MEMORY.md loader.
//
// Three cases:
//   A. MEMORY.md exists & non-empty → content emitted in additionalContext
//   B. MEMORY.md absent             → no MEMORY block in output
//   C. PRISM_DISABLE_MEMORY_INJECT=1, file exists → nothing emitted even if file exists
//
// Harness: subprocess spawnSync, ESM, dependency-free (Node built-ins only).

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', '..', 'hooks', 'prism-session-start.mjs');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    ()  => { pass++; console.log(`  ok  ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n        ${e.stack || e.message}`); }
  );
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** Create a minimal temp HOME that the hook will accept without crashing. */
function makeHome(label) {
  const home = mkdtempSync(join(tmpdir(), `mi001-${label}-`));
  mkdirSync(join(home, '.claude'), {recursive: true});
  mkdirSync(join(home, '.claude', 'tools'), {recursive: true});
  mkdirSync(join(home, '.claude', 'hooks', 'lib'), {recursive: true});
  return home;
}

/**
 * Create a temp project-cwd with an optional .claude/agents/MEMORY.md.
 * Returns the cwd path; caller is responsible for cleanup.
 */
function makeCwd(label, memContent /* string|null */) {
  const cwd = mkdtempSync(join(tmpdir(), `mi001-cwd-${label}-`));
  if (memContent != null) {
    mkdirSync(join(cwd, '.claude', 'agents'), {recursive: true});
    writeFileSync(join(cwd, '.claude', 'agents', 'MEMORY.md'), memContent, 'utf-8');
  }
  return cwd;
}

/**
 * Run the hook as a subprocess.
 *   home      — fake HOME (controls H inside the hook)
 *   cwd       — project directory (controls process.cwd() inside the hook)
 *   extraEnv  — additional env vars (merged over process.env)
 *
 * Returns {status, stdout, stderr}.
 */
function runHook(home, cwd, extraEnv = {}) {
  const payload = JSON.stringify({session_id: 'test-mi001', cwd});
  const r = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf-8',
    timeout: 10000,
    cwd,               // sets process.cwd() inside the hook subprocess
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Silence every unrelated notice source so assertions are clean.
      PRISM_DISABLE_FRESHNESS_SWEEP: '1',
      PRISM_DISABLE_PARALLEL_REMINDER: '1',
      PRISM_DISABLE_CLAUDE_MEM_GUARD: '1',
      PRISM_DISABLE_KNOWLEDGE_DELTA: '1',
      PRISM_DISABLE_ACL_NOTIFY: '1',
      ...extraEnv,
    },
  });
  return r;
}

/**
 * Parse the hook's stdout JSON and return the additionalContext string (or null).
 * Throws if stdout is non-empty but not valid JSON.
 */
function parseAdditionalContext(stdout) {
  if (!stdout || !stdout.trim()) return null;
  const parsed = JSON.parse(stdout);           // throws on invalid JSON
  return parsed?.hookSpecificOutput?.additionalContext ?? null;
}

// ── MEMORY needle — the string the hook prepends before the MEMORY content ───
const MEMORY_NEEDLE = '<RECALL-GATE priority=highest>';

// ── Test cases ───────────────────────────────────────────────────────────────

// A. MEMORY.md exists and is non-empty → content emitted in additionalContext
await test('A: MEMORY.md exists & non-empty → MEMORY block present in additionalContext', () => {
  const home = makeHome('A');
  const memContent = '# Project memory\n\nKey rule: always dispatch subagents.\n';
  const cwd = makeCwd('A', memContent);
  try {
    const r = runHook(home, cwd);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = parseAdditionalContext(r.stdout);
    assert(ctx !== null, `no additionalContext emitted — stdout was: ${r.stdout.slice(0, 300)}`);
    assert(
      ctx.includes(MEMORY_NEEDLE),
      `additionalContext does not contain MEMORY needle "${MEMORY_NEEDLE}". ctx=${ctx.slice(0, 400)}`
    );
    // The actual MEMORY content must be present verbatim (trimmed).
    assert(
      ctx.includes('Key rule: always dispatch subagents.'),
      `MEMORY content body not found in additionalContext. ctx=${ctx.slice(0, 400)}`
    );
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd,  {recursive: true, force: true});
  }
});

// B. MEMORY.md absent → no MEMORY block in additionalContext
await test('B: MEMORY.md absent → no MEMORY block in additionalContext', () => {
  const home = makeHome('B');
  const cwd = makeCwd('B', null);   // null → do NOT create MEMORY.md
  try {
    const r = runHook(home, cwd);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = parseAdditionalContext(r.stdout);
    // ctx may be null (no notices at all) or contain notices but NOT the MEMORY block.
    assert(
      ctx === null || !ctx.includes(MEMORY_NEEDLE),
      `MEMORY block unexpectedly present when MEMORY.md is absent. ctx=${(ctx || '').slice(0, 400)}`
    );
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd,  {recursive: true, force: true});
  }
});

// C. PRISM_DISABLE_MEMORY_INJECT=1 + file exists → nothing emitted for MEMORY
await test('C: PRISM_DISABLE_MEMORY_INJECT=1, file exists → MEMORY block suppressed', () => {
  const home = makeHome('C');
  const memContent = '# Memory\n\nThis must NOT appear when disabled.\n';
  const cwd = makeCwd('C', memContent);
  try {
    const r = runHook(home, cwd, {PRISM_DISABLE_MEMORY_INJECT: '1'});
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = parseAdditionalContext(r.stdout);
    assert(
      ctx === null || !ctx.includes(MEMORY_NEEDLE),
      `MEMORY block emitted despite PRISM_DISABLE_MEMORY_INJECT=1. ctx=${(ctx || '').slice(0, 400)}`
    );
    // The verbatim content must not appear either.
    assert(
      ctx === null || !ctx.includes('This must NOT appear when disabled.'),
      `MEMORY content body leaked into additionalContext despite disable flag. ctx=${(ctx || '').slice(0, 400)}`
    );
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd,  {recursive: true, force: true});
  }
});

// D (bonus): whitespace-only MEMORY.md → treated as empty → no block emitted
await test('D (bonus): whitespace-only MEMORY.md → no MEMORY block emitted', () => {
  const home = makeHome('D');
  const cwd = makeCwd('D', '   \n\n\t  \n');   // non-empty file but blank content
  try {
    const r = runHook(home, cwd);
    assert(r.status === 0, `hook exited ${r.status}, stderr=${r.stderr}`);

    const ctx = parseAdditionalContext(r.stdout);
    assert(
      ctx === null || !ctx.includes(MEMORY_NEEDLE),
      `MEMORY block emitted for whitespace-only MEMORY.md. ctx=${(ctx || '').slice(0, 400)}`
    );
  } finally {
    rmSync(home, {recursive: true, force: true});
    rmSync(cwd,  {recursive: true, force: true});
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
