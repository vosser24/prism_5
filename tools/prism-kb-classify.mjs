#!/usr/bin/env node
// PRISM KB Classify (v2.1.26 Phase 2.7)
//
// Read-only reporter. Prints every indexed entry's assigned domain and lets
// you focus on one domain or review low-confidence classifications before
// they reach cloud.
//
// Usage:
//   node ~/.claude/tools/prism-kb-classify.mjs                 # full report
//   node ~/.claude/tools/prism-kb-classify.mjs --domain misc   # one domain
//   node ~/.claude/tools/prism-kb-classify.mjs --low-confidence
//   node ~/.claude/tools/prism-kb-classify.mjs --json

import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import {DOMAINS, summarize} from './prism-kb-domains.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const INDEX_PATH = join(H, '.claude', '.prism-kb-index.json');

const args = process.argv.slice(2);
let domainFilter = null;
const di = args.indexOf('--domain');
if (di >= 0 && args[di + 1]) domainFilter = args[di + 1];
const lowOnly = args.includes('--low-confidence');
const json = args.includes('--json');

if (!existsSync(INDEX_PATH)) { console.error(`index missing: ${INDEX_PATH}`); process.exit(1); }
const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
const entries = index.entries;
const sum = summarize(entries);

let filtered = entries;
if (domainFilter) {
  if (!DOMAINS.includes(domainFilter)) { console.error(`unknown domain: ${domainFilter}`); process.exit(1); }
  filtered = entries.filter(e => e.domain === domainFilter);
}
if (lowOnly) filtered = filtered.filter(e => (e.domain_confidence || 0) < 0.3);

if (json) {
  process.stdout.write(JSON.stringify({
    summary: sum.byDomain,
    low_confidence_count: sum.lowConfidence.length,
    filter: {domain: domainFilter, low_only: lowOnly},
    entries: filtered.map(e => ({
      id: e.id, type: e.type, name: e.name,
      domain: e.domain, confidence: e.domain_confidence, reason: e.domain_reason,
    })),
  }, null, 2));
} else {
  console.log(`PRISM KB Classify`);
  console.log(`  Total entries: ${entries.length}`);
  console.log(`  By domain:`);
  for (const d of DOMAINS) {
    const n = sum.byDomain[d] || 0;
    if (n) console.log(`    ${d.padEnd(22)} ${n}`);
  }
  if (sum.lowConfidence.length) {
    console.log(`  Low-confidence: ${sum.lowConfidence.length}`);
  }
  console.log('');
  if (domainFilter) console.log(`Filter: domain=${domainFilter}`);
  if (lowOnly) console.log(`Filter: low-confidence only`);
  console.log(`Showing ${filtered.length} entries:`);
  for (const e of filtered) {
    const conf = (e.domain_confidence || 0).toFixed(2);
    console.log(`  ${String(e.domain).padEnd(22)} conf=${conf} ${e.id}  [${e.domain_reason}]`);
  }
}
