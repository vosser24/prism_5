#!/usr/bin/env node
// Tests for PRISM_PANEL_DISABLED env-gated panel-suppression switch (v5.13.x).
//
// Purpose: verify the Arm B isolation experiment knob. When
// PRISM_PANEL_DISABLED=1 (or 'true'), the orchestrator/dispatch machinery
// must remain intact while the expert panel is silenced.
//
// Assertions:
//   (a) env UNSET → summon_panel=true, panel_disabled falsy, tier=opus (control)
//   (b) PRISM_PANEL_DISABLED=1 → summon_panel=false AND panel_disabled=true
//       AND tier UNCHANGED (still opus) AND the orchestrator/dispatch preamble
//       still present in additionalContext AND the panel directive ABSENT
//
// Run: node tests/v3/state/test-prism-panel-disabled.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const ROUTER = join(REPO, 'hooks', 'prism-prompt-tier-router.mjs');

// D025 Fix 2a: implicit panel signals are floored at PANEL_MIN_WORDS (50) words.
// padToMinWords() pads a prompt with filler tokens to guarantee ≥50 words, so
// tests that exercise the panel path still work after the floor was added.
const PANEL_MIN_WORDS = 50;
function padToMinWords(prompt) {
  let p = prompt; let n = 0;
  while (p.trim().split(/\s+/).filter(Boolean).length < PANEL_MIN_WORDS) p += ` filler${n++}`;
  return p;
}

// D034 Amendment (2026-06-25): explicit-only panel trigger.
// NOVEL_PROMPT updated to use an EXPLICIT panel request so it reliably triggers
// summon_panel=true under the new explicit-only contract. The PRISM_PANEL_DISABLED
// switch is still meaningful — it suppresses the panel even on explicit requests.
// The padToMinWords comment is preserved for historical reference (the floor still
// applies to implicit signals in PRISM_LEXICAL_PANEL=1 mode).
const NOVEL_PROMPT = 'run the expert panel on this architecture design for a real-time analytics platform';

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}
function assertContains(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`expected string to contain "${needle}"${msg ? ' — ' + msg : ''}\ngot: ${String(haystack).slice(0, 300)}`);
  }
}
function assertNotContains(haystack, needle, msg) {
  if (String(haystack).includes(needle)) {
    throw new Error(`expected string NOT to contain "${needle}"${msg ? ' — ' + msg : ''}`);
  }
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-panel-disabled-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}
function sentinelPath(home, sessionId) {
  return join(home, '.claude', `.prism-turn-tier-${sessionId}.json`);
}

// Run the tier-router hook and return {sentinel, additionalContext}.
function runRouter(home, sessionId, prompt, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PRISM_PROMPT_ROUTER: 'hard',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [ROUTER], {
    encoding: 'utf-8',
    input: JSON.stringify({prompt, session_id: sessionId, cwd: home}),
    env,
    timeout: 15000,
  });
  if (r.status !== 0 && !r.stdout) throw new Error(`router exited ${r.status}: ${r.stderr}`);
  let additionalContext = '';
  try {
    const out = JSON.parse(r.stdout || '{}');
    additionalContext = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
  } catch {}
  const sentinel = JSON.parse(readFileSync(sentinelPath(home, sessionId), 'utf-8'));
  return {sentinel, additionalContext};
}

// ── (a) Control: env UNSET → normal panel path ────────────────────────────────
test('(a) env UNSET: NOVEL prompt → tier=opus, summon_panel=true, panel_disabled falsy', () => {
  const home = makeHome();
  const sid = 'sess-pd-ctrl';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {});
    assertEq(sentinel.tier, 'opus', 'tier must be opus on NOVEL prompt');
    assertEq(!!sentinel.summon_panel, true, 'summon_panel must be true without suppression');
    assertEq(!!sentinel.panel_disabled, false, 'panel_disabled must be falsy when env is unset');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(a) env UNSET: additionalContext contains PANEL-SUMMONING directive', () => {
  const home = makeHome();
  const sid = 'sess-pd-ctrl-ctx';
  try {
    const {additionalContext} = runRouter(home, sid, NOVEL_PROMPT, {});
    assertContains(additionalContext, 'PANEL-SUMMONING', 'panel directive must be present when env is unset');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── (b) PRISM_PANEL_DISABLED=1 ───────────────────────────────────────────────
test('(b) PRISM_PANEL_DISABLED=1: summon_panel=false on NOVEL prompt', () => {
  const home = makeHome();
  const sid = 'sess-pd-b1';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    assertEq(!!sentinel.summon_panel, false, 'summon_panel must be forced false when PRISM_PANEL_DISABLED=1');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(b) PRISM_PANEL_DISABLED=1: panel_disabled=true in sentinel', () => {
  const home = makeHome();
  const sid = 'sess-pd-b2';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    assertEq(!!sentinel.panel_disabled, true, 'panel_disabled must be true when PRISM_PANEL_DISABLED=1');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(b) PRISM_PANEL_DISABLED=1: tier UNCHANGED — still opus', () => {
  const home = makeHome();
  const sid = 'sess-pd-b3';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    assertEq(sentinel.tier, 'opus', 'tier must remain opus even with panel suppressed');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(b) PRISM_PANEL_DISABLED=1: PANEL-SUMMONING directive ABSENT from additionalContext', () => {
  const home = makeHome();
  const sid = 'sess-pd-b4';
  try {
    const {additionalContext} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    assertNotContains(additionalContext, 'PANEL-SUMMONING', 'panel directive must be suppressed when PRISM_PANEL_DISABLED=1');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(b) PRISM_PANEL_DISABLED=1: PRISM TIER ROUTER header still present (orchestrator preamble intact)', () => {
  const home = makeHome();
  const sid = 'sess-pd-b5';
  try {
    const {additionalContext} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    assertContains(additionalContext, 'PRISM TIER ROUTER', 'tier-router preamble must still be present');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── (b) PRISM_PANEL_DISABLED=true (string form) ───────────────────────────────
test('(b) PRISM_PANEL_DISABLED=true: also suppresses panel', () => {
  const home = makeHome();
  const sid = 'sess-pd-btrue';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: 'true'});
    assertEq(!!sentinel.summon_panel, false, 'summon_panel must be false with PRISM_PANEL_DISABLED=true');
    assertEq(!!sentinel.panel_disabled, true, 'panel_disabled must be true with PRISM_PANEL_DISABLED=true');
    assertEq(sentinel.tier, 'opus', 'tier must remain opus');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── (b) PRISM_PANEL_DISABLED=0 (falsy) must NOT suppress ─────────────────────
test('(b) PRISM_PANEL_DISABLED=0: panel NOT suppressed (falsy value)', () => {
  const home = makeHome();
  const sid = 'sess-pd-b0';
  try {
    const {sentinel} = runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '0'});
    assertEq(!!sentinel.summon_panel, true, 'summon_panel must remain true when PRISM_PANEL_DISABLED=0');
    assertEq(!!sentinel.panel_disabled, false, 'panel_disabled must be falsy when PRISM_PANEL_DISABLED=0');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── routing-log marker check: panel_disabled in .prism-routing.jsonl ──────────
test('(b) PRISM_PANEL_DISABLED=1: panel_disabled:true appears in routing log', () => {
  const home = makeHome();
  const sid = 'sess-pd-log';
  try {
    runRouter(home, sid, NOVEL_PROMPT, {PRISM_PANEL_DISABLED: '1'});
    const logPath = join(home, '.claude', '.prism-routing.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assertEq(last.panel_disabled, true, 'panel_disabled:true must appear in the routing log event');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('(a) env UNSET: panel_disabled NOT in routing log (no noise on default path)', () => {
  const home = makeHome();
  const sid = 'sess-pd-log-ctrl';
  try {
    runRouter(home, sid, NOVEL_PROMPT, {});
    const logPath = join(home, '.claude', '.prism-routing.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    // When env is unset, panel_disabled is either absent or falsy.
    const val = last.panel_disabled;
    if (val !== undefined && val !== false && val !== null) {
      throw new Error(`panel_disabled should be absent/falsy on default path, got: ${JSON.stringify(val)}`);
    }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── run all ───────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
