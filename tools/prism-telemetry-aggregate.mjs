#!/usr/bin/env node
// PRISM telemetry aggregator (v4.1 Phase C — Q10).
//
// Reads ~/.claude/.prism-routing.jsonl, computes the rollup, writes
// ~/.claude/.prism-telemetry-rollup.json. Idempotent. Honours the
// `telemetry.opt_in` consent in ~/.claude/prism-policy.json — if the
// user has not opted in, aggregation refuses with a clear message
// (exit 13) rather than silently building the rollup.
//
// Single-project today: the routing log entries don't carry a `cwd`
// or `project` field, so cross-project aggregation requires an
// architectural change to the writers. Deferred to v4.2; this helper
// surfaces tuning-candidate guards from the current global log.
//
// Usage:
//   node tools/prism-telemetry-aggregate.mjs                  → aggregate + write
//   node tools/prism-telemetry-aggregate.mjs --dry-run        → compute, don't write
//   node tools/prism-telemetry-aggregate.mjs --tuning         → print guard tuning candidates
//   node tools/prism-telemetry-aggregate.mjs --force          → bypass opt-in gate (tests only)
//   node tools/prism-telemetry-aggregate.mjs --home <path>    → sandbox HOME (tests)
//
// Exit codes:
//   0  ok
//   13 telemetry not opted in (call `node prism-bootstrap.mjs set-telemetry-consent on`)
//   14 routing log missing or unreadable
//   15 destination file write failed
//
// No network. Ever. The rollup is a local artifact.

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync} from 'fs';
import {join, dirname} from 'path';

const args = process.argv.slice(2);
let opts = {dryRun: false, tuning: false, force: false, home: null, phase15Agreement: false};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--tuning') opts.tuning = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--home') opts.home = args[++i];
  else if (a === '--phase-1-5-agreement') opts.phase15Agreement = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write(`Usage: prism-telemetry-aggregate [--dry-run] [--tuning] [--force] [--phase-1-5-agreement] [--home <path>]\n`);
    process.exit(0);
  }
}

const HOME = opts.home || process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  process.stderr.write('error: HOME/USERPROFILE unset and no --home passed\n');
  process.exit(2);
}

const POLICY = join(HOME, '.claude', 'prism-policy.json');
const LOG = join(HOME, '.claude', '.prism-routing.jsonl');
const ROLLUP = join(HOME, '.claude', '.prism-telemetry-rollup.json');

// ── consent gate ─────────────────────────────────────────────────────
// Industry-standard opt-out env vars: DO_NOT_TRACK (consoledonottrack.com)
// and DISABLE_TELEMETRY (broadly observed). Honor without reading policy —
// the env signal is authoritative and overrides any prior opt-in.
function envForcedOff() {
  if (process.env.DISABLE_TELEMETRY === '1') return 'DISABLE_TELEMETRY';
  if (process.env.DO_NOT_TRACK === '1') return 'DO_NOT_TRACK';
  return null;
}

function checkConsent() {
  if (opts.force) return true;
  if (envForcedOff()) return false;
  if (!existsSync(POLICY)) return false;
  try {
    const p = JSON.parse(readFileSync(POLICY, 'utf8'));
    return Boolean(p && p.telemetry && p.telemetry.opt_in === true);
  } catch { return false; }
}

if (!checkConsent()) {
  const envVar = envForcedOff();
  if (envVar) {
    process.stderr.write(
      `PRISM telemetry: aggregation refused — ${envVar}=1 in environment (industry-standard opt-out honored).\n`
    );
  } else {
    process.stderr.write(
      `PRISM telemetry: aggregation refused — opt-in not set in ${POLICY}.\n` +
      `Set with: node tools/prism-bootstrap.mjs set-telemetry-consent on\n` +
      `Or via slash command: /prism-telemetry --opt-in\n`
    );
  }
  process.exit(13);
}

// ── v4.4: --phase-1-5-agreement subcommand ────────────────────────────
if (opts.phase15Agreement) {
  const verdictLogPath = join(HOME, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  if (!existsSync(verdictLogPath)) {
    process.stdout.write('No OOB verdict log yet — agreement-rate signal not available.\n');
    process.exit(0);
  }
  let verdictEntries = [];
  try {
    verdictEntries = readFileSync(verdictLogPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    process.stderr.write(`error reading verdict log: ${e.message}\n`);
    process.exit(14);
  }
  // Cross-reference with routing log for phase_1_5_oob events
  let routing = [];
  if (existsSync(LOG)) {
    try {
      routing = readFileSync(LOG, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(e => e && e.event === 'phase_1_5_oob');
    } catch {}
  }
  const perAgent = {};
  for (const e of verdictEntries) {
    const a = e.specialist_name;
    if (!a) continue;
    if (!perAgent[a]) perAgent[a] = {dispatches: 0, total_claims: 0, reviewer_un_cited: 0};
    perAgent[a].dispatches++;
    perAgent[a].total_claims += (e.summary && e.summary.total) || 0;
    perAgent[a].reviewer_un_cited += ((e.summary && e.summary.un_cited) || 0) + ((e.summary && e.summary.rejected) || 0);
  }
  const rows = Object.entries(perAgent).map(([a, s]) => ({
    agent: a,
    dispatches: s.dispatches,
    reviewer_un_cited_rate: s.total_claims > 0 ? (s.reviewer_un_cited / s.total_claims) : 0,
  })).sort((a, b) => b.reviewer_un_cited_rate - a.reviewer_un_cited_rate);
  process.stdout.write(`OOB reviewer agreement signal (per agent, all-time):\n`);
  for (const r of rows) {
    process.stdout.write(`  ${r.agent.padEnd(40)} ${r.dispatches} dispatches  ${(r.reviewer_un_cited_rate * 100).toFixed(1)}% UN-CITED/REJECTED by reviewer\n`);
  }
  process.stdout.write(`\nNote: full master↔reviewer agreement rate requires master-side verdict_pre logging (planned v4.5).\n`);
  process.exit(0);
}

// ── read log ─────────────────────────────────────────────────────────
if (!existsSync(LOG)) {
  process.stderr.write(`PRISM telemetry: no routing log at ${LOG} — nothing to aggregate.\n`);
  process.exit(14);
}

let raw;
try { raw = readFileSync(LOG, 'utf8'); }
catch (e) {
  process.stderr.write(`PRISM telemetry: cannot read ${LOG}: ${e.message}\n`);
  process.exit(14);
}

const events = [];
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch {}
}

// ── compute rollup ───────────────────────────────────────────────────
function emptyRollup() {
  return {
    schema_version: '4.1.0',
    first_event: null,
    last_event: null,
    events_aggregated: 0,
    tier_distribution: {haiku: 0, sonnet: 0, opus: 0},
    classifier_sources: {opus: 0, 'sonnet-fallback': 0, cache: 0, 'keyword-floor': 0, allowlist: 0, 'force-opus': 0},
    guard_denies: {mutation: 0, dispatch: 0, model: 0, tier_advisor: 0, safety: 0, parallel: 0, panel: 0, skill_trigger: 0},
    hook_event_counts: {},
    event_kind_counts: {},
    force_opus_uses: 0,
    subagent_bypasses: {parent_tool_use_id: 0, env: 0, 'sentinel.dispatched': 0},
    panel_summons: {true: 0, false: 0},
    tuning_candidates: [],
  };
}

function aggregate(events) {
  const r = emptyRollup();
  if (!events.length) return r;
  r.events_aggregated = events.length;
  for (const e of events) {
    if (e.ts) {
      if (!r.first_event || e.ts < r.first_event) r.first_event = e.ts;
      if (!r.last_event || e.ts > r.last_event) r.last_event = e.ts;
    }
    if (e.tier && r.tier_distribution[e.tier] !== undefined) r.tier_distribution[e.tier]++;
    if (e.classifier_source && r.classifier_sources[e.classifier_source] !== undefined) r.classifier_sources[e.classifier_source]++;
    if (e.guard_deny && r.guard_denies[e.guard_deny] !== undefined) r.guard_denies[e.guard_deny]++;
    if (e.hook_event) r.hook_event_counts[e.hook_event] = (r.hook_event_counts[e.hook_event] || 0) + 1;
    if (e.event) r.event_kind_counts[e.event] = (r.event_kind_counts[e.event] || 0) + 1;
    if (e.force_opus) r.force_opus_uses++;
    if (e.subagent_bypass && r.subagent_bypasses[e.subagent_bypass] !== undefined) r.subagent_bypasses[e.subagent_bypass]++;
    if (e.panel_summon !== undefined) r.panel_summons[String(Boolean(e.panel_summon))]++;
  }

  // Tuning candidates: any guard that denies > 25% of its triggering events.
  // This is the prism-updater consumption surface per the roadmap. We can't
  // compute precise "fire %" without total-triggers-per-guard counts, so we
  // approximate: guards that account for more than 25% of guard_denies
  // total are flagged as candidates.
  const totalDenies = Object.values(r.guard_denies).reduce((a, b) => a + b, 0);
  if (totalDenies > 0) {
    for (const [guard, count] of Object.entries(r.guard_denies)) {
      const pct = count / totalDenies;
      if (pct >= 0.25 && count >= 3) {
        r.tuning_candidates.push({
          guard,
          deny_count: count,
          share_of_denies: Math.round(pct * 100),
          recommendation: `Guard '${guard}' produces ${Math.round(pct * 100)}% of all guard denies (${count}/${totalDenies}). Consider reviewing its match pattern for false positives, OR confirming it's the right behavioral signal for this workload.`,
        });
      }
    }
    r.tuning_candidates.sort((a, b) => b.deny_count - a.deny_count);
  }

  return r;
}

const rollup = aggregate(events);

if (opts.tuning) {
  if (!rollup.tuning_candidates.length) {
    process.stdout.write('PRISM telemetry: no tuning candidates surfaced (guard deny rate within normal bounds).\n');
  } else {
    process.stdout.write(`PRISM telemetry: ${rollup.tuning_candidates.length} tuning candidate(s) surfaced.\n\n`);
    for (const c of rollup.tuning_candidates) {
      process.stdout.write(`- ${c.guard}: ${c.deny_count} denies (${c.share_of_denies}%)\n  → ${c.recommendation}\n\n`);
    }
  }
  if (opts.dryRun) process.exit(0);
}

// ── write rollup (atomic) ────────────────────────────────────────────
if (opts.dryRun) {
  process.stdout.write(JSON.stringify(rollup, null, 2) + '\n');
  process.exit(0);
}

try {
  mkdirSync(dirname(ROLLUP), {recursive: true});
  const body = JSON.stringify(rollup, null, 2) + '\n';
  const tmp = ROLLUP + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  try { renameSync(tmp, ROLLUP); } catch { writeFileSync(ROLLUP, body, 'utf8'); }
  process.stdout.write(`PRISM telemetry: rollup written → ${ROLLUP} (${rollup.events_aggregated} events, ${rollup.tuning_candidates.length} tuning candidates)\n`);
} catch (e) {
  process.stderr.write(`PRISM telemetry: write failed (${ROLLUP}): ${e.message}\n`);
  process.exit(15);
}

process.exit(0);
