#!/usr/bin/env node
// Tests for v5.4.0 — mutation-guard re-scope (D010 §6).
//
// DECISION (claude-master workshop, option a — full removal):
//   The mutation-guard STOPS hard-blocking the clean Edit/Write/MultiEdit tools
//   in the parent (Opus) context. Those tools emit clean UTF-8 and are the
//   recommended path; the dispatch-guard already owns tier-based work-gating
//   for them (positive-list matcher includes Edit|Write|MultiEdit, and they are
//   absent from its ALWAYS_ALLOW). The mutation-guard keeps its UNIQUE value:
//   blocking Bash/PowerShell file-writes (BOM/bypass hazard on Windows).
//
// Properties pinned here:
//   B1 (unblock):   parent Edit/Write/MultiEdit → ALLOWED (status 0).
//   B2 (retained):  parent Bash/PowerShell file-writes → STILL DENIED (status 2).
//   B3 (subagent):  subagent context is unaffected (both kinds pass).
//   B4 (no hole):   the dispatch-guard remains the sole tier fence for parent
//                   Edit/Write on haiku/sonnet (proves no mutating path opens).
//   B5 (wiring):    v5.7 folds the mutation-guard into the PreToolUse dispatcher
//                   (no standalone entry) in BOTH settings.fragment.json and
//                   .claude-plugin/plugin.json; the dispatcher matcher still
//                   covers Bash + PowerShell so the write-fence keeps firing.
//
// Run: node tests/v3/state/test-prism-mutation-guard-unblock.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const MUTATION_GUARD = join(REPO, 'hooks', 'prism-mutation-guard.mjs');
const DISPATCH_GUARD = join(REPO, 'hooks', 'prism-parent-dispatch-guard.mjs');
const FRAGMENT = join(REPO, 'settings.fragment.json');
const PLUGIN = join(REPO, '.claude-plugin', 'plugin.json');

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function assertEq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`expected ${B}, got ${A}${msg ? ' — ' + msg : ''}`);
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'prism-mg-unblock-'));
  mkdirSync(join(home, '.claude'), {recursive: true});
  return home;
}
function sentinelPath(home, sessionId) {
  return join(home, '.claude', `.prism-turn-tier-${sessionId}.json`);
}
function seedSentinel(home, sessionId, obj) {
  writeFileSync(sentinelPath(home, sessionId), JSON.stringify(obj));
}
// Parent turn: NOT dispatched, NOT force_opus — the case the guard would block.
// `entrypoint` lets a test simulate a subagent via CLAUDE_CODE_ENTRYPOINT.
function runHook(hook, home, payload, {entrypoint = ''} = {}) {
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    PRISM_DISPATCH_GUARD: 'hard', PRISM_MUTATION_GUARD: 'hard',
    CLAUDE_CODE_ENTRYPOINT: entrypoint,
    // Pin single-actor: clear the agent-teams marker so this test's single-actor
    // hard-deny assertions don't flip to the D043 advisory-downgrade when the
    // harness runs inside an agent-teams session (ambient marker leak).
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '',
  };
  const r = spawnSync(process.execPath, [hook], {encoding: 'utf-8', input: JSON.stringify(payload), env, timeout: 15000});
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

const parentSentinel = () => ({
  tier: 'opus', summon_panel: false, dispatched: false, force_opus: false,
  source: 'keyword-floor', rationale: 'test parent turn', ts: new Date().toISOString(),
});

// Read the mutation-guard hook group's matcher out of a manifest's PreToolUse.
function matcherFor(manifestPath, hookNeedle) {
  const j = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const groups = (((j.hooks || {}).PreToolUse) || []);
  for (const g of groups) {
    for (const h of (g.hooks || [])) {
      if (String(h.command || '').includes(hookNeedle)) return g.matcher;
    }
  }
  return undefined;
}

// ── B1: parent Edit/Write/MultiEdit now ALLOWED ──────────────────────────────
test('mutation-guard: ALLOWS Edit in the parent (opus, not dispatched) on a normal file', () => {
  const home = makeHome(); const sid = 'mg-b1-edit';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Edit', session_id: sid,
      tool_input: {file_path: join(home, 'src', 'thing.js'), old_string: 'a', new_string: 'b'},
    });
    assertEq(r.status, 0, 'parent Edit must be allowed — clean UTF-8, dispatch-guard owns tier gating');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: ALLOWS Write in the parent (no sentinel) on a normal file', () => {
  const home = makeHome(); const sid = 'mg-b1-write';
  try {
    // no sentinel seeded — the bare parent case
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Write', session_id: sid,
      tool_input: {file_path: join(home, 'README.md'), content: '# hi'},
    });
    assertEq(r.status, 0, 'parent Write must be allowed');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: ALLOWS MultiEdit in the parent on a normal file', () => {
  const home = makeHome(); const sid = 'mg-b1-multi';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'MultiEdit', session_id: sid,
      tool_input: {file_path: join(home, 'a.ts'), edits: [{old_string: 'x', new_string: 'y'}]},
    });
    assertEq(r.status, 0, 'parent MultiEdit must be allowed');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── B2: parent Bash/PowerShell file-writes STILL DENIED (retained value) ──────
test('mutation-guard: DENIES a Bash ">" redirect file-write in the parent', () => {
  const home = makeHome(); const sid = 'mg-b2-redir';
  try {
    seedSentinel(home, sid, parentSentinel()); // opus + not dispatched ⇒ proves mutation-guard blocks INDEPENDENTLY of tier
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Bash', session_id: sid,
      tool_input: {command: 'echo hi > out.txt'},
    });
    assertEq(r.status, 2, 'parent Bash file-write must stay blocked (BOM/bypass)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: DENIES a Set-Content file-write (no encoding) in the parent', () => {
  const home = makeHome(); const sid = 'mg-b2-sc';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Bash', session_id: sid,
      tool_input: {command: 'Set-Content -Path x.json -Value $j'},
    });
    assertEq(r.status, 2, 'Set-Content without UTF8NoBOM must stay blocked');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: Set-Content -Encoding UTF8NoBOM still blocked (bypass) but WITHOUT the BOM warning', () => {
  const home = makeHome(); const sid = 'mg-b2-bomsafe';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Bash', session_id: sid,
      tool_input: {command: 'Set-Content -Path x.json -Value $j -Encoding UTF8NoBOM'},
    });
    assertEq(r.status, 2, 'BOM-safe write is still a parent Bash-write bypass — stays blocked');
    if (process.platform === 'win32') {
      const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
      assertEq(/BOM WARNING/.test(reason), false, 'BOM_SAFE_RE must suppress the BOM warning text');
    }
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: passes a non-write Bash command (git status) in the parent', () => {
  const home = makeHome(); const sid = 'mg-b2-ro';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Bash', session_id: sid,
      tool_input: {command: 'git status'},
    });
    assertEq(r.status, 0, 'non-write Bash must pass cleanly');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── B3: subagent context unaffected ──────────────────────────────────────────
test('mutation-guard: ALLOWS a Bash ">" redirect in SUBAGENT context (parent_tool_use_id)', () => {
  const home = makeHome(); const sid = 'mg-b3-bash';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Bash', session_id: sid, parent_tool_use_id: 'toolu_123',
      tool_input: {command: 'echo hi > out.txt'},
    });
    assertEq(r.status, 0, 'subagent Bash-write passes (subagent owns its own writes)');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('mutation-guard: ALLOWS Edit in SUBAGENT context (CLAUDE_CODE_ENTRYPOINT=subagent)', () => {
  const home = makeHome(); const sid = 'mg-b3-edit';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(MUTATION_GUARD, home, {
      tool_name: 'Edit', session_id: sid,
      tool_input: {file_path: join(home, 'a.js'), old_string: 'a', new_string: 'b'},
    }, {entrypoint: 'subagent'});
    assertEq(r.status, 0, 'subagent Edit passes');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── B4: dispatch-guard remains the sole tier fence for parent Edit (no hole) ──
test('dispatch-guard: STILL denies Edit on a sonnet turn pre-dispatch (sole tier fence for edits)', () => {
  const home = makeHome(); const sid = 'mg-b4-sonnet';
  try {
    seedSentinel(home, sid, {
      tier: 'sonnet', summon_panel: false, dispatched: false, orchestrator_dispatched: false,
      source: 'keyword-floor', rationale: 'test sonnet turn', ts: new Date().toISOString(),
    });
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Edit', session_id: sid,
      tool_input: {file_path: join(home, 'real.js'), old_string: 'a', new_string: 'b'},
    });
    assertEq(r.status, 2, 'dispatch-guard must still gate parent Edit on sonnet — it now solely owns this');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

test('dispatch-guard: ALLOWS Edit on an opus non-panel turn (intended: parent Opus may edit)', () => {
  const home = makeHome(); const sid = 'mg-b4-opus';
  try {
    seedSentinel(home, sid, parentSentinel());
    const r = runHook(DISPATCH_GUARD, home, {
      tool_name: 'Edit', session_id: sid,
      tool_input: {file_path: join(home, 'real.js'), old_string: 'a', new_string: 'b'},
    });
    assertEq(r.status, 0, 'opus parent Edit is allowed by the tier fence — consistent with mutation-guard now allowing it');
  } finally { rmSync(home, {recursive: true, force: true}); }
});

// ── B5: mutation-guard folded into the PreToolUse dispatcher (v5.7) ───────────
// Pre-5.7 the guard was its OWN PreToolUse entry, narrowed to matcher "Bash".
// v5.7 folds the advisory PreToolUse guards into prism-pretooluse-dispatcher.mjs,
// and the Bash/PowerShell narrowing now lives INSIDE the dispatcher (the mutation
// branch only runs classifyBashCommand for Bash/PowerShell — see
// tests/v3/hooks/test-mutation-guard-classify.mjs). So the wiring invariant is now:
// NO standalone mutation-guard entry, and a single dispatcher entry whose matcher
// still covers Bash + PowerShell (so the BOM/bypass write-fence still reaches).
function coversBashAndPowerShell(m) {
  return typeof m === 'string' && /\bBash\b/.test(m) && /\bPowerShell\b/.test(m);
}
test('settings.fragment.json: mutation-guard folded into PreToolUse dispatcher (no standalone entry)', () => {
  assertEq(matcherFor(FRAGMENT, 'prism-mutation-guard.mjs'), undefined, 'no standalone mutation-guard PreToolUse entry after v5.7 consolidation');
  assertEq(coversBashAndPowerShell(matcherFor(FRAGMENT, 'prism-pretooluse-dispatcher.mjs')), true, 'dispatcher matcher must still cover Bash + PowerShell');
});

test('.claude-plugin/plugin.json: mutation-guard folded into PreToolUse dispatcher (no standalone entry)', () => {
  assertEq(matcherFor(PLUGIN, 'prism-mutation-guard.mjs'), undefined, 'no standalone mutation-guard PreToolUse entry after v5.7 consolidation');
  assertEq(coversBashAndPowerShell(matcherFor(PLUGIN, 'prism-pretooluse-dispatcher.mjs')), true, 'dispatcher matcher must still cover Bash + PowerShell');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
