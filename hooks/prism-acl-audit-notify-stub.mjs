#!/usr/bin/env node
// hooks/prism-acl-audit-notify-stub.mjs — Audit scenario stub for ACL notify
//
// Used ONLY by the audit runner (tests/v3/audit-scenarios.json ACL-NTF-*).
// Sets up an isolated temp HOME with a seeded ACL digest, then invokes the
// real prism-acl-notify.mjs hook. This avoids mutating ~/.claude and does
// not dispatch any real LLM.
//
// Scenario: digest has {created:['watchdog-monitor-builder'], upgraded:[]}
// Expected: hook exits 0 and emits PRISM learned: +skill watchdog-monitor-builder

import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIFY_HOOK = join(__dirname, 'prism-acl-notify.mjs');

// Create isolated temp HOME
const tempHome = mkdtempSync(join(tmpdir(), 'prism-audit-acl-ntf-'));
const claudeDir = join(tempHome, '.claude');
mkdirSync(claudeDir, { recursive: true });

// Seed digest with a created capability entry
writeFileSync(
  join(claudeDir, '.prism-acl-digest.json'),
  JSON.stringify({ created: ['watchdog-monitor-builder'], upgraded: [] }, null, 2),
  'utf-8',
);

// Run the real notify hook
let exitCode = 0;
try {
  const r = spawnSync(process.execPath, [NOTIFY_HOOK], {
    input: JSON.stringify({ event: 'SessionStart', session_id: 'audit-acl-ntf' }),
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
