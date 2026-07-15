// hooks/lib/prism-claude-mem-guard.mjs
// Self-healing claude-mem performance guard for PRISM SessionStart (v5.7.x).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS FIXES (diagnosed 2026-06-10)
// ─────────────────────────────────────────────────────────────────────────────
// claude-mem@thedotmack ships hooks that, on Windows, made every tool call slow
// or frozen. Two independent costs were measured and root-caused on this host:
//
//   1. WORKER FREEZE (acute). claude-mem's PostToolUse matcher is "*", so it
//      fires on EVERY tool call and tries to reach a worker daemon. The worker
//      binds a DETERMINISTIC port: 37700 + (process.getuid?.() ?? 77) % 100,
//      and getuid is undefined on Windows → 37777 for every install. When a
//      worker dies abnormally (racing lazy-spawns from the MCP server + the
//      SessionStart hook + PostToolUse), it leaves a GHOST socket: a listener
//      attributed to a now-dead PID that actively refuses connections and
//      cannot be killed (the PID is gone). Every subsequent worker bind fails
//      with "Failed to start server. Is port 37777 in use?", so the worker is
//      permanently unreachable and each PostToolUse blocks on it.
//      FIX: move the worker to a fresh, stable port persisted in claude-mem's
//      OWN config (~/.claude-mem/settings.json — user data plugin updates never
//      touch). A fresh port has no ghost; claude-mem's own `start` hook then
//      binds it cleanly. Verified: worker comes up healthy on the new port.
//
//   2. LOGIN-SHELL PROBE (chronic). Every claude-mem hook command begins with
//      `export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH"`. On this
//      host a bash *login* shell costs ~1.0s (Git-for-Windows /etc/profile +
//      /etc/profile.d/*) vs ~0.12s non-login — so claude-mem paid ~1s PER HOOK
//      just to read PATH, on every tool call.
//      FIX: rewrite the probe to a direct, pre-resolved `<node-bin>:<bun-bin>`
//      PATH export (no login shell), so node (runs bun-runner.js) and bun (runs
//      the worker) are still both found.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS LIVES IN PRISM, AND WHY IT IS CONFIG-ONLY (robustness)
// ─────────────────────────────────────────────────────────────────────────────
// claude-mem auto-updates silently (it bumped to 13.5.4 the morning of the
// regression) and each update installs into a NEW version directory, wiping any
// edit to its hooks.json. The only control point that survives is PRISM's own
// SessionStart, so we RE-ASSERT the fix every session: after any future
// claude-mem update the next session re-detects the active install and re-heals.
//
// This guard does PURE, IDEMPOTENT CONFIG — it edits two files and manages NO
// processes. An earlier design killed stale workers and spawned a replacement;
// that proved brittle (a detached daemon did not survive the hook process exit,
// and killing by port risks collateral damage). It is unnecessary: claude-mem's
// own SessionStart `start` hook launches the worker, and the only thing that was
// breaking it (the 37777 ghost) is removed by the port move. So we just make
// claude-mem's environment correct and let it own its worker lifecycle.
//
// FAIL-SAFE CONTRACT: never break claude-mem, never block session start. If the
// install can't be found, or the hooks.json format changes so our probe pattern
// no longer matches, we no-op (claude-mem keeps working, just without the
// speedup) and move on.
//
// EFFECT TIMING (honest): both edits take effect on the NEXT Claude Code launch
// — hook definitions and the worker port are read at startup. The first session
// after a claude-mem update is therefore slow/ghost-prone, then self-heals.
//
// OFF-SWITCH: PRISM_DISABLE_CLAUDE_MEM_GUARD=1 disables the guard entirely.

import {existsSync, readFileSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import http from 'node:http';

// Windows default worker port is deterministic (see header) → 37777 for every
// install, which is exactly what collides and ghosts. CHOSEN_PORT is a fixed,
// uncommon port we pin in claude-mem's own settings.json.
const DEFAULT_PORT = 37777;
const CHOSEN_PORT = 37790;
const CM_SETTINGS = ['.claude-mem', 'settings.json'];
const PROBE_LITERAL = "$SHELL -lc 'echo $PATH'";
const PROBE_SUBSHELL = "$($SHELL -lc 'echo $PATH' 2>/dev/null)";

// Convert a Windows path (C:\Users\x) to the Git-Bash POSIX form (/c/Users/x).
function winToPosix(p) {
  if (!p) return p;
  return String(p)
    .replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase())
    .replace(/\\/g, '/');
}

// Newest version dir under the claude-mem cache (semver desc).
function newestCacheVersion(home) {
  const base = join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (!existsSync(base)) return null;
  let dirs = [];
  try {
    dirs = readdirSync(base)
      .filter(n => /^[0-9]/.test(n))
      .map(name => ({name, full: join(base, name)}))
      .filter(d => { try { return statSync(d.full).isDirectory(); } catch { return false; } });
  } catch { return null; }
  if (!dirs.length) return null;
  dirs.sort((a, b) => {
    const pa = a.name.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.name.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
    return 0;
  });
  return dirs[0].full;
}

// Active claude-mem install dir + candidate plugin roots whose hooks.json we keep patched.
function resolveClaudeMem(home) {
  const out = {installPath: null, roots: []};
  try {
    const ip = join(home, '.claude', 'plugins', 'installed_plugins.json');
    if (existsSync(ip)) {
      const j = JSON.parse(readFileSync(ip, 'utf8'));
      const entry = j && j['claude-mem@thedotmack'];
      const rec = Array.isArray(entry) ? entry[0] : entry;
      if (rec && rec.installPath) out.installPath = rec.installPath;
    }
  } catch {}
  if (!out.installPath) out.installPath = newestCacheVersion(home);

  const candidates = [];
  if (out.installPath) candidates.push(out.installPath);
  candidates.push(join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'));
  for (const c of candidates) {
    if (existsSync(join(c, 'hooks', 'hooks.json')) && !out.roots.includes(c)) out.roots.push(c);
  }
  return out;
}

// Idempotently strip the ~1s login-shell PATH probe from a hooks.json, replacing
// the `$($SHELL -lc 'echo $PATH' 2>/dev/null)` subshell with an absolute,
// pre-resolved `<node-bin>:<bun-bin>` prefix. Returns commands rewritten (0 =
// already patched / pattern absent). Backs up the pristine upstream copy once.
function patchHooksJson(hooksJsonPath, replacement) {
  let raw;
  try { raw = readFileSync(hooksJsonPath, 'utf8'); } catch { return 0; }
  if (!raw.includes(PROBE_LITERAL)) return 0;            // already patched or format changed

  const bak = hooksJsonPath + '.prism-orig';
  try { if (!existsSync(bak)) writeFileSync(bak, raw); } catch {}

  let obj;
  try { obj = JSON.parse(raw); } catch { return 0; }     // unparseable → leave untouched

  let count = 0;
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string' && v.includes(PROBE_SUBSHELL)) {
          node[k] = v.split(PROBE_SUBSHELL).join(replacement);
          count++;
        } else { walk(v); }
      }
    }
  };
  walk(obj);
  if (count === 0) return 0;

  try { writeFileSync(hooksJsonPath, JSON.stringify(obj, null, 2) + '\n'); return count; }
  catch { return 0; }
}

// Persist CHOSEN_PORT into claude-mem's own settings.json so every claude-mem
// process (hooks, MCP server, worker) agrees on it and it survives plugin
// updates. Idempotent: only writes when absent or still on the ghost-prone
// default. Returns {port, changed}.
function ensureWorkerPort(home) {
  const path = join(home, ...CM_SETTINGS);
  let s = {};
  try { s = JSON.parse(readFileSync(path, 'utf8')) || {}; } catch {}
  const cur = parseInt(s.CLAUDE_MEM_WORKER_PORT, 10);
  if (Number.isInteger(cur) && cur > 0 && cur !== DEFAULT_PORT) return {port: cur, changed: false};
  s.CLAUDE_MEM_WORKER_PORT = String(CHOSEN_PORT);
  try { writeFileSync(path, JSON.stringify(s, null, 2) + '\n'); return {port: CHOSEN_PORT, changed: true}; }
  catch { return {port: cur || DEFAULT_PORT, changed: false}; }
}

// Read-only health probe (no side effects): any HTTP response = worker serving.
function workerHealthy(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const req = http.get({host: '127.0.0.1', port, path: '/health', timeout: timeoutMs}, (res) => { res.resume(); finish(true); });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

// ── main entry ──────────────────────────────────────────────────────────────
export async function healClaudeMem({home}) {
  const notices = [];
  if (process.env.PRISM_DISABLE_CLAUDE_MEM_GUARD === '1') return {notices};

  const cm = resolveClaudeMem(home);
  if (!cm.installPath || !cm.roots.length) return {notices};   // not installed → no-op

  // 1) Neutralize the per-tool-call login-shell PATH probe (effective next restart).
  const nodeDirPosix = winToPosix(dirname(process.execPath));
  const bunDirPosix = winToPosix(join(home, '.bun', 'bin'));
  const replacement = `${nodeDirPosix}:${bunDirPosix}`;
  let patched = 0;
  for (const root of cm.roots) {
    try { patched += patchHooksJson(join(root, 'hooks', 'hooks.json'), replacement); } catch {}
  }
  if (patched > 0) {
    notices.push(`PRISM: neutralized claude-mem's per-tool-call login-shell PATH probe in ${patched} hook command${patched === 1 ? '' : 's'} (~1s/call saved; effective next restart). Backup: hooks.json.prism-orig. Off: PRISM_DISABLE_CLAUDE_MEM_GUARD=1.`);
  }

  // 2) Move the worker off the ghost-prone default port (effective next restart).
  const {port, changed} = ensureWorkerPort(home);
  if (changed) {
    notices.push(`PRISM: pinned claude-mem worker to port ${port} in ~/.claude-mem/settings.json (off the Windows default ${DEFAULT_PORT}, which leaves an unkillable ghost socket on abnormal exit; effective next restart).`);
  }

  // 3) Read-only status note: if the worker is down on the configured port, say
  //    so. claude-mem's own SessionStart `start` hook launches it — we do not
  //    manage the process (see header). Only surfaced once the config is stable
  //    (no port change pending) to avoid noise on the heal session.
  if (!changed) {
    try {
      const healthy = await workerHealthy(port);
      if (!healthy) {
        notices.push(`PRISM: claude-mem worker not responding on :${port}; claude-mem will auto-start it. If memory stays unavailable, check ~/.claude-mem/logs and that Bun is installed.`);
      }
    } catch {}
  }

  return {notices};
}
