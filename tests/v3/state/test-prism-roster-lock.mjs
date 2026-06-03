#!/usr/bin/env node
import { mkdtempSync, writeFileSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRosterLock } from '../../../tools/lib/prism-roster-lock.mjs';

let pass = 0; let total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const dir = mkdtempSync(join(tmpdir(), 'prism-rl-'));
const rosterPath = join(dir, 'roster.json');
writeFileSync(rosterPath, JSON.stringify({ agents: {} }));

// 1. Basic acquire/release
await withRosterLock(rosterPath, async () => {
  check('lock file exists during fn', existsSync(rosterPath + '.lock'));
});
check('lock file released after fn', !existsSync(rosterPath + '.lock'));

// 2. Concurrent acquire: 2nd should wait for 1st
const events = [];
const p1 = withRosterLock(rosterPath, async () => {
  events.push('p1-enter');
  await new Promise(r => setTimeout(r, 300));
  events.push('p1-exit');
});
const p2 = withRosterLock(rosterPath, async () => {
  events.push('p2-enter');
  events.push('p2-exit');
});
await Promise.all([p1, p2]);
check('p1 enters before p2', events.indexOf('p1-enter') < events.indexOf('p2-enter'));
check('p1 exits before p2 enters', events.indexOf('p1-exit') < events.indexOf('p2-enter'));

// 3. Stale lock detection: write a lock file with old timestamp
writeFileSync(rosterPath + '.lock', JSON.stringify({
  pid: 99999,
  created_at: new Date(Date.now() - 120_000).toISOString(),
  process_argv: 'fake',
}));
let inFn = false;
await withRosterLock(rosterPath, async () => { inFn = true; });
check('stale lock auto-released', inFn);
check('stale lock file removed after fn', !existsSync(rosterPath + '.lock'));

// 4. First-creation: roster's parent dir does not exist yet (v4.7 regression).
// withRosterLock must `mkdir -p` the lock's parent before openSync(lockPath,'wx'),
// otherwise openSync throws ENOENT (not EEXIST) and crashes the caller on first
// agent auto-registration. Covers the prism-roster-lock.mjs mkdirSync fix directly.
const nestedRosterPath = join(dir, 'does', 'not', 'exist', 'roster.json');
check('parent dir absent before lock', !existsSync(join(dir, 'does')));
let firstCreateRan = false;
let firstCreateThrew = false;
try {
  await withRosterLock(nestedRosterPath, async () => {
    firstCreateRan = true;
    check('lock file exists during fn (parent dir auto-created)', existsSync(nestedRosterPath + '.lock'));
  });
} catch { firstCreateThrew = true; }
check('withRosterLock did not throw when parent dir absent', !firstCreateThrew);
check('fn ran with absent parent dir', firstCreateRan);
check('lock released after first-creation fn', !existsSync(nestedRosterPath + '.lock'));

rmSync(dir, { recursive: true, force: true });
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
