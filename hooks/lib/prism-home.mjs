// hooks/lib/prism-home.mjs
// Validating home-directory resolver for PRISM hooks (v5.6.x).
//
// THE BUG THIS FIXES: some Windows hook-execution contexts hand the process an
// environment where USERPROFILE (or HOME) is the literal STRING "undefined".
// Because "undefined" is truthy, the long-standing idiom
//     const H = process.env.HOME || process.env.USERPROFILE;
// returned it verbatim, and `join(H, '.claude', '.prism-routing.jsonl')` then
// produced the relative path `undefined/.claude/.prism-routing.jsonl` — a stray
// artifact committed into the repo root (cleaned in 6a2e1f6, gitignored in
// 6c92aa5). os.homedir() is NOT a safe substitute on its own: on Windows it
// also consults USERPROFILE, so it can return "undefined" too.
//
// prismHome() walks HOME → USERPROFILE → os.homedir() → HOMEDRIVE+HOMEPATH →
// os.tmpdir(), returning the FIRST candidate that is a non-garbage, existing
// directory. It can never return "" / "undefined" / "null" / a missing path,
// so home-derived writes always land somewhere real (degrading to tmpdir in a
// genuinely broken environment rather than scribbling a relative `undefined/`).
//
// Call it at USE time (not captured once at module load) where in-process test
// isolation matters — re-reading the env each call keeps it cheap (one or two
// existsSync stats) and lets tests flip HOME between calls.

import {existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';

const GARBAGE = new Set(['', 'undefined', 'null', 'none']);

function isUsable(p) {
  if (!p || typeof p !== 'string') return false;
  if (GARBAGE.has(p.trim().toLowerCase())) return false;
  try { return existsSync(p); } catch { return false; }
}

export function prismHome() {
  if (isUsable(process.env.HOME)) return process.env.HOME;
  if (isUsable(process.env.USERPROFILE)) return process.env.USERPROFILE;
  let hd;
  try { hd = homedir(); } catch { /* ignore */ }
  if (isUsable(hd)) return hd;
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    const win = process.env.HOMEDRIVE + process.env.HOMEPATH;
    if (isUsable(win)) return win;
  }
  return tmpdir();
}
