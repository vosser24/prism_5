#!/usr/bin/env node
// PRISM Recall (v2.1.28 Phase 3)
//
// Unified entry point. Intent classifier picks one of 3 tiers:
//   Tier 1 — Semantic: prism-kb-query.mjs (local router + NotebookLM)
//   Tier 2 — State: reads ~/.claude/.prism-global-state.json + project .prism-state.json
//   Tier 3 — Analytical: aggregates .prism-spend.jsonl + .prism-routing.jsonl + sessions/

import {readFileSync, existsSync, readdirSync} from 'fs';
import {join, dirname} from 'path';
import {spawnSync} from 'child_process';
import {fileURLToPath, pathToFileURL} from 'url';
// F4 cross-project knowledge surface (v5.0 Phase D). Augments Tier 1 only; the
// default 3-tier recall path is untouched (F4 §7).
import {queryKnowledge} from './lib/prism-kb-knowledge-query.mjs';
import {writeShareMarker, removeShareMarker} from './prism-kb-knowledge-indexer.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(H, '.claude');
const GLOBAL_STATE = join(CLAUDE_DIR, '.prism-global-state.json');
const SPEND_LOG = join(CLAUDE_DIR, '.prism-spend.jsonl');
const SESSIONS_DIR = join(CLAUDE_DIR, '.prism-sessions');
const ROUTING_LOG = join(CLAUDE_DIR, '.prism-routing.jsonl');
const DB_PATH = join(CLAUDE_DIR, '.prism.db');
const DB_HELPER = join(CLAUDE_DIR, 'tools', 'prism-db.mjs');

const TIER3_SIGNALS = [
  /\b(cost|spend|spent|spending|expense|expenses|tokens?|budget)\b/i,
  /\b(sum|total|how many|how much|average|avg|median|count of|max|min)\b/i,
  /\b(per\s+(day|hour|week|month|session|agent|model))\b/i,
  /\b(this\s+(day|week|month|hour|session)|today|yesterday|last\s+\d+)\b/i,
  /\b(top|most|expensive|cheapest|biggest|largest)\b/i,
  /\b(aggregate|rollup|roll-up|breakdown|distribution|histogram)\b/i,
];

const TIER2_SIGNALS = [
  /\b(current|my)\s+(turn|session|state|config|model|cwd|directory)\b/i,
  /\b(what\s+is\s+my|what.s\s+my|my\s+current)\b/i,
  /\b(session\s+id|session\s+start|turns|projects\s+visited|trivial\s+streak)\b/i,
  /\b(last\s+suggestion|invocation|last\s+invocation\s+turn|cost\s+budget)\b/i,
];

export function classify(query) {
  const q = String(query || '').trim();
  if (!q) return {tier: 1, reason: 'empty-default-semantic'};
  const t3 = TIER3_SIGNALS.filter(r => r.test(q)).length;
  const t2 = TIER2_SIGNALS.filter(r => r.test(q)).length;
  if (t3 > 0 && t3 >= t2) return {tier: 3, reason: `analytical:${t3}`};
  if (t2 > 0) return {tier: 2, reason: `state:${t2}`};
  return {tier: 1, reason: 'semantic-default'};
}

export function tier2Read(query, {projectRoot = process.cwd()} = {}) {
  const q = String(query || '').toLowerCase();
  const out = {query, facts: {}};
  try {
    if (existsSync(GLOBAL_STATE)) {
      const gs = JSON.parse(readFileSync(GLOBAL_STATE, 'utf-8'));
      out.facts.global_sessions_tracked = Object.keys(gs.sessions || {}).length;
      const sessions = Object.entries(gs.sessions || {}).sort((a, b) => String(b[1].session_start || '').localeCompare(String(a[1].session_start || '')));
      if (sessions.length) {
        const [id, s] = sessions[0];
        out.facts.current_session_id = id;
        out.facts.current_session_turns = s.turns || 0;
        out.facts.current_session_start = s.session_start;
        out.facts.projects_visited = s.projects_visited || [];
        out.facts.trivial_streak = s.trivial_streak || 0;
        out.facts.last_invocation_turn = s.last_invocation_turn || 0;
      }
    }
  } catch {}
  try {
    const sf = join(projectRoot, '.claude', '.prism-state.json');
    if (existsSync(sf)) {
      const ps = JSON.parse(readFileSync(sf, 'utf-8'));
      out.facts.project_turns = ps.turns || 0;
      out.facts.project_session_start = ps.session_start;
      out.facts.project_recent_suggestions = Object.keys(ps.recent_suggestions || {}).length;
    }
  } catch {}
  const keys = Object.keys(out.facts);
  const filtered = {};
  const relevant = keys.filter(k => {
    const short = k.replace(/_/g, ' ');
    return q.split(/\s+/).some(w => w.length >= 3 && (short.includes(w) || k.toLowerCase().includes(w)));
  });
  for (const k of (relevant.length ? relevant : keys)) filtered[k] = out.facts[k];
  out.facts = filtered;
  return out;
}

function parseJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function filterByTimeWindow(rows, q) {
  const lc = String(q || '').toLowerCase();
  const now = Date.now();
  const day = 86400 * 1000;
  let since = null;
  if (/\btoday\b/.test(lc))                                          since = now - day;
  else if (/\byesterday\b/.test(lc))                                 since = now - 2 * day;
  else if (/\bthis\s+week\b|\b(past|last)\s+7\s+days?\b/.test(lc))   since = now - 7 * day;
  else if (/\bthis\s+month\b|\b(past|last)\s+30\s+days?\b/.test(lc)) since = now - 30 * day;
  if (since == null) return rows;
  return rows.filter(r => {
    const ts = Date.parse(r.ts || r.timestamp || r.time);
    return Number.isFinite(ts) && ts >= since;
  });
}

function timeWindowSql(q) {
  const lc = String(q || '').toLowerCase();
  const now = Date.now();
  const day = 86400 * 1000;
  let since = null;
  if (/\btoday\b/.test(lc))                                          since = now - day;
  else if (/\byesterday\b/.test(lc))                                 since = now - 2 * day;
  else if (/\bthis\s+week\b|\b(past|last)\s+7\s+days?\b/.test(lc))   since = now - 7 * day;
  else if (/\bthis\s+month\b|\b(past|last)\s+30\s+days?\b/.test(lc)) since = now - 30 * day;
  return since == null ? null : new Date(since).toISOString();
}

async function loadDbHelper() {
  if (!existsSync(DB_PATH)) return null;
  try {
    return await import(pathToFileURL(DB_HELPER).href);
  } catch { return null; }
}

async function tier3AggregateSQL(query) {
  const helper = await loadDbHelper();
  if (!helper) return null;
  const q = String(query || '').toLowerCase();
  const out = {query, series: {}, backend: 'sqlite'};
  const sinceIso = timeWindowSql(q);
  let db;
  try { db = helper.openDb({readonly: true}); } catch { return null; }
  try {
    if (/\b(cost|spend|spending|expense|tokens?|budget)\b/.test(q) || /\b(sum|total|how much)\b/.test(q)) {
      const where = sinceIso ? 'WHERE ts >= ?' : '';
      const args = sinceIso ? [sinceIso] : [];
      const totals = db.prepare(
        `SELECT COUNT(*) AS rows_counted,
                COALESCE(SUM(cost_usd),0) AS total_cost_usd,
                COALESCE(SUM(tokens),0) AS total_tokens
         FROM spend ${where}`
      ).get(...args);
      const byModel = db.prepare(
        `SELECT COALESCE(model,'unknown') AS k, SUM(cost_usd) AS v
         FROM spend ${where} GROUP BY k ORDER BY v DESC`
      ).all(...args);
      const byAgent = db.prepare(
        `SELECT COALESCE(agent,'unknown') AS k, SUM(cost_usd) AS v
         FROM spend ${where} GROUP BY k ORDER BY v DESC LIMIT 10`
      ).all(...args);
      out.series.spend = {
        rows_counted: totals.rows_counted,
        total_cost_usd: Number((totals.total_cost_usd || 0).toFixed(4)),
        total_tokens: Number(totals.total_tokens || 0),
        by_model: Object.fromEntries(byModel.map(r => [r.k, Number((r.v || 0).toFixed(4))])),
        by_agent: Object.fromEntries(byAgent.map(r => [r.k, Number((r.v || 0).toFixed(4))])),
      };
    }

    if (/\b(sessions?|projects?|activity)\b/.test(q) || /\b(how many|count)\b/.test(q)) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      const recent = db.prepare('SELECT session_id FROM sessions ORDER BY end_ts DESC LIMIT 5').all();
      out.series.sessions = {
        total_session_files: total.n,
        recent_5: recent.map(r => r.session_id),
      };
    }

    if (/\b(model|routing|haiku|sonnet|opus|tier|classifier)\b/.test(q)) {
      const where = sinceIso ? 'WHERE ts >= ?' : '';
      const args = sinceIso ? [sinceIso] : [];
      const count = db.prepare(`SELECT COUNT(*) AS n FROM model_routing ${where}`).get(...args);
      const tiers = db.prepare(
        `SELECT COALESCE(tier_detected,'none') AS k, COUNT(*) AS n
         FROM model_routing ${where} GROUP BY k`
      ).all(...args);
      const actions = db.prepare(
        `SELECT COALESCE(action,'none') AS k, COUNT(*) AS n
         FROM model_routing ${where} GROUP BY k`
      ).all(...args);
      const tierCount = {haiku: 0, sonnet: 0, opus: 0};
      for (const r of tiers) if (tierCount[r.k] != null) tierCount[r.k] = r.n;
      const actionCount = Object.fromEntries(actions.map(r => [r.k, r.n]));
      out.series.model_routing = {
        rows_counted: count.n,
        by_tier: tierCount,
        by_action: actionCount,
      };
    }
  } finally {
    try { helper.close(db); } catch {}
  }
  return out;
}

function tier3AggregateJSONL(query) {
  const q = String(query || '').toLowerCase();
  const out = {query, series: {}, backend: 'jsonl'};
  const spendRows = parseJsonl(SPEND_LOG);
  const routingRows = parseJsonl(ROUTING_LOG);

  const scopedSpend = filterByTimeWindow(spendRows, q);
  if (/\b(cost|spend|spending|expense|tokens?|budget)\b/.test(q) || /\b(sum|total|how much)\b/.test(q)) {
    let totalCost = 0, totalTokens = 0;
    const byModel = {}, byAgent = {};
    for (const r of scopedSpend) {
      const c = Number(r.cost_usd || r.cost || r.usd || 0);
      totalCost += c;
      totalTokens += Number(r.tokens || 0);
      const model = r.model || 'unknown';
      const agent = r.agent || r.agent_name || 'unknown';
      byModel[model] = (byModel[model] || 0) + c;
      byAgent[agent] = (byAgent[agent] || 0) + c;
    }
    out.series.spend = {
      rows_counted: scopedSpend.length,
      total_cost_usd: Number(totalCost.toFixed(4)),
      total_tokens: totalTokens,
      by_model: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, Number(v.toFixed(4))])),
      by_agent: Object.fromEntries(Object.entries(byAgent).slice(0, 10).map(([k, v]) => [k, Number(v.toFixed(4))])),
    };
  }

  if (/\b(sessions?|projects?|activity)\b/.test(q) || /\b(how many|count)\b/.test(q)) {
    const sessions = existsSync(SESSIONS_DIR)
      ? readdirSync(SESSIONS_DIR).filter(n => n.endsWith('.md'))
      : [];
    out.series.sessions = {
      total_session_files: sessions.length,
      recent_5: sessions.slice(-5),
    };
  }

  if (/\b(model|routing|haiku|sonnet|opus|tier|classifier)\b/.test(q)) {
    const scoped = filterByTimeWindow(routingRows, q);
    const tierCount = {haiku: 0, sonnet: 0, opus: 0};
    const actionCount = {};
    for (const r of scoped) {
      if (r.tier_detected && tierCount[r.tier_detected] != null) tierCount[r.tier_detected]++;
      actionCount[r.action] = (actionCount[r.action] || 0) + 1;
    }
    out.series.model_routing = {
      rows_counted: scoped.length,
      by_tier: tierCount,
      by_action: actionCount,
    };
  }

  return out;
}

export async function tier3Aggregate(query) {
  const sql = await tier3AggregateSQL(query);
  return sql || tier3AggregateJSONL(query);
}

function tier1Query(query, {limitDomains = 2, json = false} = {}) {
  const here = dirname(fileURLToPath(import.meta.url));
  const queryPath = join(here, 'prism-kb-query.mjs');
  const args = [queryPath, query, '--limit-domains', String(limitDomains)];
  if (json) args.push('--json');
  const r = spawnSync('node', args, {encoding: 'utf-8', timeout: 5 * 60 * 1000});
  if (r.status !== 0) return {error: r.stderr || r.stdout || 'tier-1 delegate failed'};
  if (json) {
    try { return JSON.parse(r.stdout); } catch { return {raw: r.stdout}; }
  }
  return {text: r.stdout};
}

export async function recall(query, {forcedTier = null, json = false, verbose = false, crossProject = false, noRerank = false} = {}) {
  const c = forcedTier ? {tier: forcedTier, reason: 'forced'} : classify(query);
  let result = null;
  if (c.tier === 1)      result = tier1Query(query, {json});
  else if (c.tier === 2) result = tier2Read(query);
  else if (c.tier === 3) result = await tier3Aggregate(query);
  const envelope = {query, classification: c, result};
  // F4 §7: --cross-project augments Tier 1 ONLY. Tiers 2/3 unaffected. Without the
  // flag, this block is skipped entirely and recall behaves exactly as before.
  if (crossProject && c.tier === 1) {
    const H = process.env.HOME || process.env.USERPROFILE;
    envelope.crossProject = queryKnowledge(query, {home: H, crossProject: true, rerank: !noRerank});
  }
  if (json) return envelope;
  return formatEnvelope(envelope, {verbose});
}

function formatEnvelope(env, {verbose = false} = {}) {
  const lines = [];
  if (verbose) lines.push(`[classify] tier=${env.classification.tier} reason=${env.classification.reason}`);
  const r = env.result;
  if (env.classification.tier === 1) {
    if (r && r.text) lines.push(r.text.trimEnd());
    else if (r && r.error) lines.push(`ERROR: ${r.error}`);
    else lines.push('(no tier-1 result)');
  } else if (env.classification.tier === 2) {
    lines.push('State:');
    const entries = Object.entries((r && r.facts) || {});
    if (!entries.length) lines.push('  (no state facts matched)');
    for (const [k, v] of entries) {
      const vs = Array.isArray(v) ? v.join(', ') : String(v);
      lines.push(`  ${k}: ${vs}`);
    }
  } else if (env.classification.tier === 3) {
    lines.push('Aggregates:');
    const series = (r && r.series) || {};
    for (const [name, obj] of Object.entries(series)) {
      lines.push(`  [${name}]`);
      for (const [k, v] of Object.entries(obj)) {
        const vs = typeof v === 'object' ? JSON.stringify(v) : String(v);
        lines.push(`    ${k}: ${vs}`);
      }
    }
    if (!Object.keys(series).length) lines.push('  (no aggregates matched)');
  }
  // F4 cross-project block (only present when --cross-project + Tier 1). Honest
  // labeling: print the label string from queryKnowledge, never 'embeddings'/'vector'.
  if (env.crossProject) {
    const cp = env.crossProject;
    lines.push('');
    lines.push(`Cross-project knowledge ${cp.label}:`.trimEnd());
    if (!cp.results || !cp.results.length) {
      lines.push('  (none)');
    } else {
      for (const r of cp.results) {
        lines.push(`  [${r.project_label}] ${r.type}: ${r.title}`);
        if (r.source_path) lines.push(`    ${r.source_path}`);
      }
    }
  }
  return lines.join('\n');
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const verbose = args.includes('--verbose');
const crossProject = args.includes('--cross-project');
const noRerank = args.includes('--no-rerank');
const shareIdx = args.indexOf('--share-project');
const unshareProject = args.includes('--unshare-project');
let forcedTier = null;
const ti = args.indexOf('--tier');
if (ti >= 0 && args[ti + 1]) { const n = parseInt(args[ti + 1], 10); if (n >= 1 && n <= 3) forcedTier = n; }
const skip = new Set(['--json', '--verbose', '--cross-project', '--no-rerank', '--unshare-project', '--share-project']);
if (ti >= 0) { skip.add(args[ti]); skip.add(args[ti + 1]); }
// --share-project consumes its following type tokens (anything until the next --flag).
const shareTypes = [];
if (shareIdx >= 0) {
  for (let i = shareIdx + 1; i < args.length && !args[i].startsWith('--'); i++) {
    shareTypes.push(args[i]);
    skip.add(args[i]);
  }
}
const positional = args.filter(a => !skip.has(a) && !a.startsWith('--'));
const query = positional.join(' ').trim();

const argv1 = process.argv[1] || '';
const invokedDirectly = (argv1 && import.meta.url === `file://${argv1.replace(/\\/g, '/')}`) || argv1.endsWith('prism-recall.mjs');
if (invokedDirectly) {
  // Management actions (F4 §7): share/unshare the current project's corpus. These
  // do not run a recall query — they mutate .prism-kb-share.json and report.
  if (shareIdx >= 0) {
    const obj = writeShareMarker(process.cwd(), shareTypes);
    console.log(`Shared cross-project corpus types: ${obj.shared_types.join(', ')}`);
    console.log(`Wrote: ${join(process.cwd(), '.prism-kb-share.json')}`);
  } else if (unshareProject) {
    const removed = removeShareMarker(process.cwd());
    console.log(removed
      ? `Removed share marker: ${join(process.cwd(), '.prism-kb-share.json')}`
      : 'No share marker to remove (project was not sharing).');
  } else {
    if (!query) {
      console.error('Usage: prism-recall.mjs "<query>" [--json] [--verbose] [--tier 1|2|3] [--cross-project] [--no-rerank]');
      console.error('       prism-recall.mjs --share-project [type1 type2 ...] | --unshare-project');
      process.exit(1);
    }
    const out = await recall(query, {forcedTier, json, verbose, crossProject, noRerank});
    if (json) process.stdout.write(JSON.stringify(out, null, 2));
    else console.log(out);
  }
}
