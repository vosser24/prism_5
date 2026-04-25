#!/usr/bin/env node
// PRISM v3.6.0 audit-run analyzer.
//
// Reads the synthetic audit-run JSONL produced by tools/prism-audit-runner.mjs
// (one line per scenario with timing/pass-fail/hooks-fired) and optionally a
// real-session routing log (~/.claude/.prism-routing.jsonl). Produces a
// structured markdown report on stdout covering:
//   - Coverage matrix (capability -> exercised? pass/fail)
//   - Timing distribution per hook (min/p50/p95/p99/max)
//   - Trigger correlation (which hooks fired per scenario)
//   - Failures (if any)
//   - Anomalies (classifier divergence, parallel_guard violations,
//     panel hallucinations, force-opus events, ...)
//   - Real-session correlation (if routing.jsonl provided)
//   - Verdict (PASS / PASS-WITH-WARNINGS / FAIL)
//
// Style mirrors tests/v3/analyze-log.mjs.
//
// Usage:
//   node tests/v3/analyze-audit.mjs <audit-run.jsonl> [routing.jsonl]
//
// Audit-run JSONL schema (one object per line):
//   {
//     "scenario_id": "CLF-001",
//     "category": "Classifier - keyword-floor",
//     "capability": "classifier:keyword-floor",
//     "expected": {"tier":"haiku","summon_panel":false,"source":"keyword-floor"},
//     "observed": {"tier":"haiku","summon_panel":false,"source":"keyword-floor"},
//     "pass": true,
//     "duration_ms": 92,
//     "hooks_fired": [
//       {"hook":"prism-prompt-tier-router","duration_ms":92},
//       {"hook":"prism-mutation-guard","duration_ms":24}
//     ],
//     "events": [{"event":"...", ...}],
//     "error": null,
//     "ts": "2026-04-25T..."
//   }

import {readFileSync, existsSync} from 'node:fs';

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--help') || args[0] === '-h') {
  console.error('Usage: node tests/v3/analyze-audit.mjs <audit-run.jsonl> [routing.jsonl]');
  console.error('');
  console.error('  <audit-run.jsonl>   Output of tools/prism-audit-runner.mjs');
  console.error('  [routing.jsonl]     Optional: ~/.claude/.prism-routing.jsonl for real-session correlation');
  process.exit(2);
}

const auditPath = args[0];
const routingPath = args[1] || null;

if (!existsSync(auditPath)) {
  console.error(`FAIL: audit-run JSONL not found at ${auditPath}`);
  console.error('Run tools/prism-audit-runner.mjs first:');
  console.error('  node tools/prism-audit-runner.mjs --output ' + auditPath);
  process.exit(1);
}

function parseJsonl(path) {
  const raw = readFileSync(path, 'utf-8');
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const scenarios = parseJsonl(auditPath);

if (scenarios.length === 0) {
  console.error('FAIL: audit-run JSONL is empty or unparseable');
  process.exit(1);
}

// ---------- Coverage matrix ----------
// Group scenarios by category; count pass/fail.
const categories = new Map();
for (const s of scenarios) {
  const cat = s.category || s.capability || 'uncategorized';
  if (!categories.has(cat)) categories.set(cat, {scenarios: 0, pass: 0, fail: 0});
  const row = categories.get(cat);
  row.scenarios += 1;
  if (s.pass) row.pass += 1; else row.fail += 1;
}

// ---------- Timing distribution ----------
// Per-hook latency stats from hooks_fired arrays.
const hookTimings = new Map();
for (const s of scenarios) {
  const hf = Array.isArray(s.hooks_fired) ? s.hooks_fired : [];
  for (const h of hf) {
    if (!h || !h.hook || typeof h.duration_ms !== 'number') continue;
    if (!hookTimings.has(h.hook)) hookTimings.set(h.hook, []);
    hookTimings.get(h.hook).push(h.duration_ms);
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const hookStats = [...hookTimings.entries()].map(([hook, samples]) => ({
  hook,
  count: samples.length,
  min: Math.min(...samples),
  p50: pct(samples, 50),
  p95: pct(samples, 95),
  p99: pct(samples, 99),
  max: Math.max(...samples),
})).sort((a, b) => b.p95 - a.p95);

// ---------- Failures ----------
const failures = scenarios.filter(s => !s.pass);

// ---------- Anomalies ----------
const anomalies = {
  classifier_divergence: 0,
  parallel_guard_violation: 0,
  panel_hallucination: 0,
  force_opus: 0,
  guard_deny: 0,
  skill_trigger_advisory: 0,
};
for (const s of scenarios) {
  const evs = Array.isArray(s.events) ? s.events : [];
  for (const e of evs) {
    if (!e) continue;
    if (e.event === 'classifier_divergence') anomalies.classifier_divergence += 1;
    if (e.event === 'parallel_guard_block' || e.event === 'pgroup_violation') anomalies.parallel_guard_violation += 1;
    if (e.event === 'panel_hallucination_detected') anomalies.panel_hallucination += 1;
    if (e.force_opus === true || e.source === 'force-opus') anomalies.force_opus += 1;
    if (e.action && String(e.action).toLowerCase().includes('deny')) anomalies.guard_deny += 1;
    if (e.event === 'skill_trigger_advisory') anomalies.skill_trigger_advisory += 1;
  }
}

// ---------- Totals ----------
const totalScenarios = scenarios.length;
const totalPass = scenarios.filter(s => s.pass).length;
const totalFail = totalScenarios - totalPass;
const totalDurationMs = scenarios.reduce((acc, s) => acc + (s.duration_ms || 0), 0);
const totalDurationS = (totalDurationMs / 1000).toFixed(1);

// ---------- Real-session correlation (optional) ----------
let realSessionSection = null;
if (routingPath && existsSync(routingPath)) {
  const real = parseJsonl(routingPath);
  if (real.length > 0) {
    // For each scenario with an expected tier+source, check if the real log
    // contains at least one event matching the same (tier, source).
    let matched = 0;
    let total = 0;
    const realKeys = new Set();
    for (const e of real) {
      if (e.tier && e.source) realKeys.add(`${e.tier}|${e.source}`);
    }
    for (const s of scenarios) {
      const exp = s.expected || {};
      if (!exp.tier || !exp.source) continue;
      total += 1;
      if (realKeys.has(`${exp.tier}|${exp.source}`)) matched += 1;
    }
    const pctMatch = total > 0 ? ((matched / total) * 100).toFixed(1) : 'n/a';
    realSessionSection = {events: real.length, total, matched, pctMatch};
  }
}

// ---------- Verdict ----------
let verdict;
if (totalFail === 0 && anomalies.panel_hallucination === 0) verdict = 'PASS';
else if (totalFail === 0) verdict = 'PASS-WITH-WARNINGS';
else verdict = 'FAIL';

// ---------- Output ----------
const out = [];
const ts = new Date().toISOString();
out.push(`# PRISM v3.6.0 Audit Report -- ${ts}`);
out.push('');
out.push(`Run: ${totalScenarios} scenarios across ${categories.size} categories. Total wall-time: ${totalDurationS}s.`);
out.push('');
out.push(`- Audit-run JSONL: \`${auditPath}\``);
if (routingPath) out.push(`- Routing log: \`${routingPath}\``);
out.push(`- Pass: **${totalPass}** | Fail: **${totalFail}**`);
out.push('');

// Coverage matrix
out.push('## Coverage matrix (capability -> exercised?)');
out.push('');
out.push('| Capability | Scenarios | Pass | Fail | Coverage |');
out.push('|---|---|---|---|---|');
const sortedCats = [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [cat, row] of sortedCats) {
  const cov = row.fail === 0 ? 'PASS' : 'FAIL';
  out.push(`| ${cat} | ${row.scenarios} | ${row.pass} | ${row.fail} | ${cov} |`);
}
out.push('');

// Timing distribution
out.push('## Timing distribution');
out.push('');
if (hookStats.length === 0) {
  out.push('No hook timing samples in audit-run JSONL.');
} else {
  out.push('| Hook | Count | Min | p50 | p95 | p99 | Max |');
  out.push('|---|---|---|---|---|---|---|');
  for (const s of hookStats) {
    out.push(`| ${s.hook} | ${s.count} | ${s.min}ms | ${s.p50}ms | ${s.p95}ms | ${s.p99}ms | ${s.max}ms |`);
  }
  out.push('');
  out.push('(Sorted by p95 descending -- slowest first.)');
}
out.push('');

// Trigger correlation
out.push('## Trigger correlation (which hooks fire on which scenarios)');
out.push('');
const trigRows = scenarios.slice(0, 80).map(s => {
  const hooks = Array.isArray(s.hooks_fired) ? s.hooks_fired.map(h => h.hook).join(' -> ') : '(none)';
  return `- **${s.scenario_id || '?'}** (${s.category || s.capability || '?'}): ${hooks || '(no hooks fired)'}`;
});
if (trigRows.length === 0) out.push('No scenarios.');
else out.push(...trigRows);
if (scenarios.length > 80) out.push(`- ... and ${scenarios.length - 80} more scenarios`);
out.push('');

// Failures
out.push('## Failures');
out.push('');
if (failures.length === 0) {
  out.push('None. All scenarios passed.');
} else {
  for (const f of failures) {
    out.push(`### ${f.scenario_id || '?'} -- ${f.category || f.capability || '?'}`);
    out.push('');
    out.push('- Expected: `' + JSON.stringify(f.expected || null) + '`');
    out.push('- Observed: `' + JSON.stringify(f.observed || null) + '`');
    if (f.error) out.push(`- Error: ${f.error}`);
    out.push('');
  }
}
out.push('');

// Anomalies
out.push('## Anomalies');
out.push('');
out.push(`- ${anomalies.classifier_divergence} classifier divergences detected`);
out.push(`- ${anomalies.parallel_guard_violation} parallel_guard violations`);
out.push(`- ${anomalies.panel_hallucination} panel hallucinations caught`);
out.push(`- ${anomalies.force_opus} force-opus events`);
out.push(`- ${anomalies.guard_deny} guard-deny actions`);
out.push(`- ${anomalies.skill_trigger_advisory} skill-trigger advisories`);
out.push('');

// Real-session correlation
out.push('## Real-session correlation');
out.push('');
if (!routingPath) {
  out.push('Skipped -- no routing.jsonl path provided. Pass `~/.claude/.prism-routing.jsonl` as the second argument to enable.');
} else if (!existsSync(routingPath)) {
  out.push(`Skipped -- ${routingPath} does not exist. Real-session correlation requires Claude Code to have written the routing log.`);
} else if (!realSessionSection) {
  out.push('Routing log present but empty or unparseable.');
} else {
  out.push(`- Routing-log events: **${realSessionSection.events}**`);
  out.push(`- Synthetic scenarios with matchable (tier, source): **${realSessionSection.total}**`);
  out.push(`- Matched in real session: **${realSessionSection.matched}** (${realSessionSection.pctMatch}%)`);
  out.push('');
  out.push('Interpretation: a high match rate indicates real-world classifier behavior aligns with synthetic expectations. Low rates suggest either (a) the user has not exercised those code paths recently, or (b) the classifier is drifting.');
}
out.push('');

// Verdict
out.push('## Verdict');
out.push('');
out.push(`**${verdict}**`);
out.push('');
const summaryBits = [];
summaryBits.push(`${categories.size} capabilities exercised across ${totalScenarios} scenarios.`);
summaryBits.push(`${totalFail} failures.`);
if (anomalies.panel_hallucination > 0) summaryBits.push(`${anomalies.panel_hallucination} panel hallucinations -- run /prism-index and re-run failing panels.`);
if (anomalies.parallel_guard_violation > 0) summaryBits.push(`${anomalies.parallel_guard_violation} parallel-guard violations -- review pgroup dispatch.`);
if (totalFail === 0 && anomalies.panel_hallucination === 0) summaryBits.push('No anomalies that block release.');
out.push(summaryBits.join(' '));
out.push('');
out.push('Recommended next steps:');
if (totalFail > 0) out.push('- Investigate failures listed in the Failures section above.');
if (anomalies.panel_hallucination > 0) out.push('- Run `/prism-index` to populate resource-index, then re-run panel scenarios.');
if (hookStats.length > 0 && hookStats[0].p95 > 500) out.push(`- Investigate ${hookStats[0].hook} -- p95 of ${hookStats[0].p95}ms exceeds 500ms threshold.`);
if (!routingPath) out.push('- Optionally re-run with a real-session routing log to cross-check synthetic vs real.');
if (totalFail === 0 && anomalies.panel_hallucination === 0) out.push('- Ship it. All capabilities exercised cleanly.');
out.push('');

console.log(out.join('\n'));
