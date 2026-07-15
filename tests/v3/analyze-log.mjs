#!/usr/bin/env node
// PRISM v3.0 log analyzer.
//
// Reads ~/.claude/.prism-routing.jsonl (or a path passed as $1), emits a
// structured markdown report of tier distribution, guard fires, force
// overrides, classifier sources, and any flagged anomalies (pgroup
// violations, classifier divergence, force-opus usage).
//
// Usage:
//   node tests/v3/analyze-log.mjs                           # uses default path
//   node tests/v3/analyze-log.mjs /path/to/routing.jsonl    # explicit path
//   node tests/v3/analyze-log.mjs --since 2026-04-24T00:00:00Z  # filter by time
//
// Output: markdown on stdout. Redirect to file to save.

import {readFileSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const HOME = homedir();
const DEFAULT_LOG = join(HOME, '.claude', '.prism-routing.jsonl');

const args = process.argv.slice(2);
let logPath = DEFAULT_LOG;
let since = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since' && args[i + 1]) {
    since = new Date(args[i + 1]);
    i++;
  } else if (!args[i].startsWith('--')) {
    logPath = args[i];
  }
}

if (!existsSync(logPath)) {
  console.error(`FAIL: log not found at ${logPath}`);
  process.exit(1);
}

const raw = readFileSync(logPath, 'utf-8');
const events = raw.split('\n').filter(Boolean).map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(e => e && (!since || (e.ts && new Date(e.ts) >= since)));

if (events.length === 0) {
  console.log('# PRISM v3.0 Log Analysis\n\nNo events in log' + (since ? ` since ${since.toISOString()}` : '') + '. Run some prompts first.\n');
  process.exit(0);
}

// Distributions
const tiers = {haiku: 0, sonnet: 0, opus: 0, unknown: 0};
const sources = {};
const actions = {};
const summonPanel = {true: 0, false: 0};
const forceOpus = [];
const pgroupViolations = [];
const classifierDivergence = [];
const guardDenies = [];
const subagentBypasses = {parent_tool_use_id: 0, env: 0, 'sentinel.dispatched': 0};
// v3.1.0: new event types from parallel-guard, panel-guard, skill-trigger-guard
const v31Events = {
  panel_hallucination_detected: 0,
  skill_trigger_advisory: 0,
  policy_loaded: 0,
  parallel_guard_block: 0,
  parallel_guard_advise: 0,
};

for (const e of events) {
  // Tier counts (from router events)
  if (e.tier) tiers[e.tier] = (tiers[e.tier] || 0) + 1;
  // Sources
  if (e.source) sources[e.source] = (sources[e.source] || 0) + 1;
  // Actions
  if (e.action) actions[e.action] = (actions[e.action] || 0) + 1;
  // summon_panel
  if (typeof e.summon_panel === 'boolean') summonPanel[e.summon_panel] = (summonPanel[e.summon_panel] || 0) + 1;
  // force_opus events
  if (e.force_opus === true || e.source === 'force-opus') forceOpus.push(e);
  // pgroup violations (future hook target)
  if (e.event === 'pgroup_violation') pgroupViolations.push(e);
  // Classifier divergence
  if (e.event === 'classifier_divergence') classifierDivergence.push(e);
  // Guard denies
  if (e.action && String(e.action).toLowerCase().includes('deny')) guardDenies.push(e);
  // Subagent bypasses (agent-model-guard passthrough v2.9.0)
  if (e.action === 'passthrough-subagent-context' && e.reason) {
    subagentBypasses[e.reason] = (subagentBypasses[e.reason] || 0) + 1;
  }
  // v3.1.0 hook events
  if (e.event && Object.prototype.hasOwnProperty.call(v31Events, e.event)) {
    v31Events[e.event] = (v31Events[e.event] || 0) + 1;
  }
}

// Time range
const first = events[0].ts || 'unknown';
const last = events[events.length - 1].ts || 'unknown';

// Output
const out = [];
out.push('# PRISM v3.0 Log Analysis');
out.push('');
out.push(`- Log: \`${logPath}\``);
out.push(`- Events analyzed: **${events.length}**`);
out.push(`- Time range: ${first} → ${last}`);
if (since) out.push(`- Filter: since ${since.toISOString()}`);
out.push('');

out.push('## Tier distribution');
out.push('');
out.push('| Tier | Count | % |');
out.push('|---|---|---|');
const tTotal = Object.values(tiers).reduce((a, b) => a + b, 0);
for (const [t, c] of Object.entries(tiers)) {
  if (c > 0) out.push(`| ${t} | ${c} | ${tTotal > 0 ? ((c / tTotal) * 100).toFixed(1) : 0}% |`);
}
out.push('');

out.push('## Classifier sources');
out.push('');
out.push('| Source | Count |');
out.push('|---|---|');
for (const [s, c] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
  out.push(`| ${s} | ${c} |`);
}
out.push('');
if (sources['keyword-floor'] && sources['keyword-floor'] > 0 && !sources['opus'] && !sources['sonnet-fallback']) {
  out.push('> ⚠ Classifier running in keyword-floor-only mode. ANTHROPIC_API_KEY may be missing from hook env. See INSTALL.md §2.7.');
  out.push('');
}

out.push('## Panel-summoning turns');
out.push('');
out.push(`- Novel/architecture (summon_panel=true): **${summonPanel.true || 0}**`);
out.push(`- Routine (summon_panel=false): **${summonPanel.false || 0}**`);
out.push('');

out.push('## Force-opus usage');
out.push('');
if (forceOpus.length === 0) {
  out.push('None. Users did not use the `!opus-force:` escape hatch in this log window.');
} else {
  out.push(`${forceOpus.length} force-opus events:`);
  out.push('');
  for (const f of forceOpus.slice(0, 10)) {
    out.push(`- ${f.ts || '(no ts)'}: session=${f.session_id || '?'}, rationale=${f.rationale || '(none)'}`);
  }
  if (forceOpus.length > 10) out.push(`- ... and ${forceOpus.length - 10} more`);
}
out.push('');

out.push('## Guard denies');
out.push('');
if (guardDenies.length === 0) {
  out.push('None. No guard-deny actions logged.');
} else {
  out.push(`${guardDenies.length} deny events:`);
  out.push('');
  const denyBreakdown = {};
  for (const d of guardDenies) {
    const key = d.action || 'unknown';
    denyBreakdown[key] = (denyBreakdown[key] || 0) + 1;
  }
  for (const [k, v] of Object.entries(denyBreakdown).sort((a, b) => b[1] - a[1])) {
    out.push(`- ${k}: ${v}`);
  }
}
out.push('');

out.push('## Subagent-context bypasses (v2.9.0 three-path parity)');
out.push('');
const bypassTotal = Object.values(subagentBypasses).reduce((a, b) => a + b, 0);
if (bypassTotal === 0) {
  out.push('No subagent-context bypasses logged. Either no subagent dispatches happened, or the v2.9.0 fix is not triggering (worth investigating if subagent chains failed with unexpected denies).');
} else {
  for (const [r, c] of Object.entries(subagentBypasses)) {
    if (c > 0) out.push(`- \`${r}\`: ${c} bypasses`);
  }
  out.push('');
  out.push(`Total: ${bypassTotal}`);
}
out.push('');

out.push('## Classifier divergence events');
out.push('');
if (classifierDivergence.length === 0) {
  out.push('None. Sentinel tier matched re-classification in every check.');
} else {
  out.push(`⚠ ${classifierDivergence.length} divergence events — sentinel tier disagreed with agent-model-guard's re-classification. Review weekly rollup for systematic drift.`);
}
out.push('');

out.push('## Pgroup violations (future hook target)');
out.push('');
if (pgroupViolations.length === 0) {
  out.push('None logged. NOTE: pgroup-violation detection is v2.10 target; absence here may mean detection isn\'t wired yet, not that zero violations occurred.');
} else {
  out.push(`⚠ ${pgroupViolations.length} sequential dispatches of pgroup-marked tasks. Each costs a fresh prompt-cache prime. See weekly rollup.`);
}
out.push('');

out.push('## v3.1.0 hook events (parallel-guard / panel-guard / skill-trigger-guard / policy)');
out.push('');
const v31Total = Object.values(v31Events).reduce((a, b) => a + b, 0);
if (v31Total === 0) {
  out.push('No v3.1.0 hook events logged in this window. Either v3.1 hooks not yet installed, or no triggers fired.');
} else {
  out.push('| Event | Count |');
  out.push('|---|---|');
  for (const [k, c] of Object.entries(v31Events)) {
    if (c > 0) out.push(`| ${k} | ${c} |`);
  }
  out.push('');
  if (v31Events.panel_hallucination_detected > 0) {
    out.push(`> ⚠ ${v31Events.panel_hallucination_detected} panels with unindexed personas detected. Run /prism-index to populate the resource-index, then re-run those panels.`);
    out.push('');
  }
  if (v31Events.parallel_guard_block > 0) {
    out.push(`> ${v31Events.parallel_guard_block} parallel-guard blocks fired (sequential dispatch of pgroup-tagged tasks). T10.3 enforcement is working.`);
    out.push('');
  }
  if (v31Events.skill_trigger_advisory > 0) {
    out.push(`> ${v31Events.skill_trigger_advisory} skill-trigger advisories — prompts that matched a known skill-trigger regex but the skill wasn't auto-invoked. Review to see if you have an installed skill being underused.`);
    out.push('');
  }
  if (v31Events.policy_loaded > 0) {
    out.push(`> ${v31Events.policy_loaded} sessions loaded a centrally-managed policy from ~/.claude/prism-policy.json.`);
    out.push('');
  }
}
out.push('');

out.push('## Action breakdown');
out.push('');
out.push('| Action | Count |');
out.push('|---|---|');
for (const [a, c] of Object.entries(actions).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  out.push(`| ${a} | ${c} |`);
}
out.push('');

// Verdict
out.push('## Verdict (heuristic)');
out.push('');
const checks = [];
if (sources['opus'] && sources['opus'] > 0) checks.push('✅ Classifier API reachable (opus source present)');
else if (sources['keyword-floor'] > 0) checks.push('⚠ Classifier keyword-floor only (no API-backed classifications)');
if (tiers.haiku > 0 && tiers.sonnet > 0 && tiers.opus > 0) checks.push('✅ All three tiers observed');
else checks.push(`⚠ Tier coverage partial: haiku=${tiers.haiku}, sonnet=${tiers.sonnet}, opus=${tiers.opus}`);
if (guardDenies.length > 0) checks.push('✅ Guards firing (real enforcement observed)');
else checks.push('⚠ No guard denies logged — either clean session or guards not firing when they should');
if (bypassTotal > 0) checks.push('✅ Subagent-context bypass working (v2.9.0 parity confirmed)');
if (pgroupViolations.length === 0 && actions['parallel_opportunity']) checks.push('✅ Parallel opportunities detected');

for (const c of checks) out.push(`- ${c}`);
out.push('');

console.log(out.join('\n'));
