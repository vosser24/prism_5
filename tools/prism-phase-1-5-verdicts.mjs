#!/usr/bin/env node
// PRISM v4.4 — verdict log reader / aggregator / query CLI
//
// Usage:
//   prism-phase-1-5-verdicts                       → summarise last 30 days
//   prism-phase-1-5-verdicts --agent @code-reviewer → per-agent breakdown
//   prism-phase-1-5-verdicts --since 2026-05-01    → date range
//   prism-phase-1-5-verdicts --json                → raw JSON output
//   prism-phase-1-5-verdicts --uncited-rate        → per-agent UN-CITED rate (for ratchet)
//
// Reads ~/.claude/.prism-phase-1-5-verdicts.jsonl (append-only log written by
// hooks/prism-phase-1-5-oob.mjs). No network. Fail-open: missing log → exit 0
// with "no data".

import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const H = prismHome();
const LOG = join(H, '.claude', '.prism-phase-1-5-verdicts.jsonl');

const args = process.argv.slice(2);
let opts = {agent: null, since: null, json: false, uncitedRate: false};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--agent') opts.agent = args[++i];
  else if (a === '--since') opts.since = args[++i];
  else if (a === '--json') opts.json = true;
  else if (a === '--uncited-rate') opts.uncitedRate = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: prism-phase-1-5-verdicts [--agent <name>] [--since <YYYY-MM-DD>] [--json] [--uncited-rate]\n');
    process.exit(0);
  }
}

if (!existsSync(LOG)) {
  process.stdout.write('No verdict log yet (no OOB reviews have completed).\n');
  process.exit(0);
}

let entries;
try {
  entries = readFileSync(LOG, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
} catch (e) {
  process.stderr.write('Failed to read log: ' + e.message + '\n');
  process.exit(1);
}

let sinceMs;
if (opts.since) {
  sinceMs = new Date(opts.since).getTime();
  if (Number.isNaN(sinceMs)) {
    process.stderr.write(`Invalid --since date: ${opts.since}. Expected YYYY-MM-DD.\n`);
    process.exit(2);
  }
} else {
  sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
}
entries = entries.filter(e => new Date(e.completed_at).getTime() >= sinceMs);
if (opts.agent) {
  const target = opts.agent.startsWith('@') ? opts.agent : '@' + opts.agent;
  entries = entries.filter(e => e.specialist_name === target);
}

if (opts.uncitedRate) {
  const perAgent = {};
  for (const e of entries) {
    const a = e.specialist_name;
    if (!perAgent[a]) perAgent[a] = {total_claims: 0, un_cited: 0, dispatches: 0};
    perAgent[a].dispatches++;
    perAgent[a].total_claims += e.summary.total;
    perAgent[a].un_cited += e.summary.un_cited;
  }
  const rows = Object.entries(perAgent).map(([a, s]) => ({
    agent: a,
    dispatches: s.dispatches,
    total_claims: s.total_claims,
    un_cited: s.un_cited,
    un_cited_rate: s.total_claims > 0 ? (s.un_cited / s.total_claims) : 0,
  })).sort((a, b) => b.un_cited_rate - a.un_cited_rate);
  if (opts.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  else {
    process.stdout.write('UN-CITED rate per agent (last ' + (opts.since || '30d') + '):\n');
    for (const r of rows) {
      process.stdout.write('  ' + r.agent.padEnd(40) + String(r.dispatches).padStart(4) + ' dispatches  ' + (r.un_cited_rate * 100).toFixed(1) + '% UN-CITED  (' + r.un_cited + '/' + r.total_claims + ' claims)\n');
    }
  }
  process.exit(0);
}

if (opts.json) {
  process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
  process.exit(0);
}

// Default: rollup summary
const totals = {dispatches: entries.length, total_claims: 0, evidenced: 0, un_cited: 0, rejected: 0};
for (const e of entries) {
  totals.total_claims += e.summary.total;
  totals.evidenced += e.summary.evidenced;
  totals.un_cited += e.summary.un_cited;
  totals.rejected += e.summary.rejected;
}
process.stdout.write('OOB PHASE 1.5 verdicts (last ' + (opts.since || '30d') + (opts.agent ? ', agent ' + opts.agent : '') + '):\n');
process.stdout.write('  Dispatches: ' + totals.dispatches + '\n');
process.stdout.write('  Total claims: ' + totals.total_claims + '\n');
process.stdout.write('    EVIDENCED: ' + totals.evidenced + '\n');
process.stdout.write('    UN-CITED:  ' + totals.un_cited + '\n');
process.stdout.write('    REJECTED:  ' + totals.rejected + '\n');
process.exit(0);
