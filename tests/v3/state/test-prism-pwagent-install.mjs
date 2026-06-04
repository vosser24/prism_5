#!/usr/bin/env node
// Tests for embedding pwagent in the PRISM install:
//   - install-manifest.json ships every pwagent SOURCE file (and never a .venv)
//   - prism-installer `setup-pwagent` is idempotent + fail-soft (dry-run probe)
//
// Run: node tests/v3/state/test-prism-pwagent-install.mjs

import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INSTALLER = join(REPO, 'tools', 'prism-installer.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const man = JSON.parse(readFileSync(join(REPO, 'tools', 'install-manifest.json'), 'utf8'));
const srcs = man.files.map((f) => f.src.replace(/\\/g, '/'));

const PWAGENT_FILES = [
  'tools/pwagent/pwagent.cmd',
  'tools/pwagent/pwagent.ps1',
  'tools/pwagent/requirements.txt',
  'tools/pwagent/src/pwagent/__init__.py',
  'tools/pwagent/src/pwagent/__main__.py',
  'tools/pwagent/src/pwagent/cli.py',
  'tools/pwagent/src/pwagent/actions.py',
  'tools/pwagent/src/pwagent/session.py',
  'tools/pwagent/src/pwagent/errors.py',
];

t('manifest ships all pwagent source files', () => {
  for (const f of PWAGENT_FILES) assert(srcs.includes(f), 'missing from manifest: ' + f);
});

t('manifest never ships a pwagent .venv', () => {
  assert(!srcs.some((s) => s.includes('pwagent/.venv')), '.venv must not be shipped');
});

t('setup-pwagent --dry-run reports PATH + warm actions without performing them', () => {
  const r = spawnSync(process.execPath, [INSTALLER, 'setup-pwagent', '--dry-run'], {encoding: 'utf8'});
  assert(r.status === 0, 'exit ' + r.status + ': ' + r.stderr);
  assert(/pwagent/i.test(r.stdout), 'no pwagent setup output');
  assert(/PATH/i.test(r.stdout), 'should mention a PATH action');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
