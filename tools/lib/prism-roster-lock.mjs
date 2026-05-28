// tools/lib/prism-roster-lock.mjs
// v4.5 Layer 2 — O2 cross-platform roster.json read-modify-write lock.
// Uses exclusive-create lock file (works on Windows + POSIX). 30s timeout +
// stale detection. NOT a true OS flock; designed for the read-modify-write
// race that occurs when parallel master-<slug> sessions write the same
// roster.json from PRISM hooks.

import { writeFileSync, unlinkSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';

const LOCK_TIMEOUT_MS = 30_000;
const STALE_LOCK_THRESHOLD_MS = 60_000;
const POLL_INTERVAL_MS = 100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tryAcquire(lockPath, ownerInfo) {
  try {
    // 'wx' = exclusive create; throws EEXIST if file exists
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    writeFileSync(lockPath, JSON.stringify(ownerInfo));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function isStale(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (!raw.created_at) return true;
    return Date.now() - new Date(raw.created_at).getTime() > STALE_LOCK_THRESHOLD_MS;
  } catch { return true; }
}

function releaseStale(lockPath) {
  try { unlinkSync(lockPath); } catch { /* race with another reaper, fine */ }
}

/**
 * Acquire the roster lock, run `fn`, then release. `fn` may be async.
 * @param {string} rosterPath - path to roster.json
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withRosterLock(rosterPath, fn) {
  const lockPath = rosterPath + '.lock';
  const ownerInfo = {
    pid: process.pid,
    created_at: new Date().toISOString(),
    process_argv: process.argv.slice(0, 3).join(' '),
  };
  const startedAt = Date.now();
  let acquired = false;
  let warnedSkip = false;

  while (!acquired) {
    if (tryAcquire(lockPath, ownerInfo)) { acquired = true; break; }
    if (isStale(lockPath)) {
      process.stderr.write(`[roster-lock] stale lock detected at ${lockPath}; releasing\n`);
      releaseStale(lockPath);
      continue;
    }
    if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
      if (!warnedSkip) {
        process.stderr.write(`[roster-lock] WARNING: timeout after ${LOCK_TIMEOUT_MS}ms; proceeding without lock (race possible)\n`);
        warnedSkip = true;
      }
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  try {
    return await fn();
  } finally {
    if (acquired) { try { unlinkSync(lockPath); } catch { /* swallow */ } }
  }
}
