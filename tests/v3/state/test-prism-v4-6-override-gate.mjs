#!/usr/bin/env node
// tests/v3/state/test-prism-v4-6-override-gate.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const HOOK = join(repoRoot, 'hooks', 'prism-session-start.mjs');
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

function runSessionStart(home, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 't' }),
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8',
  });
}

const home = mkdtempSync(join(tmpdir(), 'prism-ovr-'));
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', '.prism-override-pending-abc123de.json'),
  JSON.stringify({ event: 'master_override', verdict_sha: 'abc123de', kind: 'phase_1_5', reviewer_severity: 'REJECTED', ts: new Date().toISOString() }));

const r = runSessionStart(home);
const out = r.stdout || '';
check('advisory mentions the override', /overrode|override/i.test(out));
const routing = existsSync(join(home, '.claude', '.prism-routing.jsonl')) ? readFileSync(join(home, '.claude', '.prism-routing.jsonl'), 'utf8') : '';
check('master_override appended to routing log', routing.includes('"event":"master_override"') || routing.includes('master_override'));
check('pending file consumed (deleted)', !existsSync(join(home, '.claude', '.prism-override-pending-abc123de.json')));
writeFileSync(join(home, '.claude', '.prism-override-pending-def456ab.json'),
  JSON.stringify({ event: 'master_override', verdict_sha: 'def456ab', reviewer_severity: 'REJECTED', ts: new Date().toISOString() }));
const strict = runSessionStart(home, { PRISM_OVERRIDE_GATE: 'strict' });
check('strict mode escalates wording', /confirm intent|review .* override/i.test(strict.stdout || ''));

rmSync(home, { recursive: true, force: true });
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
