#!/usr/bin/env node
// hooks/lib/prism-oob-spawn.mjs
// RB-06 dedup — shared helpers for the `claude -p` OOB reviewer spawn used by
// both hooks/prism-phase-0d-oob.mjs and hooks/prism-phase-1-5-oob.mjs.
//
// RCA: both hooks independently defined a byte-identical resolveClaudeBin()
// and hardcoded their own reviewer spawnSync timeout. The D064 remedy-2 fix
// (50s -> 240s) landed only in phase-1-5, leaving phase-0d hardcoded at
// 90_000ms — the RB-06 defect (Phase 0d reviewer always timing out at 90s).
// Centralizing both here means a future timeout change can't skip a copy.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// H4: resolve the claude executable to an absolute path. On Windows, spawnSync
// without shell:true does not append PATHEXT (.cmd/.exe), so a bare 'claude'
// silently fails. Probe PATH for claude(.cmd|.exe). Falls back to 'claude'.
export function resolveClaudeBin() {
  if (process.env.PRISM_CLAUDE_BIN) return process.env.PRISM_CLAUDE_BIN;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const cand = join(dir, 'claude' + ext);
      try { if (existsSync(cand)) return cand; } catch {}
    }
  }
  return 'claude';
}

// D064 remedy 2: root-caused 2026-07-22. All 9 prior `reviewer-failed`
// ETIMEDOUT entries were `pending-written -> reviewer-failed` exactly
// ~50.2-50.3s apart (routing log), i.e. the spawn was killed AT the old
// 50_000ms ceiling, not stuck indefinitely. Manual reproduction of this exact
// spawnSync(claude, ['-p','--model',...]) call, same argv/env/stdio, against
// the real reviewer prompt + real orphaned pending payloads (5.8KB-27KB),
// completed successfully 3/3 times (exit 0, valid JSON verdict) in 80s, 100s,
// and 111s wall-clock — never hanging, always finishing, always well past
// 50s. 240_000ms gives >2x margin over the worst observed run; both callers
// reach this spawn only via a detached/unref'd async worker, so a longer
// ceiling costs nothing in master-session latency — it only bounds the
// background worker. See D064 remedy 2 for the full writeup.
export const OOB_REVIEWER_TIMEOUT_MS = 240_000;
