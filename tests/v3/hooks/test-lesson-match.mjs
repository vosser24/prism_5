#!/usr/bin/env node
// Tests for hooks/prism-lesson-match.mjs
// Run: node tests/v3/hooks/test-lesson-match.mjs
// Exit code: 0 = all pass; 1 = any failure.
//
// v2.0.0 suite — updated for D023 panel override:
//   - Threshold raised to 0.15 (weak 1-2 keyword overlaps no longer match)
//   - Injection emits Rule text, not pointer phrases
//   - Locked adjudications bypass dedup TTL

import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const REPS_MICRO = 1000;
const REPS_CLI = 7;

let pass = 0, fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ok  ' + name); },
          e  => { fail++; console.log('  FAIL ' + name + '\n        ' + (e.stack || e.message)); });
}

function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

// Fresh import of the hook with a GUARANTEED-unique cache-bust token, so each
// test gets its own module instance (module-level caches in the hook do not
// leak across tests). Date.now() alone collides at sub-ms test speeds.
let _importCounter = 0;
function freshHook() {
  const token = Date.now() + '-' + (++_importCounter);
  return import(pathToFileURL(join(HOOKS, 'prism-lesson-match.mjs')).href + '?t=' + token);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// makeTestbed: map with a Locked adjudication that has a Rule line and
// strong tokens for multi-keyword matching at threshold 0.15
function makeTestbed(label) {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-' + label + '-'));
  const refDir = join(home, '.claude', 'references');
  mkdirSync(refDir, {recursive: true});
  const fakeMap = {
    version: 1,
    generated_at: new Date().toISOString(),
    entries: [
      {
        ref: 'D999',
        type: 'adjudication',
        status: 'Locked',
        title: 'Fake dispatcher latency adjudication',
        rule: 'Use a precomputed keyword map; never rescan corpus on every prompt call.',
        relPath: 'docs/prism/adjudications/D999-fake-dispatcher-latency.md',
        tokens: ['latency', 'dispatcher', 'fake', 'adjudication', 'keyword', 'corpus', 'precomputed'],
        triggers: ['dispatcher', 'latency'],
      },
    ],
  };
  writeFileSync(join(refDir, '.knowledge-keyword-map.json'), JSON.stringify(fakeMap, null, 2));
  return home;
}

// makeTestbedWeakEntry: entry with very few tokens, unlikely to hit 0.15 threshold on short prompt
function makeTestbedWeakEntry(label) {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-' + label + '-'));
  const refDir = join(home, '.claude', 'references');
  mkdirSync(refDir, {recursive: true});
  const fakeMap = {
    version: 1,
    generated_at: new Date().toISOString(),
    entries: [
      {
        ref: 'D888',
        type: 'adjudication',
        status: 'Locked',
        title: 'Dispatcher guard decision',
        rule: 'Use positive-list guards only.',
        relPath: 'docs/prism/adjudications/D888-dispatcher-guard.md',
        // Only 2 tokens; a 1-word prompt "hooks" won't reach 0.15 Jaccard
        tokens: ['dispatcher', 'guard'],
        triggers: [],
      },
    ],
  };
  writeFileSync(join(refDir, '.knowledge-keyword-map.json'), JSON.stringify(fakeMap, null, 2));
  return home;
}

function makeTestbedLarge(label) {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-' + label + '-'));
  const refDir = join(home, '.claude', 'references');
  mkdirSync(refDir, {recursive: true});
  const entries = [];
  for (let i = 0; i < 55; i++) {
    entries.push({
      ref: 'D' + String(i + 1).padStart(3, '0'),
      type: i % 3 === 0 ? 'lesson' : 'adjudication',
      status: i % 3 !== 0 ? 'Locked' : '',
      title: 'Entry ' + i + ' about hooks dispatcher latency guard routing',
      rule: 'Use a positive-list matcher and fail open; never block the read-only path.',
      relPath: 'docs/prism/adjudications/D' + String(i + 1).padStart(3, '0') + '-entry-' + i + '.md',
      tokens: ['hooks', 'dispatcher', 'latency', 'guard', 'routing', 'entry' + i],
      triggers: i < 5 ? ['dispatcher'] : [],
    });
  }
  const fakeMap = { version: 1, generated_at: new Date().toISOString(), entries };
  writeFileSync(join(refDir, '.knowledge-keyword-map.json'), JSON.stringify(fakeMap, null, 2));
  return home;
}

// ─── D023 behavioral tests ────────────────────────────────────────────────────

await test('(a) RELEVANT multi-keyword prompt matches at threshold 0.15', async () => {
  const home = makeTestbed('a-relevant');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      // Rich multi-keyword prompt that overlaps with dispatcher/latency/precomputed/corpus/keyword
      const res = await mod.run({ prompt: 'fix the dispatcher latency precomputed corpus keyword map', session_id: 'sess-a', cwd: home });
      assert(res.exit === 0, 'exit 0');
      assert(res.stdout.includes('[[D999]]'), 'stdout should contain [[D999]], got: ' + res.stdout);
      assert(res.stdout.includes('PRISM LESSON-MATCH'), 'stdout should contain PRISM LESSON-MATCH marker, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(a-rule) injected text contains RULE text, not a file pointer', async () => {
  const home = makeTestbed('a-rule');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({ prompt: 'fix the dispatcher latency precomputed corpus keyword map', session_id: 'sess-rule', cwd: home });
      assert(res.exit === 0, 'exit 0');
      // Should contain the rule text
      assert(res.stdout.includes('precomputed keyword map'), 'stdout should contain rule text, got: ' + res.stdout);
      // Must NOT contain pointer-with-read-instruction phrasing
      assert(!res.stdout.includes('read .claude/references'), 'stdout must not contain "read .claude/references", got: ' + res.stdout);
      assert(!res.stdout.includes('read the D-file'), 'stdout must not contain "read the D-file", got: ' + res.stdout);
      assert(!res.stdout.includes('before deciding'), 'stdout must not contain "before deciding", got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(b) WEAK 1-2 word overlap NO LONGER matches at 0.15 (precision)', async () => {
  const home = makeTestbedWeakEntry('b-weak');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      // Only 1 overlapping token ("hooks") out of a 2-token entry — Jaccard too low for 0.15
      const res = await mod.run({ prompt: 'hooks', session_id: 'sess-b', cwd: home });
      assert(res.exit === 0, 'exit 0');
      assert(!res.stdout.includes('LESSON-MATCH'), 'weak 1-word overlap should NOT match at 0.15, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(b2) irrelevant prompt -> no LESSON-MATCH line', async () => {
  const home = makeTestbed('b2-irrelevant');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({ prompt: 'what is the capital of france', session_id: 'sess-b2', cwd: home });
      assert(res.exit === 0, 'exit 0');
      assert(!res.stdout.includes('LESSON-MATCH'), 'stdout should NOT contain LESSON-MATCH, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(c) Locked adjudications BYPASS dedup TTL (zero-suppress)', async () => {
  const home = makeTestbed('c-locked-bypass');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const payload = {prompt: 'fix the dispatcher latency precomputed corpus keyword map', session_id: 'sess-c', cwd: home};
      // 1st run — should emit
      const res1 = await mod.run(payload);
      assert(res1.stdout.includes('[[D999]]'), '1st run should emit [[D999]]: ' + res1.stdout);
      // 2nd run same session — Locked adjudication MUST re-fire (no TTL suppression)
      const res2 = await mod.run(payload);
      assert(res2.stdout.includes('[[D999]]'), '2nd run should ALSO emit [[D999]] (Locked bypass dedup), got: ' + res2.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(c2) non-Locked entries still dedup within TTL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-c2-nonlocked-'));
  try {
    const refDir = join(home, '.claude', 'references');
    mkdirSync(refDir, {recursive: true});
    // Non-locked entry
    const fakeMap = {
      version: 1,
      generated_at: new Date().toISOString(),
      entries: [{
        ref: 'L001',
        type: 'lesson',
        status: '',
        title: 'Lesson about dispatcher latency keywords corpus precomputed',
        rule: 'Cache keyword maps; do not rescan on every call.',
        relPath: 'docs/prism/lessons/2026-06-01-session.md',
        tokens: ['dispatcher', 'latency', 'keywords', 'corpus', 'precomputed', 'cache'],
        triggers: ['dispatcher'],
      }],
    };
    writeFileSync(join(refDir, '.knowledge-keyword-map.json'), JSON.stringify(fakeMap, null, 2));
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const payload = {prompt: 'dispatcher latency keywords corpus precomputed cache', session_id: 'sess-c2', cwd: home};
      const res1 = await mod.run(payload);
      assert(res1.stdout.includes('[[L001]]'), '1st run emits: ' + res1.stdout);
      const res2 = await mod.run(payload);
      assert(!res2.stdout.includes('[[L001]]'), '2nd run should NOT re-emit non-Locked within TTL, got: ' + res2.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(d) missing keyword map -> run() returns empty, exit 0 (fail-open)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-d-nomapfile-'));
  try {
    mkdirSync(join(home, '.claude', 'references'), {recursive: true});
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const res = await mod.run({prompt: 'fix the dispatcher latency', session_id: 'sess-d', cwd: home});
      assert(res.exit === 0, 'exit 0 even with no map');
      assert(res.stdout === '', 'stdout empty with no map, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(e) PRISM_DISABLE_LESSON_MATCH=1 -> empty, exit 0', async () => {
  const home = makeTestbed('e-disabled');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.PRISM_DISABLE_LESSON_MATCH = '1';
    try {
      const res = await mod.run({prompt: 'fix the dispatcher latency precomputed corpus', session_id: 'sess-e', cwd: home});
      assert(res.exit === 0, 'exit 0');
      assert(res.stdout === '', 'stdout empty when disabled, got: ' + res.stdout);
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; delete process.env.PRISM_DISABLE_LESSON_MATCH; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ─── task #82: writeDedup atomicity + loud-fallback tests ────────────────────
//
// Provenance: hooks/prism-lesson-match.mjs:writeDedup used a bare `renameSync`
// with a catch-fallback whose OWN inner catch was `{}` (empty) -- a forced
// rename failure degraded silently to a non-atomic write, and a forced
// failure of THAT write vanished with no record anywhere (D046's characteristic
// "structured path fails -> fallback emits plausible output -> nothing reports
// the miss" shape, found in PRISM's own code). Fix: renameWithRetry (F33's
// shared helper, tools/lib/atomic-fs.mjs) absorbs the transient-error window
// first, and BOTH branches of the remaining catch now call logAdvisory() so
// the degradation is measurable instead of invisible. writeDedup is exported
// with an injectable renameFn (default: the real fs.renameSync) specifically
// so these two tests can force the failure deterministically rather than
// waiting on a real, timing-dependent AV/indexer race.

await test('(f1) FORCED rename failure -> fallback write still lands AND is logged loudly (D046)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-f1-'));
  try {
    mkdirSync(join(home, '.claude'), {recursive: true});
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      // Injected renameFn always throws a TRANSIENT (EPERM) error, the exact
      // code class task #79 observed for real under concurrent-agent load on
      // this destination -- renameWithRetry exhausts its retry budget on it,
      // then writeDedup's catch fires the non-atomic fallback.
      const failingRename = () => { const e = new Error('sharing violation'); e.code = 'EPERM'; throw e; };
      const payload = {injected: {D999: 1}, turn_count: 3};
      mod.writeDedup('sess-f1', payload, failingRename);

      // (1) State was still durably written, via the fallback.
      const statePath = join(home, '.claude', '.prism-lesson-match-sess-f1.json');
      assert(existsSync(statePath), 'fallback write should have landed on disk');
      const written = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert(written.turn_count === 3, 'fallback wrote the correct payload, got: ' + JSON.stringify(written));

      // (2) The degradation was RECORDED, not silent.
      const logPath = join(home, '.claude', '.prism-routing.jsonl');
      assert(existsSync(logPath), 'advisory log should exist');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      const rec = lines.find(l => l.event === 'lesson_match_dedup_write');
      assert(rec, 'a lesson_match_dedup_write record should have been logged, got lines: ' + JSON.stringify(lines));
      assert(rec.status === 'atomic_failed_fallback_ok', 'status should be atomic_failed_fallback_ok, got: ' + JSON.stringify(rec));
      assert(rec.error_code === 'EPERM', 'error_code should be EPERM, got: ' + JSON.stringify(rec));
      assert(rec.session_id === 'sess-f1', 'session_id should be recorded, got: ' + JSON.stringify(rec));
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(f2) FORCED rename failure + FORCED fallback failure -> no longer swallowed by empty catch{}', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-lm-f2-'));
  try {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, {recursive: true});
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      // Make the destination itself a DIRECTORY, so the fallback's plain
      // writeFileSync(p, body) ALSO throws (EISDIR) -- forces both the
      // renameFn AND the fallback write to fail in the same call, which is
      // exactly the branch the old empty `catch {}` discarded.
      const statePath = join(claudeDir, '.prism-lesson-match-sess-f2.json');
      mkdirSync(statePath, {recursive: true});

      const failingRename = () => { const e = new Error('sharing violation'); e.code = 'EPERM'; throw e; };
      // Must NOT throw: writeDedup runs on the UserPromptSubmit hot path and
      // must stay fail-open even when both writes are lost.
      mod.writeDedup('sess-f2', {injected: {}, turn_count: 1}, failingRename);

      const logPath = join(claudeDir, '.prism-routing.jsonl');
      assert(existsSync(logPath), 'advisory log should exist even though BOTH writes failed');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      const rec = lines.find(l => l.event === 'lesson_match_dedup_write');
      assert(rec, 'a lesson_match_dedup_write record should have been logged even on total loss, got lines: ' + JSON.stringify(lines));
      assert(rec.status === 'write_failed', 'status should be write_failed (total loss recorded, not silent), got: ' + JSON.stringify(rec));
      assert(rec.error_code === 'EISDIR', 'error_code should be EISDIR from the fallback writeFileSync, got: ' + JSON.stringify(rec));
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(f3) HAPPY PATH: no injected failure -> zero lesson_match_dedup_write records (only the real-fs path runs)', async () => {
  const home = makeTestbed('f3-happy');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      await mod.run({prompt: 'fix the dispatcher latency precomputed corpus keyword map', session_id: 'sess-f3', cwd: home});
      const logPath = join(home, '.claude', '.prism-routing.jsonl');
      const lines = existsSync(logPath) ? readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const rec = lines.find(l => l.event === 'lesson_match_dedup_write');
      assert(!rec, 'no degraded-write record should be logged when the real rename succeeds, got: ' + JSON.stringify(rec));
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// PERF micro — RELATIVE regression check, not an absolute wall-clock ceiling.
//
// History: this assertion was originally `avgMs < 5` (fixed 5ms/call ceiling).
// That was measured to be UNVIABLE on this machine: the SAME unmodified code,
// same 55-entry testbed, same REPS_MICRO, produced 1.3-1.4ms quiet and
// 5.7-19.4ms under ordinary multi-agent CPU contention (busy neighbor
// processes on other cores) -- a >6x spread with zero code difference. A
// fixed-ms threshold sitting inside that noise band is a coin-flip, not a
// gate (task #79). Four candidates were evaluated before landing on the fix
// below: median-of-N, relative regression vs a same-session baseline,
// load-detection via os.loadavg(), and deleting the assertion outright.
//
// Why median-of-N (rejected): only helps against a few sporadic slow calls
// inside the sample. Measured per-call distribution under the SAME 20-core
// load used above: mean 20.3ms, median 17.9ms, p10 2.0ms, p90 45.0ms, with
// 54% of individual calls > 5ms. The slowdown is a SUSTAINED shift across
// the majority of calls, not outliers -- the median is just as far over any
// fixed ceiling as the mean is, so this candidate does not fix the flip.
//
// Why load-detection via os.loadavg() (rejected): os.loadavg() is a documented
// no-op on Windows -- it returns [0, 0, 0] unconditionally, confirmed on this
// machine even while 20 CPU-saturating processes were actively running. There
// is no OS-level load signal to branch on here; a real load probe would have
// to be a self-timed calibration op, which is just this candidate (below)
// under a different name.
//
// Chosen fix: measure a same-session BASELINE op (small JSON write+rename,
// same temp dir, same order of magnitude of work) immediately alongside the
// real measurement, and assert the RATIO between them instead of an absolute
// ms figure. Rationale for the baseline op: instrumenting run() showed its
// dominant per-call cost is `writeDedup`'s tmp-write + rename (Locked
// adjudications bypass the dedup TTL, so this hook writes its state file on
// EVERY call in this testbed) -- write+rename was ~45-50% of total per-call
// time in both quiet and loaded runs. A baseline op that does the same class
// of fs work tracks system-wide contention (CPU scheduling AND disk/AV I/O
// contention) the same way the real op does, so a global slowdown moves both
// numbers together and cancels out of the ratio. Measured across n=5 runs:
// quiet ratios were 1.93x, 2.02x, 2.27x (3 separate quiet runs); loaded ratios
// (20-core CPU saturation) were 1.22x and 2.23x (2 separate loaded runs). True
// observed range: 1.22x-2.27x, a ~1.9x spread -- do NOT quote "~10% drift"
// here, that number only holds if you cherry-pick the two closest values
// (2.02x and 2.23x) and ignore the 1.22x observation. The honest comparison
// is: ~1.9x ratio spread vs ~5.9x raw-ms spread (1.3-2.9ms quiet -> 5.7-19.4ms
// loaded) over the SAME load delta -- the ratio is not perfectly stable, but
// it is far more stable than the absolute figure it replaces. Notably the
// ratio DECREASED under load (2.27x quiet max vs 1.22x loaded min): the
// baseline op inflated MORE than the measured op under this load pattern,
// which is favorable for avoiding false reds but means this is not a tight
// bidirectional tracker in both directions -- a genuine regression is best
// caught on a quiet run, not inferred from a loaded one. A regression
// genuinely inside lesson-match's own CPU-bound scoring loop (not I/O) would
// still inflate this ratio, since the baseline op does no tokenizing/scoring
// at all -- so this is not merely "impossible to fail," it stays a real gate.
await test('PERF micro: relative to same-session I/O baseline (contention-resistant)', async () => {
  const home = makeTestbedLarge('perf-micro');
  try {
    const mod = await freshHook();
    const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home;
    try {
      const payload = { prompt: 'fix the dispatcher latency issue in the hooks guard routing code', session_id: 'perf-micro-sess', cwd: home };
      await mod.run(payload);

      const t0 = process.hrtime.bigint();
      for (let i = 0; i < REPS_MICRO; i++) {
        await mod.run({...payload, session_id: 'perf-sess-' + i});
      }
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      const avgMs = elapsed / REPS_MICRO;

      // Baseline op: same class of work (small JSON write + rename, same temp
      // dir) as the dominant per-call cost inside run() (writeDedup), so it
      // rises and falls with system contention the same way the real op does.
      const REPS_BASELINE = 300;
      const baselinePayload = {injected: {D001: 1, D002: 1, D003: 1}, turn_count: 42};
      const tBase0 = process.hrtime.bigint();
      for (let i = 0; i < REPS_BASELINE; i++) {
        // Unique dest per iteration: renaming onto the SAME destination
        // repeatedly was observed to throw EPERM (sharing-violation retries)
        // under this same heavy-load condition on Windows -- a real but
        // separate failure mode from what this baseline is measuring.
        const dest = join(home, '.perf-baseline-' + i + '.json');
        const tmp = dest + '.tmp';
        writeFileSync(tmp, JSON.stringify(baselinePayload, null, 2));
        renameSync(tmp, dest);
      }
      const baselineElapsed = Number(process.hrtime.bigint() - tBase0) / 1e6;
      const baselineMs = baselineElapsed / REPS_BASELINE;

      const ratio = avgMs / baselineMs;
      console.log('        [PERF] micro avg ms/call: ' + avgMs.toFixed(3) + 'ms over ' + REPS_MICRO + ' reps'
        + ' (baseline I/O op: ' + baselineMs.toFixed(3) + 'ms over ' + REPS_BASELINE + ' reps, ratio: ' + ratio.toFixed(2) + 'x)');
      // Ceiling: n=5 observed ratios (3 quiet + 2 under 20-core CPU
      // saturation) ranged 1.22x-2.27x -- see the rationale comment above for
      // every individual value. Max observed was 2.27x. The band between
      // that max and this 6x ceiling (2.27x-6x) is UNMEASURED: no run landed
      // there. 6x is therefore a judgment call for headroom above the
      // highest observed value, NOT a measured boundary -- picked to leave
      // room for legitimate run-to-run variance while still catching a
      // genuine multi-x regression in the lesson-match-specific
      // (non-baseline) code path.
      assert(ratio < 6, 'lesson-match call should be < 6x the same-session I/O baseline, got '
        + ratio.toFixed(2) + 'x (' + avgMs.toFixed(3) + 'ms vs baseline ' + baselineMs.toFixed(3) + 'ms)');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// PERF CLI — RELATIVE regression check (WITH/WITHOUT ratio), not an absolute
// wall-clock ceiling. Same defect class as PERF micro above (task #79); this
// is its sibling fix (task #83, [[D102]]).
//
// History: this assertion was `med < 2000` (fixed 2000ms ceiling on the
// median of REPS_CLI=7 spawnSync full-process CLI runs, WITH lesson-match
// enabled). Measured on this machine, same unmodified code: quiet/ambient
// (this session already runs several concurrent teammate agents, so "quiet"
// here means no DELIBERATE extra load) medians were 590-720ms; under a
// DELIBERATE combined load of 20 CPU busy-loop workers + 10 disk-I/O
// busy-loop workers, medians were 2294-2329ms (3 runs); under a heavier 40
// CPU + 20 disk load, medians reached 5445-5922ms (2 runs, individual samples
// up to 9723ms) -- all comfortably clearing the 2000ms ceiling. The old
// assertion flipped in every one of these 5 deliberately-loaded runs and
// never flipped quiet: a coin-flip gated entirely by what else the machine
// is doing, exactly the failure mode [[D102]] documents for its sibling.
//
// [[D092]]: the chair's brief ranked three candidates as a prior, not an
// instruction. All three were measured (not just the top-ranked one) across
// 8 total runs -- 3 ambient-quiet, 3 at 20-CPU+10-disk, 2 at 40-CPU+20-disk:
//
// - WITH-vs-WITHOUT ratio (this test already collects both arms: `med` with
//   lesson-match enabled, `baseMed` with PRISM_DISABLE_LESSON_MATCH=1).
//   ratio = med / baseMed. Observed: 0.897x, 0.912x, 0.934x (quiet) /
//   0.981x, 1.032x, 1.163x (moderate load) / 1.080x, 1.208x (heavy load).
//   Full range across all 8 runs: 0.897x-1.208x -- a ~1.35x spread despite
//   the RAW medians spanning 590ms-5922ms (a ~10x spread) over the same load
//   delta. CHOSEN: both arms run the full dispatcher CLI + tier classifier +
//   node cold-start, so contention inflates them together (matches
//   perf-fix's #77 finding that this benchmark spikes symmetrically on BOTH
//   arms), and the ratio cancels that shared inflation out while still
//   isolating the piece that differs between arms -- lesson-match's own
//   added cost. Bonus: needs no new baseline op, since both arms are already
//   measured; the most surgical fix available here.
// - cold-start-shaped baseline (trivial `node -e 0` spawn, same REPS_CLI,
//   same env/cwd) -- ratio = med / coldMed. Observed: 7.87x-10.17x (quiet),
//   6.98x-8.37x (moderate load), 8.35x-9.12x (heavy load); full range
//   6.98x-10.17x, a ~1.46x spread. Also contention-resistant and, unlike the
//   with/without ratio, it is shaped for the dominant cost this benchmark
//   actually has (process cold-start: the cold-spawn median itself scaled
//   from ~65-80ms quiet to ~280-650ms loaded, roughly tracking the full CLI's
//   own scaling). REJECTED only because it is a strictly weaker regression
//   detector than the with/without ratio above: it cannot distinguish "the
//   dispatcher got slower" from "lesson-match got slower" the way the
//   with/without ratio can, and this test already has the with/without data
//   for free -- no reason to prefer the noisier, less-targeted signal.
// - delete the assertion. Legitimate per [[D102]]'s own text ("still open
//   for PERF CLI"). REJECTED because the with/without ratio candidate above
//   turned out to retain real, measurably stable signal -- deleting would
//   discard a working gate, not just a broken one.
//
// RAW DELTA (med - baseMed, NOT chosen, recorded because it was measured):
// -73ms, -61ms, -46ms (quiet) / -46ms, +71ms, +326ms (moderate load) /
// +403ms, +1020ms (heavy load). Unlike the ratio, this grows with the
// absolute magnitude of contention rather than staying bounded -- confirms
// the ratio, not the raw arm difference, is the contention-resistant form of
// this same with/without data.
//
// Ceiling: n=8 observed with/without ratios ranged 0.897x-1.208x (see above).
// Max observed was 1.208x. Per [[D095]], the band between that max and this
// 3x ceiling (1.208x-3x) is UNMEASURED -- no run landed there. 3x is a
// judgment call for headroom (matching the ~2.6x headroom multiplier PERF
// micro used above: 6x ceiling over a 2.27x max observed), not a measured
// boundary, picked to leave room for legitimate run-to-run variance while
// still catching a genuine multi-x regression specific to lesson-match's own
// added cost on top of the bare dispatcher.
await test('PERF CLI: dispatcher WITH/WITHOUT ratio under ceiling (contention-resistant)', async () => {
  const home = makeTestbedLarge('perf-cli');
  try {
    const DISP = join(HOOKS, 'prism-userpromptsubmit-dispatcher.mjs');
    const payloadJSON = JSON.stringify({ prompt: 'fix the dispatcher latency issue in hooks guard routing', session_id: 'perf-cli-sess', cwd: home });
    const baseEnv = {...process.env, HOME: home, USERPROFILE: home};

    // Baseline: lesson-match DISABLED (isolates node cold-start + tier classifier cost)
    const baseTimes = [];
    for (let i = 0; i < REPS_CLI; i++) {
      const t0 = process.hrtime.bigint();
      spawnSync(process.execPath, [DISP], { input: payloadJSON, encoding: 'utf8', env: {...baseEnv, PRISM_DISABLE_LESSON_MATCH: '1'}, cwd: home });
      baseTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const baseMed = median(baseTimes);

    // With lesson-match ENABLED
    const times = [];
    for (let i = 0; i < REPS_CLI; i++) {
      const t0 = process.hrtime.bigint();
      spawnSync(process.execPath, [DISP], { input: payloadJSON, encoding: 'utf8', env: baseEnv, cwd: home });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const med = median(times);

    const ratio = med / baseMed;
    console.log('        [PERF] dispatcher median WITHOUT lesson-match: ' + baseMed.toFixed(0) + 'ms (all: ' + baseTimes.map(t => t.toFixed(0)).join(', ') + ')');
    console.log('        [PERF] dispatcher median WITH    lesson-match: ' + med.toFixed(0) + 'ms (all: ' + times.map(t => t.toFixed(0)).join(', ') + ', ratio: ' + ratio.toFixed(2) + 'x)');
    assert(ratio < 3, 'dispatcher WITH/WITHOUT ratio should be < 3x, got ' + ratio.toFixed(2)
      + 'x (' + med.toFixed(0) + 'ms vs ' + baseMed.toFixed(0) + 'ms)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('(a2) dispatcher CLI: relevant prompt -> stdout contains [[D999]]', async () => {
  const home = makeTestbed('a2-disp');
  try {
    const DISP = join(HOOKS, 'prism-userpromptsubmit-dispatcher.mjs');
    const r = spawnSync(process.execPath, [DISP], {
      // Rich multi-keyword prompt to clear 0.15 threshold
      input: JSON.stringify({ prompt: 'fix the dispatcher latency precomputed corpus keyword map', session_id: 'sess-a2', cwd: home }),
      encoding: 'utf8',
      env: {...process.env, HOME: home, USERPROFILE: home},
      cwd: home,
    });
    assert(r.status === 0, 'exit 0, stderr=' + r.stderr);
    assert(r.stdout.includes('[[D999]]'), 'dispatcher stdout should contain [[D999]], got: ' + r.stdout);
    assert(r.stdout.includes('precomputed keyword map'), 'dispatcher stdout should contain rule text, got: ' + r.stdout);
  } finally { rmSync(home, {recursive: true, force: true}); }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
