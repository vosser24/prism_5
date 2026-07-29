#!/usr/bin/env node
// F23 — stale turn-tier sentinel prune, freshness-sweep INTEGRATION.
// Run: node tests/v3/state/test-prism-turn-tier-prune.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Exercises hooks/lib/prism-freshness-sweep.mjs's G2 check: bounded, age-based
// deletion of ~/.claude/.prism-turn-tier-<session>.json sentinels that
// hooks/prism-prompt-tier-router.mjs writes every turn but never cleans up
// (confirmed: no other prune/TTL logic anywhere in the codebase touches this
// filename pattern). Verifies:
//   1. an old (dead-session) sentinel IS pruned when apply:true
//   2. a sentinel with a FRESH mtime (simulating the CURRENT session, rewritten
//      by the tier router this very turn) SURVIVES
//   3. a sentinel inside the age threshold (quiet a couple days, but not dead)
//      SURVIVES
//   4. the 24h safety floor holds even when the configured threshold, if taken
//      literally, would be far more aggressive than 24h
//   5. the automatic sweep (runFreshnessSweep / freshnessSweepDryRun) only
//      ever NUDGES for this check — it never deletes anything itself, by
//      design (deletion of routing scratch is irreversible, so G2 stays
//      manual per the D008 "mutation needs a reversibility bar" doctrine;
//      see the source comment above checkTurnTierSentinelPrune)
//   6. a sibling non-matching ~/.claude file is never touched regardless of age
//
// Uses an isolated mkdtemp HOME throughout — this test must NEVER touch the
// real ~/.claude, and does not: every path below is rooted under os.tmpdir().

import {mkdirSync, writeFileSync, existsSync, rmSync, utimesSync} from 'fs';
import {join, dirname} from 'path';
import {tmpdir} from 'os';
import {fileURLToPath, pathToFileURL} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-freshness-sweep.mjs');
const {
  runFreshnessSweep,
  freshnessSweepDryRun,
  pruneTurnTierSentinels,
  listStaleTurnTierSentinels,
  checkTurnTierSentinelPrune,
} = await import(pathToFileURL(SWEEP).href);

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.now();
let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const ROOT = join(tmpdir(), `prism-turntier-test-${process.pid}`);
const HOME = join(ROOT, 'home');
const CLAUDE = join(HOME, '.claude');

function setMtime(p, ms) {
  const d = new Date(ms);
  utimesSync(p, d, d);
}

function sentinel(sessionId, ageMs) {
  const p = join(CLAUDE, `.prism-turn-tier-${sessionId}.json`);
  writeFileSync(p, JSON.stringify({tier: 'sonnet', session_id: sessionId}));
  setMtime(p, NOW - ageMs);
  return p;
}

function seed() {
  rmSync(ROOT, {recursive: true, force: true});
  mkdirSync(CLAUDE, {recursive: true});
}

// ── 1/2/3/6: core prune — old pruned, current + recent survive, sibling untouched ──
seed();
const oldFile = sentinel('old-dead-session', 10 * DAY);           // 10d old → past default 7d threshold → stale
const currentFile = sentinel('current-live-session', 500);        // 0.5s old → "this turn"'s own sentinel
const recentFile = sentinel('recent-quiet-session', 2 * DAY);      // 2d old → inside the default 7d window
// A non-matching sibling ~/.claude file — never a candidate, regardless of age.
const otherOldFile = join(CLAUDE, '.prism-freshness-last.json');
writeFileSync(otherOldFile, '{}');
setMtime(otherOldFile, NOW - 30 * DAY);

const {scanned, stale} = listStaleTurnTierSentinels(HOME, NOW);
check('lists exactly the one stale turn-tier sentinel', stale.length === 1 && stale[0].name === '.prism-turn-tier-old-dead-session.json');
check('scanned count reflects only turn-tier-pattern files (3), not the sibling', scanned === 3);

const dryPrune = pruneTurnTierSentinels(HOME, NOW, {apply: false});
check('dry-run (apply:false) reports 1 candidate but deletes 0', dryPrune.candidates.length === 1 && dryPrune.deleted.length === 0);
check('dry-run does NOT delete the old file', existsSync(oldFile));

const applied = pruneTurnTierSentinels(HOME, NOW, {apply: true});
check('apply:true deletes exactly the old (dead-session) file', applied.deleted.length === 1 && applied.deleted[0] === '.prism-turn-tier-old-dead-session.json');
check('old (dead) session sentinel is GONE after apply:true', !existsSync(oldFile));
check('current-session sentinel SURVIVES (fresh mtime — never a delete candidate)', existsSync(currentFile));
check('recent-session sentinel SURVIVES (inside the age window)', existsSync(recentFile));
check('non-turn-tier sibling file untouched regardless of its own age', existsSync(otherOldFile));

// ── 4: 24h safety floor holds even under an aggressive configured threshold ──
seed();
const savedEnv = process.env.PRISM_TURN_TIER_PRUNE_DAYS;
process.env.PRISM_TURN_TIER_PRUNE_DAYS = '0.01'; // ~14 minutes if honored literally
const tenHoursOld = sentinel('within-safety-floor', 10 * HOUR);    // 10h old — well past 0.01d, well within 24h
const thirtyHoursOld = sentinel('past-safety-floor', 30 * HOUR);   // 30h old — past both
pruneTurnTierSentinels(HOME, NOW, {apply: true});
check('24h safety floor protects a <24h-old sentinel despite an aggressive configured threshold', existsSync(tenHoursOld));
check('a >24h-old sentinel is still eligible once past the 24h floor', !existsSync(thirtyHoursOld));
if (savedEnv === undefined) delete process.env.PRISM_TURN_TIER_PRUNE_DAYS;
else process.env.PRISM_TURN_TIER_PRUNE_DAYS = savedEnv;

// ── 5: the automatic sweep NUDGES but never deletes for this check ─────────
seed();
const staleForSweep = sentinel('stale-for-sweep-notice', 10 * DAY);
const freshForSweep = sentinel('fresh-for-sweep-notice', 1000);

const dry2 = freshnessSweepDryRun({home: HOME, now: NOW});
check('freshnessSweepDryRun surfaces the turn-tier prune nudge', dry2.notices.some((n) => /stale turn-tier sentinel/.test(n)));
check('freshnessSweepDryRun does NOT delete the stale sentinel (report-only)', existsSync(staleForSweep));

const real = runFreshnessSweep({home: HOME, now: NOW, force: true});
check('runFreshnessSweep ALSO surfaces the turn-tier prune nudge', real.notices.some((n) => /stale turn-tier sentinel/.test(n)));
check('runFreshnessSweep does NOT delete the stale sentinel — G2 is report-only by design', existsSync(staleForSweep));
check('runFreshnessSweep does NOT delete the fresh sentinel either (zero mutation for G2)', existsSync(freshForSweep));

// ── checkTurnTierSentinelPrune returns null when nothing is stale ──────────
seed();
sentinel('all-fresh-one', 1000);
sentinel('all-fresh-two', DAY);
check('checkTurnTierSentinelPrune returns null when nothing exceeds the threshold', checkTurnTierSentinelPrune(HOME, NOW) === null);

rmSync(ROOT, {recursive: true, force: true});
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
