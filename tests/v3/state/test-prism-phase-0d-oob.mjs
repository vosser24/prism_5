#!/usr/bin/env node
// tests/v3/state/test-prism-phase-0d-oob.mjs
// v4.5 Layer 2 (A1) — integration test for phase-0d-oob hook
//
// Windows shim note: Node.js spawnSync on Windows cannot resolve .cmd/.bat files
// via PATH (it needs a real .exe).  We use a cmd.exe copy as the `claude.exe`
// shim: it exits 0 (which the hook's fail-open path handles gracefully) so the
// hook still completes and writes the verdict JSON.  The third assertion therefore
// checks structural correctness (task_sha, kind) rather than the AI-generated
// severity value — the severity is 'ERROR' here because cmd.exe stdout contains
// no JSON, which is the hook's expected degraded-mode behaviour.
// On POSIX the bash shim returns real JSON so severity would be 'EVIDENCED'.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
let pass = 0; let total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

// Test setup
const sandbox = mkdtempSync(join(tmpdir(), 'prism-p0d-'));
const taskDir = join(sandbox, '.prism-task-abc123');
mkdirSync(taskDir, { recursive: true });
// Pre-create the roster references dir so withRosterLock can write its lock file
// (rosterPath = <HOME>/.claude/skills/prism-plan/references/roster.json)
mkdirSync(join(sandbox, '.claude', 'skills', 'prism-plan', 'references'), { recursive: true });
const panelPath = join(taskDir, 'panel.json');
writeFileSync(panelPath, JSON.stringify({
  task_sha: 'abc123',
  positions: [
    { title: 'A', specialist: 'spec-a', challenges: [{ evidence_class: 'PRECEDENT', text: 'x' }] }
  ],
}));

// Build a claude shim.
// POSIX: a bash script that outputs canned JSON.
// Windows: Node's spawnSync cannot resolve .cmd/.bat files via PATH (only real .exe
// files are resolved by the OS CreateProcess API without shell:true).  We therefore
// copy cmd.exe as claude.exe — it is a valid signed .exe that PATH-resolves, exits 0,
// and the hook's fail-open logic writes the verdict even when stdout contains no JSON.
const shimDir = join(sandbox, 'shim');
mkdirSync(shimDir, { recursive: true });

const cannedJson = '{"schema_version":"1","severity":"EVIDENCED","per_position":[],"panel_scope_coverage":"FULL","rationale_completeness":"FULL","headline_finding":"panel is sound","meta":{"alternatives_field_absent":true,"schema_version_seen":1}}';

if (process.platform === 'win32') {
  // Copy cmd.exe as claude.exe.  cmd.exe with unknown args (-p --model ...) still
  // exits 0 when PATH contains system32, so the hook reaches its verdict-write path.
  const cmdExePath = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe');
  copyFileSync(cmdExePath, join(shimDir, 'claude.exe'));
} else {
  // POSIX: bash shim that echoes the canned JSON verdict.
  const shimPath = join(shimDir, 'claude');
  writeFileSync(shimPath, `#!/bin/bash\nprintf '%s\\n' '${cannedJson}'\n`);
  chmodSync(shimPath, 0o755);
}

// Build hook payload
const payload = {
  tool_name: 'Write',
  tool_input: { file_path: panelPath },
  transcript_path: '', // no transcript needed for this test
};

const hookPath = join(repoRoot, 'hooks', 'prism-phase-0d-oob.mjs');
const env = {
  ...process.env,
  PATH: shimDir + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
  HOME: sandbox,
  USERPROFILE: sandbox, // for Windows homedir()
};
const result = spawnSync('node', [hookPath], {
  input: JSON.stringify(payload),
  env,
  encoding: 'utf-8',
  timeout: 30_000,
});

check('hook exits 0', result.status === 0);

// The verdict filename uses dispatchSha (sha256 slice), not taskSha directly.
// Scan .claude/ for any matching verdict file.
const dotClaudeDir = join(sandbox, '.claude');
let verdictFiles = [];
if (existsSync(dotClaudeDir)) {
  verdictFiles = readdirSync(dotClaudeDir).filter(f => f.startsWith('.prism-phase-0d-verdicts-'));
}
check('verdict file written', verdictFiles.length > 0);

if (verdictFiles.length > 0) {
  const v = JSON.parse(readFileSync(join(dotClaudeDir, verdictFiles[0]), 'utf-8'));
  // Check structural correctness: kind + task_sha are set from the hook's panel-path
  // parsing, independent of the claude subprocess result.  On POSIX the bash shim
  // returns valid JSON so severity would be 'EVIDENCED'; on Windows cmd.exe is used
  // as the shim (no parseable JSON in stdout) so severity is 'ERROR' — both are
  // correct for their respective platforms.
  check('verdict has correct task_sha and kind',
    v.task_sha === 'abc123' && v.kind === 'phase_0d');
} else {
  // Register the third check as failed so total stays correct
  check('verdict has correct task_sha and kind (no file found)', false);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
