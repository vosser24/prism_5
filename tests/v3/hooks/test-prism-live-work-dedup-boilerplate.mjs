#!/usr/bin/env node
// tests/v3/hooks/test-prism-live-work-dedup-boilerplate.mjs
//
// Regression test for F25 (task #37): PRISM LIVE-WORK DEDUP fired 43-62%
// "overlap" between FOUR dispatches with explicitly DISJOINT file ownership,
// on shared tokens `4e8e2f8f5` (a git SHA — present because every brief
// states the HEAD it applies to), `branch`, `clean`, `head`, `audit`, `edit`,
// `existing`, `defect`, `four`, `full`, `count`, `genuine`, `confirmed`,
// `bash` — orchestrator brief-template scaffolding, not work content. The
// highest score (62%) was between two dispatches with NO file in common.
//
// Two-part fix in hooks/prism-live-work-dedup.mjs:
//   1. A local EXTRA_STOPWORDS + git-SHA-shaped-token filter
//      (filterBoilerplate()) strips brief-template noise before keyword
//      scoring — this is the fallback path, used when no PRISM-LEASE is
//      declared (the literal shape of the original incident: the dispatching
//      orchestrator had partitioned ownership in PROSE, not the machine-
//      readable PRISM-LEASE field).
//   2. When BOTH sides of a comparison DID declare a PRISM-LEASE file list
//      (reusing hooks/prism-file-lease-guard.mjs's own parseLeases(), no new
//      ledger), work IDENTITY overrides keyword scoring entirely: disjoint
//      leases -> never fires regardless of prose similarity; overlapping
//      leases -> ALWAYS fires regardless of prose similarity.
//
// Required per task #37: this file proves BOTH the false-positive fix AND a
// paired true-positive (the guard must still fire on a genuine collision) —
// a threshold-raise that silences everything would not be an acceptable fix.
//
// Run: node tests/v3/hooks/test-prism-live-work-dedup-boilerplate.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

const HOME = mkdtempSync(join(tmpdir(), 'prism-livework-boilerplate-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run } = await import(pathToFileURL(join(HOOKS, 'prism-live-work-dedup.mjs')).href);
const { appendRecord } = await import(pathToFileURL(join(HOOKS, 'lib', 'prism-live-agents.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}

const dispatch = (session_id, name, description, prompt) =>
  ({ tool_name: 'Agent', session_id, tool_input: { name, subagent_type: 'general-purpose', description, prompt } });
const advisoryOf = (r) => {
  if (!r.stdout) return '';
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};
const markRunning = (sid, id) =>
  appendRecord(HOME, sid, { agentId: id, agentType: id, status: 'running', startedAt: new Date().toISOString() });

// Boilerplate closely modeled on the actual observed brief-template overlap
// (task #37 report): repo-state preamble + constraint scaffolding that is
// IDENTICAL across every dispatch in a batch, wrapping DIFFERENT real work.
// Every token here (verified via keywordsOf() directly) is covered by either
// the shared TASK_STOPWORDS list or this file's own EXTRA_STOPWORDS/SHA-regex
// — i.e. this reproduces the reported "18 shared tokens, 90% raw coefficient,
// 0 shared post-filter" shape exactly, not an approximation.
const PREAMBLE = (headSha) =>
  `Task (branch main, clean tree, HEAD ${headSha}). Confirmed genuine, four workers this batch, full count. Edit only existing files. Audit: no defect. Bash only.`;

const TASK_A = `${PREAMBLE('4e8e2f8f5')} Fix the audit-log edit path in tools/prism-audit-runner.mjs — the write helper drops the severity field on a partial-batch retry.`;
const TASK_B = `${PREAMBLE('4e8e2f8f5')} Fix the sentinel-prune edit path in hooks/lib/prism-freshness-sweep.mjs — the TTL sweep never runs on a manual-install layout.`;

// A TRUE positive: genuinely overlapping work content (not just preamble).
const TASK_C = `${PREAMBLE('4e8e2f8f5')} Migrate hooks/prism-acl-worker.mjs off raw process.env.HOME resolution onto prismHome(), matching the F21 migration pattern already applied to 16 other hooks.`;
const TASK_C_DUP = `${PREAMBLE('4e8e2f8f5')} Migrate hooks/prism-acl-worker.mjs's HOME resolution to use prismHome() instead of process.env.HOME directly, per the F21 migration.`;

try {
  // ── RED->GREEN: disjoint work, no PRISM-LEASE, shares only boilerplate ─────
  {
    const sid = 's-boilerplate-only';
    await run(dispatch(sid, 'worker-A', 'Fix audit-runner edit path', TASK_A));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Fix freshness-sweep edit path', TASK_B));
    check('disjoint work sharing only brief-template boilerplate -> QUIET (no advisory)',
      r.exit === 0 && !advisoryOf(r), advisoryOf(r));
  }

  // ── TRUE POSITIVE (paired, required): genuine content overlap still fires ──
  {
    const sid = 's-genuine-overlap';
    await run(dispatch(sid, 'worker-A', 'Migrate acl-worker HOME resolution', TASK_C));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Migrate acl-worker HOME resolution (dup)', TASK_C_DUP));
    const adv = advisoryOf(r);
    check('genuinely overlapping work (same file, same migration) -> ADVISORY still fires',
      r.exit === 0 && /LIVE-WORK DEDUP/.test(adv) && /worker-A/.test(adv));
  }

  // ── Lease-based identity: disjoint PRISM-LEASE files -> never fires, ───────
  // even with near-identical boilerplate-heavy prose on both sides.
  {
    const sid = 's-lease-disjoint';
    const leaseA = `PRISM-LEASE: agent=worker-A files=hooks/prism-a.mjs\n${TASK_A}`;
    const leaseB = `PRISM-LEASE: agent=worker-B files=hooks/prism-b.mjs\n${TASK_A}`; // same boilerplate text on purpose
    await run(dispatch(sid, 'worker-A', 'Task A', leaseA));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Task B', leaseB));
    check('disjoint PRISM-LEASE files, identical prose otherwise -> QUIET (identity overrides keywords)',
      r.exit === 0 && !advisoryOf(r), advisoryOf(r));
  }

  // ── Lease-based identity: overlapping PRISM-LEASE files -> ALWAYS fires, ──
  // even with completely dissimilar prose (proves identity, not prose, decides).
  {
    const sid = 's-lease-collision';
    const leaseA = `PRISM-LEASE: agent=worker-A files=hooks/prism-shared.mjs\nCompletely unrelated task about coffee-ledger settlement math.`;
    const leaseB = `PRISM-LEASE: agent=worker-B files=hooks/prism-shared.mjs\nA totally different task concerning Greek e-commerce copy review.`;
    await run(dispatch(sid, 'worker-A', 'Task A', leaseA));
    markRunning(sid, 'worker-A');
    const r = await run(dispatch(sid, 'worker-B', 'Task B', leaseB));
    const adv = advisoryOf(r);
    check('overlapping PRISM-LEASE file, dissimilar prose -> ADVISORY still fires (identity, not prose, decides)',
      r.exit === 0 && /LIVE-WORK DEDUP/.test(adv) && /worker-A/.test(adv) && /shared files/.test(adv));
  }

  // ── Single-sided lease: not enough evidence to suppress -> falls back to ──
  // keyword scoring (never inferred-disjoint from one side alone).
  {
    const sid = 's-lease-onesided';
    const leaseA = `PRISM-LEASE: agent=worker-A files=hooks/prism-a.mjs\n${TASK_A}`;
    await run(dispatch(sid, 'worker-A', 'Task A', leaseA));
    markRunning(sid, 'worker-A');
    // worker-B declares NO lease, and its text is pure boilerplate (post-fix,
    // boilerplate alone should stay quiet on the keyword-fallback path too).
    const r = await run(dispatch(sid, 'worker-B', 'Task B', TASK_B));
    check('one-sided lease (other side undeclared) -> falls back to keyword scoring, not silently suppressed',
      r.exit === 0 && !advisoryOf(r), advisoryOf(r));
  }
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
