#!/usr/bin/env node
// PRISM KB Sync (v2.1.26 Phase 2.4)
//
// Cloud <- local delta sync for per-domain PRISM-KB notebooks.
//
// Modes:
//   --dry-run (DEFAULT) print plan, no cloud/meta writes
//   --push              perform uploads + meta updates
//   --limit N           cap add/replace/move operations per run
//   --json              machine-readable output

import {readFileSync, existsSync, statSync} from 'fs';
import {join} from 'path';
import {spawnSync} from 'child_process';
import {init as ensureNotebooks, loadMeta, saveMeta, META_PATH} from './prism-kb-notebook-init.mjs';
import {safeLogApiCall} from './prism-db.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const INDEX_PATH = join(H, '.claude', '.prism-kb-index.json');

function nb(args, timeoutMs = 180000) {
  const r = spawnSync('notebooklm', args, {encoding: 'utf-8', timeout: timeoutMs});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

function extractJson(stdout) {
  // notebooklm CLI prefixes JSON with a "Matched: ..." header line in some modes.
  const s = String(stdout || '');
  const i = s.indexOf('{');
  if (i < 0) return null;
  const slice = s.slice(i);
  try { return JSON.parse(slice); } catch { return null; }
}

function addSource(notebookId, title, bodyPath) {
  const t0 = Date.now();
  const r = nb(['source', 'add', bodyPath, '--notebook', notebookId, '--type', 'file', '--json']);
  const duration_ms = Date.now() - t0;
  if (r.status !== 0) {
    safeLogApiCall({kind: 'source_add', notebook: notebookId, duration_ms, status: 'error', error: (r.stderr || r.stdout || '').slice(0, 500)});
    throw new Error(`source add "${title}" failed: ${r.stderr || r.stdout}`);
  }
  const obj = extractJson(r.stdout);
  let sid = null;
  if (obj) {
    if (obj.source && (obj.source.id || obj.source.source_id)) sid = obj.source.id || obj.source.source_id;
    else if (obj.id || obj.source_id) sid = obj.id || obj.source_id;
  }
  if (!sid) {
    safeLogApiCall({kind: 'source_add', notebook: notebookId, duration_ms, status: 'error', error: 'no source_id in response'});
    throw new Error(`source add "${title}": could not parse cloud_source_id from response`);
  }
  safeLogApiCall({kind: 'source_add', notebook: notebookId, source_id: sid, duration_ms, status: 'ok'});
  // Rename to the canonical entry-id-based title so sources are distinguishable
  // (all plugin SKILL.md files would otherwise share the same cloud title).
  try {
    const rr = nb(['source', 'rename', sid, title, '--notebook', notebookId]);
    if (rr.status !== 0) {
      // Not fatal — source was added, rename just cosmetic. Log via thrown error only
      // if the rename totally broke, else swallow.
    }
  } catch {}
  return sid;
}

function deleteSource(notebookId, sourceId) {
  const t0 = Date.now();
  const r = nb(['source', 'delete', sourceId, '--notebook', notebookId, '--yes']);
  const duration_ms = Date.now() - t0;
  const notFound = r.status !== 0 && (r.stderr || '').toLowerCase().includes('not found');
  if (r.status !== 0 && !notFound) {
    safeLogApiCall({kind: 'source_delete', notebook: notebookId, source_id: sourceId, duration_ms, status: 'error', error: (r.stderr || r.stdout || '').slice(0, 500)});
    throw new Error(`source delete ${sourceId} failed: ${r.stderr || r.stdout}`);
  }
  safeLogApiCall({kind: 'source_delete', notebook: notebookId, source_id: sourceId, duration_ms, status: notFound ? 'not_found' : 'ok'});
}

function sanitizeTitle(id) {
  return String(id).replace(/[/\\]/g, '-').slice(0, 120);
}

// v2.2.0 (P2.19 fix): `opts.mtimeMap` is an optional Map or plain object
// from body_path -> epoch-seconds. When provided, computePlan reads the
// mtime from the map instead of calling statSync. Tests use this to pin
// mtimes and avoid a race where an external process touches a body file
// between the test's prev-mtime snapshot and computePlan's statSync call.
// Production callers pass nothing — behavior unchanged.
function readMapped(map, key) {
  if (!map) return undefined;
  if (typeof map.get === 'function') return map.get(key);
  return map[key];
}

export function computePlan(index, meta, opts = {}) {
  const plan = {add: [], replace: [], move: [], skip: [], orphan: []};
  const seen = new Set();
  const mtimeMap = opts.mtimeMap;

  for (const entry of index.entries) {
    seen.add(entry.id);
    const prev = meta.entries[entry.id];
    let bodyMtime = 0;
    const mapped = readMapped(mtimeMap, entry.body_path);
    if (typeof mapped === 'number') {
      bodyMtime = mapped;
    } else {
      try { bodyMtime = Math.floor(statSync(entry.body_path).mtimeMs / 1000); } catch {}
    }
    const targetNotebook = meta.notebooks[entry.domain];

    if (!targetNotebook || !targetNotebook.id) {
      plan.skip.push({id: entry.id, reason: `no cloud notebook for domain "${entry.domain}"`});
      continue;
    }

    if (!prev || !prev.cloud_source_id) {
      plan.add.push({id: entry.id, domain: entry.domain, title: sanitizeTitle(entry.id), body_path: entry.body_path, body_mtime: bodyMtime});
    } else if (prev.domain !== entry.domain) {
      const oldNotebook = meta.notebooks[prev.domain];
      plan.move.push({
        id: entry.id,
        from_domain: prev.domain,
        to_domain: entry.domain,
        from_notebook: oldNotebook ? oldNotebook.id : null,
        old_source_id: prev.cloud_source_id,
        title: sanitizeTitle(entry.id),
        body_path: entry.body_path,
        body_mtime: bodyMtime,
      });
    } else if (bodyMtime > (prev.body_mtime || 0)) {
      plan.replace.push({
        id: entry.id,
        domain: entry.domain,
        old_source_id: prev.cloud_source_id,
        title: sanitizeTitle(entry.id),
        body_path: entry.body_path,
        body_mtime: bodyMtime,
        prev_mtime: prev.body_mtime || 0,
      });
    } else {
      plan.skip.push({id: entry.id, reason: 'unchanged'});
    }
  }

  for (const id of Object.keys(meta.entries)) {
    if (!seen.has(id)) {
      plan.orphan.push({id, cloud_source_id: meta.entries[id].cloud_source_id, domain: meta.entries[id].domain});
    }
  }

  return plan;
}

function bodyBytes(p) { try { return statSync(p).size; } catch { return 0; } }

export function executePlan(plan, meta, {limit = Infinity, checkpoint = null} = {}) {
  let ops = 0, failures = 0;
  const log = [];
  const maybeCheckpoint = () => { if (checkpoint && ops % 10 === 0) { try { checkpoint(meta); } catch {} } };

  for (const step of plan.add) {
    if (ops >= limit) break;
    const notebook = meta.notebooks[step.domain];
    try {
      const sourceId = addSource(notebook.id, step.title, step.body_path);
      meta.entries[step.id] = {
        cloud_source_id: sourceId,
        domain: step.domain,
        body_mtime: step.body_mtime,
        body_bytes: bodyBytes(step.body_path),
        last_synced_at: new Date().toISOString(),
      };
      log.push({op: 'add', id: step.id, domain: step.domain, source_id: sourceId});
      ops++; maybeCheckpoint();
    } catch (e) {
      failures++;
      log.push({op: 'add-fail', id: step.id, domain: step.domain, err: String(e.message || e).slice(0, 200)});
    }
  }

  for (const step of plan.replace) {
    if (ops >= limit) break;
    const notebook = meta.notebooks[step.domain];
    try {
      try { deleteSource(notebook.id, step.old_source_id); } catch (e) { log.push({op: 'replace-del-warn', id: step.id, err: e.message}); }
      const sourceId = addSource(notebook.id, step.title, step.body_path);
      meta.entries[step.id] = {
        ...meta.entries[step.id],
        cloud_source_id: sourceId,
        domain: step.domain,
        body_mtime: step.body_mtime,
        body_bytes: bodyBytes(step.body_path),
        last_synced_at: new Date().toISOString(),
      };
      log.push({op: 'replace', id: step.id, domain: step.domain, source_id: sourceId});
      ops++; maybeCheckpoint();
    } catch (e) {
      failures++;
      log.push({op: 'replace-fail', id: step.id, err: String(e.message || e).slice(0, 200)});
    }
  }

  for (const step of plan.move) {
    if (ops >= limit) break;
    try {
      if (step.from_notebook) {
        try { deleteSource(step.from_notebook, step.old_source_id); } catch (e) { log.push({op: 'move-del-warn', id: step.id, err: e.message}); }
      }
      const target = meta.notebooks[step.to_domain];
      const sourceId = addSource(target.id, step.title, step.body_path);
      meta.entries[step.id] = {
        cloud_source_id: sourceId,
        domain: step.to_domain,
        body_mtime: step.body_mtime,
        body_bytes: bodyBytes(step.body_path),
        last_synced_at: new Date().toISOString(),
      };
      log.push({op: 'move', id: step.id, from: step.from_domain, to: step.to_domain, source_id: sourceId});
      ops++; maybeCheckpoint();
    } catch (e) {
      failures++;
      log.push({op: 'move-fail', id: step.id, err: String(e.message || e).slice(0, 200)});
    }
  }

  return {ops_executed: ops, failures, log};
}

export function run({dryRun = true, limit = Infinity, json = false} = {}) {
  if (!existsSync(INDEX_PATH)) throw new Error(`index missing: ${INDEX_PATH} — run prism-kb-rebuild.mjs first`);
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));

  if (!dryRun) ensureNotebooks({dryRun: false});

  let meta = loadMeta();
  if (!Object.keys(meta.notebooks).length && !dryRun) {
    throw new Error('meta has no notebooks — run: node ~/.claude/tools/prism-kb-notebook-init.mjs');
  }

  const plan = computePlan(index, meta);
  const summary = {
    dry_run: dryRun,
    limit: limit === Infinity ? null : limit,
    index_entries: index.entries.length,
    plan_counts: {
      add: plan.add.length,
      replace: plan.replace.length,
      move: plan.move.length,
      skip: plan.skip.length,
      orphan: plan.orphan.length,
    },
    orphans: plan.orphan,
  };

  if (!dryRun) {
    const exec = executePlan(plan, meta, {
      limit,
      checkpoint: (m) => { m.last_sync_at = new Date().toISOString(); saveMeta(m); },
    });
    summary.executed = exec.ops_executed;
    summary.failures = exec.failures;
    summary.log = exec.log;
    meta.last_sync_at = new Date().toISOString();
    saveMeta(meta);
    summary.meta_path = META_PATH;
  }

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2));
  } else {
    console.log(`PRISM KB Sync ${dryRun ? '(DRY RUN)' : '(PUSH)'}`);
    console.log(`  Index entries:  ${summary.index_entries}`);
    console.log(`  Plan: add=${summary.plan_counts.add} replace=${summary.plan_counts.replace} move=${summary.plan_counts.move} skip=${summary.plan_counts.skip} orphan=${summary.plan_counts.orphan}`);
    if (!dryRun) console.log(`  Executed:       ${summary.executed} cloud operations`);
    if (summary.orphans.length) {
      console.log(`  Orphans (in meta but not in local index):`);
      for (const o of summary.orphans.slice(0, 10)) console.log(`    ${o.id} (domain=${o.domain})`);
      if (summary.orphans.length > 10) console.log(`    ... +${summary.orphans.length - 10} more`);
    }
    if (dryRun) console.log('  Run with --push to apply.');
  }
  return summary;
}

const args = process.argv.slice(2);
const dryRun = !args.includes('--push');
const json = args.includes('--json');
let limit = Infinity;
const li = args.indexOf('--limit');
if (li >= 0 && args[li + 1]) { const n = parseInt(args[li + 1], 10); if (Number.isFinite(n) && n > 0) limit = n; }

const invokedDirectly = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || (process.argv[1] || '').endsWith('prism-kb-sync.mjs');
if (invokedDirectly) {
  try { run({dryRun, limit, json}); }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}
