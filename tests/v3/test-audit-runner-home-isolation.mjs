#!/usr/bin/env node
// Task #33 — regression harness for audit-runner HOME isolation.
//
// tools/prism-audit-runner.mjs used to spawn every scenario's target hook with
// `env: process.env`, so the hooks resolved HOME to the OPERATOR'S REAL HOME and
// each audit run deposited fixture state into the live ~/.claude, structurally
// indistinguishable from production session state. Measured on the real HOME
// before the fix, scoped to the `audit-*` session ids this catalog actually emits
// (so the numbers are attributable to THIS runner, not to other harnesses'
// app-A*/live-L*/s-* fixtures that share the dir): 13 `.prism-turn-tier-audit-*`
// sentinels, 63 `"session_id":"audit-` lines in the production
// `.prism-routing.jsonl`, 77 `audit-` lines in `.prism-spend.jsonl` — and 24
// entries across 11 artifact families deposited per full run.
//
// This test pins the fix. It never touches the operator's real HOME: it points
// the runner at a throwaway SIM_HOME standing in for "the operator's home", and
// asserts fixture state does NOT land there.
//
// Cases:
//   1. isolation      — a run with HOME=SIM_HOME leaves NO audit sentinel in SIM_HOME
//   2. non-vacuous    — that same run DID deposit the sentinel in the isolated
//                       audit home (otherwise case 1 could pass by the hook simply
//                       never running, which would make the whole test worthless)
//   3. negative ctrl  — PRISM_AUDIT_REAL_HOME=1 puts the sentinel back INTO
//                       SIM_HOME, proving case 1 measures isolation rather than
//                       the sentinel merely never being written anywhere
//   4. idempotency    — two consecutive runs produce identical pass/fail sets
//                       (a persistent audit home previously made run 2 differ from
//                       run 1: UAT60-E19A read run 1's leftover inflight-dispatch
//                       file and flipped exit 0 -> 2)
//
// Run: node tests/v3/test-audit-runner-home-isolation.mjs

import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const RUNNER = join(REPO, 'tools', 'prism-audit-runner.mjs');
// Must match AUDIT_HOME in tools/prism-audit-runner.mjs.
const ISOLATED_HOME = join(tmpdir(), 'prism-audit-home');

const SID = 'audit-HOMEISO-001';
const SENTINEL = `.prism-turn-tier-${SID}.json`;

let pass = 0, total = 0;
const check = (label, cond) => {
  total++;
  if (cond) { pass++; console.log('PASS: ' + label); }
  else { console.log('FAIL: ' + label); }
};

// A one-scenario catalog aimed at the tier-router, which writes a sentinel named
// after the payload's session_id — the cheapest observable proof of "which HOME
// did the spawned hook actually write to".
function writeCatalog(dir) {
  const p = join(dir, 'catalog.json');
  writeFileSync(p, JSON.stringify({
    schema_version: 1,
    description: 'home-isolation regression fixture',
    scenarios: [{
      id: 'HOMEISO-001',
      name: 'tier-router writes a sentinel',
      category: 'classifier',
      capability: 'home_isolation',
      target_hook: 'hooks/prism-prompt-tier-router.mjs',
      input_event: 'UserPromptSubmit',
      input_payload: {session_id: SID, prompt: 'what does SIGTERM mean'},
      expected_exit_code: 0,
      max_duration_ms: 500,
    }],
  }));
  return p;
}

function runAudit({simHome, realHomeMode = false, catalogPath, outPath}) {
  return spawnSync(process.execPath, [RUNNER, '--scenarios', catalogPath, '--output', outPath], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 120000,
    env: {
      ...process.env,
      HOME: simHome,
      USERPROFILE: simHome,
      ...(realHomeMode ? {PRISM_AUDIT_REAL_HOME: '1'} : {PRISM_AUDIT_REAL_HOME: ''}),
    },
  });
}

// ── Cases 1 + 2: isolated run ───────────────────────────────────────────────
{
  const sim = mkdtempSync(join(tmpdir(), 'prism-simhome-'));
  mkdirSync(join(sim, '.claude'), {recursive: true});
  const work = mkdtempSync(join(tmpdir(), 'prism-isowork-'));
  try {
    runAudit({
      simHome: sim, catalogPath: writeCatalog(work), outPath: join(work, 'out.jsonl'),
    });
    check('isolated run leaves NO audit sentinel in the simulated real HOME',
      !existsSync(join(sim, '.claude', SENTINEL)));
    check('isolated run DID write the sentinel into the isolated audit home (non-vacuous)',
      existsSync(join(ISOLATED_HOME, '.claude', SENTINEL)));
  } finally {
    rmSync(sim, {recursive: true, force: true});
    rmSync(work, {recursive: true, force: true});
  }
}

// ── Case 3: negative control — the escape hatch restores real-HOME writes ────
// Without this, case 1 would also pass if the sentinel were simply never written
// anywhere (e.g. the hook silently failing), which would be a false green.
{
  const sim = mkdtempSync(join(tmpdir(), 'prism-simhome-real-'));
  mkdirSync(join(sim, '.claude'), {recursive: true});
  const work = mkdtempSync(join(tmpdir(), 'prism-realwork-'));
  try {
    runAudit({
      simHome: sim, realHomeMode: true,
      catalogPath: writeCatalog(work), outPath: join(work, 'out.jsonl'),
    });
    check('PRISM_AUDIT_REAL_HOME=1 DOES write the sentinel into the real HOME (control)',
      existsSync(join(sim, '.claude', SENTINEL)));
  } finally {
    rmSync(sim, {recursive: true, force: true});
    rmSync(work, {recursive: true, force: true});
  }
}

// ── Case 4: idempotency across consecutive runs ──────────────────────────────
{
  const sim = mkdtempSync(join(tmpdir(), 'prism-simhome-idem-'));
  mkdirSync(join(sim, '.claude'), {recursive: true});
  const work = mkdtempSync(join(tmpdir(), 'prism-idemwork-'));
  try {
    const catalogPath = join(REPO, 'tests', 'v3', 'audit-scenarios.json');
    const ids = (out) => {
      if (!existsSync(out)) return null;
      return readFileSync(out, 'utf-8').trim().split('\n')
        .map(JSON.parse).filter(r => !r.pass).map(r => r.scenario_id).sort().join(',');
    };
    const o1 = join(work, 'a.jsonl'), o2 = join(work, 'b.jsonl');
    runAudit({simHome: sim, catalogPath, outPath: o1});
    runAudit({simHome: sim, catalogPath, outPath: o2});
    const f1 = ids(o1), f2 = ids(o2);
    check('two consecutive full runs produce an identical failure set (idempotent)',
      f1 !== null && f1 === f2);
    if (f1 !== f2) console.log(`  run1=[${f1}]\n  run2=[${f2}]`);
  } finally {
    rmSync(sim, {recursive: true, force: true});
    rmSync(work, {recursive: true, force: true});
  }
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
