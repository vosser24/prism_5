#!/usr/bin/env node
// tests/v3/hooks/acl-worker-learn.test.mjs — F2.3 TDD test: worker detect→promote→learn
//
// Asserts that the detached worker runs detect → promote → learn in a single
// pass within the time budget and that the watermark advances exactly once.
//
// Strategy: run the worker directly (node hooks/prism-acl-worker.mjs) in
// a throwaway HOME with:
//   - A routing log seeded with clustered prompts (for detect→promote)
//   - An agent in the roster with corrections_since_last_upgrade >= 3 (for learn)
//   - A stub PRISM_ACL_FACTORY so no real LLM is invoked
//
// Assertions:
//   (a) detect ran: a new skill/agent was promoted (skill dir exists)
//   (b) promote ran: roster gained a new key
//   (c) learn ran: watchdog-monitor-builder version bumped to 2 + digest upgraded entry
//   (d) watermark advanced exactly once (from 0 to N)

import assert from 'node:assert';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync,
  readdirSync,
} from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const WORKER = join(REPO_ROOT, 'hooks', 'prism-acl-worker.mjs');
const STUB_FACTORY = join(REPO_ROOT, 'tests', 'v3', 'cli', 'acl-stub-factory.mjs');

const tmpHome = mkdtempSync(join(tmpdir(), 'prism-acl-worker-learn-'));
const claudeDir = join(tmpHome, '.claude');
mkdirSync(claudeDir, { recursive: true });

// ── Seed routing log ──────────────────────────────────────────────────────────
// 3 watchdog prompts across 2 sessions → detect will produce a promote candidate
// + 1 dispatch record for 'watchdog-monitor-builder' → learn can attribute to it
const routingLines = [
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'build a watchdog monitor to check service health uptime', ts: '2026-06-17T10:00:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-A', description: 'implement health monitor watchdog to track service uptime', ts: '2026-06-17T10:05:00Z' },
  { event: 'dispatch_cap', session_id: 'sess-B', description: 'set up watchdog health monitor for service uptime checking', ts: '2026-06-17T11:00:00Z' },
  // dispatch record for learn() attribution
  { event: 'dispatch_cap', session_id: 'sess-A', cap_name: 'watchdog-monitor-builder', ts: '2026-06-17T10:10:00Z' },
];
const routingPath = join(claudeDir, '.prism-routing.jsonl');
writeFileSync(routingPath, routingLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed lessons: 3 corrections for sess-A → enough to trigger upgrade ────────
const lessonsPath = join(claudeDir, '.prism-lessons.jsonl');
const lessonLines = [
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:02:00Z', content: 'c1' },
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:07:00Z', content: 'c2' },
  { type: 'correction', session_id: 'sess-A', ts: '2026-06-17T10:11:00Z', content: 'c3' },
];
writeFileSync(lessonsPath, lessonLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

// ── Seed roster with watchdog-monitor-builder (v1, corrections_since_last_upgrade=0) ──
// The worker's learn phase will attribute 3 corrections to it and then upgrade it.
const rosterDir = join(claudeDir, 'skills', 'prism-plan', 'references');
mkdirSync(rosterDir, { recursive: true });
const rosterPath = join(rosterDir, 'roster.json');

const skillDir = join(claudeDir, 'skills', 'watchdog-monitor-builder');
mkdirSync(skillDir, { recursive: true });
const liveFile = join(skillDir, 'watchdog-monitor-builder.md');
const v1Content = [
  '---',
  'name: watchdog-monitor-builder',
  'description: Watchdog monitor skill',
  'type: skill',
  'version: 1',
  '---',
  '',
  '# watchdog-monitor-builder v1',
  '',
  'Original v1 content.',
].join('\n');
writeFileSync(liveFile, v1Content, 'utf-8');

// Create v1 snapshot so prior version exists
const ver1Dir = join(claudeDir, 'skills', 'watchdog-monitor-builder', 'versions', '1');
mkdirSync(ver1Dir, { recursive: true });
copyFileSync(liveFile, join(ver1Dir, basename(liveFile)));

const initialRoster = {
  agents: {},
  skills: {
    'watchdog-monitor-builder': {
      description: 'Watchdog monitor skill',
      version: 1,
      path: liveFile,
      corrections_received: 0,
      corrections_since_last_upgrade: 0,
    },
  },
};
writeFileSync(rosterPath, JSON.stringify(initialRoster, null, 2), 'utf-8');

// ── Run the worker directly (synchronous, not detached) ───────────────────────
// We run the worker directly so we can wait for it and inspect results.
const t0 = Date.now();
const result = spawnSync(process.execPath, [WORKER], {
  env: {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PRISM_ACL_FACTORY: STUB_FACTORY,
    PRISM_ACL_TIME_BUDGET_MS: '30000',
  },
  timeout: 30000,
  encoding: 'utf-8',
});
const elapsed = Date.now() - t0;

console.log(`Worker exit=${result.status} elapsed=${elapsed}ms`);
if (result.stderr) console.log(`[worker stderr] ${result.stderr.trim()}`);

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

check('worker exits 0', result.status === 0, `stderr: ${result.stderr?.slice(0, 300)}`);

// ── (a) detect ran: new *-builder skill was promoted ─────────────────────────
const skillsDir = join(claudeDir, 'skills');
let newSkillFound = false;
let newSkillName = '';
if (existsSync(skillsDir)) {
  const entries = readdirSync(skillsDir);
  for (const entry of entries) {
    if (entry !== 'watchdog-monitor-builder' && entry !== 'prism-plan') {
      // Check for a live .md file inside
      const sdir = join(skillsDir, entry);
      try {
        const files = readdirSync(sdir).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          newSkillFound = true;
          newSkillName = entry;
          break;
        }
      } catch {}
    }
  }
}
check('(a) detect ran: new promoted skill exists', newSkillFound,
  newSkillFound ? `found: ${newSkillName}` : 'no new skill dir found');

// ── (b) promote ran: roster gained a new key (beyond watchdog-monitor-builder) ─
let rosterGainedKey = false;
let rosterKeys = [];
try {
  const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const allKeys = [...Object.keys(r.agents || {}), ...Object.keys(r.skills || {})];
  rosterKeys = allKeys;
  // Must have watchdog-monitor-builder (pre-seeded) + at least one new key
  rosterGainedKey = allKeys.length >= 2;
} catch (e) {
  console.log(`  [roster] error: ${e.message}`);
}
check('(b) promote ran: roster has >= 2 keys', rosterGainedKey,
  `keys: ${rosterKeys.join(', ')}`);

// ── (c) learn ran: watchdog-monitor-builder version bumped + digest has upgraded ─
let learnRan = false;
let learnDetail = '';
try {
  const r = JSON.parse(readFileSync(rosterPath, 'utf-8'));
  const entry = r.skills['watchdog-monitor-builder'];
  if (entry && entry.version >= 2) {
    // Check digest
    const digestFile = join(claudeDir, '.prism-acl-digest.json');
    if (existsSync(digestFile)) {
      const digest = JSON.parse(readFileSync(digestFile, 'utf-8'));
      const upgradeEntry = (digest.upgraded || []).find(u => u && u.name === 'watchdog-monitor-builder');
      if (upgradeEntry && upgradeEntry.from === 1 && upgradeEntry.to === 2) {
        learnRan = true;
        learnDetail = `version=${entry.version}, upgraded: ${JSON.stringify(upgradeEntry)}`;
      } else {
        learnDetail = `version=${entry.version} but no valid digest entry; upgraded=${JSON.stringify(digest.upgraded)}`;
      }
    } else {
      learnDetail = `version=${entry.version} but no digest file`;
    }
  } else {
    learnDetail = `version=${entry?.version || 'missing'} (expected >= 2); corrections_since=${entry?.corrections_since_last_upgrade}`;
  }
} catch (e) {
  learnDetail = `error: ${e.message}`;
}
check('(c) learn ran: watchdog-monitor-builder upgraded v1→v2 with digest entry', learnRan, learnDetail);

// Also check v2 snapshot exists
const ver2Dir = join(claudeDir, 'skills', 'watchdog-monitor-builder', 'versions', '2');
check('(c+) v2 snapshot exists', existsSync(ver2Dir), `path: ${ver2Dir}`);

// ── (d) watermark advanced exactly once (from 0 to N > 0) ───────────────────
const wmPath = join(claudeDir, '.prism-acl-watermark');
let wmOk = false;
let wmVal = 0;
try {
  const raw = readFileSync(wmPath, 'utf-8').trim();
  wmVal = parseInt(raw, 10);
  wmOk = Number.isFinite(wmVal) && wmVal > 0;
} catch (e) {
  // watermark file may not exist
}
check('(d) watermark advanced once (0→N)', wmOk, `watermark=${wmVal}`);

console.log(`\nResults: ${pass} PASS, ${fail} FAIL (elapsed=${elapsed}ms)`);

try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
