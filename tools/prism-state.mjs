#!/usr/bin/env node
// prism-state — thin CLI wrapper around tools/lib/prism-state.mjs.
//
// Lets the Phase 1 state-file module be driven by hand from a terminal so
// reviewers can poke the schema before Phase 2 (orchestrator) is built.
//
// Usage (run from any project root, or pass --root <path>):
//
//   prism-state init <project-name>            create initial .claude/.prism-state.json
//   prism-state read                            print parsed state + status
//   prism-state show                            pretty-print raw file
//   prism-state validate                        report ok / errors / checksum
//   prism-state phase complete <name> [--meta '{"k":v}']
//   prism-state phase fail     <name> "<error message>"
//   prism-state sync-stamp [--next <iso8601>]   set last_sync_at (and next_sync_recommended)
//   prism-state set-last-command <string|null>
//   prism-state adopt                           synthesize state from filesystem (v3.8.9 migration)
//   prism-state simulate-corrupt <kind>         kind: bom | json | schema | checksum | tmp
//   prism-state reset                           DELETE .prism-state.json (testbed convenience)
//   prism-state path                            print absolute state file path
//
// Phases: identity | structure | discovery | roster | health
//
// Refuses to operate on a directory that has no .git/ unless --no-git-guard
// is passed. Defense-in-depth against accidental misuse against the user's
// real install during Phase 1 testing.

import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

import {
  PHASES,
  computeChecksum,
  createInitialState,
  getStatePath,
  isPhaseCompleted,
  markPhaseCompleted,
  markPhaseFailed,
  nowIso,
  readState,
  setLastCommand,
  setSyncStamps,
  synthesizeFromFilesystem,
  validateState,
  verifyChecksum,
  writeStateAtomic,
} from './lib/prism-state.mjs';

// -------- arg parsing --------

const args = argv.slice(2);
const opts = {root: process.cwd(), noGitGuard: false};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '--meta') named.meta = args[++i];
  else if (a === '--next') named.next = args[++i];
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

function usage(code = 0) {
  stdout.write(`Usage: prism-state <command> [args] [--root <path>] [--no-git-guard]

Commands:
  init <project-name>
  read
  show
  validate
  phase complete <name> [--meta '<json>']
  phase fail     <name> <error-message>
  sync-stamp [--next <iso8601>]
  set-last-command <string|null>
  adopt
  simulate-corrupt <bom|json|schema|checksum|tmp>
  reset
  path

Phases: ${PHASES.join(' | ')}
`);
  exit(code);
}

if (positional.length === 0) usage(1);

// -------- safety guard --------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  stderr.write(
    `refusing to run: ${opts.root} has no .git/.\n` +
    `Pass --no-git-guard to override (only do this on a throwaway testbed).\n`
  );
  exit(2);
}

// -------- commands --------

const cmd = positional.shift();

try {
  switch (cmd) {
    case 'init': {
      const name = positional[0];
      if (!name) die('init requires <project-name>');
      const r = readState(opts.root);
      if (r.status === 'ok') die(`state already initialized: ${getStatePath(opts.root)}`);
      const s = createInitialState(name);
      const w = writeStateAtomic(opts.root, s);
      stdout.write(`initialized: ${w.path}\nchecksum: ${w.checksum}\n`);
      break;
    }
    case 'read': {
      const r = readState(opts.root);
      stdout.write(JSON.stringify({status: r.status, errors: r.errors, state: r.state}, null, 2) + '\n');
      exit(r.status === 'ok' ? 0 : 1);
    }
    case 'show': {
      const path = getStatePath(opts.root);
      if (!existsSync(path)) die('no state file', 1);
      stdout.write(readFileSync(path, 'utf8'));
      break;
    }
    case 'validate': {
      const r = readState(opts.root);
      const checksumOk = r.state ? verifyChecksum(r.state) : false;
      stdout.write(`status: ${r.status}\n`);
      stdout.write(`schema_ok: ${r.state ? validateState(r.state).ok : false}\n`);
      stdout.write(`checksum_ok: ${checksumOk}\n`);
      if (r.errors.length) stdout.write(`errors:\n  - ${r.errors.join('\n  - ')}\n`);
      exit(r.status === 'ok' ? 0 : 1);
    }
    case 'phase': {
      const sub = positional.shift();
      const name = positional.shift();
      if (!sub || !name) die('phase requires <complete|fail> <name>');
      if (!PHASES.includes(name)) die(`unknown phase: ${name} (valid: ${PHASES.join(', ')})`);
      const r = readState(opts.root);
      if (r.status !== 'ok') die(`cannot mutate: state status is ${r.status}`);
      let next;
      if (sub === 'complete') {
        let meta = {};
        if (named.meta) {
          try { meta = JSON.parse(named.meta); } catch (e) { die(`--meta is not valid JSON: ${e.message}`); }
        }
        next = markPhaseCompleted(r.state, name, meta);
      } else if (sub === 'fail') {
        const err = positional.join(' ') || 'unspecified error';
        next = markPhaseFailed(r.state, name, err);
      } else {
        die(`phase subcommand must be complete|fail, got ${sub}`);
      }
      writeStateAtomic(opts.root, next);
      stdout.write(`phase ${name} ${sub === 'complete' ? 'completed' : 'failed'}\n`);
      break;
    }
    case 'sync-stamp': {
      const r = readState(opts.root);
      if (r.status !== 'ok') die(`cannot mutate: ${r.status}`);
      const at = nowIso();
      const next = setSyncStamps(r.state, {at, nextRecommended: named.next || null});
      writeStateAtomic(opts.root, next);
      stdout.write(`last_sync_at=${at}\nnext_sync_recommended=${named.next || 'null'}\n`);
      break;
    }
    case 'set-last-command': {
      const v = positional[0];
      if (v === undefined) die('set-last-command requires a value (or "null")');
      const r = readState(opts.root);
      if (r.status !== 'ok') die(`cannot mutate: ${r.status}`);
      const next = setLastCommand(r.state, v === 'null' ? null : v);
      writeStateAtomic(opts.root, next);
      stdout.write(`last_command=${v}\n`);
      break;
    }
    case 'adopt': {
      if (existsSync(getStatePath(opts.root))) die('state already exists; use reset first');
      const synthesized = synthesizeFromFilesystem(opts.root);
      writeStateAtomic(opts.root, synthesized);
      const completed = PHASES.filter(p => isPhaseCompleted(synthesized, p));
      stdout.write(`adopted from filesystem.\n`);
      stdout.write(`phases marked complete: ${completed.length ? completed.join(', ') : '(none)'}\n`);
      break;
    }
    case 'simulate-corrupt': {
      const kind = positional[0];
      const path = getStatePath(opts.root);
      if (!existsSync(path) && kind !== 'tmp') die('no state file to corrupt; run init first', 1);
      switch (kind) {
        case 'bom': {
          // Prepend UTF-8 BOM to the existing file
          const buf = readFileSync(path);
          const bom = Buffer.from([0xef, 0xbb, 0xbf]);
          writeFileSync(path, Buffer.concat([bom, buf]));
          stdout.write('injected UTF-8 BOM at byte 0\n');
          break;
        }
        case 'json': {
          writeFileSync(path, '{this is not json');
          stdout.write('overwrote state with invalid JSON\n');
          break;
        }
        case 'schema': {
          writeFileSync(path, JSON.stringify({foo: 'bar'}));
          stdout.write('overwrote state with schema-violating object\n');
          break;
        }
        case 'checksum': {
          const obj = JSON.parse(readFileSync(path, 'utf8'));
          obj.project_name = 'tampered-' + Date.now();
          writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
          stdout.write('mutated project_name without recomputing checksum\n');
          break;
        }
        case 'tmp': {
          mkdirSync(join(opts.root, '.claude'), {recursive: true});
          const stray = path + '.tmp.99999.deadbeef';
          writeFileSync(stray, 'partial garbage from a hypothetical crash\n');
          stdout.write(`dropped stray temp file: ${stray}\n`);
          break;
        }
        default: die('simulate-corrupt requires <bom|json|schema|checksum|tmp>');
      }
      break;
    }
    case 'reset': {
      const path = getStatePath(opts.root);
      if (existsSync(path)) {
        rmSync(path);
        stdout.write(`removed ${path}\n`);
      } else {
        stdout.write('no state file to remove\n');
      }
      // Also clear stray .tmp files
      const dir = join(opts.root, '.claude');
      if (existsSync(dir)) {
        const {readdirSync} = await import('node:fs');
        for (const f of readdirSync(dir)) {
          if (f.includes('.tmp.')) {
            rmSync(join(dir, f));
            stdout.write(`removed ${join(dir, f)}\n`);
          }
        }
      }
      break;
    }
    case 'path': {
      stdout.write(getStatePath(opts.root) + '\n');
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}
