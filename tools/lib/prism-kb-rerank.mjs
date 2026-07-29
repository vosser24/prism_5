// tools/lib/prism-kb-rerank.mjs
//
// Purpose: synchronous `claude -p` LLM re-rank wrapper for F4 cross-project
// knowledge recall. Given a BM25-ordered candidate list and a user query,
// sends the top-K (K≤20) body-free descriptors to `claude -p` via stdin
// and parses the returned id-order to re-rank the full list.
//
// Design constraints (F4 §7/§8):
//   - Dep-free: Node core only (child_process, fs, os, path).
//   - Subscription auth only: calls `claude -p` via spawnSync — NO Anthropic
//     SDK, NO ANTHROPIC_API_KEY. Mirrors the oob pattern from
//     hooks/prism-phase-1-5-oob.mjs.
//   - Prompt is delivered via stdin (spawnSync `input`), which has no argv-length
//     limit — so no tempfile is needed even for large prompts, and there is no
//     `claude` flag that reads a local file as the prompt.
//   - Hard 8s timeout (overridable via opts.timeoutMs or
//     PRISM_RECALL_RERANK_TIMEOUT_MS env); silent BM25 fallback on ANY error.
//   - INTENTIONALLY SYNCHRONOUS (spawnSync-based): the caller (prism-recall)
//     is a synchronous pipeline and async spawn would require re-architecting
//     the entire query path. More importantly, the existing test harness uses
//     fn(); pass++ without await — an async export would false-pass every
//     async assertion (feedback-async-blind-test-harness). The runner is
//     injectable for tests so no live CLI is ever required in tests.
//
// Ref: docs/prism/plans/2026-05-29-F4-design.md §7 + §8

import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { prismHome } from '../../hooks/lib/prism-home.mjs';

// ── exported constants ────────────────────────────────────────────────────────

export const DEFAULT_RERANK_TIMEOUT_MS = 8000;

// ── resolveClaudeBin ──────────────────────────────────────────────────────────
//
// Mirrors the resolveClaudeBin in hooks/prism-phase-1-5-oob.mjs exactly.
// Reimplemented locally (not imported from oob) because oob is a hook entry
// point with its own async main(), not a library — importing it would run
// side-effects. Returns null (not 'claude') when not found, so the caller
// can distinguish "binary present" from "binary absent".
//
// On Windows, spawnSync without shell:true does not append PATHEXT (.cmd/.exe),
// so a bare 'claude' would silently fail. We probe each PATH dir with each
// extension. Also checks ~/.local/bin (common Claude Code install location).

export function resolveClaudeBin() {
  if (process.env.PRISM_CLAUDE_BIN) return process.env.PRISM_CLAUDE_BIN;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const H = prismHome();
  const extraDirs = [join(H, '.local', 'bin')];
  const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':').concat(extraDirs);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, 'claude' + ext);
      try { if (existsSync(cand)) return cand; } catch {}
    }
  }
  return null;
}

// ── buildRerankPrompt ─────────────────────────────────────────────────────────
//
// Builds the stdin prompt sent to `claude -p`. Instructs the model to return
// ONLY a JSON array of candidate ids ordered most→least semantically relevant
// to the query. No prose.

export function buildRerankPrompt(query, candidates) {
  const candidatesJson = JSON.stringify(
    candidates.map(c => ({
      id: c.id,
      type: c.type,
      title: c.title,
      description: c.description,
      project_label: c.project_label,
      domain: c.domain,
    })),
    null,
    2
  );

  return [
    'You are a search-relevance re-ranker. Given a QUERY and a JSON array of CANDIDATES,',
    'return ONLY a JSON array of candidate ids ordered from most to least semantically',
    'relevant to the query. No prose, no markdown fences, no explanation — only the JSON array.',
    '',
    `QUERY: ${query}`,
    '',
    'CANDIDATES:',
    candidatesJson,
    '',
    'Return ONLY a JSON array of ids, e.g.: ["id3","id1","id2"]',
  ].join('\n');
}

// ── parseRerankResponse ───────────────────────────────────────────────────────
//
// Extracts the first [...] JSON array from stdout (tolerates surrounding prose).
// Reorders `candidates` by that id order; ids present in candidates but missing
// from the response are appended in their original order.
// Returns null if no JSON array can be parsed (=> caller falls back to BM25).

export function parseRerankResponse(stdout, candidates) {
  if (!stdout || typeof stdout !== 'string') return null;

  // Find the first '[' and its matching ']'
  const start = stdout.indexOf('[');
  if (start === -1) return null;
  const end = stdout.lastIndexOf(']');
  if (end < start) return null;

  let ids;
  try {
    ids = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!Array.isArray(ids)) return null;

  // Build a lookup of candidates by id
  const byId = new Map(candidates.map(c => [c.id, c]));

  // Reorder: first all ids from the response that are valid candidates
  const seen = new Set();
  const ordered = [];
  for (const id of ids) {
    if (byId.has(id) && !seen.has(id)) {
      ordered.push(byId.get(id));
      seen.add(id);
    }
  }

  // Append any candidates not mentioned in the response (BM25 order preserved)
  for (const c of candidates) {
    if (!seen.has(c.id)) {
      ordered.push(c);
    }
  }

  return ordered;
}

// ── defaultRunner ─────────────────────────────────────────────────────────────
//
// Invokes `claude -p` via spawnSync, delivering the prompt over stdin (the same
// channel hooks/prism-phase-1-5-oob.mjs uses). stdin has no argv-length limit, so
// large prompts need no tempfile — and `claude` has no flag that reads a local
// file as the prompt (`--file` is for downloadable resource specs, not prompt IO).
// Returns { stdout, code, timedOut, error }.

function defaultRunner(claudeBin, env) {
  return function runClaude({ prompt, timeoutMs }) {
    const res = spawnSync(claudeBin, ['-p'], {
      input: prompt,
      encoding: 'utf-8',
      timeout: timeoutMs,
      env,
      windowsHide: true,
    });

    // A timeout kill surfaces as signal 'SIGTERM' on POSIX, but on Windows it
    // commonly arrives as an error with code 'ETIMEDOUT'; treat either as a
    // timeout so the user-facing label is 'timeout', not the vaguer 'error'.
    const timedOut = res.signal === 'SIGTERM' || (res.error && res.error.code === 'ETIMEDOUT');
    return {
      stdout: res.stdout || '',
      code: res.status,
      timedOut,
      error: res.error || null,
    };
  };
}

// ── rerank ────────────────────────────────────────────────────────────────────
//
// Main entry point. Never throws. On ANY skip/failure, returns candidates UNCHANGED.
//
// opts:
//   runner({prompt, timeoutMs}) -> {stdout, code, timedOut, error}  (injectable; default uses spawnSync)
//   timeoutMs       number   explicit timeout (default: DEFAULT_RERANK_TIMEOUT_MS, or env override)
//   rerank          boolean  set false to disable entirely (default: true)
//   claudeBin       string|null|undefined  override binary path (undefined = auto-resolve)
//   env             object   environment for disable-flag checks + timeout env (default: process.env)
//
// Returns { results: Array, reranked: boolean, reason: string }

export function rerank(query, candidates, opts = {}) {
  const FALLBACK = (reason) => ({ results: candidates, reranked: false, reason });

  try {
    const env = opts.env !== undefined ? opts.env : process.env;

    // 1. Disabled via opts.rerank === false
    if (opts.rerank === false) return FALLBACK('disabled');

    // 2. Disabled via env PRISM_RECALL_RERANK === 'off'
    if (env.PRISM_RECALL_RERANK === 'off') return FALLBACK('disabled');

    // 3. Trivial: 0 or 1 candidates
    if (!candidates || candidates.length <= 1) return FALLBACK('trivial');

    // 4. Resolve claude binary
    //    opts.claudeBin === null   => explicit "no CLI" (e.g. tests)
    //    opts.claudeBin === undefined => auto-resolve
    //    opts.claudeBin === string  => use as-is
    let bin;
    if (opts.claudeBin !== undefined) {
      bin = opts.claudeBin;
    } else {
      bin = resolveClaudeBin();
    }
    if (!bin) return FALLBACK('no-cli');

    // 5. Resolve timeoutMs: explicit opts.timeoutMs > env override > default
    let timeoutMs = DEFAULT_RERANK_TIMEOUT_MS;
    if (typeof opts.timeoutMs === 'number') {
      timeoutMs = opts.timeoutMs;
    } else if (env.PRISM_RECALL_RERANK_TIMEOUT_MS) {
      const parsed = parseInt(env.PRISM_RECALL_RERANK_TIMEOUT_MS, 10);
      if (!isNaN(parsed)) timeoutMs = parsed;
    }

    // 6. Cap input to top-K (K <= 20); hold the tail for later
    const K = 20;
    const topK = candidates.slice(0, K);
    const tail = candidates.slice(K);

    // 7. Build prompt from the top-K slice
    const prompt = buildRerankPrompt(query, topK);

    // 8. Run (via injected runner or default spawnSync runner)
    const runner = opts.runner || defaultRunner(bin, env);
    let res;
    try {
      res = runner({ prompt, timeoutMs });
    } catch (e) {
      return FALLBACK('error');
    }

    // 9. Evaluate result
    if (res.timedOut) return FALLBACK('timeout');
    if (res.error || res.code !== 0) return FALLBACK('error');

    // 10. Parse re-rank response
    const reorderedTopK = parseRerankResponse(res.stdout, topK);
    if (!reorderedTopK) return FALLBACK('parse-fail');

    // 11. Return re-ordered top-K + tail in original BM25 order
    return { results: reorderedTopK.concat(tail), reranked: true, reason: 'ok' };

  } catch {
    // Belt-and-suspenders: rerank must never throw
    return FALLBACK('error');
  }
}
