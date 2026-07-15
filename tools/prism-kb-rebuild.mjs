#!/usr/bin/env node
// PRISM KB Rebuild (v2.1.27 Phase 3a)
//
// Forces a full KB index rebuild, optionally pushes delta to cloud.
// Use when a plugin is added/removed or agents/rules change and you want
// the router to reflect the change immediately. With --sync, also pushes
// new entries to NotebookLM so the cloud side stays in lockstep.
//
// Usage:
//   node ~/.claude/tools/prism-kb-rebuild.mjs              # rebuild only
//   node ~/.claude/tools/prism-kb-rebuild.mjs --sync       # rebuild + push
//   node ~/.claude/tools/prism-kb-rebuild.mjs --sync --quiet  # scheduled runs

import {build} from './prism-kb-indexer.mjs';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const args = process.argv.slice(2);
const doSync = args.includes('--sync');
const quiet = args.includes('--quiet');

const log = (...a) => { if (!quiet) console.log(...a); };
const warn = (...a) => console.error(...a);

const stats = build({force: true});
if (!stats.rebuilt) {
  warn('Rebuild did not execute (unexpected).');
  process.exit(1);
}

log('PRISM KB index rebuilt.');
log(`  Entries:     ${stats.entry_count}`);
log(`  By type:     ${Object.entries(stats.by_type).map(([t, n]) => `${t}=${n}`).join(', ')}`);
if (stats.by_domain) log(`  By domain:   ${Object.entries(stats.by_domain).map(([t, n]) => `${t}=${n}`).join(', ')}`);
log(`  Elapsed:     ${stats.elapsed_ms}ms`);
log(`  Written:     ${stats.written_bytes.toLocaleString()} bytes`);
log(`  Source mtime max: ${new Date(stats.source_mtime_max * 1000).toISOString()}`);

if (!doSync) process.exit(0);

// --- Phase 3a: chain sync --push ---
const here = dirname(fileURLToPath(import.meta.url));
const syncPath = join(here, 'prism-kb-sync.mjs');
log('');
log('PRISM KB sync (--push) ...');
const syncArgs = ['--push'];
if (quiet) syncArgs.push('--json');
const r = spawnSync('node', [syncPath, ...syncArgs], {encoding: 'utf-8', timeout: 30 * 60 * 1000});
if (r.status !== 0) {
  warn('Sync failed:');
  warn((r.stderr || r.stdout || '').slice(0, 1000));
  process.exit(r.status || 1);
}

if (quiet) {
  try {
    const summary = JSON.parse(r.stdout);
    const c = summary.plan_counts || {};
    warn(`prism-kb-refresh ${new Date().toISOString()} rebuilt=${stats.entry_count} executed=${summary.executed ?? 0} failures=${summary.failures ?? 0} add=${c.add ?? 0} replace=${c.replace ?? 0} move=${c.move ?? 0} skip=${c.skip ?? 0}`);
  } catch {
    warn('prism-kb-refresh completed (could not parse summary)');
  }
} else {
  process.stdout.write(r.stdout);
}
