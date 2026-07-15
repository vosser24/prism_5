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
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
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

await test('PERF micro: avg ms/call < 5ms with 55-entry map', async () => {
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
      console.log('        [PERF] micro avg ms/call: ' + avgMs.toFixed(3) + 'ms over ' + REPS_MICRO + ' reps');
      assert(avgMs < 5, 'avg ms/call should be < 5ms, got ' + avgMs.toFixed(3) + 'ms');
    } finally { process.env.HOME = prevH; process.env.USERPROFILE = prevU; }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

await test('PERF CLI: dispatcher median under ceiling, with vs without lesson-match', async () => {
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

    console.log('        [PERF] dispatcher median WITHOUT lesson-match: ' + baseMed.toFixed(0) + 'ms (all: ' + baseTimes.map(t => t.toFixed(0)).join(', ') + ')');
    console.log('        [PERF] dispatcher median WITH    lesson-match: ' + med.toFixed(0) + 'ms (all: ' + times.map(t => t.toFixed(0)).join(', ') + ')');
    assert(med < 2000, 'dispatcher median should be < 2000ms, got ' + med.toFixed(0) + 'ms');
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
