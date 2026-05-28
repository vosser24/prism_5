#!/usr/bin/env node
// tests/v3/state/test-installer-coverage.mjs
// Q3 — every shipped file on disk is in manifest.files[], and every manifest
// src exists on disk. Catches the manifest gaps that bit v4.5 three times.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'install-manifest.json'), 'utf8'));
const srcSet = new Set(manifest.files.map(f => f.src.replace(/\\/g, '/')));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

// Directories + patterns the installer must ship in full.
const COVERED = [
  { dir: 'hooks',          re: /^prism-.*\.mjs$/ },
  { dir: 'hooks/lib',      re: /^prism-.*\.mjs$/ },
  { dir: 'tools',          re: /^prism-.*\.mjs$/ },
  { dir: 'tools/lib',      re: /^prism-.*\.mjs$/ },
  { dir: 'agents',         re: /-reviewer.*\.md$/ },
];

test('every shipped file on disk is in manifest.files[]', () => {
  const missing = [];
  for (const { dir, re } of COVERED) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!re.test(name)) continue;
      const rel = `${dir}/${name}`;
      if (!srcSet.has(rel)) missing.push(rel);
    }
  }
  assert(missing.length === 0, `not in manifest.files[]: ${missing.join(', ')}`);
});

test('every manifest.files[].src exists on disk', () => {
  const gone = manifest.files.map(f => f.src).filter(s => !existsSync(join(REPO_ROOT, s)));
  assert(gone.length === 0, `manifest src missing on disk: ${gone.join(', ')}`);
});

process.stdout.write(`tests passed: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
