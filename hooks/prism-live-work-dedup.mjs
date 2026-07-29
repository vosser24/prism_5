#!/usr/bin/env node
// PRISM Live-Work Dedup (v1.0.0) — PreToolUse:Agent + PreToolUse:SendMessage
//
// PROBLEM (2026-07-14 incident, docs/prism/2026-07-14-dispatch-dedup-diagnosis.md):
// the exact-signature dedup guard compares a new dispatch only against each live
// agent's ORIGINAL spawn-time text. When a live agent's scope is EXPANDED via
// SendMessage ("also measure X"), a later independent dispatch of that same X is
// invisible to the exact-hash fence — two agents answer one question. Task #17
// made SendMessage visible to PreToolUse; this guard closes the loop:
//
//   • PreToolUse:SendMessage → a scope-assigning message TO a live agent appends
//     a taskText record to the live-agents ledger (hooks/lib/prism-live-agents.mjs)
//     under the recipient's id. Chatter/status pings are ignored (conservative
//     deterministic heuristic — every doubt resolves to no-record).
//   • PreToolUse:Agent → the FRESH dispatch's description+prompt keywords are
//     compared (deterministic keyword/topic overlap — keywordsOf/taskOverlap,
//     NO fuzzy/semantic/embeddings, per the diagnosis's rejected-option) against
//     the ACCUMULATED task summaries of every LIVE agent. Likely-duplicate live
//     work → ADVISORY additionalContext, exit 0. Then the fresh dispatch's own
//     task is recorded under its agent id.
//
// ADVISORY-ONLY BY DESIGN (soft-first, D-diagnosis recommendation): a topical-
// overlap match is probabilistic; a hard deny here would be the next guard that
// cries wolf. NO deny path exists in this file. Promote to hard only on
// measured false-positive evidence, as a separate change.
//
// THRESHOLDS (deterministic constants, documented): advise when the fresh
// dispatch shares ≥4 meaningful keywords with a live agent's summary AND the
// overlap coefficient (|∩|/min set size) is ≥0.30 AND that coefficient exceeds
// the fresh dispatch's median coefficient against the persisted dispatch
// corpus by ≥0.35 (F36 excess-over-background; F41 corpus). One rule, no
// small-sample branch — see the F41 block below.
//
// FAIL-OPEN: every path swallows errors → exit 0, no output.
//
// Kill-switch: PRISM_LIVE_WORK_DEDUP=off (default on). Read per call.

import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';
import {
  appendTaskSummary, collectLiveWork, keywordsOf, taskOverlap,
} from './lib/prism-live-agents.mjs';
// Read-only reuse of the SAME `PRISM-LEASE: agent=<id> files=<paths>` parser
// hooks/prism-file-lease-guard.mjs already ships (F25 fix, task #37) — no new
// ledger, no shared state: this hook re-parses the lease line straight out of
// the dispatch text it already has in hand (freshText / a live agent's
// accumulated taskText), the same text prism-file-lease-guard.mjs itself scans.
import { parseLeases } from './prism-file-lease-guard.mjs';

const MIN_SHARED = 4;
const MIN_COEFF = 0.30;

// ─── F36 fix (task #53) — EXCESS-OVER-BACKGROUND ─────────────────────────────
// The #37 fix below (EXTRA_STOPWORDS) generalises only to the vocabulary of ONE
// prior incident: it is a hand-picked denylist, so the NEXT batch of dispatches
// simply fires on a different set of house words. Measured 2026-07-28 (session
// 7c96a3ea): two advisories whose ENTIRE shared-token evidence was boilerplate
// that appears in no denylist — `check/content/date/docs/filename/look/memory/
// recent` (36%) and `adjudications/alone/below/brief/capture/commands/
// conventions/d087` (32%, against `team-lead` — the CHAIR, i.e. advising the
// orchestrator to delegate to itself).
//
// ROOT CAUSE: every PRISM dispatch carries the same auto-appended clause blocks
// and house vocabulary, so ANY two dispatches share a large common vocabulary
// BY CONSTRUCTION. An ABSOLUTE similarity bar therefore measures "is this a
// PRISM dispatch", not "is this the same work". Compounding it, the overlap
// coefficient divides by min(|A|,|B|): a 200-token brief covers ~a third of any
// 25-token brief's vocabulary by sheer size alone (FP1 was 197 vs 25 tokens).
//
// FIX: score each candidate RELATIVE to the background the same fresh dispatch
// scores against every OTHER live agent. Duplicate work stands out from its
// own batch; house vocabulary does not, because it lifts every pair equally.
// This is self-calibrating — it needs no vocabulary list and adapts to any
// project's house prose, which is exactly what the denylist could not do.
//
// MEASURED on the two real false positives + two real true positives (the
// verbatim dispatch texts, replayed through this hook — see
// tests/v3/hooks/test-prism-live-work-dedup-background.mjs):
//     FP1 obs 0.360, background median 0.132 -> excess 0.228  (quiet)
//     FP2 obs 0.318, background median 0.311 -> excess 0.007  (quiet)
//     TP-A obs 1.000, background median 0.226 -> excess 0.774 (FIRES)
//     TP-B obs 1.000, background median 0.152 -> excess 0.848 (FIRES)
// Separation gap 0.228 -> 0.774; MIN_EXCESS sits at 0.30 with margin on both
// sides. Rejected alternatives, both measured, both worse:
//   • Jaccard |A∩B|/|A∪B| — kills both FPs (0.042 / 0.118) but ALSO kills
//     TP-B (0.181): a short re-dispatch of a long brief is a genuine duplicate
//     that a union denominator cannot see.
//   • IDF-weighted coefficient — FP1 still FIRES (0.319). Per-token rarity
//     cannot fix a denominator problem.
//   • Subtracting the machine-appended `[PRISM ...]` clause blocks — measured
//     ZERO effect on both FPs (0.360/0.318 unchanged): the offending tokens
//     come from hand-written brief prose, not the appended footer.
//
// ─── F41 fix (task #58) — the background is now a PERSISTED CORPUS ──────────
// F36 (above) drew its background from the OTHER LIVE AGENTS in the same batch.
// That sample is frequently too small to compute a median from, and the
// original code handled that by forcing baseline = 0. With baseline === 0,
// excess === coefficient IDENTICALLY, so `excess >= MIN_EXCESS` was logically
// IMPLIED by `coefficient >= MIN_COEFF` whenever the two constants were equal
// (both were 0.30) — a strict no-op, not merely a weakened guard. Confirmed in
// production: `kw_suppressed` (below) summed to 0 across 19 post-F36 records
// with zero non-zero entries, i.e. the conjunct never once changed an outcome.
//
// Two things made that degenerate path COMMON rather than a rare edge:
//   1. the background excluded the candidate itself, so a non-zero baseline
//      needed 3+ scored live peers, not 2;
//   2. a lease-resolved pair `continue`s before ever being scored (see the
//      lease block below), so GOOD lease discipline SHRANK the very pool the
//      baseline was estimated from — a perverse incentive.
//
// FIX: stop estimating the background from the live batch at all. Every
// dispatch and every scope-assigning SendMessage ALREADY appends a `taskText`
// record to the session ledger (hooks/lib/prism-live-agents.mjs), and those
// ledgers are never pruned — so a large, real, self-seeding corpus of past
// dispatch prose is already on disk. `collectLiveWork` merely FILTERS it to
// currently-live agents at read time; the records themselves persist. Measured
// on this machine 2026-07-28: 176 ledger files, 1091 taskText records, 390
// (session, agent) documents, 163 sessions. Nothing new is persisted by this
// fix — it reads state the ledger already wrote.
//
// Both of the defects above dissolve rather than being tuned around:
//   • the baseline no longer depends on how many peers happen to be live, so
//     the small-sample path — and the whole `haveBaseline` branch, and its
//     interim MIN_COEFF_NO_BASELINE constant — is GONE, not retuned;
//   • the baseline no longer depends on kwScored, so lease discipline no
//     longer shrinks it. The perverse incentive is removed.
//   • the F36 "KNOWN LIMITATION" (a wholly-duplicated batch raises its own
//     background until nothing fires) is also removed: one batch is a few
//     documents against a corpus of hundreds, so it cannot move the median.
//
// MEASURED against the corpus, replaying the verbatim fixtures in
// tests/v3/hooks/test-prism-live-work-dedup-background.mjs (real ~/.claude
// corpus, n≈390 docs / temp-HOME corpus the test itself builds):
//     FP1  obs 0.360, baseline 0.143 -> excess 0.217 / 0.228  (quiet)
//     FP2  obs 0.318, baseline 0.217 -> excess 0.100 / 0.007  (quiet)
//     TP-A obs 1.000, baseline 0.158 -> excess 0.842 / 0.766  (FIRES)
//     TP-B obs 1.000, baseline 0.146 -> excess 0.854 / 0.848  (FIRES)
//     DEGENERACY (ONE live agent, genuine duplicate) obs 1.000, baseline
//          0.158 -> excess 0.842 (FIRES) — this case previously existed ONLY
//          because of the special-cased branch; it now fires from a measured
//          389-document background like every other case.
//
// WHY MIN_EXCESS MOVED 0.30 -> 0.35. A corpus cannot make a baseline of 0
// unreachable: a dispatch whose vocabulary resembles nothing in the corpus
// legitimately MEASURES 0 (the F41 regression fixture below is exactly that).
// The difference is that 0 is now a measurement rather than a stand-in for
// "unknown" — but the arithmetic identity `excess === coefficient at baseline
// 0` is a property of the CONSTANTS, not of the sample, so MIN_EXCESS must
// differ from MIN_COEFF or the conjunct stays inert in that case. 0.35 is the
// smallest value that clears the highest measured false positive (the F41
// fixture's 0.308) with margin. Unlike the interim 0.60 no-baseline bar it
// replaces, this interval is SAMPLED, not guessed: over all 578 real corpus
// pairs scoring in 0.40-0.90, raising 0.30 -> 0.35 costs 47 of 274 firings
// (17%), whereas the interim 0.60 bar dropped 165 of them in the regime where
// it applied. One bar, applied identically in every case.
const MIN_EXCESS = 0.35;

// Ledger files scanned to build the corpus, newest-mtime first. A bound is
// required because this runs on EVERY dispatch: the read+tokenize of all 176
// files on this machine measured 76-89ms. Newest-first keeps the corpus
// tracking the project's CURRENT house vocabulary, which is the thing the
// baseline is supposed to cancel.
const CORPUS_MAX_FILES = 64;
const LEDGER_FILE_RE = /^\.prism-live-agents-.*\.jsonl$/;
const CORPUS_TEXTS_PER_AGENT = 5; // mirrors TASK_TEXTS_PER_AGENT in the ledger lib

// Median of a numeric array (deterministic; [] -> 0). Median, not mean, so one
// genuinely-duplicated pair in the batch cannot drag the whole baseline up.
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Read the persisted dispatch corpus: every (session, agentId) document across
// the CORPUS_MAX_FILES most recently written live-agent ledgers, as a joined
// taskText string. Returns [{ id, text }] — the SAME document shape the live
// comparison uses (info.texts.join(' ')), so a corpus score and a candidate
// score are directly comparable, which is the whole point of an excess bar.
//
// Deliberately parsed here rather than via prism-live-agents.mjs: that module's
// reader (collectLiveWork) filters to CURRENTLY-LIVE agents, which is exactly
// the filter that made the background too small to estimate from. This wants
// the unfiltered history. Fails soft to [] on any I/O or parse error — callers
// treat an empty corpus as a measured (and LOGGED, see kw_corpus_docs) zero
// baseline, never as a silent fallback to a different rule.
export function readDispatchCorpus(home) {
  const out = [];
  try {
    const dir = join(home, '.claude');
    let names;
    try { names = readdirSync(dir); } catch { return out; }
    const files = [];
    for (const n of names) {
      if (!LEDGER_FILE_RE.test(n)) continue;
      let mtime = 0;
      try { mtime = statSync(join(dir, n)).mtimeMs; } catch { /* keep at 0 */ }
      files.push({ n, mtime });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const { n } of files.slice(0, CORPUS_MAX_FILES)) {
      let text;
      try { text = readFileSync(join(dir, n), 'utf-8'); } catch { continue; }
      const byId = new Map();
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let rec;
        try { rec = JSON.parse(s); } catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        if (typeof rec.taskText !== 'string' || !rec.taskText) continue;
        const id = typeof rec.agentId === 'string' ? rec.agentId.trim() : '';
        if (!id) continue;
        const a = byId.get(id) || [];
        a.push(rec.taskText);
        if (a.length > CORPUS_TEXTS_PER_AGENT) a.shift();
        byId.set(id, a);
      }
      for (const [id, texts] of byId) out.push({ id, text: texts.join(' ') });
    }
  } catch { /* fail-open: empty corpus, logged as kw_corpus_docs: 0 */ }
  return out;
}

// ─── F25 fix (task #37) — bag-of-words over the WHOLE prompt matches on ──────
// repo-state/dispatch-template BOILERPLATE, not work identity. Observed live:
// four disjoint-file-ownership dispatches scored 43-62% "overlap" on shared
// tokens `4e8e2f8f5` (a git SHA — present because every brief states the HEAD
// it applies to), `branch`, `clean`, `head`, `audit`, `edit`, `existing`,
// `defect`, `four`, `full`, `count`, `genuine`, `confirmed`, `bash` — none of
// which describe what either dispatch actually does. The shared
// TASK_STOPWORDS list in prism-live-agents.mjs (session/agent/prism/claude/
// file/tool/dispatch/...) does not cover this vocabulary because it targets
// generic PRISM/dispatch nouns, not this project's specific brief-template
// prose. Kept LOCAL to this file (not added to the shared TASK_STOPWORDS) —
// this is dedup-specific noise, not a claim that these words are never
// meaningful project-wide.
const EXTRA_STOPWORDS = new Set([
  // The exact "branch main, clean tree, HEAD <sha>" repo-status clause every
  // brief in this session opens with — one boilerplate unit, filtered whole.
  'branch', 'main', 'clean', 'tree', 'head',
  // The rest of the reported shared-topics list verbatim.
  'audit', 'edit', 'existing', 'defect', 'four', 'full', 'count', 'genuine',
  'confirmed', 'bash',
  // Dispatch-batch scaffolding ("N workers dispatched this batch" — 'worker'
  // singular is already in the shared TASK_STOPWORDS; 'workers'/'batch' close
  // the plural/adjacent-noun gap for this project's specific brief template).
  'workers', 'batch',
  'commit', 'commits', 'push', 'installer', 'install', 'deploy', 'deployed',
  'windows',
]);
// A git-SHA-shaped token (7-40 lowercase hex chars, must contain both a digit
// AND a letter so a genuine word like "face" or "dead" isn't caught) — repo-
// state preambles ("HEAD 4e8e2f8f5", "commit a0d7eefea") make a bare SHA look
// like a shared "topic" even though it identifies no work content at all.
const SHA_LIKE_RE = /^(?=.*[0-9])(?=.*[a-f])[0-9a-f]{7,40}$/;

function filterBoilerplate(kwSet) {
  const out = new Set();
  for (const t of kwSet) {
    if (EXTRA_STOPWORDS.has(t)) continue;
    if (SHA_LIKE_RE.test(t)) continue;
    out.add(t);
  }
  return out;
}

// Every distinct file path a text's PRISM-LEASE line(s) declare, normalized
// exactly like prism-file-lease-guard.mjs (case-insensitive, no leading ./,
// forward slashes) via that same parseLeases() — so a lease-file match here
// means the SAME thing it means to the lease guard.
function leaseFilesOf(text) {
  const files = new Set();
  for (const { files: fs } of parseLeases(text)) for (const f of fs) files.add(f);
  return files;
}

// Orphan-task liveness window (a task record whose SubagentStart never landed):
// PRISM_LIVE_WORK_TTL_MS, integer ms, clamped 30s..1h, default 15 min.
function ttlMs(env = process.env) {
  const raw = env.PRISM_LIVE_WORK_TTL_MS;
  if (raw != null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (n >= 30000 && n <= 3600000) return n;
  }
  return 15 * 60000;
}

function enabled(env = process.env) {
  return String(env.PRISM_LIVE_WORK_DEDUP ?? 'on').toLowerCase() !== 'off';
}

function inSubagentContext(payload, env = process.env) {
  if (payload && payload.parent_tool_use_id) return true;
  if (String(env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent') return true;
  return false;
}

function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// Scope-assignment filter for SendMessage (mirrors the conservative stance of
// prism-dispatch-preamble.mjs's SM heuristic, but LOOSER on purpose: this path
// only feeds the advisory keyword pool for an already-live agent — a false
// record costs at worst one soft advisory, never a rewrite or a block).
const SM_STATUS_OPEN_RE = /^\s*(?:phase\s+\d+\s+(?:complete|done)|task\s*#?\d+\s+(?:complete|done)|completed?\b|done[.:!\s]|status\b|update[:\s]|fyi\b|re:|thanks\b|ok\b|yes\b|no\b)/i;

function runSendMessage(payload, env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  const ti = (payload && payload.tool_input) || {};
  const to = typeof ti.to === 'string' ? ti.to.trim() : '';
  const message = ti.message;
  if (!to || to === 'main') return quiet;
  if (typeof message !== 'string' || message.length < 80) return quiet;
  if (SM_STATUS_OPEN_RE.test(message)) return quiet;
  const sessionId = (payload && payload.session_id) || 'anon';
  appendTaskSummary(prismHome(), sessionId, to, message);
  return quiet;
}

export async function run(payload, env = process.env) {
  const quiet = { exit: 0, stdout: '', stderr: '' };
  try {
    if (!enabled(env)) return quiet;
    const tool = payload && payload.tool_name;
    if (tool === 'SendMessage') return runSendMessage(payload, env);
    if (tool !== 'Agent') return quiet;
    if (inSubagentContext(payload, env)) return quiet;

    const sessionId = (payload && payload.session_id) || 'anon';
    const ti = (payload && payload.tool_input) || {};
    const freshId = String(ti.name || ti.subagent_type || ti.agent_type || 'general-purpose').trim().replace(/^@/, '');
    const freshText = `${String(ti.description || '')} ${String(ti.prompt || '')}`.trim();
    const H = prismHome();

    const freshKw = keywordsOf(freshText);
    const freshLeaseFiles = leaseFilesOf(freshText);
    const hits = [];
    // Every keyword-path pair, scored but NOT yet thresholded: the excess test
    // needs a background distribution before any pair can be judged, so
    // thresholding moves to a second pass below.
    const kwScored = [];
    // Corpus + per-candidate baselines, for the routing-log instrumentation.
    let corpus = [];
    const baselines = [];
    if (freshKw.size > 0 || freshLeaseFiles.size > 0) {
      const live = collectLiveWork(H, sessionId, ttlMs(env));
      for (const [id, info] of live) {
        if (id === freshId) continue; // re-steering the same agent is not a dup
        const liveText = info.texts.join(' ');

        // Work-identity check FIRST (F25 fix): a PRISM-LEASE file declaration
        // is explicit ground truth about what an agent owns; keyword overlap
        // over the whole prompt is not. When BOTH sides declared a lease,
        // trust the declared files instead of scoring topic overlap at all —
        // best-effort only: a live agent's lease may be missing here if it
        // fell outside the 600-char-per-record cap `appendTaskSummary` keeps
        // (see prism-live-agents.mjs TASK_TEXT_MAX) — degrades safely to the
        // keyword fallback below when that happens, same as when no lease
        // was ever declared.
        const liveLeaseFiles = leaseFilesOf(liveText);
        if (freshLeaseFiles.size > 0 && liveLeaseFiles.size > 0) {
          const overlapFiles = [...freshLeaseFiles].filter(f => liveLeaseFiles.has(f));
          if (overlapFiles.length > 0) {
            hits.push({ id, shared: overlapFiles.sort(), coefficient: 1, via: 'lease' });
          }
          continue; // identity resolved this pair (collision or genuine disjoint) — skip keyword scoring
        }

        const { shared, coefficient } = taskOverlap(
          filterBoilerplate(freshKw), filterBoilerplate(keywordsOf(liveText)));
        kwScored.push({ id, shared, coefficient });
      }

      // ── Second pass: absolute bars AND excess over the CORPUS background ────
      // The background is what THIS fresh dispatch scores against the persisted
      // corpus of past dispatch documents (F41; F36 used only the live batch).
      // House vocabulary lifts every one of those scores together, so it
      // cancels; genuinely duplicated work does not, so it survives. The
      // candidate's own documents are excluded so a pair cannot raise its own
      // baseline. ONE rule, applied identically in every case — there is no
      // small-sample branch, because an empty corpus is a MEASURED baseline of
      // 0 (logged as kw_corpus_docs, per D046: observable, never a silent
      // fallback to a different rule), and MIN_EXCESS > MIN_COEFF so the excess
      // conjunct still binds there instead of degenerating into a no-op.
      // Read the corpus only when there is something to judge — this is the
      // one filesystem scan on the hot path (76-89ms for 176 files measured).
      if (kwScored.length) corpus = readDispatchCorpus(H);
      const corpusScores = corpus
        .filter(d => d.id !== freshId)
        .map(d => ({ id: d.id, coefficient: taskOverlap(
          filterBoilerplate(freshKw), filterBoilerplate(keywordsOf(d.text))).coefficient }));
      for (const c of kwScored) {
        const background = corpusScores.filter(o => o.id !== c.id).map(o => o.coefficient);
        const baseline = median(background);
        const excess = c.coefficient - baseline;
        baselines.push({ id: c.id, baseline, n: background.length });
        const passes = c.shared.length >= MIN_SHARED
          && c.coefficient >= MIN_COEFF && excess >= MIN_EXCESS;
        if (passes) {
          hits.push({
            id: c.id, shared: c.shared.sort(), coefficient: c.coefficient,
            via: 'keywords', excess,
          });
        }
      }
    }

    // Record the fresh dispatch's task AFTER comparing (never self-match).
    if (freshText) appendTaskSummary(H, sessionId, freshId, freshText);

    appendLog({
      event: 'live_work_dedup',
      ts: new Date().toISOString(),
      session_id: sessionId,
      target: freshId,
      overlap_hits: hits.map(h => h.id),
      overlap_via: hits.map(h => h.via), // F25 instrumentation: 'lease' vs 'keywords', for post-fix measurement
      // F36 instrumentation: how many pairs cleared the absolute-only bars but
      // were suppressed as background noise. A persistently high suppressed
      // count means the briefs are near-identical boilerplate; a suppressed
      // count that never moves means MIN_EXCESS is doing nothing. It summed to
      // 0 across all 19 post-F36 records — the evidence that produced F41.
      kw_suppressed: kwScored.filter(c =>
        c.shared.length >= MIN_SHARED && c.coefficient >= MIN_COEFF
        && !hits.some(h => h.via === 'keywords' && h.id === c.id)).length,
      // F41 instrumentation (D046 — a degraded corpus must be OBSERVABLE, never
      // a silent fallback). kw_corpus_docs is the size of the background sample
      // actually used; 0 means the corpus was unreadable or this is a brand-new
      // install with no dispatch history, in which case every baseline below is
      // a measured 0 and only the absolute bars + MIN_EXCESS are doing work.
      kw_corpus_docs: corpus.length,
      kw_baselines: baselines.map(b => ({ id: b.id, base: Math.round(b.baseline * 1000) / 1000, n: b.n })),
      advised: hits.length > 0,
    });

    if (!hits.length) return quiet;

    hits.sort((a, b) => b.coefficient - a.coefficient);
    const lines = hits.slice(0, 3).map(h =>
      `  • ${h.id} — shared ${h.via === 'lease' ? 'files' : 'topics'}: ${h.shared.slice(0, 8).join(', ')} (overlap ${Math.round(h.coefficient * 100)}%)`);
    const notice = [
      `PRISM LIVE-WORK DEDUP (advisory): this dispatch overlaps work a LIVE agent already holds:`,
      ...lines,
      `A live agent's scope includes SendMessage-assigned work, not just its original dispatch.`,
      `Consider: SendMessage the live agent to check/extend its scope instead of dispatching a`,
      `second agent for the same question. Proceeding is allowed — this is advisory only.`,
      `Kill-switch: PRISM_LIVE_WORK_DEDUP=off.`,
    ].join('\n');

    return {
      exit: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
      }),
      stderr: '',
    };
  } catch {
    return quiet; // FAIL OPEN
  }
}

// Standalone shim (parity with sibling guards).
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-live-work-dedup.mjs';
if (invokedDirectly) {
  (async () => {
    let payload = {};
    try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
    try {
      const r = await run(payload);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.exit || 0);
    } catch { process.exit(0); }
  })();
}
