#!/usr/bin/env node
// PRISM KB Notebook Init (v2.1.26 Phase 2.3)
//
// Idempotent bootstrap for per-domain PRISM-KB notebooks on NotebookLM.
// - Reads ~/.claude/.prism-kb-meta.json (creates if absent)
// - Lists existing cloud notebooks (`notebooklm list --json`)
// - Reuses any titled "PRISM-KB: <domain>"; creates the rest
// - Writes resolved id-map back to meta file
//
// Usage:
//   node ~/.claude/tools/prism-kb-notebook-init.mjs           # create missing
//   node ~/.claude/tools/prism-kb-notebook-init.mjs --dry-run # show plan only
//   node ~/.claude/tools/prism-kb-notebook-init.mjs --json    # machine output

import {readFileSync, writeFileSync, existsSync} from 'fs';
import {join} from 'path';
import {spawnSync} from 'child_process';
import {DOMAINS, DOMAIN_TITLES} from './prism-kb-domains.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const META_PATH = join(H, '.claude', '.prism-kb-meta.json');

function loadMeta() {
  if (!existsSync(META_PATH)) {
    return {
      schema_version: 1,
      created_at: new Date().toISOString(),
      last_init_at: null,
      notebooks: {},
      entries: {},
    };
  }
  try { return JSON.parse(readFileSync(META_PATH, 'utf-8')); }
  catch (e) { throw new Error(`meta file corrupt: ${e.message}`); }
}

function saveMeta(meta) {
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

function nb(args, timeoutMs = 60000) {
  const r = spawnSync('notebooklm', args, {encoding: 'utf-8', timeout: timeoutMs});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

function listCloudNotebooks() {
  const r = nb(['list', '--json']);
  if (r.status !== 0) throw new Error(`notebooklm list failed: ${r.stderr || r.stdout}`);
  const data = JSON.parse(r.stdout);
  return Array.isArray(data.notebooks) ? data.notebooks : [];
}

function createCloudNotebook(title) {
  const r = nb(['create', title, '--json']);
  if (r.status !== 0) throw new Error(`notebooklm create "${title}" failed: ${r.stderr || r.stdout}`);
  try {
    const obj = JSON.parse(r.stdout);
    if (obj && obj.id) return {id: obj.id, title: obj.title || title, created_at: obj.created_at || new Date().toISOString()};
  } catch {}
  const all = listCloudNotebooks();
  const match = all.find(n => (n.title || '').trim() === title);
  if (!match) throw new Error(`created "${title}" but could not locate it in subsequent list`);
  return {id: match.id, title: match.title, created_at: match.created_at || new Date().toISOString()};
}

function init({dryRun = false, json = false} = {}) {
  const meta = loadMeta();
  const cloud = listCloudNotebooks();
  const wantedDomains = DOMAINS.filter(d => d !== 'misc');

  const plan = [];
  for (const domain of wantedDomains) {
    const title = DOMAIN_TITLES[domain];
    const existingMeta = meta.notebooks[domain];
    const cloudMatch = cloud.find(n => (n.title || '').trim() === title);

    if (cloudMatch) {
      plan.push({domain, action: 'reuse', notebook_id: cloudMatch.id, title});
      meta.notebooks[domain] = {
        id: cloudMatch.id,
        title,
        created_at: cloudMatch.created_at || (existingMeta && existingMeta.created_at) || new Date().toISOString(),
      };
    } else if (existingMeta && existingMeta.id && cloud.find(n => n.id === existingMeta.id)) {
      plan.push({domain, action: 'reuse-by-id', notebook_id: existingMeta.id, title, warning: 'title drift'});
    } else {
      plan.push({domain, action: dryRun ? 'would-create' : 'create', title});
    }
  }

  if (!dryRun) {
    for (const step of plan) {
      if (step.action === 'create') {
        const created = createCloudNotebook(step.title);
        step.notebook_id = created.id;
        step.action = 'created';
        meta.notebooks[step.domain] = {
          id: created.id,
          title: created.title,
          created_at: created.created_at,
        };
      }
    }
    meta.last_init_at = new Date().toISOString();
    saveMeta(meta);
  }

  const summary = {
    dry_run: dryRun,
    notebooks_total: wantedDomains.length,
    reused: plan.filter(p => p.action === 'reuse' || p.action === 'reuse-by-id').length,
    created: plan.filter(p => p.action === 'created').length,
    would_create: plan.filter(p => p.action === 'would-create').length,
    plan,
    meta_path: META_PATH,
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2));
  } else {
    console.log(`PRISM KB Notebook Init ${dryRun ? '(dry-run)' : ''}`);
    console.log(`  Total domains: ${summary.notebooks_total}`);
    console.log(`  Reused:        ${summary.reused}`);
    console.log(`  ${dryRun ? 'Would create' : 'Created'}: ${dryRun ? summary.would_create : summary.created}`);
    for (const p of plan) {
      const idStr = p.notebook_id ? ` [${p.notebook_id.slice(0, 8)}]` : '';
      const warn = p.warning ? ` WARN ${p.warning}` : '';
      console.log(`  ${String(p.action).padEnd(14)} ${p.domain.padEnd(22)}${idStr}${warn}`);
    }
    if (!dryRun) console.log(`  Meta: ${META_PATH}`);
  }
  return summary;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const json = args.includes('--json');
const invokedDirectly = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || (process.argv[1] || '').endsWith('prism-kb-notebook-init.mjs');
if (invokedDirectly) {
  try { init({dryRun, json}); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}

export { init, loadMeta, saveMeta, META_PATH };
