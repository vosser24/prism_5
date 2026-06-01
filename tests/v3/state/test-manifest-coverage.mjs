#!/usr/bin/env node
// Manifest-coverage gate (PRISM v5.0 F4 Phase E, design §10).
// Run: node tests/v3/state/test-manifest-coverage.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Enforces [[feedback-installer-manifest-coverage-cross-check]] as a BUILD-PHASE
// gate, not a review afterthought: every shippable prism-*.mjs under tools/,
// tools/lib/, hooks/, hooks/lib/ MUST appear in install-manifest.json files[]
// (so it actually installs) AND be matched by a remove_on_upgrade_pattern (so a
// stale copy is cleaned on upgrade). A file that exists on disk but is missing
// from files[] ships UNINSTALLED — exactly the gap this test exists to catch.

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

// Intentional exclusions: the bootstrap installer is run FROM the clone
// (`node tools/prism-installer.mjs update`), never installed into ~/.claude —
// so it is deliberately absent from files[]. Documented here so the gate stays
// honest about what it is NOT checking.
const FILES_EXEMPT = new Set([
  'tools/prism-installer.mjs',
]);

const manifest = JSON.parse(readFileSync(join(REPO, 'tools', 'install-manifest.json'), 'utf-8'));
const srcSet = new Set(manifest.files.map(f => f.src));
const removePatterns = manifest.remove_on_upgrade_patterns || [];

// Glob ("tools/prism-*.mjs") -> RegExp. * matches within a path segment only.
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + esc + '$');
}
const removeRes = removePatterns.map(globToRe);
const matchedByRemove = (rel) => removeRes.some(re => re.test(rel));

// Discover shippable prism-*.mjs across the four installed dirs.
const SCAN_DIRS = ['tools', 'tools/lib', 'hooks', 'hooks/lib'];
const discovered = [];
for (const d of SCAN_DIRS) {
  let names;
  try { names = readdirSync(join(REPO, d)); } catch { continue; }
  for (const n of names) {
    if (/^prism-.*\.mjs$/.test(n)) discovered.push(`${d}/${n}`);
  }
}

check('discovered a non-trivial set of prism-*.mjs files', discovered.length >= 20);

// Every discovered file (minus exemptions) must be in files[] AND a remove pattern.
const missingFromFiles = discovered.filter(rel => !FILES_EXEMPT.has(rel) && !srcSet.has(rel));
const missingFromRemove = discovered.filter(rel => !matchedByRemove(rel));

if (missingFromFiles.length) console.log('  not in files[]: ' + missingFromFiles.join(', '));
if (missingFromRemove.length) console.log('  not matched by remove pattern: ' + missingFromRemove.join(', '));

check('every prism-*.mjs is in install-manifest files[] (minus documented exemptions)', missingFromFiles.length === 0);
check('every prism-*.mjs is matched by a remove_on_upgrade_pattern', missingFromRemove.length === 0);

// The five F4 files specifically (the gap that motivated this gate).
const F4_FILES = [
  'tools/lib/prism-bm25.mjs',
  'tools/prism-kb-knowledge-indexer.mjs',
  'tools/prism-kb-knowledge-rebuild.mjs',
  'tools/lib/prism-kb-knowledge-query.mjs',
  'tools/lib/prism-kb-rerank.mjs',
];
for (const f of F4_FILES) {
  check(`F4 file present in files[]: ${f}`, srcSet.has(f));
}

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
