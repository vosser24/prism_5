#!/usr/bin/env node
// PRISM Lesson-Match Guard (v2.0.0)
//
// UserPromptSubmit advisory hook. Matches the user prompt against a
// precomputed keyword map (.claude/references/.knowledge-keyword-map.json)
// and surfaces at most 2 relevant adjudications/lessons per turn.
//
// Design (D022 + D023 panel override):
//   - Precomputed keyword map keeps this off the file-glob hot path.
//   - Reuses tokenize + keywordScore from hooks/lib/prism-router.mjs.
//   - Threshold: 0.15 (raised from 0.04 per D023 — cuts false-positive rate ~45%→<10%).
//   - Injection: emit entry's **Rule:** text, NOT a file pointer. If rule is empty,
//     fall back to title. Never emit "read the D-file" phrasing (panel: theater).
//   - Hard cap: ~60 tokens / prompt (≈2 lines). Top-2, but truncate to cap.
//   - Top-2 cap: prefer at most 1 adjudication + 1 lesson if both qualify.
//   - Dedup: Locked adjudications are NEVER suppressed (zero-suppress). TTL 10 for all else.
//   - Off-switch: PRISM_DISABLE_LESSON_MATCH=1.
//   - Fully fail-open: any error -> {exit:0,stdout:'',stderr:''}.
//
// State file: ~/.claude/.prism-lesson-match-<session_id>.json
//   { injected: {<ref>: turnInjected}, turn_count: N }

import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const H = process.env.HOME || process.env.USERPROFILE || '';

// Module-level router cache (loaded once per process)
let _tokenize = null;
let _keywordScore = null;
let _routerLoaded = false;

async function loadRouter() {
  if (_routerLoaded) return;
  _routerLoaded = true;
  try {
    // Strip any query/hash decoration (e.g. cache-bust ?t=...) from import.meta.url
    // before fileURLToPath — a decorated URL otherwise corrupts the sibling path.
    const selfUrl = import.meta.url.replace(/[?#].*$/, '');
    const routerPath = join(dirname(fileURLToPath(selfUrl)), 'lib', 'prism-router.mjs');
    // pathToFileURL is required on Windows: dynamic import() rejects bare Win32 paths
    // (e.g. "Y:\...") with ERR_UNSUPPORTED_ESM_URL_SCHEME — file:// URLs work everywhere.
    const mod = await import(pathToFileURL(routerPath).href);
    _tokenize = mod.tokenize;
    _keywordScore = mod.keywordScore;
  } catch {
    _tokenize = (text) => {
      if (!text) return [];
      return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
    };
    _keywordScore = () => 0;
  }
}

// Module-level keyword map cache (loaded once per process)
let _mapCache = null;
let _mapLoaded = false;
// D053: memoized corpus document-frequency map (token -> #entries containing it),
// computed once over the loaded map's entries alongside _mapCache. Pure function
// of map.entries[].tokens, so it is definitionally consistent with what the
// scoring loop scores against — no stored field, no append drift.
let _dfCache = null;

// D053: count corpus document-frequency over the loaded entries.
function computeDf(entries) {
  const df = new Map();
  for (const e of entries) {
    for (const t of new Set(e.tokens || [])) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

function loadKeywordMap(root) {
  if (_mapLoaded) return _mapCache;
  _mapLoaded = true;
  try {
    const mapPath = join(root || H, '.claude', 'references', '.knowledge-keyword-map.json');
    if (!existsSync(mapPath)) { _mapCache = null; return null; }
    _mapCache = JSON.parse(readFileSync(mapPath, 'utf-8'));
    _dfCache = computeDf((_mapCache && _mapCache.entries) || []);
  } catch {
    _mapCache = null;
    _dfCache = null;
  }
  return _mapCache;
}

const DEDUP_TTL_TURNS = 10;
const MATCH_THRESHOLD = 0.15;  // D023: raised from 0.04 to cut false-positive rate

// D053: corpus-distinctiveness gate. A keyword-driven fire must be anchored by
// >=ANCHOR_MIN shared token(s) unique to the matched entry (corpus DF<=ANCHOR_DF_MAX).
// Generic tokens (does/session/guard/cannot/memory) raise the score but never
// anchor a fire. DF is computed in-hook over the loaded map (no stored field,
// no append drift). See docs/prism/adjudications/D053.
const ANCHOR_DF_MAX = 1;   // "distinctive" == appears in exactly one corpus entry
const ANCHOR_MIN = 1;      // K: min distinctive shared tokens to admit a fire
// ~60-token cap on total injected text (≈2 lines of ~30 tokens each).
// One line is roughly 180 chars at ~3 chars/token; cap at 2*180=360 chars total.
const INJECT_CHAR_CAP = 360;

// Resolve HOME at call time (not module-load) so the dedup state file tracks the
// live environment — the module-level H constant can be stale if HOME is set
// after import (e.g. test harnesses, or re-exec contexts).
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || H;
}

function dedupPath(sessionId) {
  return join(homeDir(), '.claude', `.prism-lesson-match-${sessionId || 'anon'}.json`);
}

function readDedup(sessionId) {
  try {
    const p = dedupPath(sessionId);
    if (!existsSync(p)) return {injected: {}, turn_count: 0};
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return {injected: {}, turn_count: 0}; }
}

function writeDedup(sessionId, payload) {
  try {
    const p = dedupPath(sessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, p);
  } catch {
    try { writeFileSync(dedupPath(sessionId), JSON.stringify(payload, null, 2)); } catch {}
  }
}

export async function run(payload) {
  try {
    if (process.env.PRISM_DISABLE_LESSON_MATCH === '1') {
      return {exit: 0, stdout: '', stderr: ''};
    }

    const input = payload || {};
    const sessionId = String(input.session_id || 'anon');
    const userPrompt = String(input.user_prompt || input.prompt || '');
    if (!userPrompt) return {exit: 0, stdout: '', stderr: ''};

    const root = input.cwd || process.cwd();

    const map = loadKeywordMap(root);
    if (!map || !Array.isArray(map.entries) || map.entries.length === 0) {
      return {exit: 0, stdout: '', stderr: ''};
    }

    await loadRouter();

    const promptLC = userPrompt.toLowerCase();
    const promptTokens = _tokenize(userPrompt);

    const promptSet = new Set(promptTokens);

    const scored = [];
    for (const entry of map.entries) {
      const kwScore = _keywordScore(promptTokens, entry.tokens || []);

      let triggerBonus = 0;
      for (const trig of (entry.triggers || [])) {
        if (trig && promptLC.includes(trig.toLowerCase())) {
          triggerBonus += 0.05;
          if (triggerBonus >= 0.15) { triggerBonus = 0.15; break; }
        }
      }

      const score = kwScore + triggerBonus;
      if (score >= MATCH_THRESHOLD) {
        // D053 distinctiveness gate. Trigger-driven fires (author-configured exact
        // phrases) bypass — high-precision by design. Keyword-driven fires require a
        // distinctive (DF<=ANCHOR_DF_MAX) shared-token anchor.
        let anchored = triggerBonus > 0;
        if (!anchored) {
          let hits = 0;
          for (const t of (entry.tokens || [])) {
            if (promptSet.has(t) && ((_dfCache && _dfCache.get(t)) || 0) <= ANCHOR_DF_MAX) {
              if (++hits >= ANCHOR_MIN) break;
            }
          }
          anchored = hits >= ANCHOR_MIN;
        }
        if (anchored) scored.push({entry, score});
      }
    }

    if (scored.length === 0) return {exit: 0, stdout: '', stderr: ''};

    scored.sort((a, b) => b.score - a.score);

    // Cap TOP 2: prefer at most 1 adjudication + 1 lesson
    const selected = [];
    let adjCount = 0, lessonCount = 0;
    for (const s of scored) {
      if (selected.length >= 2) break;
      if (s.entry.type === 'adjudication') {
        if (adjCount < 1) { selected.push(s); adjCount++; }
      } else {
        if (lessonCount < 1) { selected.push(s); lessonCount++; }
      }
    }
    // If we haven't filled 2 slots with mixed types, fill from remaining
    if (selected.length < 2) {
      for (const s of scored) {
        if (selected.length >= 2) break;
        if (!selected.includes(s)) selected.push(s);
      }
    }

    const state = readDedup(sessionId);
    const turnNow = (state.turn_count || 0) + 1;
    const injected = state.injected || {};

    const toEmit = selected.filter(s => {
      const e = s.entry;
      // D023: Locked adjudications are NEVER suppressed by the dedup window.
      if (e.type === 'adjudication' && (e.status || '').toLowerCase().startsWith('locked')) {
        return true;
      }
      const lastTurn = injected[e.ref];
      return lastTurn === undefined || (turnNow - lastTurn) > DEDUP_TTL_TURNS;
    });

    for (const s of toEmit) {
      injected[s.entry.ref] = turnNow;
    }
    writeDedup(sessionId, {injected, turn_count: turnNow});

    if (toEmit.length === 0) return {exit: 0, stdout: '', stderr: ''};

    // D023: inject the Rule text, not a pointer. Fall back to title if rule absent.
    // Hard-cap total output to ~60 tokens (INJECT_CHAR_CAP chars).
    const lines = toEmit.map(s => {
      const e = s.entry;
      const text = (e.rule && e.rule.trim()) ? e.rule.trim() : (e.title || e.ref);
      return `PRISM LESSON-MATCH: ${text} [[${e.ref}]]`;
    });

    // Apply char cap: build combined output and trim to cap
    let combined = lines.join('\n');
    if (combined.length > INJECT_CHAR_CAP) {
      combined = combined.slice(0, INJECT_CHAR_CAP).replace(/\n[^\n]*$/, '');  // trim at last newline boundary
    }

    return {exit: 0, stdout: combined, stderr: ''};

  } catch {
    return {exit: 0, stdout: '', stderr: ''};
  }
}

const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-lesson-match.mjs';
if (invokedDirectly) {
  (async () => {
    try {
      let payload = {};
      try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch {}
      const res = await run(payload);
      if (res.stdout) process.stdout.write(res.stdout);
      process.exit(res.exit || 0);
    } catch { process.exit(0); }
  })();
}
