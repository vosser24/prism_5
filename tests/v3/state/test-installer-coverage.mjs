#!/usr/bin/env node
// tests/v3/state/test-installer-coverage.mjs
// Q3 — every shipped file on disk is in manifest.files[], and every manifest
// src exists on disk. Catches the manifest gaps that bit v4.5 three times.
//
// Extended (v5.9.1+): also requires commands/*.md, hooks/**/*.sh, hooks/**/*.cmd,
// tools/**/*.sh, and tools/**/*.cmd to be manifested — closing the non-.mjs gap
// that caused capability-log.md, capability-rollback.md, and nlm-call.sh to be
// omitted from v5.9.0.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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

// Intentionally NOT self-shipped: prism-installer.mjs is the bootstrap — it runs
// from the plugin/repo root (`node tools/prism-installer.mjs`) and is the thing
// that copies files INTO ~/.claude, so it does not install a copy of itself.
//
// ACL audit stubs: test-only fixtures used by audit-scenarios.json (ACL-NTF /
// ACL-RBK scenarios). They live in hooks/ so the audit runner can resolve them
// via repo-relative paths, but they are NOT shipped capabilities — they must not
// be deployed to ~/.claude.
//
// tools/prism-monitor/ is a repo-only Python monitoring dashboard — intentionally
// never installed into ~/.claude (zero manifest entries by design).
const SHIP_EXEMPT = new Set([
  'tools/prism-installer.mjs',
  'hooks/prism-acl-audit-notify-stub.mjs',
  'hooks/prism-acl-audit-rollback-stub.mjs',
]);
// Prefix-based exemption for the repo-only prism-monitor dashboard.
const SHIP_EXEMPT_PREFIXES = [
  'tools/prism-monitor/',
];

function isShipExempt(rel) {
  if (SHIP_EXEMPT.has(rel)) return true;
  return SHIP_EXEMPT_PREFIXES.some(p => rel.startsWith(p));
}

// Recursive fs-walk: collect all files under `absBase` (repo-relative prefix
// `prefix`) whose names match `re`. Returns repo-relative paths with forward slashes.
function walkDir(absBase, prefix, re, out = []) {
  let entries;
  try { entries = readdirSync(absBase); } catch { return out; }
  for (const name of entries) {
    const absChild = join(absBase, name);
    let st;
    try { st = statSync(absChild); } catch { continue; }
    if (st.isDirectory()) {
      walkDir(absChild, `${prefix}/${name}`, re, out);
    } else if (re.test(name)) {
      out.push(`${prefix}/${name}`);
    }
  }
  return out;
}

test('every shipped file on disk is in manifest.files[]', () => {
  const missing = [];
  for (const { dir, re } of COVERED) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!re.test(name)) continue;
      const rel = `${dir}/${name}`;
      if (isShipExempt(rel)) continue;
      if (!srcSet.has(rel)) missing.push(rel);
    }
  }
  assert(missing.length === 0, `not in manifest.files[]: ${missing.join(', ')}`);
});

test('every manifest.files[].src exists on disk', () => {
  const gone = manifest.files.map(f => f.src).filter(s => !existsSync(join(REPO_ROOT, s)));
  assert(gone.length === 0, `manifest src missing on disk: ${gone.join(', ')}`);
});

// ── Non-.mjs shipped files (v5.9.1+ guard) ──────────────────────────────────
// Closes the gap where capability-log.md, capability-rollback.md, and
// nlm-call.sh were omitted from v5.9.0 — no test caught it because only
// prism-*.mjs was scanned.

test('every commands/*.md is in manifest.files[]', () => {
  const files = walkDir(join(REPO_ROOT, 'commands'), 'commands', /\.md$/);
  const missing = files.filter(rel => !isShipExempt(rel) && !srcSet.has(rel));
  assert(missing.length === 0,
    missing.map(f => `shipped non-mjs file not in manifest.files[]: ${f}`).join('\n'));
});

test('every hooks/**/*.{sh,cmd} is in manifest.files[]', () => {
  const files = walkDir(join(REPO_ROOT, 'hooks'), 'hooks', /\.(sh|cmd)$/);
  const missing = files.filter(rel => !isShipExempt(rel) && !srcSet.has(rel));
  assert(missing.length === 0,
    missing.map(f => `shipped non-mjs file not in manifest.files[]: ${f}`).join('\n'));
});

test('every tools/**/*.{sh,cmd} is in manifest.files[]', () => {
  const files = walkDir(join(REPO_ROOT, 'tools'), 'tools', /\.(sh|cmd)$/);
  const missing = files.filter(rel => !isShipExempt(rel) && !srcSet.has(rel));
  assert(missing.length === 0,
    missing.map(f => `shipped non-mjs file not in manifest.files[]: ${f}`).join('\n'));
});

process.stdout.write(`tests passed: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
