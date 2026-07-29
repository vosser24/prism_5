#!/usr/bin/env node
// PRISM v3.6.0 audit runner.
//
// Loads tests/v3/audit-scenarios.json, spawns each scenario's target hook
// as a subprocess with the input_payload piped via stdin, captures
// timing + exit code + stdout + stderr, compares against expected_*,
// emits one JSON line per scenario to the output JSONL.
//
// Usage:
//   node tools/prism-audit-runner.mjs                              # run all
//   node tools/prism-audit-runner.mjs --category classifier         # filter
//   node tools/prism-audit-runner.mjs --output /tmp/audit-run.jsonl
//   node tools/prism-audit-runner.mjs --scenarios <path>           # custom catalog
//
// Exit 0 on all-pass, 1 on any fail or runner error.

import {readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

// --- arg parsing ---
const args = process.argv.slice(2);
let category = null;
let output = '/tmp/prism-audit-run.jsonl';
let scenariosPath = join(REPO, 'tests/v3/audit-scenarios.json');
let help = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--category' && args[i + 1]) { category = args[i + 1]; i++; }
  else if (args[i] === '--output' && args[i + 1]) { output = args[i + 1]; i++; }
  else if (args[i] === '--scenarios' && args[i + 1]) { scenariosPath = args[i + 1]; i++; }
  else if (args[i] === '--help' || args[i] === '-h') { help = true; }
}

if (help) {
  console.log(`PRISM v3.6.0 audit runner

Usage:
  node tools/prism-audit-runner.mjs [--category <name>] [--output <path>] [--scenarios <path>]

Options:
  --category <name>   Filter scenarios by category (e.g., classifier, mutation-guard, safety)
  --output <path>     Output JSONL path (default: /tmp/prism-audit-run.jsonl)
  --scenarios <path>  Custom catalog (default: tests/v3/audit-scenarios.json)
  --help              This message

Exit 0 on all-pass, 1 on any fail or runner error.`);
  process.exit(0);
}

// --- load catalog ---
if (!existsSync(scenariosPath)) {
  console.error(`[audit] FATAL: scenarios file not found at ${scenariosPath}`);
  // F13 — distinguish "manual (non-plugin) install" from "corrupted/edited source
  // checkout". install-manifest.json ships tools/prism-audit-runner.mjs to a
  // manual install's ~/.claude/tools/, but never copies tests/ (no manifest
  // entry for tests/v3/audit-scenarios.json or tests/v3/analyze-audit.mjs) —
  // so REPO (this runner's parent dir) has no tests/v3 directory at all on a
  // manual install, vs. a full source-repo checkout where tests/v3 exists
  // alongside tools/. Only degrade-with-explanation here; do not silently
  // no-op or fabricate a report (Constraints section of commands/prism-audit-full.md).
  if (!existsSync(join(REPO, 'tests', 'v3'))) {
    console.error(`[audit] This looks like a manual (non-plugin) PRISM install: the runner is`);
    console.error(`[audit] present (this file), but its test-fixture directory (tests/v3/) is`);
    console.error(`[audit] never shipped to manual installs by design (see tools/install-manifest.json`);
    console.error(`[audit] — it copies tools/, hooks/, agents/, commands/, skills/, never tests/).`);
    console.error(`[audit] /prism-audit-full only works from a full PRISM source-repo clone.`);
    console.error(`[audit] Use instead:`);
    console.error(`[audit]   - /prism-audit  (fast hygiene/secrets scan — works on any install)`);
    console.error(`[audit]   - clone the PRISM source repo and run this command with that repo as cwd`);
  }
  process.exit(1);
}
let catalog;
try {
  catalog = JSON.parse(readFileSync(scenariosPath, 'utf-8'));
} catch (err) {
  console.error(`[audit] FATAL: scenarios file invalid JSON: ${err.message}`);
  process.exit(1);
}

const allScenarios = catalog.scenarios || [];
const scenarios = category
  ? allScenarios.filter(s => s.category === category)
  : allScenarios;

if (scenarios.length === 0) {
  console.error(`[audit] no scenarios match (category=${category || 'all'})`);
  process.exit(1);
}

console.log(`[audit] Running ${scenarios.length} scenarios (output: ${output})`);
if (category) console.log(`[audit]   filter: category=${category}`);

// --- ensure output dir exists ---
try { mkdirSync(dirname(output), {recursive: true}); } catch {}

// --- runner ---
let pass = 0;
let fail = 0;
const results = [];

// #33 — AUDIT HOME ISOLATION. Every hook this runner spawns resolves its state
// directory from HOME/USERPROFILE, so inheriting the operator's real environment
// made each audit run deposit fixture state into the LIVE ~/.claude, structurally
// indistinguishable from production session state. Measured on 2026-07-27 against
// the real HOME before this fix, scoped to the `audit-*` session ids THIS catalog
// emits (all 66 of them start with `audit-`, so the count is attributable — the
// wider 42-sentinel figure in task #33 also includes app-A*/live-L*/check-0*/s-*
// fixtures deposited by OTHER harnesses, which this fix does not address):
//   13 `.prism-turn-tier-audit-*.json` sentinels,
//   63 `"session_id":"audit-` lines in the production `.prism-routing.jsonl`,
//   77 `audit-` lines in `.prism-spend.jsonl`.
// A single full run deposits 24 entries across 11 artifact families — sentinels
// are only the visible part; the contaminated routing/spend telemetry is what
// /prism-telemetry and the monitor read back.
// Pointing HOME at a run-scoped temp dir keeps all of it out of production state.
// Stable path (not mkdtemp), mirroring RUN_SCRATCH_DIR below, so the deposited
// fixture state stays inspectable after a run for debugging.
// Escape hatch: PRISM_AUDIT_REAL_HOME=1 restores the prior inherit-real-HOME
// behavior for anyone deliberately auditing against live state.
const USE_REAL_HOME = String(process.env.PRISM_AUDIT_REAL_HOME || '') === '1';
const AUDIT_HOME = USE_REAL_HOME
  ? prismHome()
  : join(tmpdir(), 'prism-audit-home');

// Reset the isolated state dir before every run. Measured, not assumed: with a
// persistent dir the audit is NOT IDEMPOTENT — run 1 on a clean dir scored 68/72,
// and an immediately-following run 2 scored 67/72 because scenario UAT60-E19A
// (prism-dispatch-dedup-guard, expected_exit_code 0) read the
// `.prism-inflight-dispatches-audit-UAT60-E19.json` left behind by run 1 and denied
// with exit 2. A verification harness whose result depends on whether it was run
// before is worse than useless, so each run starts from empty state.
// The USE_REAL_HOME guard is load-bearing: it must be impossible for this to
// delete anything under a real ~/.claude.
if (!USE_REAL_HOME) { try { rmSync(join(AUDIT_HOME, '.claude'), {recursive: true, force: true}); } catch {} }
try { mkdirSync(join(AUDIT_HOME, '.claude'), {recursive: true}); } catch {}

// The environment every spawned hook receives. Beyond HOME isolation this pins
// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS off: it is ambiently set to 1 inside an
// agent-teams session, and hooks/prism-parent-dispatch-guard.mjs:120 reads it to
// downgrade that guard's hard-deny to a D043 advisory — which made scenario
// DSP-001 (expected_exit_code 2) return 0 and fail purely because of WHERE the
// audit was run from, not what the guard does. Pinning it makes the audit
// deterministic inside or outside an agent-teams session. This is the same
// ambient-marker leak class fixed in tests/v3/dispatch-guard-subagent.test.mjs.
const CHILD_ENV = {
  ...process.env,
  HOME: AUDIT_HOME,
  USERPROFILE: AUDIT_HOME,
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '',
};

// #33 — fixture state no longer lands in the real ~/.claude; say where it went.
console.log(`[audit]   hook state dir: ${AUDIT_HOME}` +
  (String(process.env.PRISM_AUDIT_REAL_HOME || '') === '1' ? '  (REAL HOME — PRISM_AUDIT_REAL_HOME=1)' : '  (isolated)'));

// v5.x FIX-B: seed a per-session sentinel so stateful guards (dispatch-guard,
// mutation-guard) can be exercised the way they fire in a live session. The
// synthetic harness otherwise has no sentinel, so the guards short-circuit to
// "allow" and the scenario can't test the deny path. Returns the path to clean.
// #33: seeds into AUDIT_HOME, the SAME root the spawned hook reads via CHILD_ENV —
// these two must not diverge, or the 6 setup_sentinel scenarios would write the
// seed where the hook under test never looks.
function seedSentinel(sc) {
  if (!sc.setup_sentinel) return null;
  const H = AUDIT_HOME;
  if (!H) return null;
  const sid = (sc.input_payload && sc.input_payload.session_id) || 'anon';
  const p = join(H, '.claude', `.prism-turn-tier-${sid}.json`);
  try { mkdirSync(dirname(p), {recursive: true}); writeFileSync(p, JSON.stringify(sc.setup_sentinel)); return p; }
  catch { return null; }
}

// v3.11.1 #66 — portable scratch-cwd placeholder: a scenario's input_payload
// may embed the literal token `{{TMP}}` anywhere a path string is needed
// (e.g. `"cwd": "{{TMP}}/my-scratch-dir"`). Substituted here, at run time,
// for a stable OS-temp-rooted directory shared by the whole audit run — this
// keeps scenarios free of any machine-specific absolute path while still
// isolating filesystem side effects (e.g. handoff-pointer writes) away from
// the real repo. Forward-slash-normalized so it JSON-embeds safely on Windows.
const RUN_SCRATCH_DIR = join(tmpdir(), 'prism-audit-scratch').replace(/\\/g, '/');

function stdinPayload(sc) {
  const raw = JSON.stringify(sc.input_payload || {});
  return raw.includes('{{TMP}}') ? raw.split('{{TMP}}').join(RUN_SCRATCH_DIR) : raw;
}

function runScenario(targetPath, sc) {
  const seeded = seedSentinel(sc);
  return new Promise((resolve) => {
    const done = (res) => { if (seeded) { try { unlinkSync(seeded); } catch {} } resolve(res); };
    const proc = spawn('node', [targetPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CHILD_ENV,   // #33 — isolated HOME + pinned ambient markers, see CHILD_ENV above
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => done({exit_code: -1, stdout, stderr, error: err.message}));
    proc.on('close', exit_code => done({exit_code, stdout, stderr}));
    try {
      proc.stdin.write(stdinPayload(sc));
      proc.stdin.end();
    } catch (err) {
      // stdin may be closed already; ignore
    }
    // v5.x FIX-B: the kill timeout must clear Windows node cold-start (~1–3.5s)
    // + git snapshot, or slow-but-correct hooks get SIGTERM'd → exit null → a
    // FALSE failure. `max_duration_ms` is a soft latency budget (recorded in the
    // result for reporting), NOT the kill deadline.
    const KILL_FLOOR_MS = 12000;
    const timeoutMs = Math.max(sc.max_duration_ms || 0, KILL_FLOOR_MS);
    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
  });
}

function checkPass(result, sc) {
  if (sc.expected_exit_code !== undefined && result.exit_code !== sc.expected_exit_code) {
    return {pass: false, reason: `exit_code expected=${sc.expected_exit_code} got=${result.exit_code}`};
  }
  if (sc.expected_stdout_pattern) {
    const haystack = (result.stdout || '') + '\n' + (result.stderr || '');
    // Support regex alternation (e.g. "sonnet|opus") in addition to literal substrings.
    const matched = (() => { try { return new RegExp(sc.expected_stdout_pattern).test(haystack); } catch { return haystack.includes(sc.expected_stdout_pattern); } })();
    if (!matched) {
      return {pass: false, reason: `stdout/stderr did not contain pattern: ${sc.expected_stdout_pattern.slice(0, 60)}`};
    }
  }
  return {pass: true};
}

(async () => {
  for (const sc of scenarios) {
    const targetPath = join(REPO, sc.target_hook);
    if (!existsSync(targetPath)) {
      console.log(`[audit] ${sc.id} ✗ MISSING TARGET ${sc.target_hook}`);
      results.push({
        ts: new Date().toISOString(),
        scenario_id: sc.id,
        name: sc.name,
        category: sc.category,
        target_hook: sc.target_hook,
        pass: false,
        errors: ['target hook missing on disk'],
        duration_ms: 0,
        hooks_fired: [{
          hook: (sc.target_hook || '').replace(/^.*[\/]/, '').replace(/.mjs$/, ''),
          duration_ms: 0,
        }],
      });
      fail++;
      continue;
    }

    const start = Date.now();
    const result = await runScenario(targetPath, sc);
    const duration_ms = Date.now() - start;
    const verdict = checkPass(result, sc);
    const symbol = verdict.pass ? '✓' : '✗';
    const tail = verdict.pass ? '' : ` — ${verdict.reason}`;
    console.log(`[audit] ${sc.id} ${symbol} ${duration_ms}ms${tail}`);

    results.push({
      ts: new Date().toISOString(),
      scenario_id: sc.id,
      name: sc.name,
      category: sc.category,
      capability: sc.capability,
      target_hook: sc.target_hook,
      pass: verdict.pass,
      reason: verdict.reason,
      exit_code: result.exit_code,
      duration_ms,
      hooks_fired: [{
        hook: (sc.target_hook || '').replace(/^.*[\/]/, '').replace(/.mjs$/, ''),
        duration_ms,
      }],
      expected: (sc.expected_tier && sc.expected_source)
        ? {tier: sc.expected_tier, source: sc.expected_source}
        : null,
      stdout: (result.stdout || '').slice(0, 500),
      stderr: (result.stderr || '').slice(0, 500),
      expected_exit_code: sc.expected_exit_code,
      expected_stdout_pattern: sc.expected_stdout_pattern,
    });

    if (verdict.pass) pass++;
    else fail++;
  }

  // --- write JSONL ---
  try {
    writeFileSync(output, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    console.error(`[audit] FATAL: could not write output: ${err.message}`);
    process.exit(1);
  }

  // --- summary ---
  console.log('');
  console.log(`Run complete: ${pass} pass / ${fail} fail / ${scenarios.length} total.`);
  console.log(`Output: ${output}`);

  if (fail > 0) process.exit(1);
  process.exit(0);
})();
