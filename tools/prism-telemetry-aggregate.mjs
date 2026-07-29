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
import {prismHome} from '../hooks/lib/prism-home.mjs';

const args = process.argv.slice(2);
let opts = {dryRun: false, tuning: false, force: false, home: null, phase15Agreement: false, agreement: false, routingLog: null, recommendCalibration: false, blindnessCanary: false};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--tuning') opts.tuning = true;
  else if (a === '--force') opts.force = true;
  else if (a === '--home') opts.home = args[++i];
  else if (a === '--phase-1-5-agreement') opts.phase15Agreement = true;
  else if (a === '--agreement') opts.agreement = true;
  else if (a === '--routing-log') opts.routingLog = args[++i];
  else if (a === '--recommend-calibration') opts.recommendCalibration = true;
  else if (a === '--blindness-canary') opts.blindnessCanary = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write(`Usage: prism-telemetry-aggregate [--dry-run] [--tuning] [--force] [--phase-1-5-agreement] [--agreement] [--recommend-calibration] [--blindness-canary] [--routing-log <path>] [--home <path>]\n`);
    process.exit(0);
  }
}

const HOME = opts.home || prismHome();
if (!HOME) {
  process.stderr.write('error: HOME/USERPROFILE unset and no --home passed\n');
  process.exit(2);
}

const POLICY = join(HOME, '.claude', 'prism-policy.json');
const LOG = join(HOME, '.claude', '.prism-routing.jsonl');
const ROLLUP = join(HOME, '.claude', '.prism-telemetry-rollup.json');

// ── v4.6: --agreement subcommand (per-spec UN-CITED rate from verdict JSONL) ─
// Phase-0d challenge substance from the routing log + per-spec UN-CITED rate
// from ~/.claude/.prism-phase-1-5-verdicts.jsonl (the real reviewer-agreement
// proxy). A cross-event join keyed on task_sha is impossible because verdict
// JSONL entries carry specialist_name/summary but no task_sha.
// Runs before the consent gate because it accepts an arbitrary --routing-log
// path (used for unit tests) and does not write any system state.
function runAgreementMode(routingLogPath) {
  // Phase-0d challenge substance, grouped (from routing log).
  const challengeRows = [];
  if (existsSync(routingLogPath)) {
    for (const line of readFileSync(routingLogPath, 'utf-8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.event === 'phase_0d_challenge') challengeRows.push(e);
    }
  }
  // Phase-1.5 per-spec UN-CITED rate (the real reviewer-agreement proxy).
  const verdictLog = join(HOME, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  const perSpec = {};
  if (existsSync(verdictLog)) {
    for (const line of readFileSync(verdictLog, 'utf-8').split('\n').filter(Boolean)) {
      let v; try { v = JSON.parse(line); } catch { continue; }
      const a = String(v.specialist_name || '').replace(/^@/, '');
      if (!a) continue;
      perSpec[a] ??= { dispatches: 0, total: 0, un_cited: 0 };
      perSpec[a].dispatches++;
      perSpec[a].total += (v.summary?.total) || 0;
      perSpec[a].un_cited += ((v.summary?.un_cited) || 0) + ((v.summary?.rejected) || 0);
    }
  }
  const rows = Object.entries(perSpec).map(([spec, s]) => ({
    spec, dispatches: s.dispatches,
    un_cited_rate: s.total > 0 ? s.un_cited / s.total : null,
  })).sort((a, b) => (b.un_cited_rate ?? 0) - (a.un_cited_rate ?? 0));
  process.stdout.write(JSON.stringify({
    mode: 'agreement',
    phase_0d_challenges: challengeRows.length,
    per_spec_uncited: rows,
  }, null, 2) + '\n');
  process.exit(0);
}

if (opts.agreement) {
  const routingLogPath = opts.routingLog || LOG;
  if (!existsSync(routingLogPath)) {
    process.stderr.write(`PRISM telemetry: no routing log at ${routingLogPath}\n`);
    process.exit(14);
  }
  runAgreementMode(routingLogPath);
}

// ── v6.3: --blindness-canary subcommand (self-blindness canary) ───────
// Detects a hook that logs the SAME bail/no-op `action` value ~100% of
// the time forever — the failure mode where a mechanism goes silently
// dead and nothing notices (e.g. phase-1-5-oob logging 'no-agent-name'
// ~29,618x on one install while the whole reviewer path was inert).
// Read-only, local-only; runs before the consent gate like --agreement
// above (accepts --routing-log for tests, writes no system state).

// NO-OP / BAIL action class (case-insensitive, exact-or-substring match
// against the logged `action` string). This is the single source of
// truth for "this action means the hook did nothing" — extend it here,
// not inline, when a new bail-style action string is introduced.
const NO_OP_ACTION_MARKERS = [
  'no-agent-name', 'agent-not-tagged', 'roster-unreadable', 'no-output',
  'killswitch', 'recursion-guard', 'bail', 'noop', 'no-op', 'skip',
  'skip-next-oob',
];
const NO_OP_CANARY_MIN_VOLUME = 20;   // hook needs >= this many entries to be judged
const NO_OP_CANARY_FLAG_SHARE = 0.95; // top-action share >= this ⇒ flag
const NO_OP_CANARY_WINDOW = 2000;     // only look at the last N entries — PER HOOK (D064 remedy 4a)

// D064 remedy 4b — paired start/completion lifecycle actions to check for a
// completion-rate metric. A hook that logs `start` a healthy number of times
// but `complete` ZERO times is a mechanism that starts and never finishes —
// invisible to the no-op-share canary above (its top action isn't a no-op
// marker; it just never closes the loop). Today only phase_1_5_oob emits this
// convention (`pending-written` -> `verdict-written`, D064's canonical 0/11
// case), but this list is scanned against EVERY hook (data-driven, not
// hardcoded to a hook name) so any future hook adopting the same
// start/complete action-naming convention is automatically covered.
const LIFECYCLE_PAIRS = [
  { start: 'pending-written', complete: 'verdict-written' },
];

function isNoOpAction(action) {
  if (action === undefined || action === null) return false;
  const a = String(action).toLowerCase();
  return NO_OP_ACTION_MARKERS.some(marker => a === marker || a.includes(marker));
}

function tallyActions(list) {
  const s = { total: 0, actions: {} };
  for (const e of list) {
    s.total++;
    const key = String(e.action);
    s.actions[key] = (s.actions[key] || 0) + 1;
  }
  return s;
}

// D064 remedy 4b: completion-rate metric, computed over each hook's FULL
// (unwindowed) lifetime history — not the recency window used for the no-op
// share check below. A mechanism whose completions are genuinely zero
// forever is invisible to ANY recency window (there is nothing recent to
// find on either side of the pair), so this check deliberately looks at the
// whole log, however far back it goes.
function computeCompletionRates(perHookFull) {
  const rates = [];
  const findings = [];
  for (const [hook, s] of Object.entries(perHookFull)) {
    for (const pair of LIFECYCLE_PAIRS) {
      const starts = s.actions[pair.start] || 0;
      if (starts === 0) continue; // this hook doesn't emit this lifecycle at all
      const completions = s.actions[pair.complete] || 0;
      const rate = completions / starts;
      const row = {
        hook,
        start_action: pair.start,
        complete_action: pair.complete,
        starts,
        completions,
        completion_rate: rate,
      };
      rates.push(row);
      if (completions === 0) {
        findings.push({
          ...row,
          severity: 'LOUD',
          message: `Hook '${hook}' emitted '${pair.start}' ${starts} time(s) across its full lifetime but '${pair.complete}' ZERO times — the mechanism starts but never completes. Investigate immediately.`,
        });
      }
    }
  }
  return { rates, findings };
}

function computeBlindnessCanary(events) {
  // D064 remedy 4a — group by hook FIRST, over the FULL (unwindowed) event
  // list, preserving each hook's own chronological order. Previously this
  // function received an already-windowed (last-2000-of-the-MERGED-log)
  // slice, so a low-frequency hook (phase_1_5_oob: 8,769 of 47,506 total
  // lines) was almost entirely excluded before this function ever saw it —
  // the canary could see only whatever scraps of that hook happened to fall
  // in the last 2000 lines of every OTHER hook's noise too. Fix: each hook
  // is now windowed against its OWN last-N entries, not the merged log's.
  const perHookAll = {};
  for (const e of events) {
    if (!e || !e.event || e.action === undefined) continue; // only events carrying an `action` field are in scope
    (perHookAll[e.event] ??= []).push(e);
  }

  const perHookFull = {};     // hook -> tally over its FULL history (completion-rate input)
  const perHookWindowed = {}; // hook -> tally over its OWN last-N entries (no-op-share input)
  for (const [hook, list] of Object.entries(perHookAll)) {
    perHookFull[hook] = tallyActions(list);
    const ownWindow = list.length > NO_OP_CANARY_WINDOW ? list.slice(list.length - NO_OP_CANARY_WINDOW) : list;
    perHookWindowed[hook] = tallyActions(ownWindow);
  }

  const checked = [];
  const flagged = [];
  for (const [hook, s] of Object.entries(perHookWindowed)) {
    if (s.total < NO_OP_CANARY_MIN_VOLUME) continue;
    const [topAction, topCount] = Object.entries(s.actions).sort((a, b) => b[1] - a[1])[0];
    const share = topCount / s.total;
    const row = {
      hook,
      total: s.total,
      top_action: topAction,
      top_action_count: topCount,
      top_action_share: share,
      hook_lifetime_total: perHookFull[hook].total,
    };
    checked.push(row);
    if (isNoOpAction(topAction) && share >= NO_OP_CANARY_FLAG_SHARE) {
      // F10 fix (task #23): before escalating to LOUD, cross-check whether
      // this SAME windowed slice (`s`, already tallied above — no second
      // pass over the log, no new lifecycle definitions) also shows a
      // LIFECYCLE_PAIRS completion. A high no-op share plus zero completions
      // is "likely dead" (the D064 shape: starts:11, completions:0, forever).
      // A high no-op share WITH recent completions in the SAME window is a
      // hook correctly bailing most of the time (e.g. a low tag-ratio) while
      // demonstrably still alive — that is not the same finding and must not
      // be reported with the same "likely dead" severity.
      //
      // DELIBERATELY windowed, not lifetime-wide: `computeCompletionRates()`
      // below reads `perHookFull` (the hook's ENTIRE history) by design,
      // exactly so a mechanism that is dead NOW cannot hide behind
      // completions from long ago (see its own comment). Reusing that
      // full-lifetime number HERE would create the opposite bug: a hook that
      // completed successfully once, long before the current window, could
      // mask a genuine RECENT regression — completions>0 lifetime-wide would
      // never go back to false even after the mechanism actually died. F10's
      // own fix-candidate wording is "recent genuine fires exist", and
      // "recent" is the operative word — so this check is scoped to the same
      // last-N window the no-op share itself was computed from.
      const recentCompletions = LIFECYCLE_PAIRS.some(pair => (s.actions[pair.complete] || 0) > 0);
      if (recentCompletions) {
        flagged.push({
          ...row,
          severity: 'INFO',
          message: `Hook '${hook}' emitted no-op action '${topAction}' in ${(share * 100).toFixed(1)}% of its own last ${s.total} logged entries, but shows genuine recent completions in that SAME window — likely correctly bailing (e.g. a low tag/arming ratio) rather than silently dead. Review if unexpected, but this is not the "likely dead" shape.`,
        });
      } else {
        flagged.push({
          ...row,
          severity: 'LOUD',
          message: `Hook '${hook}' emitted no-op action '${topAction}' in ${(share * 100).toFixed(1)}% of its own last ${s.total} logged entries — likely a silently-dead mechanism. Investigate immediately.`,
        });
      }
    }
  }
  checked.sort((a, b) => b.total - a.total);

  const { rates: completionRates, findings: completionFindings } = computeCompletionRates(perHookFull);

  const allFlagged = flagged.concat(completionFindings);
  allFlagged.sort((a, b) => (b.top_action_share ?? 0) - (a.top_action_share ?? 0));

  return {
    hooks_checked: checked.length,
    min_volume: NO_OP_CANARY_MIN_VOLUME,
    flag_share_threshold: NO_OP_CANARY_FLAG_SHARE,
    per_hook_window: NO_OP_CANARY_WINDOW,
    flagged: allFlagged,
    all: checked,
    completion_rates: completionRates,
  };
}

if (opts.blindnessCanary) {
  const routingLogPath = opts.routingLog || LOG;
  // Fail-open: missing/unreadable log is "no data", never an error.
  if (!existsSync(routingLogPath)) {
    process.stdout.write(JSON.stringify({ mode: 'blindness-canary', status: 'no-data', reason: `no routing log at ${routingLogPath}`, hooks_checked: 0, flagged: [] }, null, 2) + '\n');
    process.exit(0);
  }
  let canaryEvents = [];
  try {
    canaryEvents = readFileSync(routingLogPath, 'utf-8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    process.stdout.write(JSON.stringify({ mode: 'blindness-canary', status: 'no-data', reason: `unreadable: ${e.message}`, hooks_checked: 0, flagged: [] }, null, 2) + '\n');
    process.exit(0);
  }
  // D064 remedy 4a: no merged-log windowing here anymore — the FULL event
  // list goes into computeBlindnessCanary, which windows PER HOOK internally.
  const result = computeBlindnessCanary(canaryEvents);
  process.stdout.write(JSON.stringify({ mode: 'blindness-canary', status: 'ok', total_events: canaryEvents.length, ...result }, null, 2) + '\n');
  // F10 fix (task #23): severity-aware banner — an INFO-demoted entry (high
  // no-op share, but confirmed-alive via recent completions) must not be
  // printed under a "look silently dead" header; that would just relocate
  // the same false alarm from the message text into the banner text.
  const loudFlags = result.flagged.filter(f => f.severity !== 'INFO');
  const infoFlags = result.flagged.filter(f => f.severity === 'INFO');
  if (loudFlags.length) {
    process.stderr.write(`\n[BLINDNESS CANARY] ${loudFlags.length} hook(s) look silently dead:\n`);
    for (const f of loudFlags) process.stderr.write(`  - ${f.message}\n`);
  }
  if (infoFlags.length) {
    process.stderr.write(`\n[BLINDNESS CANARY] ${infoFlags.length} hook(s) have a high no-op share but confirmed recent activity (not dead):\n`);
    for (const f of infoFlags) process.stderr.write(`  - ${f.message}\n`);
  }
  process.exit(0);
}

// ── v4.6: calibration engine helpers ─────────────────────────────────
const MIN_N = 15;

function readRosterSafe() {
  const candidates = [
    join(HOME, '.claude', 'skills', 'prism-plan', 'references', 'roster.json'),
    join(HOME, '.claude', 'roster.json'),
  ];
  for (const p of candidates) { if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch {} } }
  return { agents: {} };
}

function insufficient(knob, n) {
  return { knob, status: 'insufficient_data', evidence: `insufficient data (n=${n}, need >=${MIN_N}); keeping current`, confidence: 'none' };
}

// K1: dispatch cap (REPORT-ONLY)
function recommendCap(events, out) {
  const caps = events.filter(e => e.event === 'dispatch_cap');
  if (caps.length < MIN_N) { out.push(insufficient('dispatch_cap', caps.length)); return; }
  const cap = caps[caps.length - 1].cap ?? 4;
  const hitWithQueue = caps.filter(e => (e.actual_parallel ?? 0) >= cap && (e.queue_depth ?? 0) > 0).length;
  const rarelyNear = caps.filter(e => (e.actual_parallel ?? 0) < cap - 1).length;
  const hitRate = hitWithQueue / caps.length;
  const lowRate = rarelyNear / caps.length;
  if (hitRate >= 0.5) {
    out.push({ knob: 'dispatch_cap', current: cap, recommended: cap + 2, confidence: hitRate >= 0.7 ? 'high' : 'medium',
      evidence: `${hitWithQueue}/${caps.length} dispatches hit cap with queue>0`,
      apply: `REPORT-ONLY (D2): edit skills/master-orchestrator/references/dispatch-shapes.md:44 cap to ${cap + 2}` });
  } else if (lowRate >= 0.8 && cap > 2) {
    out.push({ knob: 'dispatch_cap', current: cap, recommended: cap - 1, confidence: 'medium',
      evidence: `${rarelyNear}/${caps.length} dispatches stayed >=2 under cap`,
      apply: `REPORT-ONLY (D2): edit dispatch-shapes.md:44 cap to ${cap - 1}` });
  }
}

// K2: escalate model
function recommendEscalateModel(verdicts, roster, out) {
  const perSpec = {};
  for (const v of verdicts) {
    const a = String(v.specialist_name || '').replace(/^@/, '');
    if (!a) continue;
    perSpec[a] ??= { dispatches: 0, total: 0, bad: 0 };
    perSpec[a].dispatches++;
    perSpec[a].total += (v.summary?.total) || 0;
    perSpec[a].bad += ((v.summary?.un_cited) || 0) + ((v.summary?.rejected) || 0);
  }
  const agents = roster.agents || {};
  for (const [spec, s] of Object.entries(perSpec)) {
    if (s.dispatches < MIN_N) { out.push(insufficient(`model:${spec}`, s.dispatches)); continue; }
    const rate = s.total > 0 ? s.bad / s.total : 0;
    const flagged = agents[spec]?.pending_upgrade === true;
    const current = agents[spec]?.default_model || 'sonnet';
    if (flagged && rate >= 0.30 && current !== 'opus') {
      out.push({ knob: `model:${spec}`, current, recommended: 'opus', confidence: 'high',
        evidence: `pending_upgrade set by ratchet; UN-CITED ${(rate * 100).toFixed(0)}% over ${s.dispatches} dispatches`,
        apply: `node tools/prism-roster.mjs --set-model ${spec} opus` });
    }
  }
}

// K3: auto-clear pending_upgrade
function recommendAutoClear(verdicts, roster, out) {
  const perSpec = {};
  for (const v of verdicts) {
    const a = String(v.specialist_name || '').replace(/^@/, '');
    if (!a) continue;
    perSpec[a] ??= { dispatches: 0, total: 0, bad: 0 };
    perSpec[a].dispatches++;
    perSpec[a].total += (v.summary?.total) || 0;
    perSpec[a].bad += ((v.summary?.un_cited) || 0) + ((v.summary?.rejected) || 0);
  }
  const agents = roster.agents || {};
  for (const [spec, a] of Object.entries(agents)) {
    if (a?.pending_upgrade !== true) continue;
    const s = perSpec[spec];
    if (!s || s.dispatches < MIN_N) continue;
    const rate = s.total > 0 ? s.bad / s.total : 0;
    if (rate < 0.10) {
      out.push({ knob: `clear:${spec}`, current: 'pending_upgrade=true', recommended: 'pending_upgrade=false', confidence: 'high',
        evidence: `UN-CITED ${(rate * 100).toFixed(0)}% < 10% over ${s.dispatches} dispatches`,
        apply: `node tools/prism-roster.mjs --clear-pending-upgrade ${spec}` });
    }
  }
}

// K4: override gate
function recommendOverrideGate(events, out) {
  const ovr = events.filter(e => e.event === 'master_override').length;
  if (ovr >= 5) {
    out.push({ knob: 'override_gate', current: 'advisory', recommended: 'strict', confidence: 'medium',
      evidence: `${ovr} master overrides logged`,
      apply: `set PRISM_OVERRIDE_GATE=strict in your environment` });
  }
}

// ── v4.6: --recommend-calibration dispatch ────────────────────────────
if (opts.recommendCalibration) {
  const routingLogPath = opts.routingLog || LOG;
  const recommendations = [];
  const events = existsSync(routingLogPath)
    ? readFileSync(routingLogPath, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const verdictLogPath = join(HOME, '.claude', '.prism-phase-1-5-verdicts.jsonl');
  const verdicts = existsSync(verdictLogPath)
    ? readFileSync(verdictLogPath, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const roster = readRosterSafe();
  recommendCap(events, recommendations);                      // K1
  recommendEscalateModel(verdicts, roster, recommendations);  // K2
  recommendAutoClear(verdicts, roster, recommendations);      // K3
  recommendOverrideGate(events, recommendations);             // K4
  const out = { mode: 'recommend-calibration', generated_at: new Date().toISOString(), events_read: events.length, verdicts_read: verdicts.length, recommendations };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(join(HOME, '.claude', `.prism-calibration-${stamp}.json`), JSON.stringify(out, null, 2) + '\n');
  } catch (e) { process.stderr.write(`[calibration] file write failed: ${e.message}\n`); }
  process.exit(0);
}

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
    master_overrides: 0,
    // option (c) tier-override telemetry: conversation-model override RATE.
    // rate = overrides_observed / keyword_floor_turns, where
    //   overrides_observed = tier_override_outcome events with was_override:true
    //   keyword_floor_turns = prompt_tier_router turns with source:'keyword-floor'
    //     (the path that offers the self-override protocol).
    // `overall` (and each per_session rate) is null until at least one
    // keyword-floor turn is seen, to avoid a divide-by-zero.
    override_rate: {overall: null, keyword_floor_turns: 0, overrides_observed: 0, per_session: {}},
    tuning_candidates: [],
  };
}

// FIX-B (v5.x): guards emit `{event:'<x>_guard', blocked:bool}`; map the event
// kind to a guard_denies bucket (counted when blocked===true). Legacy code read
// a non-existent `guard_deny` field, so every bucket stayed 0.
const GUARD_EVENT_TO_BUCKET = {
  mutation_guard: 'mutation',
  dispatch_guard: 'dispatch',
  dispatch_guard_panel: 'dispatch',
  agent_model_guard: 'model',
  task_tier_advisor: 'tier_advisor',
  safety: 'safety',
  prism_safety: 'safety',
  parallel_guard: 'parallel',
  panel_guard: 'panel',
  skill_trigger_guard: 'skill_trigger',
};
// Subagent bypasses are logged as `reason` strings on guard passthrough events.
const BYPASS_REASON = {
  'subagent-parent-tool-use-id-passthrough': 'parent_tool_use_id',
  'subagent-claude-code-entrypoint-passthrough': 'env',
  'subagent-sentinel-dispatched-passthrough': 'sentinel.dispatched',
};

function aggregate(events) {
  const r = emptyRollup();
  if (!events.length) return r;
  r.events_aggregated = events.length;
  for (const e of events) {
    if (e.ts) {
      if (!r.first_event || e.ts < r.first_event) r.first_event = e.ts;
      if (!r.last_event || e.ts > r.last_event) r.last_event = e.ts;
    }
    const isRouting = e.event === 'prompt_tier_router';
    // v-fix (guard-telemetry-skew): dispatch_guard now also fires on silent ALLOW
    // paths (blocked:false) for visibility (RB-04). Those allow records still
    // carry `tier`, but they are not a routing/enforcement decision — excluding
    // them (and ONLY them) keeps tier_distribution's pre-fix semantics for every
    // other event type that carries `tier`.
    const isNewGuardAllow = e.event === 'dispatch_guard' && e.blocked === false;
    if (e.tier && r.tier_distribution[e.tier] !== undefined && !isNewGuardAllow) r.tier_distribution[e.tier]++;
    // FIX-B (v5.x): classifier source is `source` on routing events (legacy code
    // read a non-existent `classifier_source`). Scope to routing events.
    const src = e.classifier_source || (isRouting ? e.source : undefined);
    if (src && r.classifier_sources[src] !== undefined) r.classifier_sources[src]++;
    // FIX-B (v5.x): count guard denies from {event:'<x>_guard', blocked:true}.
    if (e.blocked === true && GUARD_EVENT_TO_BUCKET[e.event] && r.guard_denies[GUARD_EVENT_TO_BUCKET[e.event]] !== undefined) {
      r.guard_denies[GUARD_EVENT_TO_BUCKET[e.event]]++;
    } else if (e.guard_deny && r.guard_denies[e.guard_deny] !== undefined) {
      r.guard_denies[e.guard_deny]++; // legacy shape, back-compat
    }
    if (e.hook_event) r.hook_event_counts[e.hook_event] = (r.hook_event_counts[e.hook_event] || 0) + 1;
    if (e.event) r.event_kind_counts[e.event] = (r.event_kind_counts[e.event] || 0) + 1;
    if (e.force_opus) r.force_opus_uses++;
    // FIX-B (v5.x): subagent bypasses are logged as `reason` strings on guards.
    const bypass = e.subagent_bypass || BYPASS_REASON[e.reason];
    if (bypass && r.subagent_bypasses[bypass] !== undefined) r.subagent_bypasses[bypass]++;
    // FIX-B (v5.x): the field is `summon_panel` (legacy read `panel_summon`).
    // Scope to routing events so guard events carrying summon_panel don't double-count.
    if (isRouting) {
      const sp = (e.summon_panel !== undefined) ? e.summon_panel : e.panel_summon;
      if (sp !== undefined) r.panel_summons[String(Boolean(sp))]++;
    }
    if (e.event === 'master_override') r.master_overrides++;

    // option (c) tier-override telemetry reducer. Denominator: keyword-floor
    // routing turns (the ones that offer the override). Numerator:
    // tier_override_outcome events where the model actually overrode.
    const sid = e.session_id || 'anon';
    if (isRouting && e.source === 'keyword-floor') {
      r.override_rate.keyword_floor_turns++;
      r.override_rate.per_session[sid] ??= {keyword_floor_turns: 0, overrides_observed: 0, override_rate: null};
      r.override_rate.per_session[sid].keyword_floor_turns++;
    }
    if (e.event === 'tier_override_outcome' && e.was_override === true) {
      r.override_rate.overrides_observed++;
      r.override_rate.per_session[sid] ??= {keyword_floor_turns: 0, overrides_observed: 0, override_rate: null};
      r.override_rate.per_session[sid].overrides_observed++;
    }
  }

  // option (c): finalize override rates (guard divide-by-zero → null).
  if (r.override_rate.keyword_floor_turns > 0) {
    r.override_rate.overall = r.override_rate.overrides_observed / r.override_rate.keyword_floor_turns;
  }
  for (const s of Object.values(r.override_rate.per_session)) {
    s.override_rate = s.keyword_floor_turns > 0 ? s.overrides_observed / s.keyword_floor_turns : null;
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
