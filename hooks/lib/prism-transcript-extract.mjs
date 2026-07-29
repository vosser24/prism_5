#!/usr/bin/env node
// hooks/lib/prism-transcript-extract.mjs
// F7 Phase 3 follow-up — bound the OOB-reviewer transcript payload.
//
// RCA (proven by live smoke, not theory): the phase-0d reviewer fed
// readTranscriptTail(path, 600) — 600 RAW JSONL lines — straight into the
// `claude -p` reviewer prompt. On a real long, tool-heavy session each JSONL
// line is a full event (tool_use inputs, tool_result outputs, system-reminder
// noise), so 600 lines measured 1.2 MB (and 2.6 MB on a pathological session).
// `claude -p` then returns "Prompt is too long", exit 1 → the reviewer wrote
// severity:"ERROR", which SessionStart SURFACES — a cry-wolf on every long
// panel. Line count is a weak proxy for payload size (arch-review foresaw
// exactly this: "prefer last-K-assistant-turns over N raw lines").
//
// This module is the real fix: extract ONLY assistant-turn TEXT (the panel
// deliberation the reviewer actually grades), dropping tool_use inputs,
// tool_result outputs, thinking blocks, and system-reminder noise; keep the
// most-recent K turns; and hard-cap the result by BYTES as a backstop that
// makes an oversized prompt impossible regardless of extraction quality.
//
// Dep-free, fail-open: a parse failure NEVER throws — it falls back to a
// byte-capped raw tail so the reviewer still gets *something* bounded.

// Default backstop: 128 KB — comfortably under the model context window, and
// within the 100-150 KB band the fix spec called for. Env-overridable per
// caller (PRISM_PHASE_0D_MAX_INPUT_BYTES / PRISM_PHASE_1_5_MAX_INPUT_BYTES).
export const DEFAULT_MAX_INPUT_BYTES = 131072;

// Default deliberation window: the last K assistant turns. Modest by design —
// the reviewer grades the recent challenge/rebuttal exchange, not the whole
// session. The BYTE cap is the hard guarantee; K just shapes what survives.
export const DEFAULT_MAX_TURNS = 16;

// Resolve a byte cap from an env var, falling back to DEFAULT_MAX_INPUT_BYTES.
// A non-positive / non-numeric override is ignored (fail-safe to the default).
export function resolveMaxBytes(envName, fallback = DEFAULT_MAX_INPUT_BYTES) {
  const raw = envName && process.env[envName];
  if (raw != null && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

// Cap a string to at most `maxBytes` UTF-8 bytes, KEEPING THE TAIL (the most
// recent content — oldest-first truncation). If truncation happens, prepend a
// marker and trim a leading partial line so the result starts on a clean
// boundary (also repairs a codepoint split from slicing mid-character).
const TRUNCATION_MARKER = '[…transcript truncated (oldest-first) — most recent deliberation follows…]\n';

export function capBytesTail(str, maxBytes = DEFAULT_MAX_INPUT_BYTES) {
  if (typeof str !== 'string' || str.length === 0) return '';
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  // Reserve the marker's byte cost so the FINAL result (marker + tail) stays
  // within maxBytes. Degrade gracefully if maxBytes is smaller than the marker.
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf-8');
  const tailBudget = Math.max(0, maxBytes - markerBytes);
  let tail = buf.subarray(buf.length - tailBudget).toString('utf-8');
  // Drop a leading partial line (from slicing mid-line / mid-codepoint) when a
  // newline appears early, so we don't feed a mangled fragment to the reviewer.
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < 512) tail = tail.slice(nl + 1);
  return TRUNCATION_MARKER + tail;
}

// Parse a JSONL transcript window and return an array of assistant-turn TEXT
// strings (deliberation), oldest→newest. Handles BOTH transcript shapes:
//   • Real Claude Code:  { type:"assistant", message:{ content:[ {type:"text",
//     text:"…"}, {type:"tool_use", …}, {type:"thinking", …} ] } }  → text only
//   • Simple/test shape: { role:"assistant", text:"…" }  or
//     { type:"assistant", text:"…" }  or  { …, message:{ content:"…" } }
// Non-assistant lines (user turns, tool_result, system reminders) are skipped.
export function extractAssistantTurns(rawJsonl) {
  const out = [];
  if (typeof rawJsonl !== 'string' || !rawJsonl) return out;
  for (const line of rawJsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const role = o.type || o.role;
    if (role !== 'assistant') continue;
    const msg = o.message;
    if (msg && Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
      if (text) out.push(text);
      continue;
    }
    if (typeof o.text === 'string' && o.text.trim()) { out.push(o.text.trim()); continue; }
    if (msg && typeof msg.content === 'string' && msg.content.trim()) { out.push(msg.content.trim()); }
  }
  return out;
}

// The public entry point. Given a raw JSONL transcript window, return a bounded
// deliberation string suitable for a `claude -p` reviewer prompt:
//   1. Extract assistant-turn text, keep the last `maxTurns`.
//   2. Byte-cap the joined result at `maxBytes` (oldest-first truncation).
//   3. Fail-open: if extraction yields NOTHING (all tool/thinking/noise, or a
//      total parse failure), fall back to a byte-capped raw tail so the
//      reviewer still receives bounded context rather than an empty payload.
export function extractDeliberation(rawJsonl, opts = {}) {
  const maxTurns = Number.isInteger(opts.maxTurns) && opts.maxTurns > 0 ? opts.maxTurns : DEFAULT_MAX_TURNS;
  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_INPUT_BYTES;
  if (typeof rawJsonl !== 'string' || !rawJsonl.trim()) return '';
  let turns;
  try { turns = extractAssistantTurns(rawJsonl); } catch { turns = []; }
  if (turns.length === 0) {
    // Nothing gradable extracted — bound the raw tail instead of feeding 1.2 MB.
    return capBytesTail(rawJsonl, maxBytes);
  }
  const kept = turns.slice(-maxTurns);
  return capBytesTail(kept.join('\n\n'), maxBytes);
}
