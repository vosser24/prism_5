#!/usr/bin/env node
// ATLAS KB Promote Domain (v2.1.26 Phase 2.7)
//
// Creates a new cloud notebook for a new domain key and records it in meta.
// Does NOT move sources automatically.
// After running this:
//   1. Add the new domain to DOMAINS + DOMAIN_TITLES in prism-kb-domains.mjs
//   2. Add a classifier rule so new entries get tagged
//   3. node ~/.claude/tools/prism-kb-rebuild.mjs
//   4. node ~/.claude/tools/prism-kb-sync.mjs --push   (moves tagged entries)
//
// Usage:
//   node ~/.claude/tools/prism-kb-promote-domain.mjs rust-dev "rust-dev"
//   node ~/.claude/tools/prism-kb-promote-domain.mjs rust-dev "rust-dev" --dry-run

import {readFileSync, writeFileSync, existsSync} from 'fs';
import {spawnSync} from 'child_process';
import {DOMAINS, DOMAIN_TITLES} from './prism-kb-domains.mjs';
import {META_PATH} from './prism-kb-notebook-init.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(a => !a.startsWith('--'));
const newDomain = positional[0];
const humanTitle = positional[1] || newDomain;

if (!newDomain) {
  console.error('Usage: prism-kb-promote-domain.mjs <new-domain-key> "<human title>" [--dry-run]');
  process.exit(1);
}

if (DOMAINS.includes(newDomain)) {
  console.error(`Domain "${newDomain}" already exists in DOMAINS taxonomy.`);
  console.error('Nothing to promote — edit prism-kb-domains.mjs rules to route entries to it.');
  process.exit(1);
}

const title = DOMAIN_TITLES[newDomain] || `PRISM-KB: ${humanTitle}`;

if (!existsSync(META_PATH)) {
  console.error(`meta missing: ${META_PATH} -- run prism-kb-notebook-init.mjs first`);
  process.exit(1);
}
const meta = JSON.parse(readFileSync(META_PATH, 'utf-8'));

if (meta.notebooks[newDomain]) {
  console.log(`Notebook for domain "${newDomain}" already exists in meta: ${meta.notebooks[newDomain].id}`);
  process.exit(0);
}

if (dryRun) {
  console.log(`[DRY RUN] Would create NotebookLM notebook titled "${title}" and record it under meta.notebooks["${newDomain}"].`);
  console.log('Next steps (manual):');
  console.log(`  1. Add "${newDomain}" to DOMAINS array in ~/.claude/tools/prism-kb-domains.mjs`);
  console.log(`  2. Add DOMAIN_TITLES["${newDomain}"] = "${title}"`);
  console.log(`  3. Add a classifier rule (RULES entry) so new entries get tagged`);
  console.log(`  4. node ~/.claude/tools/prism-kb-rebuild.mjs`);
  console.log(`  5. node ~/.claude/tools/prism-kb-sync.mjs --push   # moves tagged entries`);
  process.exit(0);
}

const r = spawnSync('notebooklm', ['create', title, '--json'], {encoding: 'utf-8', timeout: 60000});
if (r.status !== 0) { console.error(`notebooklm create failed: ${r.stderr || r.stdout}`); process.exit(1); }
let id = null, createdAt = new Date().toISOString(), titleOut = title;
try {
  const obj = JSON.parse(r.stdout);
  if (obj && obj.id) { id = obj.id; titleOut = obj.title || title; createdAt = obj.created_at || createdAt; }
} catch {}
if (!id) {
  const list = spawnSync('notebooklm', ['list', '--json'], {encoding: 'utf-8', timeout: 60000});
  try {
    const nbs = JSON.parse(list.stdout).notebooks || [];
    const match = nbs.find(n => (n.title || '').trim() === title);
    if (match) id = match.id;
  } catch {}
}
if (!id) { console.error('could not determine new notebook id'); process.exit(1); }

meta.notebooks[newDomain] = {id, title: titleOut, created_at: createdAt};
writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
console.log(`Created notebook "${titleOut}" [${id}] and recorded in meta.notebooks["${newDomain}"].`);
console.log('Next: add classifier rules in prism-kb-domains.mjs, then rerun rebuild+sync.');
