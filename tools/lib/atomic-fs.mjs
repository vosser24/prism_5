// tools/lib/atomic-fs.mjs
// Shared cross-process durability helper: bounded retry around the
// tmp-write + rename step of an atomic file write.
//
// THE PROBLEM: on Windows a concurrent antivirus scan, search indexer, or
// another PRISM process holding a handle on the destination path can make
// fs.renameSync throw EPERM/EACCES/EBUSY for a file that is otherwise fine —
// the OS just refused the atomic replace for a few milliseconds. A bare
// renameSync with no retry treats that transient condition as permanent:
// for callers with no fallback it aborts durable work already computed in
// memory (F33 — tools/prism-clean.mjs's writeMemoryMdAtomic lost an already-
// synthesized /prism-clean capture this way). For callers that DO have a
// "fall back to a direct non-atomic write" path, retrying first means they
// hit that degraded (briefly non-atomic) path far less often.
//
// This is the single canonical home for the retry loop. It was originally
// written and unit-tested inside tools/lib/prism-state.mjs (D083-era,
// covering only .prism-state.json); prism-state.mjs now re-exports this
// module's renameWithRetry unchanged so its existing imports/tests keep
// working without a second implementation to drift out of sync.
//
// Retry ONLY these three codes. Anything else (ENOSPC, ENOENT, EROFS, ...)
// is not a transient lock-contention symptom and must fail immediately —
// retrying it would just mask a real problem behind a few hundred ms of
// silence.
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isTransientRenameError(err) {
  return Boolean(err && TRANSIENT_CODES.has(err.code));
}

// renameFn is injected so tests can simulate failures without touching a
// real filesystem — call sites pass node:fs's renameSync.
//
// Defaults (retries=5, delayMs=25, linear backoff of delayMs*attempt across
// the 4 waited attempts: 25, 50, 75, 100ms — ~250ms worst case before the
// 5th and final try) match the precedent already shipped and tested for
// this exact Windows AV/indexer handle-contention class of error, which
// typically clears within tens of milliseconds. Kept identical everywhere
// in the repo so one retry policy governs one class of transient error.
export function renameWithRetry(renameFn, tmp, dst, { retries = 5, delayMs = 25 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { renameFn(tmp, dst); return; }
    catch (e) {
      if (!isTransientRenameError(e) || attempt >= retries) throw e;
      // Synchronous backoff — these call sites are sync hook-lifecycle code
      // and must not become async. Atomics.wait on a throwaway buffer blocks
      // this thread without an event-loop trip. If Atomics.wait is somehow
      // unavailable, we skip the wait and retry immediately: the bounded
      // attempt count still holds, so the worst case is a fast-failing retry
      // budget rather than a hang.
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt); }
      catch { /* no sync sleep available: retry immediately, bounded by `retries` */ }
    }
  }
}
