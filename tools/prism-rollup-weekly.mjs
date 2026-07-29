#!/usr/bin/env node
// PRISM weekly rollup (Phase 4)
//
// Aggregates the last 7 days from ~/.claude/.prism.db and writes a markdown
// digest to ~/.claude/.prism-rollups/<YYYY-Www>.md. Idempotent: re-running
// overwrites the same-week file.
//
// Usage:
//   node ~/.claude/tools/prism-rollup-weekly.mjs
//   node ~/.claude/tools/prism-rollup-weekly.mjs --quiet
//
// Scheduling (Windows Task Scheduler): weekly Sunday 02:00, action =
//   node %USERPROFILE%\.claude\tools\prism-rollup-weekly.mjs --quiet
// Scheduling (cron):
//   0 2 * * 0 node ~/.claude/tools/prism-rollup-weekly.mjs --quiet

import {writeFileSync, readFileSync, mkdirSync, existsSync, renameSync} from 'fs';
import {join} from 'path';

// ATOMIC-WRITE-001: tempfile + renameSync with direct-write fallback.
// Matches the canonical pattern in hooks/prism-session-start.mjs:121-136.
// Prevents truncated state JSON / markdown from crashes mid-write
// (disk-full, antivirus, process kill). Readers downstream either see
// the previous valid file or the new one — never a partial.
function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, content); } catch {}
  }
}
import {openDb, close} from './prism-db.mjs';
import {COST_MULTIPLIER} from './lib/prism-tier-classify.mjs';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const H = prismHome();
const OUT_DIR = join(H, '.claude', '.prism-rollups');

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function fmtUsd(n) { return `$${Number(n || 0).toFixed(4)}`; }
function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, {recursive: true});
  const db = openDb({readonly: true});
  const sinceIso = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const todayIso = new Date().toISOString().slice(0, 10);
  const week = isoWeek(new Date());

  const totals = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens),0) AS tokens
     FROM spend WHERE ts >= ?`
  ).get(sinceIso);

  const byModel = db.prepare(
    `SELECT COALESCE(model,'unknown') AS k, SUM(cost_usd) AS cost, SUM(tokens) AS tokens, COUNT(*) AS n
     FROM spend WHERE ts >= ? GROUP BY k ORDER BY cost DESC LIMIT 10`
  ).all(sinceIso);

  const byAgent = db.prepare(
    `SELECT COALESCE(agent,'unknown') AS k, SUM(cost_usd) AS cost, COUNT(*) AS n
     FROM spend WHERE ts >= ? GROUP BY k ORDER BY cost DESC LIMIT 10`
  ).all(sinceIso);

  const byProject = db.prepare(
    `SELECT COALESCE(project,'unknown') AS k, SUM(cost_usd) AS cost, COUNT(*) AS n
     FROM spend WHERE ts >= ? GROUP BY k ORDER BY cost DESC LIMIT 10`
  ).all(sinceIso);

  const sessionStats = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd),0) AS cost, COALESCE(SUM(total_tokens),0) AS tokens
     FROM sessions WHERE end_ts >= ?`
  ).get(sinceIso.slice(0, 10));

  const recentSessions = db.prepare(
    `SELECT session_id, end_ts, projects, total_tokens, total_cost_usd, last_user_prompt
     FROM sessions WHERE end_ts >= ? ORDER BY end_ts DESC LIMIT 10`
  ).all(sinceIso.slice(0, 10));

  const routing = db.prepare(
    `SELECT COALESCE(tier_detected,'none') AS tier, COUNT(*) AS n
     FROM model_routing WHERE ts >= ? GROUP BY tier ORDER BY n DESC`
  ).all(sinceIso);

  const actions = db.prepare(
    `SELECT COALESCE(action,'none') AS action, COUNT(*) AS n
     FROM model_routing WHERE ts >= ? GROUP BY action ORDER BY n DESC`
  ).all(sinceIso);

  const api = db.prepare(
    `SELECT kind, COUNT(*) AS n, COALESCE(AVG(duration_ms),0) AS avg_ms,
            SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_n,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err_n
     FROM api_calls WHERE ts >= ? GROUP BY kind`
  ).all(sinceIso);

  // --- Phase 5a.4 Plan-Tier Adherence ---
  const adviceByTier = db.prepare(
    `SELECT COALESCE(tier,'none') AS tier, COUNT(*) AS n
     FROM task_tier_advice WHERE ts >= ? GROUP BY tier ORDER BY n DESC`
  ).all(sinceIso);

  const totalAdvice = db.prepare(
    `SELECT COUNT(*) AS n FROM task_tier_advice WHERE ts >= ?`
  ).get(sinceIso).n;

  // Skill adherence — subject starts with bracketed [haiku|sonnet|opus]
  const annotated = db.prepare(
    `SELECT COUNT(*) AS n FROM task_tier_advice
     WHERE ts >= ? AND (
       subject LIKE '[haiku]%' OR subject LIKE '[sonnet]%' OR subject LIKE '[opus]%'
     )`
  ).get(sinceIso).n;

  // Follow-up Agent() adherence — for each advice row, find the next
  // model_routing row in same session within 120s. Match = tier_detected
  // on routing row equals advised tier. LEFT JOIN so non-followed-up
  // advice rows show up too.
  const followups = db.prepare(
    `SELECT
       a.task_id, a.tier AS advised_tier, a.h AS adv_h, a.s AS adv_s, a.o AS adv_o,
       a.ts AS a_ts,
       (SELECT r.tier_detected FROM model_routing r
        WHERE r.session_id = a.session_id
          AND r.ts >= a.ts
          AND julianday(r.ts) - julianday(a.ts) <= 120.0/86400.0
        ORDER BY r.ts ASC LIMIT 1) AS followup_tier,
       (SELECT r.action FROM model_routing r
        WHERE r.session_id = a.session_id
          AND r.ts >= a.ts
          AND julianday(r.ts) - julianday(a.ts) <= 120.0/86400.0
        ORDER BY r.ts ASC LIMIT 1) AS followup_action
     FROM task_tier_advice a
     WHERE a.ts >= ?`
  ).all(sinceIso);

  let matched = 0, mismatched = 0, orphaned = 0, savingsUnits = 0;
  for (const r of followups) {
    if (!r.followup_tier) { orphaned++; continue; }
    if (r.followup_tier === r.advised_tier) matched++;
    else {
      mismatched++;
      const advCost = COST_MULTIPLIER[r.advised_tier] || 1;
      const actCost = COST_MULTIPLIER[r.followup_tier] || 1;
      if (actCost > advCost) savingsUnits += (actCost - advCost);
    }
  }
  const withFollowup = matched + mismatched;

  close(db);

  const md = [];
  md.push(`# PRISM Weekly Rollup — ${week}`);
  md.push('');
  md.push(`_Generated ${todayIso} from last-7-day window (since ${sinceIso})._`);
  md.push('');
  md.push('## Spend ledger');
  md.push(`- Rows: ${fmtInt(totals.n)}`);
  md.push(`- Total cost: ${fmtUsd(totals.cost)}`);
  md.push(`- Total tokens: ${fmtInt(totals.tokens)}`);
  md.push('');
  md.push('### Top models by cost');
  if (byModel.length) {
    md.push('| Model | Cost | Tokens | Calls |');
    md.push('|---|---:|---:|---:|');
    for (const r of byModel) md.push(`| ${r.k} | ${fmtUsd(r.cost)} | ${fmtInt(r.tokens)} | ${fmtInt(r.n)} |`);
  } else md.push('_(none)_');
  md.push('');
  md.push('### Top agents by cost');
  if (byAgent.length) {
    md.push('| Agent | Cost | Calls |');
    md.push('|---|---:|---:|');
    for (const r of byAgent) md.push(`| ${r.k} | ${fmtUsd(r.cost)} | ${fmtInt(r.n)} |`);
  } else md.push('_(none)_');
  md.push('');
  md.push('### Top projects by cost');
  if (byProject.length) {
    md.push('| Project | Cost | Calls |');
    md.push('|---|---:|---:|');
    for (const r of byProject) md.push(`| ${r.k} | ${fmtUsd(r.cost)} | ${fmtInt(r.n)} |`);
  } else md.push('_(none)_');
  md.push('');
  md.push('## Sessions');
  md.push(`- Sessions with end_ts in window: ${fmtInt(sessionStats.n)}`);
  md.push(`- Aggregate session cost: ${fmtUsd(sessionStats.cost)}`);
  md.push(`- Aggregate session tokens: ${fmtInt(sessionStats.tokens)}`);
  md.push('');
  md.push('### Recent sessions (last 10)');
  if (recentSessions.length) {
    md.push('| End | Session | Projects | Tokens | Cost | Last prompt |');
    md.push('|---|---|---|---:|---:|---|');
    for (const s of recentSessions) {
      const shortId = (s.session_id || '').slice(0, 8);
      const prompt = (s.last_user_prompt || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80);
      md.push(`| ${s.end_ts || ''} | ${shortId} | ${s.projects || ''} | ${fmtInt(s.total_tokens)} | ${fmtUsd(s.total_cost_usd)} | ${prompt} |`);
    }
  } else md.push('_(none)_');
  md.push('');
  md.push('## Model routing (Phase 3b guard)');
  if (routing.length) {
    md.push('| Tier | Count |');
    md.push('|---|---:|');
    for (const r of routing) md.push(`| ${r.tier} | ${fmtInt(r.n)} |`);
  } else md.push('_(none)_');
  md.push('');
  if (actions.length) {
    md.push('| Action | Count |');
    md.push('|---|---:|');
    for (const r of actions) md.push(`| ${r.action} | ${fmtInt(r.n)} |`);
  }
  md.push('');
  md.push('## NotebookLM API telemetry');
  if (api.length) {
    md.push('| Kind | Calls | Avg ms | OK | Err |');
    md.push('|---|---:|---:|---:|---:|');
    for (const r of api) md.push(`| ${r.kind} | ${fmtInt(r.n)} | ${Number(r.avg_ms).toFixed(0)} | ${fmtInt(r.ok_n)} | ${fmtInt(r.err_n)} |`);
  } else md.push('_(none)_');
  md.push('');
  md.push('## Plan-Tier Adherence (Phase 5a.4)');
  md.push(`- Tasks advised: ${fmtInt(totalAdvice)}`);
  if (totalAdvice > 0) {
    const pctAnnot = ((annotated / totalAdvice) * 100).toFixed(1);
    md.push(`- Skill-format adherence ([tier]-prefixed subjects): ${fmtInt(annotated)}/${fmtInt(totalAdvice)} (${pctAnnot}%)`);
    md.push(`- With Agent() follow-up within 120s: ${fmtInt(withFollowup)}`);
    if (withFollowup > 0) {
      const pctMatch = ((matched / withFollowup) * 100).toFixed(1);
      md.push(`- Follow-up tier match: ${fmtInt(matched)}/${fmtInt(withFollowup)} (${pctMatch}%)`);
      md.push(`- Tier drift (advised vs used mismatch): ${fmtInt(mismatched)}`);
      md.push(`- Savings potential (cost-unit differential on overshoot): ${savingsUnits} units (1 unit ≈ 1× Haiku)`);
    }
    md.push(`- Advice emitted without Agent() follow-up: ${fmtInt(orphaned)} (tasks executed in main context or not routed through Agent)`);
    md.push('');
    if (adviceByTier.length) {
      md.push('### Advice by tier');
      md.push('| Tier | Count |');
      md.push('|---|---:|');
      for (const r of adviceByTier) md.push(`| ${r.tier} | ${fmtInt(r.n)} |`);
    }
  } else {
    md.push('_(no TaskCreate advice rows in window — either no TaskCreate calls or advisor hook not firing)_');
  }
  md.push('');

  // v2.7.0: Classifier calibration section.
  // Reads divergence events from .prism-routing.jsonl for the week and
  // reports advised-vs-used gaps. Appends a short recommendation to
  // update-log.json under calibration_history[] so /prism-update can
  // surface the trend to the user.
  md.push('## Classifier Calibration (v2.7.0)');
  const calibration = computeCalibration();
  if (calibration) {
    md.push(`- Classifier decisions this week: ${fmtInt(calibration.total)}`);
    md.push(`- Advised tier distribution: opus ${calibration.advisedPct.opus}% / sonnet ${calibration.advisedPct.sonnet}% / haiku ${calibration.advisedPct.haiku}%`);
    if (calibration.hasActual) {
      md.push(`- Actual model used:          opus ${calibration.actualPct.opus}% / sonnet ${calibration.actualPct.sonnet}% / haiku ${calibration.actualPct.haiku}%`);
      md.push(`- Tier divergences logged: ${fmtInt(calibration.divergences)}`);
      if (calibration.topMismatches.length) {
        md.push('');
        md.push('### Top 5 advised ≠ actual');
        for (const m of calibration.topMismatches.slice(0, 5)) {
          md.push(`  - ${m.direction}: ${m.count}× (${m.note})`);
        }
      }
    }
    if (calibration.recommendation) {
      md.push('');
      md.push(`**Recommendation:** ${calibration.recommendation}`);
    }
    appendToUpdateLog(calibration, week);
  } else {
    md.push('_(no classifier decisions logged this week — hooks may not be firing)_');
  }

  const outPath = join(OUT_DIR, `${week}.md`);
  atomicWrite(outPath, md.join('\n'));
  log(`wrote ${outPath}`);
  log(`spend_rows=${totals.n} total_cost=${fmtUsd(totals.cost)} sessions=${sessionStats.n}`);
}

// v2.7.0: classifier calibration from .prism-routing.jsonl for the week.
function computeCalibration() {
  try {
    const H = prismHome();
    const logPath = join(H, '.claude', '.prism-routing.jsonl');
    if (!existsSync(logPath)) return null;
    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const advised = {opus: 0, sonnet: 0, haiku: 0};
    const actual = {opus: 0, sonnet: 0, haiku: 0};
    let divergences = 0;
    const mismatchKeys = new Map();
    for (const line of lines) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(ev.ts || '');
      if (!ts || ts < weekAgoMs) continue;
      if (ev.event === 'prompt_tier_router' && ev.tier && advised[ev.tier] != null) {
        advised[ev.tier]++;
      }
      if (ev.event === 'dispatch_guard_panel' || ev.event === 'dispatch_guard') {
        // v-fix (guard-telemetry-skew): dispatch_guard now also fires on silent
        // ALLOW paths (blocked:false) for visibility (RB-04). Those allow records
        // carry `tier`, but they are not a routing/enforcement decision — exclude
        // them (and ONLY them) so dispatch_guard_panel's pre-existing behavior
        // (counted regardless of blocked) and genuine dispatch_guard DENY records
        // (blocked:true) are unaffected — mirrors the minimal exclusion used in
        // tools/prism-telemetry-aggregate.mjs's tier_distribution counter.
        const isNewGuardAllow = ev.event === 'dispatch_guard' && ev.blocked === false;
        if (ev.tier && actual[ev.tier] != null && !isNewGuardAllow) actual[ev.tier]++;
      }
      if (ev.event === 'classifier_divergence' || ev.event === 'task_tier_divergence') {
        divergences++;
        const key = `${ev.sentinel_tier || ev.advised || '?'} → ${ev.plan_tier || ev.actual || '?'}`;
        mismatchKeys.set(key, (mismatchKeys.get(key) || 0) + 1);
      }
    }
    const total = advised.opus + advised.sonnet + advised.haiku;
    if (total === 0) return null;
    const pct = (o) => ({
      opus: ((o.opus / Math.max(1, o.opus + o.sonnet + o.haiku)) * 100).toFixed(1),
      sonnet: ((o.sonnet / Math.max(1, o.opus + o.sonnet + o.haiku)) * 100).toFixed(1),
      haiku: ((o.haiku / Math.max(1, o.opus + o.sonnet + o.haiku)) * 100).toFixed(1),
    });
    const actualTotal = actual.opus + actual.sonnet + actual.haiku;
    const hasActual = actualTotal > 0;
    const topMismatches = [...mismatchKeys.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({direction: k, count: v, note: 'see .prism-routing.jsonl for context'}));
    let recommendation = null;
    if (advised.opus / total > 0.5) {
      recommendation = `Classifier biased toward opus (${((advised.opus/total)*100).toFixed(0)}% opus-advised). Review OPUS_SIGNALS regex for over-matching in tools/lib/prism-tier-classify.mjs, or raise PRISM_TIER_THRESHOLDS.`;
    } else if (advised.haiku / total > 0.6) {
      recommendation = `Classifier biased toward haiku (${((advised.haiku/total)*100).toFixed(0)}% haiku-advised). Verify OPUS_SIGNALS are catching architecture and security prompts.`;
    } else if (divergences > total * 0.15) {
      recommendation = `High divergence rate (${divergences}/${total} = ${((divergences/total)*100).toFixed(1)}%). Sentinel and plan annotations disagree often — review which source is authoritative in your workflow.`;
    }
    return {
      total,
      advised,
      actual,
      advisedPct: pct(advised),
      actualPct: pct(actual),
      hasActual,
      divergences,
      topMismatches,
      recommendation,
    };
  } catch { return null; }
}

function appendToUpdateLog(calibration, week) {
  try {
    const H = prismHome();
    const logPath = join(H, '.claude', 'skills', 'prism-plan', 'references', 'update-log.json');
    if (!existsSync(logPath)) return;
    const data = JSON.parse(readFileSync(logPath, 'utf-8'));
    data.calibration_history = Array.isArray(data.calibration_history) ? data.calibration_history : [];
    data.calibration_history.push({
      week,
      ts: new Date().toISOString(),
      total: calibration.total,
      advised: calibration.advised,
      actual: calibration.actual,
      divergences: calibration.divergences,
      recommendation: calibration.recommendation,
    });
    // Keep last 26 entries (~6 months of weekly rollups).
    if (data.calibration_history.length > 26) {
      data.calibration_history = data.calibration_history.slice(-26);
    }
    atomicWrite(logPath, JSON.stringify(data, null, 2));
  } catch {}
}

const invokedDirectly = (process.argv[1] || '').endsWith('prism-rollup-weekly.mjs');
if (invokedDirectly) main();
