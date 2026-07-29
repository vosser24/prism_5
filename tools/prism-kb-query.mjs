#!/usr/bin/env node
// PRISM KB Query (v2.1.26 Phase 2.5)
//
// Tier-2 cloud lookup. Routes prompt through local router -> picks top-N
// domains -> asks each domain's NotebookLM notebook -> returns answers.
//
// Usage:
//   node ~/.claude/tools/prism-kb-query.mjs "how do I run a TDD loop?"
//   node ~/.claude/tools/prism-kb-query.mjs "..." --domain dev-testing-quality
//   node ~/.claude/tools/prism-kb-query.mjs "..." --limit-domains 2 --json

import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import {spawnSync} from 'child_process';
import {routeQuery} from '../hooks/lib/prism-router.mjs';
import {DOMAINS} from './prism-kb-domains.mjs';
import {META_PATH} from './prism-kb-notebook-init.mjs';
import {safeLogApiCall} from './prism-db.mjs';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const H = prismHome();
const INDEX_PATH = join(H, '.claude', '.prism-kb-index.json');

function nbCli(args, timeoutMs = 90000) {
  const r = spawnSync('notebooklm', args, {encoding: 'utf-8', timeout: timeoutMs});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

function pickDomains(prompt, index, {limit = 2, explicit = null} = {}) {
  if (explicit) {
    if (!DOMAINS.includes(explicit)) throw new Error(`unknown domain: ${explicit}`);
    return [{domain: explicit, score: 10.0, hits: []}];
  }
  const hits = routeQuery(prompt, index, {limit: 25, minScore: 0.5, includeDisabled: true});
  if (!hits.length) return [];
  const byDomain = new Map();
  for (const h of hits) {
    const d = h.entry.domain || 'misc';
    const cur = byDomain.get(d) || {domain: d, score: 0, hits: []};
    cur.score += h.score;
    cur.hits.push({id: h.entry.id, score: h.score});
    byDomain.set(d, cur);
  }
  return Array.from(byDomain.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

function askNotebook(notebookId, prompt) {
  const t0 = Date.now();
  const r = nbCli(['ask', prompt, '--notebook', notebookId, '--json']);
  const duration_ms = Date.now() - t0;
  const ok = r.status === 0;
  safeLogApiCall({
    kind: 'ask',
    notebook: notebookId,
    tokens_est: Math.ceil(String(prompt || '').length / 4),
    duration_ms,
    status: ok ? 'ok' : 'error',
    error: ok ? null : (r.stderr || r.stdout || '').slice(0, 500),
  });
  if (!ok) return {error: r.stderr || r.stdout};
  try { return JSON.parse(r.stdout); } catch { return {answer: r.stdout}; }
}

export function runQuery(prompt, {limitDomains = 2, explicitDomain = null, json = false} = {}) {
  if (!existsSync(INDEX_PATH)) throw new Error(`index missing: ${INDEX_PATH} — run prism-kb-rebuild.mjs first`);
  if (!existsSync(META_PATH)) throw new Error(`meta missing: ${META_PATH} — run prism-kb-notebook-init.mjs first`);
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  const meta = JSON.parse(readFileSync(META_PATH, 'utf-8'));

  const domains = pickDomains(prompt, index, {limit: limitDomains, explicit: explicitDomain});
  if (!domains.length) {
    const out = {prompt, domains: [], answers: [], note: 'no routing hits; try --domain <name> explicitly'};
    if (json) process.stdout.write(JSON.stringify(out, null, 2));
    else console.log('No local routing hits. Try --domain <name> to pick a notebook explicitly.');
    return out;
  }

  // Build reverse index: cloud_source_id -> entry id (for human-readable citations)
  const sourceIdToEntry = new Map();
  for (const [entryId, info] of Object.entries(meta.entries || {})) {
    if (info && info.cloud_source_id) sourceIdToEntry.set(info.cloud_source_id, entryId);
  }

  const answers = [];
  for (const d of domains) {
    const nb = meta.notebooks[d.domain];
    if (!nb || !nb.id) {
      answers.push({domain: d.domain, error: 'no cloud notebook — run prism-kb-notebook-init.mjs'});
      continue;
    }
    const res = askNotebook(nb.id, prompt);
    answers.push({domain: d.domain, notebook_id: nb.id, score: d.score, result: res, _sourceIdToEntry: sourceIdToEntry});
  }

  const out = {prompt, domains, answers};
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2));
  } else {
    console.log(`PRISM KB Query`);
    console.log(`  Prompt: ${prompt}`);
    console.log(`  Routed to: ${domains.map(d => `${d.domain}(${d.score.toFixed(1)})`).join(', ')}`);
    for (const a of answers) {
      console.log(`\n-- Domain: ${a.domain} --`);
      if (a.error) { console.log(`  ERROR: ${a.error}`); continue; }
      const r = a.result || {};
      if (r.error) { console.log(`  ERROR: ${r.error}`); continue; }
      const ans = r.answer || r.response || r.text || JSON.stringify(r).slice(0, 400);
      console.log(ans);
      const refs = r.references || r.citations || r.sources;
      if (Array.isArray(refs) && refs.length) {
        // Dedupe by citation_number to avoid printing the same number repeatedly.
        const seen = new Set();
        console.log(`  Citations:`);
        for (const ref of refs) {
          const n = ref.citation_number ?? ref.index ?? ref.n;
          if (n == null || seen.has(n)) continue;
          seen.add(n);
          const sid = ref.source_id || '';
          const entryId = a._sourceIdToEntry.get(sid);
          const label = entryId || ref.title || ref.source_title || (sid ? sid.slice(0, 8) : '?');
          console.log(`    [${n}] ${label}`);
          if (seen.size >= 10) break;
        }
      }
    }
  }
  return out;
}

const args = process.argv.slice(2);
let explicitDomain = null;
const di = args.indexOf('--domain');
if (di >= 0 && args[di + 1]) explicitDomain = args[di + 1];
let limitDomains = 2;
const ld = args.indexOf('--limit-domains');
if (ld >= 0 && args[ld + 1]) { const n = parseInt(args[ld + 1], 10); if (Number.isFinite(n) && n > 0) limitDomains = n; }
const json = args.includes('--json');
const skipArgs = new Set();
if (di >= 0) { skipArgs.add(args[di]); skipArgs.add(args[di + 1]); }
if (ld >= 0) { skipArgs.add(args[ld]); skipArgs.add(args[ld + 1]); }
skipArgs.add('--json');
const positional = args.filter(a => !skipArgs.has(a) && !a.startsWith('--'));
const prompt = positional.join(' ').trim();

const invokedDirectly = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || (process.argv[1] || '').endsWith('prism-kb-query.mjs');
if (invokedDirectly) {
  if (!prompt) { console.error('Usage: prism-kb-query.mjs "<prompt>" [--domain <d>] [--limit-domains N] [--json]'); process.exit(1); }
  try { runQuery(prompt, {limitDomains, explicitDomain, json}); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}
