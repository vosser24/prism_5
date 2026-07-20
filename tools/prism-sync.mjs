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
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {
  isPhaseCompleted,
  markPhaseCompleted,
  nowIso,
  readState,
  setSyncStamps,
  writeStateAtomic,
} from './lib/prism-state.mjs';

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
`);
  exit(code);
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
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
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

function planMaintenancePhases(state) {
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
  reasons.roster = 'reconcile orphan agents';

  pending.push('health');
  reasons.health = 'verify wiring';

  return {pending, reasons, claude_md_changed: claudeChanged};
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'plan': {
      if (opts.smartDrift) {
        stderr.write('WARNING: --smart-drift is EXPERIMENTAL and not yet implemented; falling back to conservative.\n');
      }
      const state = loadStateOrDie();
      const planned = planMaintenancePhases(state);
      stdout.write(JSON.stringify({
        project: state.project_name,
        mode: 'conservative',
        pending: planned.pending,
        reasons: planned.reasons,
        last_sync_at: state.last_sync_at,
        last_run: state.last_run,
        claude_md_changed: planned.claude_md_changed,
      }, null, 2) + '\n');
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
