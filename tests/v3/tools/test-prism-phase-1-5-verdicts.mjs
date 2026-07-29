#!/usr/bin/env node
// F30 — tools/prism-phase-1-5-verdicts.mjs (verdict log reader/aggregator CLI) had
// zero test coverage: 17 grep hits in tests/ all reference the
// .prism-phase-1-5-verdicts.jsonl ARTIFACT FILENAME as a fixture for other
// consumers (ratchet, freshness-sweep, knowledge-indexer, oob-pickup) — none
// actually spawn this script. This file is the first real coverage.
//
// Exercises (all read from tools/prism-phase-1-5-verdicts.mjs source, not assumed):
//   - default 30-day window: sinceMs = Date.now() - 30*24*60*60*1000, entries
//     kept when completed_at >= sinceMs (inclusive lower bound).
//   - --since <date>: valid date narrows the window; INVALID date -> exit 2
//     (process.exit(2), confirmed at prism-phase-1-5-verdicts.mjs:53).
//   - --agent <name>: prefixes a bare name with '@' before filtering.
//   - --json: raw JSON array of surviving entries.
//   - --uncited-rate [--json]: per-agent rollup sorted by un_cited_rate desc.
//   - --help: usage line, exit 0.
//   - missing log file: exit 0, "No verdict log yet" (fail-open).
//   - corrupt log (bad JSON line): exit 1, "Failed to read log" on stderr.
//
// CRITICAL: every timestamp is derived from Date.now() at run time — never a
// calendar literal — so this test does not silently change meaning as real
// time passes (lesson from a prior finding on this same window logic).

import {readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'prism-phase-1-5-verdicts.mjs');

const DAY = 24 * 60 * 60 * 1000;

function run(args, home) {
  const res = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf-8',
    env: {...process.env, HOME: home, USERPROFILE: home},
  });
  return {status: res.status, stdout: res.stdout || '', stderr: res.stderr || ''};
}

function mkSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'prism-verdicts-cli-test-'));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, {recursive: true});
  return {home, claudeDir, logPath: join(claudeDir, '.prism-phase-1-5-verdicts.jsonl')};
}

function entry(completedAtMs, specialist, summary) {
  return {
    completed_at: new Date(completedAtMs).toISOString(),
    specialist_name: specialist,
    summary,
  };
}

function main() {
  assert.ok(existsSync(TOOL), `tool missing: ${TOOL}`);

  const now = Date.now();
  // Clearly inside the default 30-day window.
  const t5d = now - 5 * DAY;
  const t29d = now - 29 * DAY;
  // Clearly outside the default window.
  const t31d = now - 31 * DAY;
  // Straddle the exact boundary with a 1-hour margin each side, so ordinary
  // test-execution latency between "now" (captured here) and the tool's own
  // Date.now() (captured when it runs a few ms later) can never flip which
  // side of the window these land on.
  const tBoundaryIn = now - (30 * DAY - 60 * 60 * 1000);   // ~29d23h ago -> IN
  const tBoundaryOut = now - (30 * DAY + 60 * 60 * 1000);  // ~30d1h ago  -> OUT

  const eIn5d = entry(t5d, '@code-reviewer', {total: 10, evidenced: 7, un_cited: 2, rejected: 1});
  const eIn29d = entry(t29d, '@code-reviewer', {total: 5, evidenced: 3, un_cited: 1, rejected: 1});
  const eOut31d = entry(t31d, '@security-expert', {total: 100, evidenced: 100, un_cited: 0, rejected: 0});
  const eInBoundary = entry(tBoundaryIn, '@security-expert', {total: 4, evidenced: 2, un_cited: 2, rejected: 0});
  const eOutBoundary = entry(tBoundaryOut, '@security-expert', {total: 999, evidenced: 0, un_cited: 999, rejected: 0});

  const allEntries = [eIn5d, eIn29d, eOut31d, eInBoundary, eOutBoundary];

  function writeLog(logPath, entries) {
    writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  // ── (a) missing log file -> exit 0, fail-open ──────────────────────────────
  {
    const {home} = mkSandbox();
    try {
      const res = run([], home);
      assert.equal(res.status, 0, `missing-log exit != 0\nstderr:\n${res.stderr}`);
      assert.match(res.stdout, /No verdict log yet/, 'missing-log message not shown');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: missing log -> exit 0, fail-open message');

  // ── (b) default 30-day window (text output) ────────────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const res = run([], home);
      assert.equal(res.status, 0, `default-window exit != 0\nstderr:\n${res.stderr}`);
      // Only eIn5d + eIn29d + eInBoundary survive: dispatches=3,
      // total=10+5+4=19, evidenced=7+3+2=12, un_cited=2+1+2=5, rejected=1+1+0=2.
      assert.match(res.stdout, /Dispatches:\s*3\b/, 'dispatch count wrong');
      assert.match(res.stdout, /Total claims:\s*19\b/, 'total claims wrong');
      assert.match(res.stdout, /EVIDENCED:\s*12\b/, 'evidenced count wrong');
      assert.match(res.stdout, /UN-CITED:\s*5\b/, 'un_cited count wrong');
      assert.match(res.stdout, /REJECTED:\s*2\b/, 'rejected count wrong');
      // Sentinel: eOutBoundary's 999 values must NOT leak into the totals.
      assert.doesNotMatch(res.stdout, /999/, 'out-of-window sentinel entry leaked into default-window totals');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: default 30-day window includes t5d/t29d/boundary-in, excludes t31d/boundary-out');

  // ── (c) --json shape, default window ───────────────────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const res = run(['--json'], home);
      assert.equal(res.status, 0, `--json exit != 0\nstderr:\n${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.ok(Array.isArray(parsed), '--json did not return an array');
      assert.equal(parsed.length, 3, `expected 3 entries in default window, got ${parsed.length}`);
      const completedSet = new Set(parsed.map(e => e.completed_at));
      assert.ok(completedSet.has(eIn5d.completed_at), 't5d entry missing from --json output');
      assert.ok(completedSet.has(eIn29d.completed_at), 't29d entry missing from --json output');
      assert.ok(completedSet.has(eInBoundary.completed_at), 'boundary-in entry missing from --json output');
      assert.ok(!completedSet.has(eOut31d.completed_at), 't31d entry leaked into --json output');
      assert.ok(!completedSet.has(eOutBoundary.completed_at), 'boundary-out entry leaked into --json output');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --json shape (array of surviving entries, correct membership)');

  // ── (d) --since with a VALID date widens the window ─────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const sinceDate = new Date(now - 60 * DAY).toISOString().slice(0, 10); // YYYY-MM-DD, 60 days ago
      const res = run(['--since', sinceDate, '--json'], home);
      assert.equal(res.status, 0, `--since valid exit != 0\nstderr:\n${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.length, 5, `--since 60d should include all 5 fixture entries, got ${parsed.length}`);
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --since <valid date> widens the window (all 5 entries included)');

  // ── (e) --since with an INVALID date -> exit 2 ───────────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const res = run(['--since', 'not-a-real-date'], home);
      assert.equal(res.status, 2, `invalid --since should exit 2 per source, got ${res.status}`);
      assert.match(res.stderr, /Invalid --since date/, 'invalid-date message not on stderr');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --since <invalid date> -> exit 2, message on stderr');

  // ── (f) --agent filter (bare name gets "@"-prefixed) ─────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const res = run(['--agent', 'code-reviewer', '--json'], home);
      assert.equal(res.status, 0, `--agent exit != 0\nstderr:\n${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.length, 2, `--agent code-reviewer should match 2 entries, got ${parsed.length}`);
      assert.ok(parsed.every(e => e.specialist_name === '@code-reviewer'), '--agent filter let a non-matching specialist through');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --agent filter (bare name auto-prefixed with "@")');

  // ── (g) --uncited-rate --json: per-agent rollup, sorted desc by rate ─────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeLog(logPath, allEntries);
      const res = run(['--uncited-rate', '--json'], home);
      assert.equal(res.status, 0, `--uncited-rate exit != 0\nstderr:\n${res.stderr}`);
      const rows = JSON.parse(res.stdout);
      assert.ok(Array.isArray(rows), '--uncited-rate --json did not return an array');
      assert.equal(rows.length, 2, `expected 2 agents in default window, got ${rows.length}`);
      // In-window: @code-reviewer {total:10,un_cited:2} + {total:5,un_cited:1}
      //   => dispatches=2, total_claims=15, un_cited=3, rate=0.2
      // @security-expert (only eInBoundary in-window): dispatches=1, total_claims=4, un_cited=2, rate=0.5
      const byAgent = Object.fromEntries(rows.map(r => [r.agent, r]));
      assert.ok(byAgent['@code-reviewer'], '@code-reviewer row missing');
      assert.ok(byAgent['@security-expert'], '@security-expert row missing');
      assert.equal(byAgent['@code-reviewer'].dispatches, 2, 'code-reviewer dispatches wrong');
      assert.equal(byAgent['@code-reviewer'].total_claims, 15, 'code-reviewer total_claims wrong');
      assert.equal(byAgent['@code-reviewer'].un_cited, 3, 'code-reviewer un_cited wrong');
      assert.equal(byAgent['@code-reviewer'].un_cited_rate, 0.2, 'code-reviewer un_cited_rate wrong');
      assert.equal(byAgent['@security-expert'].dispatches, 1, 'security-expert dispatches wrong (window leak?)');
      assert.equal(byAgent['@security-expert'].total_claims, 4, 'security-expert total_claims wrong (window leak?)');
      assert.equal(byAgent['@security-expert'].un_cited, 2, 'security-expert un_cited wrong (window leak?)');
      assert.equal(byAgent['@security-expert'].un_cited_rate, 0.5, 'security-expert un_cited_rate wrong');
      // Sorted descending by un_cited_rate: security-expert (0.5) before code-reviewer (0.2).
      assert.equal(rows[0].agent, '@security-expert', 'rows not sorted desc by un_cited_rate');
      assert.equal(rows[1].agent, '@code-reviewer', 'rows not sorted desc by un_cited_rate');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --uncited-rate --json per-agent rollup, correct rates, sorted desc');

  // ── (h) --help -> exit 0, usage line ─────────────────────────────────────────
  {
    const {home} = mkSandbox();
    try {
      const res = run(['--help'], home);
      assert.equal(res.status, 0, `--help exit != 0\nstderr:\n${res.stderr}`);
      assert.match(res.stdout, /Usage: prism-phase-1-5-verdicts/, 'usage line missing');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: --help -> exit 0, usage line');

  // ── (i) corrupt log (invalid JSON line) -> exit 1 ────────────────────────────
  {
    const {home, logPath} = mkSandbox();
    try {
      writeFileSync(logPath, 'not valid json\n');
      const res = run([], home);
      assert.equal(res.status, 1, `corrupt log should exit 1, got ${res.status}`);
      assert.match(res.stderr, /Failed to read log/, 'corrupt-log message not on stderr');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  }
  console.log('PASS: corrupt log -> exit 1, message on stderr');

  console.log('GREEN — prism-phase-1-5-verdicts CLI: default window, --since (valid/invalid), --agent, --json, --uncited-rate, --help, missing/corrupt log.');
}

main();
