#!/usr/bin/env node
// prism-sync — deterministic maintenance helper for /prism-sync (v3.11.0 Phase A.1).
//
// Conservative drift only in v3.11.0: every sync re-runs discovery/roster/health.
// --smart-drift is a stub that prints an EXPERIMENTAL warning and falls back to conservative.
//
// Locked design: docs/prism/adjudications/D002-v3.10-hooks-drift-scope.md §5
//
// Subcommands:
//   prism-sync plan [--smart-drift]
//   prism-sync complete [--meta '<json>']
//
// All subcommands accept --root <path> and refuse to run without .git/ unless --no-git-guard.

import {existsSync, statSync, appendFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';
import {prismHome} from '../hooks/lib/prism-home.mjs';

import {
  isPhaseCompleted,
  markPhaseCompleted,
  nowIso,
  readState,
  setSyncStamps,
  writeStateAtomic,
} from './lib/prism-state.mjs';
import { reconcileRoster } from './lib/prism-roster-reconcile.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), smartDrift: false, noGitGuard: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--smart-drift') opts.smartDrift = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-sync <command> [args] [--root <path>] [--no-git-guard]

Commands:
  plan [--smart-drift]
  complete [--meta '<json>']
  reconcile-roster
`);
  exit(code);
}

function resolveHome() {
  return prismHome();
}

// ------------------------------ guards ------------------------------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

// ------------------------------ helpers ------------------------------

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

// Fail-open routing-log append (mirrors the hooks' one-liner pattern, e.g.
// hooks/prism-file-lease-guard.mjs appendLog). Gives the exit-3/no-op and
// completion decision points an observable trace so "correctly declined" and
// "silently broken" are distinguishable after the fact (F8). Telemetry must
// never break the sync it records — swallow every error.
function appendRouting(obj) {
  try {
    const home = prismHome();
    const p = join(home, '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), {recursive: true});
    appendFileSync(p, JSON.stringify({ts: new Date().toISOString(), ...obj}) + '\n');
  } catch { /* fail-open */ }
}

// ------------------------------ phase planning ------------------------------

function loadStateOrDie() {
  const r = readState(opts.root);
  if (r.status === 'missing') {
    // Observability for the correct-by-design decline in an unbootstrapped
    // worktree: the exit-3 STOP contract is unchanged, we only leave a trace.
    if (cmd === 'plan') appendRouting({event: 'prism_sync', action: 'no-state', root: opts.root});
    die('no state file. Run: /prism-bootstrap first.', 3);
  }
  if (r.status !== 'ok') {
    die(`state ${r.status}: ${r.errors.join('; ')}`, 4);
  }
  return r.state;
}

function claudeMdChangedSince(referenceIso) {
  const path = join(opts.root, 'CLAUDE.md');
  if (!existsSync(path)) return false;
  if (!referenceIso) return true;
  const mtimeMs = statSync(path).mtimeMs;
  const refMs = new Date(referenceIso).getTime();
  return mtimeMs > refMs;
}

function planMaintenancePhases(state, root) {
  const reasons = {};
  const pending = [];

  pending.push('structure');
  reasons.structure = 'verify scaffold';

  const baseline = state.last_sync_at || state.initialized_at;
  const claudeChanged = claudeMdChangedSince(baseline);
  if (claudeChanged) {
    pending.push('identity');
    reasons.identity = 'CLAUDE.md modified since last sync';
  }

  pending.push('discovery');
  reasons.discovery = 'conservative re-scan';

  pending.push('roster');
  // F11 (task #26): this used to be a label with no diff behind it. Now
  // actually runs the reconcile so `reasons.roster` reflects real findings
  // instead of a static "reconcile orphan agents" string that named work it
  // never did.
  const rosterReconcile = reconcileRoster({home: resolveHome(), cwd: root});
  const orphanCount = rosterReconcile.orphanRosterEntries.length + rosterReconcile.orphanDiskFiles.length;
  const renamedCount = rosterReconcile.renamedOrphans.length;
  const shadowedCount = rosterReconcile.shadowed.length;
  reasons.roster = (orphanCount === 0 && renamedCount === 0 && shadowedCount === 0)
    ? 'reconcile orphan agents — no orphans found'
    : `reconcile orphan agents — ${orphanCount} orphan(s), ${renamedCount} renamed, ${shadowedCount} shadowed (see roster_reconcile)`;

  pending.push('health');
  reasons.health = 'verify wiring';

  return {pending, reasons, claude_md_changed: claudeChanged, roster_reconcile: rosterReconcile};
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'plan': {
      if (opts.smartDrift) {
        stderr.write('WARNING: --smart-drift is EXPERIMENTAL and not yet implemented; falling back to conservative.\n');
      }
      const state = loadStateOrDie();
      const planned = planMaintenancePhases(state, opts.root);
      stdout.write(JSON.stringify({
        project: state.project_name,
        mode: 'conservative',
        pending: planned.pending,
        reasons: planned.reasons,
        last_sync_at: state.last_sync_at,
        last_run: state.last_run,
        claude_md_changed: planned.claude_md_changed,
        roster_reconcile: planned.roster_reconcile,
      }, null, 2) + '\n');
      break;
    }

    case 'reconcile-roster': {
      // Standalone entry point (F11 / task #26) — same reconcile the `plan`
      // phase now runs, callable directly without a full bootstrap/state
      // check. REPORT-ONLY: prints findings, never mutates roster.json or
      // any agent file. Exit code reflects only whether the reconcile itself
      // ran (0) or a roster file was unparseable (1) — orphans found is NOT
      // a failure exit, this is advisory, not a gate.
      const report = reconcileRoster({home: resolveHome(), cwd: opts.root});
      stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.global_roster_unparseable || report.project_roster_unparseable) {
        exit(1);
      }
      break;
    }

    case 'complete': {
      const state = loadStateOrDie();
      let meta = {};
      if (named.meta) {
        try {
          meta = JSON.parse(named.meta);
        } catch (e) {
          die(`--meta is not valid JSON: ${e.message}`, 5);
        }
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          die('--meta must be a JSON object keyed by phase name', 5);
        }
      }

      const now = nowIso();
      const nextRecommended = new Date(Date.now() + 7 * 86400_000).toISOString();

      let next = setSyncStamps(state, {at: now, nextRecommended});
      for (const phase of ['discovery', 'roster', 'health']) {
        const phaseMeta = meta[phase] && typeof meta[phase] === 'object' ? meta[phase] : {};
        next = markPhaseCompleted(next, phase, phaseMeta, {now});
      }
      for (const phase of ['identity', 'structure']) {
        if (meta[phase] && typeof meta[phase] === 'object') {
          next = markPhaseCompleted(next, phase, meta[phase], {now});
        }
      }

      writeStateAtomic(opts.root, next);
      appendRouting({event: 'prism_sync', action: 'complete', last_sync_at: now});
      stdout.write(`sync complete: last_sync_at=${now}, next_sync_recommended=${nextRecommended}\n`);
      break;
    }

    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
