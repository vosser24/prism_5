#!/usr/bin/env node
// tests/v3/state/test-oob-pickup-e2e.mjs
// v4.5 Layer 2 (O3) — E2E: write verdict file → SessionStart hook picks up → additionalContext
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0; let total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const sandbox = mkdtempSync(join(tmpdir(), 'prism-e2e-'));
mkdirSync(join(sandbox, '.claude'), { recursive: true });

// 1. Phase 1.5 verdict file
const verdict1_5 = {
  kind: 'phase_1_5',
  task_sha: 'sha1',
  verdict: { severity: 'UN-CITED', headline_finding: 'missing evidence on claim X' },
  completed_at: new Date().toISOString(),
};
writeFileSync(join(sandbox, '.claude', '.prism-phase-1-5-verdicts-sha1.json'),
  JSON.stringify(verdict1_5));

// 2. Phase 0d verdict file (v4.5 NEW)
const verdict0d = {
  kind: 'phase_0d',
  task_sha: 'sha2',
  verdict: { severity: 'REJECTED', headline_finding: 'panel theater detected' },
  completed_at: new Date().toISOString(),
};
writeFileSync(join(sandbox, '.claude', '.prism-phase-0d-verdicts-sha2.json'),
  JSON.stringify(verdict0d));

// Run SessionStart hook with sandbox HOME
const hookPath = join(repoRoot, 'hooks', 'prism-session-start.mjs');
const env = { ...process.env, HOME: sandbox, USERPROFILE: sandbox };
const result = spawnSync('node', [hookPath], {
  input: JSON.stringify({ session_id: 'test-e2e', source: 'startup' }),
  env, encoding: 'utf-8', timeout: 10_000,
});

check('SessionStart exits 0', result.status === 0);
let out;
try { out = JSON.parse(result.stdout); } catch { out = null; }
check('SessionStart returns JSON', out !== null);
const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
// Claude Code validates SessionStart additionalContext output and REQUIRES
// hookSpecificOutput.hookEventName === 'SessionStart'. Omitting it triggers
// "Hook JSON output validation failed — hookSpecificOutput is missing
// required field 'hookEventName'" at session start whenever notices fire.
check('hookSpecificOutput.hookEventName is SessionStart', out?.hookSpecificOutput?.hookEventName === 'SessionStart');
check('additionalContext surfaces phase_1_5 UN-CITED', /UN-CITED|missing evidence/.test(ctx));
check('additionalContext surfaces phase_0d REJECTED', /REJECTED|panel theater/.test(ctx));

rmSync(sandbox, { recursive: true, force: true });
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
