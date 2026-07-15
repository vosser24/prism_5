#!/usr/bin/env node
// hooks/prism-acl-audit-rollback-stub.mjs — Audit scenario stub for ACL rollback guard
//
// Used ONLY by the audit runner (tests/v3/audit-scenarios.json ACL-RBK-*).
// Sets up an isolated temp HOME with a seeded capability at v2 (upgraded),
// then invokes the real prism-acl-rollback-guard.mjs with a correction payload.
// This avoids mutating ~/.claude and does not dispatch any real LLM.
//
// Scenario: correction attributed to watchdog-monitor-builder (upgraded to v2)
// Expected: hook exits 0 and emits rollback stderr message

import {
  mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_HOOK = join(__dirname, 'prism-acl-rollback-guard.mjs');

const NAME = 'watchdog-monitor-builder';

// Create isolated temp HOME
const tempHome = mkdtempSync(join(tmpdir(), 'prism-audit-acl-rbk-'));
const claudeDir = join(tempHome, '.claude');
mkdirSync(claudeDir, { recursive: true });

// Seed v1 snapshot
const ver1Dir = join(claudeDir, 'skills', NAME, 'versions', '1');
mkdirSync(ver1Dir, { recursive: true });
const v1Content = [
  '---', `name: ${NAME}`, 'description: Watchdog skill (v1)', 'type: skill', 'version: 1', '---',
  '', `# ${NAME} v1`, 'Original v1 content.',
].join('\n');
writeFileSync(join(ver1Dir, NAME + '.md'), v1Content, 'utf-8');

// Seed v2 live file
const skillDir = join(claudeDir, 'skills', NAME);
const liveFile = join(skillDir, NAME + '.md');
const v2Content = [
  '---', `name: ${NAME}`, 'description: Watchdog skill (bad v2)', 'type: skill', 'version: 2', '---',
  '', `# ${NAME} v2`, 'Bad v2 content.',
].join('\n');
writeFileSync(liveFile, v2Content, 'utf-8');

// Seed roster
const rosterDir = join(claudeDir, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
writeFileSync(join(rosterDir, 'roster.json'), JSON.stringify({
  agents: {},
  skills: {
    [NAME]: {
      description: 'Watchdog monitor skill',
      version: 2,
      path: liveFile,
      last_upgraded_at: new Date().toISOString(),
      last_upgrade_version: 2,
      acl_promoted: true,
    },
  },
}, null, 2), 'utf-8');

// Run the real rollback-guard hook with a correction payload
let exitCode = 0;
try {
  const r = spawnSync(process.execPath, [GUARD_HOOK], {
    input: JSON.stringify({
      event: 'correction',
      session_id: 'audit-acl-rbk',
      cap_name: NAME,
      type: 'correction',
      content: 'The upgrade gave wrong output',
    }),
    env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
    timeout: 8000,
    encoding: 'utf-8',
  });

  // Forward stdout/stderr
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  exitCode = r.status ?? 0;
} finally {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
}

process.exit(exitCode);
