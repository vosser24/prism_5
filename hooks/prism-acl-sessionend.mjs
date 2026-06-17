#!/usr/bin/env node
// hooks/prism-acl-sessionend.mjs — ACL SessionEnd hook (v1.0)
//
// Reads stdin JSON (SessionEnd event); if ACL is enabled and not debounced:
//   • spawns prism-acl-worker.mjs as a DETACHED child (fire-and-forget)
//   • writes a debounce stamp
//   • writes a spawn marker (for test assertion)
//   • exits 0 IMMEDIATELY (<50ms — no detection inline)
//
// Detached spawn pattern (E-P4): detached+stdio:'ignore'+windowsHide+unref()
// so the parent hook exits before the worker finishes, matching the OOB-spawn
// pattern in prism-session-start.mjs (context-audit detached launch).
//
// Debounce: cadence 'session-end' → once per session-end invocation. The stamp
// is a timestamp; a second call within DEBOUNCE_MS is a no-op (no new spawn).
// Default DEBOUNCE_MS = 60 000 ms (1 min) — configurable via env.

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(HOME, '.claude');
const DEBOUNCE_FILE = join(CLAUDE_DIR, '.prism-acl-debounce');
const SPAWN_MARKER = join(CLAUDE_DIR, '.prism-acl-spawn-marker');
const DEBOUNCE_MS = parseInt(process.env.PRISM_ACL_DEBOUNCE_MS || '60000', 10);

// The worker script — lives next to this hook
const WORKER = new URL('./prism-acl-worker.mjs', import.meta.url).pathname;

// ── Load config (inline sync — avoid dynamic import latency) ──────────────────

function loadConfigFast() {
  const cfgPath = join(CLAUDE_DIR, '.prism-acl-config.json');
  const defaults = {
    enabled: true, cluster_threshold: 3, cadence: 'session-end',
    notify: true, autonomy: 'silent-notified',
  };
  if (!existsSync(cfgPath)) return defaults;
  try { return { ...defaults, ...JSON.parse(readFileSync(cfgPath, 'utf-8')) }; } catch { return defaults; }
}

// ── Debounce check ────────────────────────────────────────────────────────────

function isDebounced() {
  if (!existsSync(DEBOUNCE_FILE)) return false;
  try {
    const ts = parseInt(readFileSync(DEBOUNCE_FILE, 'utf-8').trim(), 10);
    return Number.isFinite(ts) && (Date.now() - ts) < DEBOUNCE_MS;
  } catch { return false; }
}

// ── Main (fully synchronous after top-level await for ESM startup) ───────────
// Note: stdin is intentionally NOT awaited; the hook reads config from disk and
// exits immediately.  The SessionEnd payload is not used for routing decisions
// in Phase 1 (all routing state is in the routing log).

try {
  const cfg = loadConfigFast();
  if (!cfg.enabled) { process.exit(0); }

  // Ensure .claude dir exists
  try { mkdirSync(CLAUDE_DIR, { recursive: true }); } catch {}

  if (isDebounced()) {
    // No-op: second call within cadence
    process.exit(0);
  }

  // Spawn detached worker (E-P4 pattern: detached+stdio:'ignore'+unref())
  const workerEnv = { ...process.env, HOME, USERPROFILE: HOME };
  const child = spawn(process.execPath, [WORKER], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: workerEnv,
  });
  child.unref();

  // Write debounce stamp
  writeFileSync(DEBOUNCE_FILE, String(Date.now()), 'utf-8');

  // Write spawn marker (PID of spawned child) for test assertion
  writeFileSync(SPAWN_MARKER, String(child.pid || Date.now()), 'utf-8');

} catch {}

process.exit(0);
